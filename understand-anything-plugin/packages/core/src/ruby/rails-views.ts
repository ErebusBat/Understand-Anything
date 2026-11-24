import { join } from "node:path";
import type { TreeSitterPlugin } from "../plugins/tree-sitter-plugin.js";
import { rubyCall, rubyConstant, rubyLiteral, rubyOptions, rubyStatements, walkRuby, type RubyAstNode } from "./ast.js";
import { safeRubySourcePath, type RubyDependencyResolver } from "./resolver.js";
import type { DependencyFact } from "./types.js";

const CONTROLLER = /^app\/controllers\/((?:[a-z0-9_]+\/)*[a-z0-9_]+)_controller\.rb$/;
const VIEW_NAME = /^(?:[a-z0-9_-]+\/)*[a-z0-9_-]+$/;
const LOOKUP_METHODS = new Set(["render", "render_to_body", "find_template", "lookup_context", "view_paths",
  "controller_path", "_prefixes", "local_prefixes", "prepend_view_path", "append_view_path"]);

function findClass(body: RubyAstNode | null, expected: string, prefix = ""): RubyAstNode | null {
  for (const node of rubyStatements(body)) {
    if (node.type !== "class" && node.type !== "module") continue;
    const raw = rubyConstant(node.childForFieldName("name"));
    if (!raw || (prefix && raw.includes("::") && !raw.startsWith("::"))) continue;
    const name = raw.startsWith("::") ? raw.slice(2) : prefix + raw;
    if (name === expected && node.type === "class") return node;
    if (expected.startsWith(name + "::")) {
      const nested = findClass(node.childForFieldName("body"), expected, name + "::");
      if (nested) return nested;
    }
  }
  return null;
}

function lookupOverridden(body: RubyAstNode): boolean {
  let overridden = false;
  walkRuby(body, node => {
    if (overridden || node.type === "class" || node.type === "module") return false;
    if (node.type === "method" || node.type === "singleton_method") {
      overridden = LOOKUP_METHODS.has(node.childForFieldName("name")?.text ?? "");
    } else if (node.type === "call") {
      const method = node.childForFieldName("method")?.text;
      if (method === "prepend_view_path" || method === "append_view_path" || method === "view_paths") overridden = true;
    }
  });
  return overridden;
}

function renderPath(node: RubyAstNode, controller: string): { name: string; key: string } | null {
  const call = rubyCall(node);
  if (!call || call.method !== "render" || call.receiver || call.block || call.args.length !== 1) return null;
  const arg = call.args[0];
  let name = rubyLiteral(arg);
  let partial = false;
  if (arg.type === "pair" || arg.type === "hash") {
    const options = rubyOptions(call.args);
    if (!options || options.size !== 1) return null;
    const [[mode, value]] = options;
    if (!["action", "template", "partial"].includes(mode)) return null;
    // Action lookup applies controller prefixes. An explicit template uses
    // the view root. Only accept paths whose prefix choice is unambiguous.
    if (typeof value !== "string" || (mode === "action" && value.includes("/"))
      || (mode === "template" && !value.includes("/"))) return null;
    const pair = arg.type === "hash" ? rubyStatements(arg)[0] : arg;
    if (mode !== "action" && pair?.childForFieldName("value")?.type !== "string") return null;
    name = value;
    partial = mode === "partial";
  }
  if (typeof name !== "string" || !VIEW_NAME.test(name)) return null;
  const key = name.includes("/") ? name : `${controller}/${name}`;
  const slash = key.lastIndexOf("/") + 1;
  return { name, key: partial ? key.slice(0, slash) + "_" + key.slice(slash) : key };
}

interface Controller {
  parent: string | null;
  facts: DependencyFact[];
}

/** Resolve only explicit controller renders backed by a single selected view.
 * All candidate formats count toward ambiguity, including unsupported ones. */
export class RailsViewResolver {
  private readonly templates = new Map<string, string | null>();
  private readonly controllers = new Map<string, Controller | null>();

  constructor(views: string[], projectRoot: string, private readonly resolver: RubyDependencyResolver,
    private readonly plugin: TreeSitterPlugin) {
    if (!views.length) return;
    const root = join(projectRoot, "app/views");
    try {
      if (safeRubySourcePath(projectRoot, "app/views") !== root) return;
    } catch { return; }
    for (const path of views) {
      const match = /^app\/views\/((?:[\w-]+\/)*[\w-]+)(\+[^./]+)?\.(.+)$/.exec(path);
      if (!match) continue;
      const [, key, variant, suffix] = match;
      let target = null;
      if (!this.templates.has(key) && !variant && /^(?:html\.)?(?:erb|haml|slim)$/.test(suffix)) {
        try {
          safeRubySourcePath(root, path.slice("app/views/".length));
          target = path;
        } catch { /* An unavailable or escaping template cannot supply an endpoint. */ }
      }
      this.templates.set(key, target);
    }
  }

  private controller(path: string): Controller | null {
    if (this.controllers.has(path)) return this.controllers.get(path)!;
    const controllerPath = CONTROLLER.exec(path)?.[1];
    const name = controllerPath && this.resolver.camelize(controllerPath + "_controller");
    const source = this.resolver.sources.get(path);
    if (!name || source === undefined || this.resolver.resolveConstant("::" + name, { path }) !== path) return null;
    const result = this.plugin.withSyntaxTree(path, source, root => {
      const node = findClass(root, name);
      const body = node?.childForFieldName("body");
      const superclass = node?.childForFieldName("superclass")?.namedChildren[0];
      const baseName = rubyConstant(superclass);
      if (!superclass || !baseName || (body && lookupOverridden(body))) return null;
      const parent = this.resolver.getDependencies(path).find(fact => fact.kind === "superclass"
        && fact.line === superclass.startPosition.row + 1 && fact.reference === baseName)?.target;
      if (!parent && baseName.replace(/^::/, "") !== "ActionController::Base") return null;
      const facts = new Map<string, DependencyFact>();
      for (const method of rubyStatements(body)) {
        const methodBody = method.type === "method" && method.childForFieldName("body");
        if (!methodBody) continue;
        walkRuby(methodBody, statement => {
          // Blocks may change self or negotiate another format. Nested classes
          // and methods have their own receiver.
          if (["block", "do_block", "lambda", "class", "module", "singleton_class", "method", "singleton_method"].includes(statement.type)) return false;
          const render = renderPath(statement, controllerPath);
          if (!render) return;
          const target = this.templates.get(render.key);
          if (target) {
            const line = statement.startPosition.row + 1;
            const fact: DependencyFact = { type: "depends_on", kind: "render", target, reference: render.name, line };
            facts.set(JSON.stringify(fact), fact);
          }
        });
      }
      return { parent: parent ?? null, facts: [...facts.values()] };
    });
    this.controllers.set(path, result);
    return result;
  }

  dependencies(path: string): DependencyFact[] {
    if (!this.templates.size || !this.resolver.isRails || this.resolver.inferenceBlocked || !CONTROLLER.test(path)) return [];
    const controller = this.controller(path);
    if (!controller?.facts.length) return [];
    let parent = controller.parent;
    const seen = new Set([path]);
    while (parent) {
      if (seen.has(parent)) return [];
      seen.add(parent);
      const ancestor = this.controller(parent);
      if (!ancestor) return [];
      parent = ancestor.parent;
    }
    return controller.facts;
  }
}
