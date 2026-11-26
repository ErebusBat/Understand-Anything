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
const DEFAULT_RENDER_METHODS = new Set(["default_render", "send_action", "process_action", "action_methods", "method_for_action"]);
const LOOKUP_METHODS = new Set(["render", "render_to_body", "find_template", "lookup_context", "view_paths",
  "layout", "_layout", "_normalize_layout", "_layout_for_option", "respond_to", "controller_path", "_prefixes", "local_prefixes", "prepend_view_path", "append_view_path"]);

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

function lookupOverridden(body: RubyAstNode, methods = LOOKUP_METHODS): boolean {
  let overridden = false;
  walkRuby(body, node => {
    if (overridden || node.type === "class" || node.type === "module") return false;
    if (node.type === "method" || node.type === "singleton_method") {
      overridden = methods.has(node.childForFieldName("name")?.text ?? "");
    } else if (methods === LOOKUP_METHODS && node.type === "call") {
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
  if (!call || call.method !== "render" || call.receiver || call.block || !call.args.length) return null;
  const [first, ...rest] = call.args;
  const positional = first.type === "string" || first.type === "simple_symbol";
  let name = positional ? rubyLiteral(first) : undefined;
  let partial = false;
  const seen = new Set<string>();
  const options = positional ? rest : call.args;
  for (const pair of options.flatMap(arg => arg.type === "hash" ? rubyStatements(arg) : [arg])) {
    if (pair.type !== "pair") return null;
    const key = rubyLiteral(pair.childForFieldName("key"));
    if (typeof key !== "string" || seen.has(key)) return null;
    seen.add(key);
    // The layout and response status are independent of the template path.
    if (["layout", "status", "locals"].includes(key)) continue;
    if (positional || name !== undefined || !["action", "template", "partial"].includes(key)) return null;
    const value = pair.childForFieldName("value");
    name = rubyLiteral(value);
    if (typeof name !== "string" || (key === "action" && name.includes("/"))
      || (key === "template" && !name.includes("/")) || (key !== "action" && value?.type !== "string")) return null;
    partial = key === "partial";
  }
  if (typeof name !== "string" || !VIEW_NAME.test(name)) return null;
  const key = name.includes("/") ? name : `${controller}/${name}`;
  return { name, key: partial ? partialKey(key) : key };
}

/** Direct empty instance methods may fall through to Rails' default render.
 * Visibility setters with dynamic names and action-hiding macros can change
 * which methods Rails exposes, so they must be accounted for first. */
function emptyActions(statements: RubyAstNode[]): RubyAstNode[] {
  const actions = new Map<string, RubyAstNode>();
  const hidden = new Set<string>();
  let publicVisibility = true;
  for (const statement of statements) {
    if (["public", "protected", "private"].includes(statement.text)) {
      publicVisibility = statement.text === "public";
      continue;
    }
    const call = rubyCall(statement);
    if (call && !call.receiver && ["private", "protected", "hide_action", "remove_method", "undef_method"].includes(call.method)) {
      for (const arg of call.args) {
        const name = arg.type === "method" ? arg.childForFieldName("name")?.text : rubyLiteral(arg);
        if (typeof name !== "string") return [];
        hidden.add(name);
      }
    }
    if (statement.type !== "method") continue;
    const name = statement.childForFieldName("name")?.text;
    if (!name) continue;
    actions.delete(name);
    if (publicVisibility && /^[a-z][a-z0-9_]*$/.test(name) && !rubyStatements(statement.childForFieldName("parameters")).length
        && !rubyStatements(statement.childForFieldName("body")).length) actions.set(name, statement);
  }
  return [...actions].filter(([name]) => !hidden.has(name)).map(([, node]) => node);
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
  overridesDefaultRender: boolean;
}

/** Resolve only explicit controller renders backed by a single selected view.
 * All candidate formats count toward ambiguity, including unsupported ones. */
export class RailsViewResolver {
  private readonly templates = new Map<string, string | null>();
  private readonly viewSources = new Map<string, string>();
  private readonly mailerCache = new Map<string, DependencyFact[]>();
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
      const statements = rubyStatements(body);
      const overridesDefaultRender = !!body && lookupOverridden(body, DEFAULT_RENDER_METHODS);
      if (!controllerPath) return {parent: parent ?? null, facts: [], overridesDefaultRender};
      for (const action of emptyActions(statements)) {
        const name = action.childForFieldName("name")!.text;
        const target = this.templates.get(controllerPath + "/" + name);
        if (!target) continue;
        const fact: DependencyFact = {type: "depends_on", kind: "render", target, reference: name,
          line: action.startPosition.row + 1, resolution: "inferred"};
        facts.set(JSON.stringify(fact), fact);
      }
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
              if (child.type === "assignment" || child.type === "operator_assignment") break;
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
      return {parent: parent ?? null, facts: [...facts.values()], overridesDefaultRender};
    });
    this.controllers.set(path, result);
    return result;
  }

  private controllerDependencies(path: string): DependencyFact[] {
    if (!this.templates.size || !CONTROLLER.test(path)) return [];
    const controller = this.controller(path);
    if (!controller?.facts.length) return [];
    let parent = controller.parent;
    let overridesDefaultRender = controller.overridesDefaultRender;
    const seen = new Set([path]);
    while (parent) {
      if (seen.has(parent)) return [];
      seen.add(parent);
      const ancestor = this.controller(parent);
      if (!ancestor) return [];
      overridesDefaultRender ||= ancestor.overridesDefaultRender;
      parent = ancestor.parent;
    }
    return overridesDefaultRender ? controller.facts.filter(fact => !fact.resolution) : controller.facts;
  }

  private mailerAncestry(path: string, name: string, seen = new Set<string>()): boolean {
    if (seen.has(path)) return false;
    seen.add(path);
    const source = this.resolver.sources.get(path);
    if (source === undefined || this.resolver.resolveConstant("::" + name, {path}) !== path) return false;
    return this.plugin.withSyntaxTree(path, source, root => {
      const node = findClass(root, name), body = node?.childForFieldName("body");
      if (!node || (body && lookupOverridden(body))) return false;
      // Template defaults and name overrides redirect ActionMailer's lookup.
      for (const statement of rubyStatements(body)) {
        const call = rubyCall(statement);
        if (statement.type === "singleton_method" && ["mailer_name", "default"].includes(statement.childForFieldName("name")?.text ?? "")) return false;
        if (call?.method === "default" && !call.receiver) {
          const pairs = call.args.flatMap(arg => arg.type === "hash" ? rubyStatements(arg) : [arg]);
          if (pairs.some(pair => pair.type !== "pair" || ["template_name", "template_path", "body"].includes(String(rubyLiteral(pair.childForFieldName("key")))))) return false;
        }
      }
      const superclass = node.childForFieldName("superclass")?.namedChildren[0];
      const base = rubyConstant(superclass);
      if (!base) return false;
      // Superclasses resolve in the declaration's enclosing lexical scopes,
      // not in the class body and not always at the workspace root.
      const ancestors: RubyAstNode[] = [];
      for (let ancestor = node.parent; ancestor; ancestor = ancestor.parent) {
        if (ancestor.type === "class" || ancestor.type === "module") ancestors.unshift(ancestor);
      }
      const nesting: string[] = [];
      for (const ancestor of ancestors) {
        const raw = rubyConstant(ancestor.childForFieldName("name"));
        if (!raw) return false;
        nesting.unshift(raw.startsWith("::") ? raw.slice(2) : nesting[0] ? nesting[0] + "::" + raw : raw);
      }
      const parent = this.resolver.resolveConstant(base, {path, nesting, line: superclass!.startPosition.row + 1});
      if (!parent) return base.replace(/^::/, "") === "ActionMailer::Base";
      const candidates = base.startsWith("::") ? [base.slice(2)] : [...nesting.map(scope => scope + "::" + base), base];
      const parentName = candidates.find(candidate => this.resolver.resolveConstant("::" + candidate, {path}) === parent);
      return !!parentName && this.mailerAncestry(parent, parentName, seen);
    });
  }

  private mailerDependencies(path: string): DependencyFact[] {
    const cached = this.mailerCache.get(path);
    if (cached) return cached;
    const prefix = /^app\/mailers\/((?:[a-z0-9_]+\/)*[a-z0-9_]+)\.rb$/.exec(path)?.[1];
    const name = prefix && this.resolver.camelize(prefix);
    if (!prefix || !name || !this.mailerAncestry(path, name)) return [];
    const facts = this.plugin.withSyntaxTree(path, this.resolver.sources.get(path)!, root => {
      const body = findClass(root, name)!.childForFieldName("body");
      const facts: DependencyFact[] = [];
      for (const method of rubyStatements(body)) {
        if (method.type !== "method") continue;
        const action = method.childForFieldName("name")?.text;
        if (!action) continue;
        const methodBody = method.childForFieldName("body");
        if (!methodBody) continue;
        walkRuby(methodBody, node => {
          if (["block", "do_block", "lambda", "class", "module", "method", "singleton_method"].includes(node.type)) return false;
          const call = rubyCall(node);
          if (!call || call.receiver || call.method !== "mail" || call.block) return;
          const options = new Map<string, RubyAstNode>();
          for (const pair of call.args.flatMap(arg => arg.type === "hash" ? rubyStatements(arg) : [arg])) {
            const key = pair.type === "pair" && rubyLiteral(pair.childForFieldName("key"));
            const value = pair.childForFieldName("value");
            if (typeof key !== "string" || !value || options.has(key)) return;
            options.set(key, value);
          }
          if (options.has("body")) return;
          const template = options.has("template_name") ? rubyLiteral(options.get("template_name")) : action;
          const directory = options.has("template_path") ? rubyLiteral(options.get("template_path")) : prefix;
          if (typeof template !== "string" || template.includes("/") || !VIEW_NAME.test(template)
            || typeof directory !== "string" || !VIEW_NAME.test(directory)) return;
          const target = this.templates.get(directory + "/" + template);
          if (target) facts.push({target, type: "depends_on", kind: "mailer_template", reference: directory + "/" + template,
            line: node.startPosition.row + 1, resolution: "inferred"});
        });
      }
      return facts;
    });
    this.mailerCache.set(path, facts);
    return facts;
  }

  private renderingControllerPrefix(path: string): string | null {
    const view = /^app\/views\/((?:[a-z0-9_]+\/)*[a-z0-9_]+)\/([a-z0-9][\w-]*)\.(?:html\.)?(?:erb|haml|slim)$/.exec(path);
    if (!view) return null;
    const prefix = view[1];
    // An explicit render or a default action establishes one possible host
    // with this directory first in its lookup prefixes. Shared partials and
    // layouts do not establish the caller of an unqualified partial.
    const host = this.controllerDependencies("app/controllers/" + prefix + "_controller.rb");
    if (host.some(fact => fact.kind === "render" && fact.target === path)) return prefix;
    return this.mailerDependencies("app/mailers/" + prefix + ".rb").some(fact => fact.target === path) ? prefix : null;
  }

  dependencies(path: string): DependencyFact[] {
    const source = this.viewSources.get(path);
    if (source === undefined) return [...this.controllerDependencies(path), ...this.mailerDependencies(path)];
    const facts = new Map<string, DependencyFact>();
    let prefix: string | null | undefined;
    for (const {name, line} of templatePartials(this.plugin, path, source)) {
      const relative = !name.includes("/");
      if (relative && prefix === undefined) prefix = this.renderingControllerPrefix(path);
      if (relative && !prefix) continue;
      const target = this.templates.get(partialKey(relative ? prefix + "/" + name : name));
      if (target && target !== path) facts.set(line + ":" + name, {type: "depends_on", kind: "render", target, reference: name, line,
        ...(relative ? {resolution: "inferred"} : {})});
    }
    return [...facts.values()];
  }
}
