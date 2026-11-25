import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { TreeSitterPlugin } from "../plugins/tree-sitter-plugin.js";
import { rubyCall, rubyConstant, rubyLiteral, rubyOptions, rubyStatements, walkRuby, type RubyAstNode } from "./ast.js";
import { safeRubySourcePath, type RubyDependencyResolver } from "./resolver.js";
import { templatePartials } from "./template-partials.js";
import type { DependencyFact } from "./types.js";

const CONTROLLER = /^app\/controllers\/((?:[a-z0-9_]+\/)*[a-z0-9_]+)_controller\.rb$/;
const CONTROLLER_CLASS = /^app\/controllers\/((?:[a-z0-9_]+\/)*[a-z0-9_]+)\.rb$/;
const VIEW_NAME = /^(?:[a-z0-9_-]+\/)*[a-z0-9_-]+$/;
const LOOKUP_METHODS = new Set(["render", "render_to_body", "find_template", "lookup_context", "view_paths",
  "layout", "_layout", "_normalize_layout", "_layout_for_option", "controller_path", "_prefixes", "local_prefixes", "prepend_view_path", "append_view_path"]);

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

function partialKey(name: string): string {
  const slash = name.lastIndexOf("/") + 1;
  return name.slice(0, slash) + "_" + name.slice(slash);
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
  return { name, key: partial ? partialKey(key) : key };
}

function layoutPath(node: RubyAstNode): { name: string; key: string } | null {
  const call = rubyCall(node);
  if (!call || call.receiver || call.block) return null;
  let value: RubyAstNode | null = null;
  if (call.method === "layout") {
    const [first, ...rest] = call.args;
    const options = rubyOptions(rest);
    if (!options || [...options.keys()].some(key => key !== "only" && key !== "except")) return null;
    value = first;
  } else if (call.method === "render") {
    // Partial layouts have their own (underscored) lookup. Restrict this to
    // ordinary template/action renders with an explicit full layout.
    const [first] = call.args;
    const args = first && ["string", "simple_symbol"].includes(first.type) ? call.args.slice(1) : call.args;
    const options = rubyOptions(args);
    if (!options?.has("layout") || [...options.keys()].some(key => !["layout", "template", "action"].includes(key))) return null;
    const pairs = args.flatMap(arg => arg.type === "hash" ? rubyStatements(arg) : [arg]);
    value = pairs.find(arg => rubyLiteral(arg.childForFieldName("key")) === "layout")?.childForFieldName("value") ?? null;
  }
  const name = value?.type === "string" && rubyLiteral(value);
  if (typeof name !== "string" || !VIEW_NAME.test(name)) return null;
  return {name, key: /\blayouts\//.test(name) ? name : "layouts/" + name};
}

interface Controller {
  parent: string | null;
  facts: DependencyFact[];
}

/** Resolve only explicit controller renders backed by a single selected view.
 * All candidate formats count toward ambiguity, including unsupported ones. */
export class RailsViewResolver {
  private readonly templates = new Map<string, string | null>();
  private readonly viewSources = new Map<string, string>();
  private readonly controllers = new Map<string, Controller | null>();

  constructor(views: string[], projectRoot: string, private readonly resolver: RubyDependencyResolver,
    private readonly plugin: TreeSitterPlugin) {
    if (!views.length || !resolver.isRails || resolver.inferenceBlocked) return;
    const root = join(projectRoot, "app/views");
    try {
      if (safeRubySourcePath(projectRoot, "app/views") !== root) return;
    } catch { return; }
    for (const path of views) {
      const match = /^app\/views\/((?:[\w-]+\/)*[\w-]+)(\+[^./]+)?\.(.+)$/.exec(path);
      if (!match) continue;
      const [, key, variant, suffix] = match;
      let target = null;
      if (!variant && /^(?:html\.)?(?:erb|haml|slim)$/.test(suffix)) {
        try {
          const sourcePath = safeRubySourcePath(root, path.slice("app/views/".length));
          if (sourcePath === join(projectRoot, path)) {
            const source = readFileSync(sourcePath, "utf8");
            if (source.includes("render")) this.viewSources.set(path, source);
            if (!this.templates.has(key)) target = path;
          }
        } catch (error) {
          resolver.failures.push({path, stage: "view-file-read", message: error instanceof Error ? error.message : String(error)});
        }
      }
      this.templates.set(key, target);
    }
  }

  private controller(path: string): Controller | null {
    if (this.controllers.has(path)) return this.controllers.get(path)!;
    const classPath = CONTROLLER_CLASS.exec(path)?.[1];
    const name = classPath && this.resolver.camelize(classPath);
    const controllerPath = CONTROLLER.exec(path)?.[1];
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
      const add = (kind: "layout" | "render", expression: ReturnType<typeof renderPath>, node: RubyAstNode) => {
        if (!expression) return;
        const target = this.templates.get(expression.key);
        if (!target) return;
        const fact: DependencyFact = {type: "depends_on", kind, target, reference: expression.name, line: node.startPosition.row + 1};
        facts.set(JSON.stringify(fact), fact);
      };
      // An abstract ancestor can live in a conventionally named Ruby file
      // without the controller suffix. Only its lookup behavior is needed.
      if (!controllerPath) return {parent: parent ?? null, facts: []};
      const statements = rubyStatements(body);
      const layouts = statements.filter(statement => rubyCall(statement)?.method === "layout");
      if (layouts.length === 1) add("layout", layoutPath(layouts[0]), layouts[0]);
      for (const method of statements) {
        const methodBody = method.type === "method" && method.childForFieldName("body");
        if (!methodBody) continue;
        const collect = (statement: RubyAstNode): void | boolean => {
          // Blocks may change self or negotiate another format. Nested classes
          // and methods have their own receiver.
          if (["block", "do_block", "lambda", "class", "module", "singleton_class", "method", "singleton_method"].includes(statement.type)) return false;
          const call = rubyCall(statement);
          if (call?.method === "respond_to" && !call.receiver && !call.args.length && call.block) {
            // Rails passes the format collector to this block and evaluates
            // the selected handler on the controller. Restrict this exception
            // to immediate HTML handlers on that specific block parameter.
            const params = rubyStatements(call.block.childForFieldName("parameters"));
            const collector = params.length === 1 && params[0].type === "identifier" && params[0].text;
            for (const child of rubyStatements(call.block.childForFieldName("body"))) {
              const handler = rubyCall(child);
              if (handler?.method !== "html" || handler.receiver?.type !== "identifier" || handler.receiver.text !== collector
                || handler.args.length || handler.block?.childForFieldName("parameters")) continue;
              const body = handler.block?.childForFieldName("body");
              if (body) walkRuby(body, collect);
            }
            return false;
          }
          if (call?.method === "render") {
            add("layout", layoutPath(statement), statement);
            add("render", renderPath(statement, controllerPath), statement);
          }
        };
        walkRuby(methodBody, collect);
      }
      return { parent: parent ?? null, facts: [...facts.values()] };
    });
    this.controllers.set(path, result);
    return result;
  }

  dependencies(path: string): DependencyFact[] {
    const source = this.viewSources.get(path);
    if (source !== undefined) {
      const facts = new Map<string, DependencyFact>();
      for (const {name, line} of templatePartials(this.plugin, path, source)) {
        const target = this.templates.get(partialKey(name));
        if (target && target !== path) facts.set(line + ":" + name, {type: "depends_on", kind: "render", target, reference: name, line});
      }
      return [...facts.values()];
    }
    if (!this.templates.size || !CONTROLLER.test(path)) return [];
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
