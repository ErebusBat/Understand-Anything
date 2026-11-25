import type { TreeSitterPlugin } from "../plugins/tree-sitter-plugin.js";
import { rubyCall, rubyConstant, rubyLiteral, rubyStatements, walkRuby, type RubyAstNode } from "./ast.js";
import type { DependencyDiagnostic, DependencyFact } from "./types.js";

interface RouteResolver {
  isRails: boolean;
  camelize(value: string): string | null;
  pluralize(value: string): string | null;
  resolveConstant(reference: string, options?: { path?: string; line?: number }): string | null;
}

const HTTP_METHODS = new Set(["get", "post", "put", "patch", "delete", "head", "options"]);
const CONTROLLER_PATH = /^[a-z][a-z\d_]*(?:\/[a-z][a-z\d_]*)*$/;

/** Only unconditional, statically named declarations in the application's own
 * config can establish a named routes.draw receiver. */
function applicationClasses(body: RubyAstNode | null, namespace = ""): string[] {
  const names: string[] = [];
  for (const node of rubyStatements(body)) {
    if (node.type !== "class" && node.type !== "module") continue;
    const name = rubyConstant(node.childForFieldName("name"));
    if (!name || (namespace && name.includes("::") && !name.startsWith("::"))) continue;
    const qualified = name.startsWith("::") ? name.slice(2) : namespace + name;
    const base = rubyConstant(node.childForFieldName("superclass")?.namedChildren[0]);
    if (base?.replace(/^::/, "") === "Rails::Application") names.push(qualified);
    names.push(...applicationClasses(node.childForFieldName("body"), qualified + "::"));
  }
  return names;
}

type Call = NonNullable<ReturnType<typeof rubyCall>>;
interface RouteScope {
  prefix: string;
  resource?: string;
  guards: string[];
}
interface RouteSite { node: RubyAstNode; controller: string; reference: string; guards: string[] }

const ACTION = /^[a-z_]\w*[!?]?$/;
const REST_ACTIONS = ["index", "show", "new", "create", "edit", "update", "destroy"];

// Preserve value nodes: only a few nested options (e.g. defaults: {format: ...})
// have known semantics. An unknown option may override the endpoint.
function routeOptions(args: RubyAstNode[], allowed: string[]): Map<string, RubyAstNode> | null {
  const options = new Map<string, RubyAstNode>();
  for (const arg of args.flatMap(n => n.type === "hash" ? rubyStatements(n) : [n])) {
    const keyNode = arg.childForFieldName("key");
    const key = rubyLiteral(keyNode);
    const value = arg.childForFieldName("value");
    if (arg.type !== "pair" || !keyNode || !["hash_key_symbol", "simple_symbol"].includes(keyNode.type)
      || typeof key !== "string" || !allowed.includes(key) || !value || options.has(key)) return null;
    if (key === "defaults" || key === "constraints") {
      const settings = value.type === "hash" && routeOptions(rubyStatements(value), ["format"]);
      if (!settings) return null;
    } else if (key === "only" || key === "except" || key === "via") {
      if (!actionList(value)) return null;
    } else if (typeof rubyLiteral(value) !== "string") return null;
    options.set(key, value);
  }
  return options;
}

function actionList(node: RubyAstNode): string[] | null {
  if (node.type === "symbol_array") {
    const names = rubyStatements(node).map(n => n.type === "bare_symbol" && ACTION.test(n.text) ? n.text : null);
    return names.every(n => n !== null) ? names as string[] : null;
  }
  const value = rubyLiteral(node);
  const list = Array.isArray(value) ? value : [value];
  return list.every(n => typeof n === "string" && ACTION.test(n)) ? list as string[] : null;
}

function httpDestination(call: Call, resource?: string): { controller: string; reference: string } | null {
  const [first, ...rest] = call.args;
  if (!first) return null;
  const allowed = ["to", "as", "on", "constraints", "defaults", ...(call.method === "match" ? ["via"] : [])];
  let destination;
  let options;
  if (first.type === "pair" && first.childForFieldName("key")?.type === "string") {
    if (call.method === "root" || typeof rubyLiteral(first.childForFieldName("key")) !== "string") return null;
    destination = rubyLiteral(first.childForFieldName("value"));
    options = routeOptions(rest, allowed.filter(key => key !== "to"));
  } else if (call.method === "root" && first.type === "pair") {
    options = routeOptions(call.args, allowed);
    destination = rubyLiteral(options?.get("to"));
  } else {
    const path = rubyLiteral(first);
    if (typeof path !== "string") return null;
    options = routeOptions(rest, allowed);
    destination = options?.has("to") ? rubyLiteral(options.get("to")) : call.method === "root" ? path : undefined;
    if (options && !options.has("to") && call.method !== "root" && resource && ACTION.test(path)) {
      destination = resource + "#" + path;
    }
  }
  if (!options || (call.method === "match" && !options.has("via")) || typeof destination !== "string") return null;
  if (options.has("on") && (!resource || !["member", "collection", "new"].includes(String(rubyLiteral(options.get("on")))))) return null;
  const parts = destination.split("#");
  return parts.length === 2 && CONTROLLER_PATH.test(parts[0]) && ACTION.test(parts[1])
    ? { controller: parts[0], reference: destination } : null;
}

