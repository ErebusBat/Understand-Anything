import type { TreeSitterPlugin } from "../plugins/tree-sitter-plugin.js";
import { rubyCall, rubyConstant, rubyLiteral, rubyOptions, rubyStatements, type RubyAstNode } from "./ast.js";
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

/** Traverse literal namespace blocks only. An unsupported scope can change
 * every controller beneath it, so reject the whole subtree at its source line. */
function* routeStatements(body: RubyAstNode | null, prefix = ""): Generator<{ node: RubyAstNode; prefix: string }> {
  for (const node of rubyStatements(body)) {
    const call = rubyCall(node);
    if (call?.method === "namespace" && !call.receiver && call.block && !call.block.childForFieldName("parameters")) {
      const name = rubyLiteral(call.args[0]);
      const options = rubyOptions(call.args.slice(1));
      if (typeof name === "string" && CONTROLLER_PATH.test(name) && options
        && [...options].every(([key, value]) => ["path", "as"].includes(key) && typeof value === "string")) {
        yield* routeStatements(call.block.childForFieldName("body"), prefix + name + "/");
        continue;
      }
    }
    yield { node, prefix };
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
      for (const { node, prefix } of routeStatements(draw.block.childForFieldName("body"))) {
        const call = rubyCall(node);
        if (!call || call.receiver || call.block) {
          reject(node, "Unsupported route scope, block, condition or receiver.");
          continue;
        }
        let controller: string | null = null;
        let reference: string | null = null;
        if (HTTP_METHODS.has(call.method)) {
          const routePath = rubyLiteral(call.args[0]);
          const options = rubyOptions(call.args.slice(1));
          const destination = options?.get("to");
          if (typeof routePath !== "string" || call.args[0]?.type !== "string"
            || options?.size !== 1 || typeof destination !== "string") {
            reject(node, "HTTP routes require a literal path and only a literal to: 'controller#action' option.");
            continue;
          }
          const parts = destination.split("#");
          if (parts.length !== 2 || !CONTROLLER_PATH.test(parts[0]) || !/^[a-z_]\w*[!?]?$/.test(parts[1])) {
            reject(node, "Route destination must name a literal controller path and action.");
            continue;
          }
          controller = parts[0];
          reference = destination;
        } else if (call.method === "resource" || call.method === "resources") {
          const name = rubyLiteral(call.args[0]);
          if (call.args.length !== 1 || typeof name !== "string" || !/^[a-z][a-z\d_]*$/.test(name)) {
            reject(node, "Resource declarations require one literal name and no options or block.");
            continue;
          }
          controller = call.method === "resource" ? resolver.pluralize(name) : name;
          reference = `${call.method} :${name}`;
        } else {
          reject(node, `Route DSL method ${call.method} is outside the supported subset.`);
          continue;
        }
        const constant = controller && resolver.camelize(`${prefix}${controller}_controller`);
        if (!constant) {
          reject(node, "Controller inflection could not be determined statically.");
          continue;
        }
        const line = node.startPosition.row + 1;
        const target = resolver.resolveConstant(`::${constant}`, { path, line });
        if (!target || !/(^|\/)app\/controllers\/.+\.rb$/.test(target)) {
          diagnostics.push({ path, line, code: "unresolved-route", message: `No unambiguous local controller file for ${constant}.` });
          continue;
        }
        dependencies.push({ target, type: "routes", kind: "route", reference: reference!, line });
      }
    }
  });
  return { dependencies, diagnostics };
}