// Rails applications can mount one local route block at several namespaces.
// Accept only a direct, zero-argument lambda whose other uses are sibling
// namespace block arguments. Reassignment or passing it elsewhere is ambiguous.
function localRouteBlock(node: RubyAstNode, body: RubyAstNode): {name: string; body: RubyAstNode} | null {
  if (node.type !== "assignment") return null;
  const left = node.childForFieldName("left");
  const right = node.childForFieldName("right");
  const call = rubyCall(right);
  const block = right?.type === "lambda" && !right.childForFieldName("parameters") ? right.childForFieldName("body")
    : call?.method === "lambda" && !call.receiver && !call.args.length ? call.block : null;
  const statements = block?.childForFieldName("body");
  if (left?.type !== "identifier" || !statements || block?.childForFieldName("parameters")) return null;
  const allowed = new Set([left.id]);
  for (const sibling of rubyStatements(body)) {
    const mount = rubyCall(sibling);
    const arg = mount?.args.at(-1);
    const id = arg?.type === "block_argument" && arg.namedChildren[0];
    if (mount?.method === "namespace" && !mount.receiver && !mount.block
      && id && id.type === "identifier" && id.text === left.text && sibling.startIndex > node.endIndex) allowed.add(id.id);
  }
  if (allowed.size === 1) return null;
  let safe = true;
  walkRuby(body, child => {
    if (child.type === "identifier" && child.text === left.text && !allowed.has(child.id)) safe = false;
    if (!safe) return false;
  });
  return safe ? {name: left.text, body: statements} : null;
}

function visitRoutes(body: RubyAstNode | null, scope: RouteScope, resolver: RouteResolver,
  record: (site: RouteSite) => void, reject: (node: RubyAstNode, message: string) => void): void {
  if (!body) return;
  const blocks = new Map<string, RubyAstNode>();
  const mounted = new Set<string>();
  for (const node of rubyStatements(body)) {
    const binding = localRouteBlock(node, body);
    if (binding) {
      blocks.set(binding.name, binding.body);
      continue;
    }
    const call = rubyCall(node);
    const blockArg = call?.method === "namespace" ? call.args.at(-1) : undefined;
    const shared = blockArg?.type === "block_argument" ? blocks.get(blockArg.namedChildren[0]?.text) : undefined;
    const nested = call?.block?.childForFieldName("body") ?? shared;
    const condition = node.childForFieldName("condition");
    if ((node.type === "if" || node.type === "unless") && condition
      && /^(?:::)?[A-Z]\w*(?:::[A-Z]\w*)*(?:\.[a-z_]\w*\??)+$/.test(condition.text)) {
      visitRoutes(node.childForFieldName("consequence"), {...scope, guards: [...scope.guards, node.type + " " + condition.text]}, resolver, record, reject);
      const alternative = node.childForFieldName("alternative");
      if (alternative?.type === "else") {
        const inverse = node.type === "if" ? "unless " : "if ";
        visitRoutes(alternative, {...scope, guards: [...scope.guards, inverse + condition.text]}, resolver, record, reject);
      } else if (alternative) reject(alternative, "Unsupported alternative route condition.");
      continue;
    }
    if (call && !call.receiver && !call.block?.childForFieldName("parameters")) {
      const args = shared ? call.args.slice(0, -1) : call.args;
      const [first, ...rest] = args;
      const name = rubyLiteral(first);
      if (nested && (call.method === "namespace" || call.method === "scope")) {
        const takesPath = typeof name === "string";
        const options = routeOptions(takesPath ? rest : args, ["path", "as", "module"]);
        const mod = options?.has("module") ? rubyLiteral(options.get("module")) : call.method === "namespace" ? name : "";
        const url = options?.has("path") ? rubyLiteral(options.get("path")) : name;
        if (options && (takesPath || call.method === "scope") && typeof mod === "string" && (!mod || CONTROLLER_PATH.test(mod))
          && !(typeof url === "string" && /:(?:controller|action)\b/.test(url))) {
          const prefix = scope.prefix + (mod ? mod + "/" : "");
          const mount = shared && JSON.stringify([shared.id, prefix]);
          if (!mount || !mounted.has(mount)) visitRoutes(nested, {...scope, prefix}, resolver, record, reject);
          if (mount) mounted.add(mount);
          continue;
        }
      } else if (nested && scope.resource && ["member", "collection", "new"].includes(call.method) && !call.args.length) {
        visitRoutes(nested, scope, resolver, record, reject);
        continue;
      } else if (call.method === "resources" || call.method === "resource") {
        const options = routeOptions(rest, ["only", "except", "controller", "as", "path", "param", "defaults", "constraints"]);
        if (typeof name === "string" && /^[a-z][a-z\d_]*$/.test(name) && options && !(options.has("only") && options.has("except"))) {
          const controller = options.has("controller") ? rubyLiteral(options.get("controller"))
            : call.method === "resource" ? resolver.pluralize(name) : name;
          if (typeof controller === "string" && CONTROLLER_PATH.test(controller)) {
            const only = options.get("only"), except = options.get("except");
            const actions = REST_ACTIONS.filter(action => action !== "index" || call.method === "resources");
            if (actions.some(action => (!only || actionList(only)!.includes(action)) && (!except || !actionList(except)!.includes(action)))) {
              record({node, controller: scope.prefix + controller, reference: call.method + " :" + name, guards: scope.guards});
            }
            if (nested) visitRoutes(nested, {...scope, resource: controller}, resolver, record, reject);
            continue;
          }
        }
      } else if (!call.block && (HTTP_METHODS.has(call.method) || call.method === "root" || call.method === "match")) {
        const destination = httpDestination(call, scope.resource);
        if (destination) {
          record({node, controller: scope.prefix + destination.controller, reference: destination.reference, guards: scope.guards});
          continue;
        }
      }
    }
    reject(node, "Route scope or destination is outside the supported literal subset.");
  }
}

export function extractRailsRouteDependencies({ path, source, applicationSource, plugin, resolver }: {
  path: string;
  source: string;
  applicationSource?: string;
  plugin: TreeSitterPlugin;
  resolver: RouteResolver;
}): { dependencies: DependencyFact[]; diagnostics: DependencyDiagnostic[] } {
  const dependencies: DependencyFact[] = [];
  const diagnostics: DependencyDiagnostic[] = [];
  if (!resolver.isRails || !/(^|\/)config\/routes\.rb$/.test(path)) return { dependencies, diagnostics };
  const reject = (node: RubyAstNode | null, message: string) => {
    diagnostics.push({ path, code: "unsupported-route", message, ...(node ? { line: node.startPosition.row + 1 } : {}) });
  };
  // An engine's isolated namespace cannot be inferred from the route filename.
  if (path !== "config/routes.rb") {
    reject(null, "Engine route namespaces are outside the supported literal route subset.");
    return { dependencies, diagnostics };
  }
  const names = applicationSource
    ? plugin.withSyntaxTree("config/application.rb", applicationSource, root => applicationClasses(root))
    : [];
  plugin.withSyntaxTree(path, source, root => {
    for (const statement of rubyStatements(root)) {
      const draw = rubyCall(statement);
      const routes = rubyCall(draw?.receiver);
      const application = rubyCall(routes?.receiver);
      const named = rubyConstant(routes?.receiver)?.replace(/^::/, "");
      const defaultApplication = application?.method === "application" && application.args.length === 0 && !application.block
        && rubyConstant(application.receiver)?.replace(/^::/, "") === "Rails";
      const recognized = draw?.method === "draw" && draw.args.length === 0 && draw.block
        && routes?.method === "routes" && routes.args.length === 0 && !routes.block
        && (defaultApplication || (named && names.length === 1 && named === names[0]));
      if (!recognized || !draw?.block || draw.block.childForFieldName("parameters")) {
        reject(statement, "Expected a direct routes.draw block on Rails.application or the configured application class.");
        continue;
      }
      visitRoutes(draw.block.childForFieldName("body"), {prefix: "", guards: []}, resolver, ({node, controller, reference, guards}) => {
        const constant = resolver.camelize(controller + "_controller");
        if (!constant) {
          reject(node, "Controller inflection could not be determined statically.");
          return;
        }
        const line = node.startPosition.row + 1;
        const target = resolver.resolveConstant(`::${constant}`, { path, line });
        if (!target || !/(^|\/)app\/controllers\/.+\.rb$/.test(target)) {
          diagnostics.push({ path, line, code: "unresolved-route", message: `No unambiguous local controller file for ${constant}.` });
          return;
        }
        dependencies.push({ target, type: "routes", kind: "route", reference: [reference, ...guards].join(" "), line });
      }, reject);
    }
  });
  return { dependencies, diagnostics };
}
