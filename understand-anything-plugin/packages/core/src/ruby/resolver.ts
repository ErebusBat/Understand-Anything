import { readFileSync, realpathSync } from "node:fs";
import { isAbsolute, posix, relative, resolve, sep } from "node:path";
import type { TreeSitterPlugin } from "../plugins/tree-sitter-plugin.js";
import { rubyCall, rubyConstant, rubyLiteral, rubyOptions, rubySelfSingletonClass, rubyStatements, walkRuby, type RubyAstNode } from "./ast.js";
import { classicRailsMajor, detectRailsApplication, initialRubyConfiguration, readRubyConfiguration, type RubyConfiguration } from "./config.js";
import { grapeDependencyArguments } from "./grape-api.js";
import { rubyMethodEvidence } from "./singleton-methods.js";
import { RubyTestSuites } from "./spec-registry.js";
import { DEFAULT_RUBY_MIXIN_RESOLUTION, type DependencyDiagnostic, type DependencyFact, type RubyDependencyFailure, type RubyInventoryFile, type RubyMixinResolution } from "./types.js";

interface Declaration {
  name: string;
  kind: "class" | "module" | "assignment";
  path: string;
  line: number;
  nesting: string[];
  superclass?: string;
  mixins: string[];
  conditional: boolean;
  wrapsDeclarations?: boolean;
  concernBase?: string;
  performsJob?: boolean;
  methods?: ReturnType<typeof rubyMethodEvidence>;
  valueAssignment?: "name" | "qualified";
}
interface Reference {
  reference: string;
  displayReference?: string;
  nesting: string[];
  kind: DependencyFact["kind"];
  line: number;
  owner?: string;
  mixinOffset?: number;
  receiverCall?: {method: string; offset: number};
  reflection?: {name: string; macro: string; path: string};
  classNameCall?: {method: string; nesting: string[]; offset: number};
  through?: {join: string; sources: string[]; override?: string};
}
interface RubyFileFacts {
  declarations: Declaration[];
  references: Reference[];
  requiredFiles: {path: string; end: number}[];
  uninspectedLoadOffset?: number;
}

export interface RubyDependencyResolverOptions {
  projectRoot: string;
  files: RubyInventoryFile[];
  plugin: TreeSitterPlugin;
  mixinResolution?: RubyMixinResolution;
}

type ConstantMatch = Pick<DependencyFact, "target" | "resolution">;

export interface RubyResolveOptions {
  nesting?: string[];
  path?: string;
  line?: number;
  association?: boolean;
  macroTarget?: "serializer" | "validator" | "grape" | "associationClassName";
  valueRead?: boolean;
  mixin?: boolean;
  mixinOffset?: number;
  receiverCall?: Reference["receiverCall"];
}

const ASSOCIATIONS = new Set(["belongs_to", "has_one", "has_many", "has_and_belongs_to_many"]);
const ACTIVE_RECORD_CLASS_METHODS = new Set([
  "new", "create", "create!", "find", "find_by", "find_by!", "find_each", "find_in_batches",
  "find_or_create_by", "find_or_create_by!", "find_or_initialize_by", "first", "last", "exists?",
  "all", "where", "unscoped", "includes", "joins", "preload", "eager_load", "order", "limit",
  "group", "having", "pluck", "count", "transaction", "update_all", "delete_all", "destroy_all",
]);
const CONDITIONAL = new Set(["if", "unless", "if_modifier", "unless_modifier", "case", "case_match", "conditional", "while", "until", "while_modifier", "until_modifier", "for", "rescue", "rescue_modifier", "ensure", "begin"]);
const FRAMEWORK_BASES = new Set(["ActiveRecord::Base", "ActionController::Base", "ActionController::API", "ActionMailer::Base", "ActiveJob::Base", "Object", "BasicObject"]);
const DEVISE_NAMESPACE = /^Devise(?:::|$)/;

function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function compare(a: string, b: string): number { return a < b ? -1 : a > b ? 1 : 0; }

function declaresJobEntryPoint(body: RubyAstNode, kind: Declaration["kind"]): boolean {
  const statements = rubyStatements(body);
  return statements.some((node, index) => {
    if (rubySelfSingletonClass(node)) {
      return rubyStatements(node.childForFieldName("body"))
        .some(method => method.type === "method" && method.childForFieldName("name")?.text === "perform");
    }
    if (node.childForFieldName("name")?.text !== "perform") return false;
    if (node.type === "singleton_method") return node.childForFieldName("object")?.type === "self";
    const previous = statements[index - 1];
    return kind === "module" && node.type === "method" && previous?.type === "identifier" && previous.text === "module_function";
  });
}

/** Paths are inventory-relative; both spelling and resolved symlinks must remain
 * inside the selected checkout. This function reads no target source. */
export function safeRubySourcePath(projectRoot: string, path: string): string {
  if (!path || isAbsolute(path) || /^[a-z]:/i.test(path) || path.includes("\\") || path.split("/").some(p => !p || p === "." || p === "..")) throw new Error(`Unsafe project-relative Ruby path: ${path}`);
  const boundary = realpathSync(projectRoot);
  const actual = realpathSync(resolve(boundary, path));
  const rel = relative(boundary, actual);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error(`Ruby path escapes project boundary: ${path}`);
  return actual;
}

/** Static file-level Rails resolver. Full inventory is always read/indexed;
 * getDependencies controls which consumer facts a selective scan emits.
 * No Ruby, Rails, application configuration, or globs are executed. */
export class RubyDependencyResolver {
  readonly sources = new Map<string, string>();
  private readonly collectedDiagnostics: DependencyDiagnostic[] = [];
  private sortedDiagnosticCount = 0;
  readonly failures: RubyDependencyFailure[] = [];
  readonly isRails: boolean;
  readonly applicationRootKnown: boolean;
  readonly configuration: RubyConfiguration;
  private readonly facts = new Map<string, RubyFileFacts>();
  private readonly bindings = new Map<string, Set<string>>();
  private readonly valueBindings = new Map<string, string>();
  private readonly declarations = new Map<string, Declaration[]>();
  private readonly consumerDeclarations = new Map<string, Map<string, Declaration[]>>();
  private readonly namespaces = new Set<string>();
  private readonly blocked = new Set<string>();
  private readonly dependencyCache = new Map<string, DependencyFact[]>();
  private readonly diagnosticKeys = new Set<string>();
  /** A null entry means the reflection is duplicate or is outside the static subset. */
  private readonly reflections = new Map<string, Map<string, Reference | null>>();
  private readonly dynamicReflections = new Set<string>();
  private readonly specRegistry: RubyTestSuites;
  private readonly initializerPaths = new Set<string>();
  private readonly mixinResolution: RubyMixinResolution;
  private indexIncomplete = false;

  constructor(options: RubyDependencyResolverOptions) {
    const {projectRoot, plugin} = options;
    this.mixinResolution = options.mixinResolution ?? DEFAULT_RUBY_MIXIN_RESOLUTION;
    this.specRegistry = new RubyTestSuites(options.files);
    const defaultOptions = /(?:^|\/)\.rspec$/;
    for (const {path} of options.files.filter(f => defaultOptions.test(f.path))) {
      try { this.specRegistry.readDefaultOptions(path, readFileSync(safeRubySourcePath(projectRoot, path), "utf8")); }
      catch (error) { this.failures.push({path, stage: "ruby-file-read", message: errorMessage(error)}); }
    }
    const paths = [...new Set(options.files.filter(f => !defaultOptions.test(f.path) && (f.path.endsWith(".rb") || f.language === "ruby")).map(f => f.path))].sort(compare);
    const autoloadPaths = paths.filter(path => path.endsWith(".rb"));
    const trees = new Map<string, { application: boolean; engines: boolean }>();
    let gemfileMajor: number | undefined;
    for (const path of paths) {
      const autoloadable = path.endsWith(".rb");
      let source: string;
      try { source = readFileSync(safeRubySourcePath(projectRoot, path), "utf8"); }
      catch (error) {
        this.failures.push({path, stage: "ruby-file-read", message: errorMessage(error)});
        if (autoloadable) this.indexIncomplete = true;
        continue;
      }
      try {
        const detected = plugin.withSyntaxTree(path, source, root => {
          this.specRegistry.index(path, root);
          if (path === "Gemfile") gemfileMajor = classicRailsMajor(root);
          if (!autoloadable) return {application: false, engines: false};
          let engines = false;
          walkRuby(root, node => {
            if (node.type === "class" && rubyConstant(node.childForFieldName("superclass")?.namedChildren[0])?.replace(/^::/, "") === "Rails::Engine") engines = true;
          });
          return {application: path === "config/application.rb" && detectRailsApplication(root), engines};
        });
        trees.set(path, detected);
        this.sources.set(path, source);
      } catch (error) {
        this.failures.push({path, stage: "ruby-file-parse", message: errorMessage(error)});
        if (autoloadable) this.indexIncomplete = true;
      }
    }
    this.applicationRootKnown = trees.get("config/application.rb")?.application ?? false;
    this.isRails = this.applicationRootKnown || [...trees.values()].some(t => t.engines);
    const classicMajor = trees.get("config/application.rb")?.application ? gemfileMajor : undefined;
    this.configuration = initialRubyConfiguration(autoloadPaths, this.isRails, classicMajor);
    if (!this.isRails) return;
    const engineConfigPrefixes = new Set<string>();
    const engineRoots = new Map<string, string>();
    for (const [path, detected] of trees) if (detected.engines) {
      const match = path.match(/^(.*?)lib\/(?:[^/]+\/)*engine\.rb$/);
      if (!match) {
        this.addDiagnostic({path, code: "unsupported_engine_context", message: "Rails::Engine source has no supported local lib/.../engine.rb context"});
        this.configuration.unsafe = true;
      } else {
        const prefix = match[1];
        engineRoots.set(path, prefix.replace(/\/$/, ""));
        engineConfigPrefixes.add(`${prefix}config/`);
        for (const root of initialRubyConfiguration(autoloadPaths.filter(p => p.startsWith(prefix)).map(p => p.slice(prefix.length)), true, classicMajor).roots) {
          this.configuration.roots.push({...root, path: prefix + root.path, provenance: path});
        }
      }
    }
    const configPrefixes = ["config/", ...engineConfigPrefixes];
    for (const [path, source] of this.sources) {
      if (!path.endsWith(".rb")) continue;
      if (configPrefixes.some(prefix => path.startsWith(prefix + "initializers/"))) this.initializerPaths.add(path);
      if (configPrefixes.some(prefix => path.startsWith(prefix)) || trees.get(path)?.engines) {
        plugin.withSyntaxTree(path, source, root => readRubyConfiguration(path, root, this.configuration, this.collectedDiagnostics, {
          projectRoot, applicationRootKnown:this.applicationRootKnown, engineRoot:engineRoots.get(path),
        }));
      }
    }
    // A failed parse/read can hide an alias, root override, or duplicate. Never
    // turn that incomplete inventory into confident dependency facts.
    if (this.inferenceBlocked) return;
    for (const [path, source] of this.sources) {
      this.facts.set(path, plugin.withSyntaxTree(path, source, root => this.extractFacts(path, root)));
    }
    this.buildIndex(classicMajor !== undefined);
  }

  get inferenceBlocked(): boolean {
    return this.configuration.unsafe || this.indexIncomplete;
  }

  camelize(value: string): string | null {
    return this.inferenceBlocked ? null : this.configuration.inflections.camelize(value);
  }
  pluralize(value: string): string | null {
    return this.inferenceBlocked ? null : this.configuration.inflections.pluralize(value);
  }

  private addDiagnostic(diagnostic: DependencyDiagnostic): void {
    const key = JSON.stringify(diagnostic);
    if (!this.diagnosticKeys.has(key)) { this.diagnosticKeys.add(key); this.collectedDiagnostics.push(diagnostic); }
  }

  get diagnostics(): DependencyDiagnostic[] {
    if (this.collectedDiagnostics.length !== this.sortedDiagnosticCount) this.sortDiagnostics();
    return this.collectedDiagnostics;
  }

  sortDiagnostics(): void {
    const diagnostics = this.collectedDiagnostics;
    const unique = new Set<string>();
    let count = 0;
    for (const diagnostic of diagnostics) {
      const key = JSON.stringify(diagnostic);
      if (!unique.has(key)) {
        unique.add(key);
        diagnostics[count++] = diagnostic;
      }
    }
    diagnostics.length = count;
    diagnostics.sort((a,b) => compare(a.path ?? "", b.path ?? "") || (a.line ?? 0) - (b.line ?? 0) || compare(a.code,b.code) || compare(a.message,b.message));
    this.sortedDiagnosticCount = count;
  }

  private extractFacts(path: string, root: RubyAstNode): RubyFileFacts {
    const result: RubyFileFacts = {declarations: [], references: [], requiredFiles: []};
    for (const statement of rubyStatements(root)) {
      const call = rubyCall(statement);
      // Only literal require_relative providers are indexed below. A different
      // preceding local or calculated load can introduce an unindexed shadow.
      if (call && (!call.receiver || rubyConstant(call.receiver)?.replace(/^::/, "") === "Kernel")
        && ["require", "load", "require_relative"].includes(call.method)) {
        const value = rubyLiteral(call.args[0]);
        const local = typeof value === "string" && [value, "lib/" + value, "app/" + value].some(probe =>
          this.sources.has(probe.endsWith(".rb") ? probe : probe + ".rb"));
        if (call.method === "load" || typeof value !== "string" || call.method === "require" && local
          || call.method === "require_relative" && call.receiver) result.uninspectedLoadOffset ??= statement.endIndex;
      }
      if (call?.method !== "require_relative" || call.receiver || call.block || call.args.length !== 1 || call.args[0].type !== "string") continue;
      const source = rubyLiteral(call.args[0]);
      if (typeof source !== "string" || !source || source.startsWith("/") || /^[a-z]:/i.test(source) || source.includes("\\")) continue;
      if (posix.extname(source) && !source.endsWith(".rb")) continue;
      const target = posix.join(posix.dirname(path), source.endsWith(".rb") ? source : source + ".rb");
      if (this.sources.has(target)) result.requiredFiles.push({path: target, end: statement.endIndex});
    }
    const grapeArguments = new Map<number, "route" | "grape_helper">();
    const reference = (node: RubyAstNode, nesting: string[], kind: Reference["kind"], owner?: string) => {
      const name = rubyConstant(node);
      const call = kind === "constant" ? rubyCall(node.parent) : null;
      if (name) result.references.push({
        ...(call?.receiver?.id === node.id ? {receiverCall: {method: call.method, offset: node.startIndex}} : {}),
        reference: name, nesting: [...nesting], kind, line: node.startPosition.row + 1, owner,
        ...(kind === "include" || kind === "extend" ? {mixinOffset: node.startIndex} : {}),
      });
    };
    const visit = (node: RubyAstNode, nesting: string[], owner?: Declaration, inMethod = false, conditional = false) => {
      if (["class", "module"].includes(node.type)) {
        const raw = rubyConstant(node.childForFieldName("name"));
        if (!raw) return;
        // Relative qualified declarations inside another lexical body depend on
        // prior lookup. Reject instead of synthesizing a possibly wrong scope.
        const uncertain = !raw.startsWith("::") && raw.includes("::") && nesting.length > 0;
        const name = raw.startsWith("::") ? raw.slice(2) : nesting[0] ? `${nesting[0]}::${raw}` : raw;
        const superclass = node.childForFieldName("superclass")?.namedChildren[0];
        const declaration: Declaration = {name, kind: node.type as "class" | "module", path, line: node.startPosition.row + 1, nesting: [...nesting], mixins: [], conditional: conditional || inMethod || uncertain};
        if (superclass) {
          declaration.superclass = rubyConstant(superclass) ?? "<dynamic>";
          reference(superclass, nesting, "superclass");
        }
        result.declarations.push(declaration);
        if (uncertain) this.addDiagnostic({path, code: "unsupported_declaration_scope", line: declaration.line, message: `Relative qualified declaration ${raw} inside another namespace is unsupported`});
        const body = node.childForFieldName("body");
        if (body && !declaration.conditional && declaration.superclass?.replace(/^::/, "") === "Grape::API") {
          for (const {node, kind} of grapeDependencyArguments(body)) grapeArguments.set(node.id, kind);
        }
        if (body && !declaration.conditional) declaration.methods = rubyMethodEvidence(body, declaration.kind);
        if (body && path.startsWith("app/jobs/")) declaration.performsJob = declaresJobEntryPoint(body, declaration.kind);
        if (body && declaration.kind === "class" && !superclass) {
          const statements = rubyStatements(body);
          declaration.wrapsDeclarations = statements.length > 0 && statements.every(s => s.type === "class" || s.type === "module");
        }
        if (body) visit(body, [name, ...nesting], declaration, false, conditional || uncertain);
        return;
      }
      if (["assignment", "operator_assignment"].includes(node.type)) {
        const raw = rubyConstant(node.childForFieldName("left"));
        if (raw) {
          const name = raw.startsWith("::") ? raw.slice(2) : nesting[0] ? `${nesting[0]}::${raw}` : raw;
          // The left side introduces a binding. Its initializer still reads
          // constants, even when the assigned name cannot be resolved later.
          const value = node.childForFieldName("right");
          result.declarations.push({
            name, kind: "assignment", path, line: node.startPosition.row + 1, nesting: [...nesting], mixins: [],
            conditional: conditional || inMethod,
            valueAssignment: node.type === "assignment" && value && !rubyConstant(value)
              ? (raw.includes("::") ? "qualified" : "name") : undefined,
          });
          if (value) visit(value, nesting, owner, inMethod, conditional);
          return;
        }
      }
      const call = rubyCall(node);
      if (call && !call.receiver && ["include", "extend", "prepend"].includes(call.method) && owner && !inMethod) {
        if (call.method === "prepend" || call.block || !call.args.length || call.args.some(a => !rubyConstant(a)) || conditional) {
          owner.mixins.push("<dynamic>");
          this.addDiagnostic({path, code: "unsupported_mixin", line: node.startPosition.row + 1, message: "Only unconditional literal include/extend constants are supported"});
        } else for (const arg of call.args) {
          if (call.method === "extend" && owner.kind === "module" && rubyConstant(arg)?.replace(/^::/, "") === "ActiveSupport::Concern") {
            owner.concernBase = rubyConstant(arg)!;
          }
          // Extend does not participate in instance/class constant ancestors.
          if (call.method === "include") owner.mixins.push(rubyConstant(arg)!);
          reference(arg, nesting, call.method as "include" | "extend", owner.name);
        }
        return;
      }
      if (node.type === "pair" && /(?:^|\/)app\/serializers\//.test(path)) {
        const key = rubyLiteral(node.childForFieldName("key"));
        const value = node.childForFieldName("value");
        if ((key === "serializer" || key === "each_serializer") && value && rubyConstant(value)) {
          reference(value, nesting, "serializer", owner?.name);
          return;
        }
      }
      const modelContext = /(?:^|\/)app\/models\//.test(path) && owner;
      if (call?.method === "validates" && !call.receiver && modelContext && !inMethod && !conditional && !call.block) {
        for (const option of call.args.flatMap(arg => arg.type === "hash" ? rubyStatements(arg) : [arg])) {
          if (option.type !== "pair" || rubyLiteral(option.childForFieldName("value")) !== true) continue;
          const key = rubyLiteral(option.childForFieldName("key"));
          if (typeof key !== "string" || !/^[a-z][a-z_\d]*$/.test(key)) continue;
          const validator = this.camelize(key + "_validator");
          if (validator) result.references.push({reference: validator, kind: "validator", nesting: [owner.name],
            owner: owner.name, line: option.startPosition.row + 1});
        }
      }
      if (call && !call.receiver && ASSOCIATIONS.has(call.method) && modelContext) {
        const line = node.startPosition.row + 1;
        const reject = (message: string) => this.addDiagnostic({path, code: "unsupported_association", line, message});
        const name = rubyLiteral(call.args[0]);
        const reflections = this.reflections.get(owner.name) ?? new Map<string, Reference | null>();
        this.reflections.set(owner.name, reflections);
        const unique = typeof name === "string" && !reflections.has(name);
        if (typeof name === "string") reflections.set(name, null);
        else this.dynamicReflections.add(owner.name);
        let classNameCall: Reference["classNameCall"];
        // Rails stores this lambda as the reflection scope. The model class
        // still comes from the association name or class_name option.
        const scope = call.args[1]?.type === "lambda" ? call.args[1] : undefined;
        if (scope) visit(scope, nesting, owner, true, conditional);
        const options = rubyOptions(call.args.slice(scope ? 2 : 1), (key, value) => {
          if (key === "class_name") {
            const selector = rubyCall(value);
            const receiver = rubyConstant(selector?.receiver);
            if (selector && receiver && ["name", "to_s"].includes(selector.method) && !selector.args.length
              && !selector.block && value.childForFieldName("operator")?.text === ".") {
              classNameCall = {method: selector.method, nesting: [...nesting], offset: value.startIndex};
              return receiver;
            }
          }
          return rubyLiteral(value);
        });
        if (inMethod || conditional || call.block || typeof name !== "string" || !/^[a-z][a-z_\d]*$/.test(name) || !options) {
          reject("Association must be an unconditional class/concern macro with literal name and options");
          return;
        }
        if (options.has("source_type") || options.get("polymorphic") !== undefined && options.get("polymorphic") !== false
          || options.has("anonymous_class") || options.has("source") && !options.has("through")) {
          reject("Dynamic or polymorphic association targets are unresolved");
          return;
        }
        const override = options.get("class_name");
        const collection = ["has_many", "has_and_belongs_to_many"].includes(call.method);
        const singular = collection ? this.configuration.inflections.singularize(name) : name;
        const target = override === undefined ? (options.has("through") ? name : singular && this.camelize(singular)) : typeof override === "string" && /^(?:::)?[A-Z]\w*(?:::[A-Z]\w*)*$/.test(override) ? override : null;
        if (!target) { reject("Association class name or inflection is outside the supported literal subset"); return; }
        // compute_type uses the model FQN, not the Ruby lexical nesting.
        const modelNesting: string[] = [];
        const parts = owner.name.split("::");
        while (parts.length) { modelNesting.push(parts.join("::")); parts.pop(); }
        const statement = node.text.replace(/\s+/g, " ");
        const ref: Reference = {reference: target, displayReference: classNameCall ? statement : statement + " => " + target,
          classNameCall, nesting: modelNesting,
          kind: "association", line, owner: owner.name, reflection: {name, macro: call.method, path}};
        if (options.has("through")) {
          const join = options.get("through"), source = options.get("source");
          if (owner.kind !== "class" || !["has_many", "has_one"].includes(call.method)
            || typeof join !== "string" || !/^[a-z][a-z_\d]*$/.test(join)
            || source !== undefined && (typeof source !== "string" || !/^[a-z][a-z_\d]*$/.test(source))) {
            reject("Through associations need literal reflection names on a model class");
            return;
          }
          const sourceName = source ?? this.configuration.inflections.singularize(name);
          if (!sourceName) {
            reject("Through association source name is outside the supported inflections");
            return;
          }
          const sources = source === undefined && sourceName !== name ? [sourceName, name] : [sourceName];
          ref.through = {join, sources, ...(typeof override === "string" ? {override} : {})};
          ref.displayReference = statement;
        }
        if (unique) reflections.set(name, ref);
        result.references.push(ref);
        return;
      }
      if (rubyConstant(node)) { reference(node, nesting, grapeArguments.get(node.id) ?? "constant", owner?.name); return; }
      if (node.type === "scope_resolution") {
        this.addDiagnostic({path, code: "unsupported_constant_expression", line: node.startPosition.row + 1, message: "A dynamic receiver cannot identify a constant namespace"});
        return;
      }
      if (node.type === "singleton_class") {
        this.addDiagnostic({path, code: "unsupported_lexical_scope", line: node.startPosition.row + 1, message: "Singleton class constant lookup is unsupported"});
        return;
      }
      const method = inMethod || ["method", "singleton_method", "lambda"].includes(node.type);
      // Concern included/class_methods blocks have the concern lexical scope;
      // do not attribute their associations to each host model.
      const unsupportedBlock = (node.type === "block" || node.type === "do_block") && !(rubyCall(node.parent)?.method === "included" && owner?.kind === "module");
      for (const child of rubyStatements(node)) {
        // Ruby permits a capitalized method selector (receiver.User). That AST
        // node is a method name, not a constant expression.
        if (call && child.id === node.childForFieldName("method")?.id) continue;
        if (["method", "singleton_method"].includes(node.type) && child.id === node.childForFieldName("name")?.id) continue;
        visit(child, nesting, owner, method, conditional || CONDITIONAL.has(node.type) || unsupportedBlock);
      }
    };
    visit(root, []);
    return result;
  }

  private buildIndex(classicRails: boolean): void {
    const roots = [...new Map(this.configuration.roots.map(r => [r.path, r])).values()].sort((a,b) => b.path.length - a.path.length || compare(a.path,b.path));
    const expectedOwners = new Map<string, string[]>();
    const classicNames = new Map<string, Set<string>>();
    if (classicRails) {
      for (const [path, {declarations}] of this.facts) {
        if (!path.endsWith(".rb") || !declarations.length) continue;
        const features = roots.filter(root => path.startsWith(root.path + "/")).map(root => path.slice(root.path.length + 1, -3));
        for (const declaration of declarations) {
          if (declaration.conditional) continue;
          const feature = this.configuration.inflections.underscore(declaration.name);
          if (!features.includes(feature)) continue;
          if (!classicNames.has(feature)) classicNames.set(feature, new Set());
          classicNames.get(feature)!.add(declaration.name);
        }
      }
    }
    const classWrappers = new Set<Declaration>();
    const valueCandidates = new Set<Declaration>();
    for (const [path, facts] of this.facts) {
      const matchingRoots = roots.filter(r => path.startsWith(r.path + "/"));
      const ignored = this.configuration.ignored.some(p => path === p || path.startsWith(p + "/") || path === p + ".rb");
      const initializer = this.initializerPaths.has(path);
      if (!path.endsWith(".rb") || (!matchingRoots.length && !initializer) || ignored) {
        // A spec or task may define test doubles and local aliases. They
        // participate in lookup in this file, even though Rails cannot
        // autoload them for consumers in another file.
        if (facts.declarations.length) {
          const declarations = new Map<string, Declaration[]>();
          for (const d of facts.declarations) declarations.set(d.name, [...(declarations.get(d.name) ?? []), d]);
          this.consumerDeclarations.set(path, declarations);
        }
        continue;
      }
      // Classic searches each root independently, while Zeitwerk gives a
      // nested root its own top-level namespace. A path alone never creates a
      // file binding, but a competing path can still intercept the lookup.
      const eligibleRoots = classicRails ? matchingRoots : matchingRoots.slice(0, 1);
      const expected = [...new Set(eligibleRoots.flatMap(root => {
        const feature = path.slice(root.path.length + 1, -3);
        const conventional = this.configuration.inflections.camelize(feature, true);
        return conventional ? [conventional, ...(classicNames.get(feature) ?? [])] : [];
      }))];
      for (const name of expected) expectedOwners.set(name, [...(expectedOwners.get(name) ?? []), path]);
      const corroborated = expected.filter(name => facts.declarations.some(d => d.name === name && (d.kind !== "assignment" || d.valueAssignment) && !d.conditional));
      if (matchingRoots.length && !corroborated.length) this.addDiagnostic({
        path, code: "unsupported_constant_mapping",
        message: `Autoload path expects ${expected.join(" or ") || "an unsupported constant name"}; no matching unconditional declaration`,
      });
      const namespaceTargets = corroborated.length ? corroborated : expected;
      for (const declaration of facts.declarations) {
        // Namespace wrappers in a nested file are not additional autoload
        // targets or independent reopenings of the namespace's own file.
        const direct = corroborated.includes(declaration.name);
        const wrapper = !direct && namespaceTargets.some(name => name.startsWith(declaration.name + "::"));
        if (wrapper && declaration.kind === "module" && !declaration.conditional) continue;
        if (wrapper && declaration.wrapsDeclarations) classWrappers.add(declaration);
        const nested = corroborated.some(name => declaration.name.startsWith(name + "::"));
        // A namespace-qualified assignment must also match the file's autoload spelling.
        if (!declaration.conditional && declaration.valueAssignment
          && (direct || (declaration.valueAssignment === "name" && (initializer || nested)))) {
          valueCandidates.add(declaration);
        }
        const list = this.declarations.get(declaration.name) ?? [];
        list.push(declaration);
        this.declarations.set(declaration.name, list);
        // Loading the expected constant also defines its nested constants.
        // An unrelated sibling declaration is not independently autoloadable
        // merely because it happens to share that source file.
        if ((direct || nested)
          && !declaration.conditional && declaration.kind !== "assignment") {
          const paths = this.bindings.get(declaration.name) ?? new Set<string>();
          paths.add(path);
          this.bindings.set(declaration.name, paths);
        }
        const parts = declaration.name.split("::");
        while (parts.length) { this.namespaces.add(parts.join("::")); parts.pop(); }
      }
      for (const name of expected) {
        const parts = name.split("::");
        while (parts.length) { this.namespaces.add(parts.join("::")); parts.pop(); }
      }
    }
    for (const [name, paths] of expectedOwners) if (paths.length > 1) {
      this.blocked.add(name);
      this.addDiagnostic({path:null, code:"ambiguous_autoload_root", message:`Multiple roots map ${name}: ${paths.sort(compare).join(", ")}; loader precedence is unknown`});
    }
    for (const [name, definitions] of this.declarations) {
      const definition = definitions[0];
      const owners = expectedOwners.get(name);
      if (definitions.length === 1 && valueCandidates.has(definition)
        && (!owners || (owners.length === 1 && owners[0] === definition.path))) {
        this.valueBindings.set(name, definition.path);
        this.blocked.add(name); // The assignment identifies the file, independently of its runtime value or type.
        continue;
      }
      // Rails has already defined ActiveRecord::Base when initializers run.
      // Class bodies without a superclass reopen that same object, including
      // guarded patches. Keep their children and mixins in the ancestor index.
      if (name === "ActiveRecord::Base" && !owners && definitions.every(d =>
        d.kind === "class" && !d.superclass && this.initializerPaths.has(d.path))) continue;
      // A child file can open its parent class just to declare the nested
      // class/module. Keep the canonical class's superclass and model identity.
      if (this.bindings.has(name) && definitions.length > 1 && definitions.every(d => d.kind === "class" && !d.conditional)) {
        const owners = definitions.filter(d => !classWrappers.has(d));
        if (owners.length === 1) {
          this.declarations.set(name, owners);
          continue;
        }
      }
      // Once a module exists unconditionally, an optional reopening cannot
      // replace it. Its children retain their own conditional/shadowing checks.
      const namespaceReopenings = definitions.every(d => d.kind === "module") && definitions.some(d => !d.conditional);
      for (const def of definitions) {
        if (def.kind === "assignment" || (def.conditional && !namespaceReopenings)) {
          this.blocked.add(name);
          this.addDiagnostic({path: def.path, code: def.kind === "assignment" ? "unsupported_constant_assignment" : "unsupported_conditional_declaration", line: def.line, message: `Constant ${name} may shadow or replace a declaration`});
        }
      }
      if (!namespaceReopenings && definitions.filter(d => d.kind !== "assignment").length > 1) {
        this.blocked.add(name);
        this.addDiagnostic({path: null, code: "ambiguous_constant", message: `Multiple declarations of ${name}: ${definitions.map(d => `${d.path}:${d.line}`).sort(compare).join(", ")}`});
      }
    }
  }

  private blockedPrefix(name: string): boolean {
    const parts = name.split("::");
    while (parts.length) { if (this.blocked.has(parts.join("::"))) return true; parts.pop(); }
    return false;
  }

  /** A preceding literal load can supply a top-level module to this consumer
   * even when Rails cannot autoload it. Keep unindexed side effects and
   * competing definitions out of this narrowly scoped lookup. */
  private requiredMixin(reference: string, options: RubyResolveOptions, locals?: Map<string, Declaration[]>):
    {declaration?: Declaration; locals?: Map<string, Declaration[]>} | null | undefined {
    const name = reference.replace(/^::/, "");
    const offset = options.mixinOffset;
    if (!options.mixin || offset === undefined || !options.path) return;
    const requires = this.facts.get(options.path)?.requiredFiles ?? [];
    if (!requires.length) return;
    const paths = new Set(requires.filter(load => load.end <= offset).map(load => load.path));
    const loaded = [...paths].flatMap(path => this.facts.get(path)?.declarations ?? []);
    // For a qualified module, the autoload index supplies the target. Other
    // declarations from the explicit loads still participate in shadow checks.
    if (name.includes("::")) return {locals: this.localsWithLoads(locals, loaded)};
    const matching = loaded.filter(d => d.name === name);
    if (!matching.length) return;
    const declaration = matching.find(d => d.kind === "module" && !d.conditional && !d.nesting.length);
    if (!declaration || matching.some(d => d.kind !== "module" || d.path !== declaration.path)) return null;
    const canonical = this.bindings.get(name)?.has(declaration.path);
    if (!canonical && matching.length !== 1) return null;
    if (this.declarations.get(name)?.some(d => d.kind !== "module" || (!canonical && d.path !== declaration.path))) return null;
    // Other explicitly loaded files can introduce a lexical shadow or reopen
    // an ancestor, even outside the autoload roots. Keep their evidence local.
    return {declaration, locals: this.localsWithLoads(locals, loaded.filter(d => d.name !== name))};
  }

  private localsWithLoads(locals: Map<string, Declaration[]> | undefined, loaded: Declaration[]) {
    const extra = loaded.filter(d => !this.declarations.get(d.name)?.includes(d));
    if (!extra.length) return locals;
    const result = new Map(locals);
    for (const d of extra) result.set(d.name, [...(result.get(d.name) ?? []), d]);
    return result;
  }

  private exact(name: string, options: RubyResolveOptions, required?: Declaration,
    locals = options.path ? this.consumerDeclarations.get(options.path) : undefined): ConstantMatch | null {
    if (locals) {
      let prefix = name;
      while (prefix) {
        const local = locals.get(prefix);
        if (local) {
          // An unconditional namespace reopening still exposes its existing
          // children. A local assignment, test double or conflicting kind
          // can change what a qualified read refers to.
          const providers = this.declarations.get(prefix);
          const knownKind = providers?.[0]?.kind ?? (this.namespaces.has(prefix) ? "module" : undefined);
          if (prefix === name || local.some(d => d.conditional || d.kind === "assignment" || d.kind !== knownKind)) return null;
        }
        const separator = prefix.lastIndexOf("::");
        if (separator < 0) break;
        prefix = prefix.slice(0, separator);
      }
    }
    if (options.valueRead && this.valueBindings.has(name)) {
      const separator = name.lastIndexOf("::");
      if (separator < 0 || !this.blockedPrefix(name.slice(0, separator))) return {target: this.valueBindings.get(name)!};
    }
    if (this.blockedPrefix(name)) {
      this.addDiagnostic({path: options.path ?? null, code: "ambiguous_constant_reference", message: `Constant ${name} has shadowing or multiple-definition evidence`, ...(options.line ? {line:options.line} : {})});
      return null;
    }
    const targets = this.bindings.get(name);
    if (targets?.size) return targets.size === 1 ? {target: [...targets][0]} : null;
    return required?.name === name ? {target: required.path} : null;
  }

  /** A scheduler target needs one declared job and an explicit singleton perform. */
  resolveScheduledJob(name: string): string | null {
    if (this.inferenceBlocked || this.blockedPrefix(name)) return null;
    const declarations = this.declarations.get(name);
    if (declarations?.length !== 1) return null;
    const job = declarations[0];
    return job.performsJob && !job.conditional ? job.path : null;
  }

  /** Returns a file endpoint only. A known namespace with a missing child
   * stops relative lookup; there is no globally-unique-basename fallback. */
  resolveConstant(reference: string, options: RubyResolveOptions = {}): string | null {
    return this.lookupConstant(reference, options, "strict")?.target ?? null;
  }

  /** Corroborate an uncertain receiver using the uniquely named local class
   * or module, after checking loads and other ancestors for shadows. */
  private inferredReceiver(reference: string, options: RubyResolveOptions): ConstantMatch | null {
    const call = options.receiverCall, scope = options.nesting?.[0];
    if (!scope || !call || !options.path || DEVISE_NAMESPACE.test(reference)) return null;
    const definitions = this.declarations.get(reference);
    if (definitions?.length !== 1) return null;
    const definition = definitions[0];
    const target = definition.path;
    if (!definition.methods?.publicSingleton?.has(call.method)) {
      if (definition.kind !== "class") return null;
      const constructor = call.method === "new" && definition.methods?.declaresInitializer;
      const modelMethod = options.macroTarget === "associationClassName" || ACTIVE_RECORD_CLASS_METHODS.has(call.method);
      if (!constructor && !(modelMethod && /(?:^|\/)app\/models\//.test(target) && this.modelOwner(reference, target, new Set()))) return null;
      if (this.overridesClassMethod(reference, call.method)) return null;
    }
    if (target === options.path || !this.bindings.get(reference)?.has(target)) return null;

    const first = reference.split("::")[0];
    const facts = this.facts.get(options.path);
    if (facts?.uninspectedLoadOffset !== undefined && facts.uninspectedLoadOffset <= call.offset) return null;
    const loaded = (facts?.requiredFiles ?? [])
      .filter(load => load.end <= call.offset).flatMap(load => this.facts.get(load.path)?.declarations ?? []);
    const locals = this.localsWithLoads(this.consumerDeclarations.get(options.path), loaded);
    if (options.nesting?.some(name => locals?.has(name + "::" + first))
      || this.exact(reference, options, undefined, locals)?.target !== target) return null;
    // The original lookup can stop at its first unknown ancestor. Inspect
    // the other branches for a matching inherited constant before inferring.
    const uninspected = new Set<string>();
    if (this.ancestorLookup(scope, first, new Set(), locals, uninspected) !== "unknown" || !uninspected.size
      || [...uninspected].some(base => base === "<dynamic>" || DEVISE_NAMESPACE.test(base))) return null;
    return {target, resolution: "inferred"};
  }

  private lookupConstant(reference: string, options: RubyResolveOptions, mixinResolution: RubyMixinResolution): ConstantMatch | null {
    if (!this.isRails || this.inferenceBlocked || !/^(?:::)?[A-Z]\w*(?:::[A-Z]\w*)*$/.test(reference)) return null;
    let locals = options.path ? this.consumerDeclarations.get(options.path) : undefined;
    if (reference.startsWith("::")) {
      const required = this.requiredMixin(reference, options, locals);
      if (required === null) return null;
      const match = this.exact(reference.slice(2), options, required?.declaration, required?.locals);
      return options.association && match && !/(?:^|\/)app\/models\//.test(match.target) ? null : match;
    }
    const nesting = options.nesting ?? [];
    if (options.association) {
      // ActiveRecord tries the complete compute_type candidate at each level;
      // this differs from lexical first-component lookup.
      for (const scope of [...nesting, ""]) {
        const name = scope ? `${scope}::${reference}` : reference;
        if (this.blockedPrefix(name)) return this.exact(name, options);
        const match = this.exact(name, options);
        if (match && /(?:^|\/)app\/models\//.test(match.target)) return match;
      }
      return null;
    }
    const first = reference.split("::")[0];
    for (const scope of nesting) {
      const name = `${scope}::${reference}`;
      const candidate = `${scope}::${first}`;
      if (locals?.has(candidate) || this.namespaces.has(candidate) || this.blockedPrefix(candidate)) return this.exact(name, options);
    }
    const required = this.requiredMixin(reference, options, locals);
    if (required === null) return null;
    if (required?.locals) {
      locals = required.locals;
      if (nesting.some(scope => locals?.has(`${scope}::${first}`))) return null;
    }
    // A qualified mixin may have a unique top-level spelling. Check every
    // ancestor branch for local shadows before using that spelling.
    const providers = options.mixin ? this.declarations.get(reference) : undefined;
    const concern = providers?.length === 1 && providers[0].concernBase
      && this.lexicalName(providers[0].concernBase, [reference, ...providers[0].nesting]) === "ActiveSupport::Concern"
      && !this.declarations.has("ActiveSupport::Concern") && !this.blockedPrefix("ActiveSupport::Concern");
    const inferredMixin = !!options.mixin && (reference.includes("::") || concern);
    const uninspected = inferredMixin || options.macroTarget ? new Set<string>() : undefined;
    const ancestry = nesting[0] ? this.ancestorLookup(nesting[0], first, new Set(), locals, uninspected, required?.declaration) : "clear";
    if (ancestry !== "clear") {
      if (ancestry === "unknown" && options.receiverCall && mixinResolution === "pragmatic") {
        const candidate = this.inferredReceiver(reference, options);
        if (candidate) return candidate;
      }
      // A Grape mount supplies endpoint evidence even when the framework
      // superclass is external. The caller verifies both endpoint classes.
      if (ancestry === "unknown" && options.macroTarget === "grape" && mixinResolution === "pragmatic"
        && uninspected?.size && [...uninspected].every(base => base === "Grape::API")) {
        const candidate = this.exact(reference, options, undefined, locals);
        if (candidate) return {...candidate, resolution: "inferred"};
      }
      // Literal serializers still name a Ruby constant. When the sole unknown
      // base is the gem serializer, keep the unique local candidate as inferred.
      if (ancestry === "unknown" && (options.macroTarget === "serializer" || options.macroTarget === "validator") && uninspected?.size
        && [...uninspected].every(base => options.macroTarget === "serializer"
          ? base === "ActiveModel::Serializer" : base !== "<dynamic>" && !DEVISE_NAMESPACE.test(base))) {
        const candidate = this.exact(reference, options);
        if (candidate && (options.macroTarget === "validator" || /(?:^|\/)app\/serializers\//.test(candidate.target))) {
          return {...candidate, resolution: "inferred"};
        }
      }
      // A literal qualified mixin can still identify a file worth inspecting.
      // An inherited first component or an ambiguous provider rules that out.
      const candidateTarget = ancestry === "unknown" && inferredMixin
        && !this.blockedPrefix(reference) && this.declarations.get(reference)?.every(d => d.kind === "module")
        ? this.exact(reference, options, undefined, locals)?.target : undefined;
      if (candidateTarget && candidateTarget !== options.path && mixinResolution === "pragmatic" && uninspected
        && [...uninspected].every(base => base !== "<dynamic>" && !DEVISE_NAMESPACE.test(base))) {
        return {target: candidateTarget, resolution: "inferred"};
      }
      this.addDiagnostic({
        path: options.path ?? null, code: "unsupported_ancestor_lookup",
        message: `Ancestor constant lookup for ${reference} in ${nesting[0]} is unresolved`,
        ...(options.line ? {line: options.line} : {}),
        ...(candidateTarget && candidateTarget !== options.path ? {candidateTarget} : {}),
      });
      return null;
    }
    return this.exact(reference, options, required?.declaration, locals);
  }

  private ancestorLookup(
    name: string, first: string, seen: Set<string>, locals: Map<string, Declaration[]> | undefined, uninspected?: Set<string>,
    required?: Declaration,
  ): "clear" | "unknown" | "shadowed" {
    if (seen.has(name) || this.blockedPrefix(name)) return "shadowed";
    seen.add(name);
    const defs = [...(this.declarations.get(name) ?? (required?.name === name ? [required] : [])), ...(locals?.get(name) ?? [])];
    let result: "clear" | "unknown" = "clear";
    for (const def of defs) {
      const bases = [
        ...def.mixins.map(base => ({base, nesting:[def.name, ...def.nesting]})),
        ...(def.superclass ? [{base:def.superclass,nesting:def.nesting}] : []),
      ];
      for (const {base, nesting} of bases) {
        const resolved = this.lexicalName(base, nesting, locals);
        if (this.blockedPrefix(resolved)) return "shadowed";
        // Only a matching first component can shadow this particular lookup.
        if (this.namespaces.has(`${resolved}::${first}`) || locals?.has(`${resolved}::${first}`)) return "shadowed";
        if (locals?.has(resolved)) return "shadowed";
        // Inspect local reopenings before trusting a well-known framework base.
        // A locally autoloaded lookalike is not evidence of framework identity.
        if ((FRAMEWORK_BASES.has(resolved) || resolved === "ActiveSupport::Concern") && !this.bindings.has(resolved) && !this.declarations.has(resolved)) continue;
        // Initializers may reopen an external Devise class or module. Inspect
        // its visible declarations, while preserving the unknown gem ancestry.
        if (uninspected && DEVISE_NAMESPACE.test(resolved) && !this.bindings.has(resolved)) {
          uninspected.add(resolved);
          result = "unknown";
        }
        const hasDefinition = this.declarations.has(resolved) || required?.name === resolved;
        if (!hasDefinition) uninspected?.add(resolved);
        const inherited = hasDefinition
          ? this.ancestorLookup(resolved, first, new Set(seen), locals, uninspected, required) : "unknown";
        if (inherited !== "clear") {
          if (!uninspected || inherited === "shadowed") return inherited;
          result = "unknown";
        }
      }
    }
    return result;
  }

  private lexicalName(reference: string, nesting: string[], locals?: Map<string, Declaration[]>): string {
    if (reference.startsWith("::")) return reference.slice(2);
    const first = reference.split("::")[0];
    for (const scope of nesting) {
      const prefix = `${scope}::${first}`;
      if (locals?.has(prefix) || this.namespaces.has(prefix) || this.blockedPrefix(prefix)) return `${scope}::${reference}`;
    }
    return reference;
  }

  /** A reflection from a parent class or included concern can change either
   * half of the chain. Only follow reflections declared on the two classes. */
  private inheritedReflection(owner: string, name: string, seen = new Set<string>()): boolean {
    if (seen.has(owner)) return false;
    seen.add(owner);
    for (const def of this.declarations.get(owner) ?? []) {
      const parents = def.mixins.map(base => this.lexicalName(base, [owner, ...def.nesting]));
      if (def.superclass) parents.push(this.lexicalName(def.superclass, def.nesting));
      for (const parent of parents) {
        if (parent === "<dynamic>" || this.dynamicReflections.has(parent) || this.reflections.get(parent)?.has(name)
          || this.inheritedReflection(parent, name, seen)) return true;
      }
    }
    return false;
  }

  private uniqueModelAt(path: string): string | null {
    const models = this.facts.get(path)?.declarations.filter(d => d.kind === "class"
      && this.bindings.get(d.name)?.has(path) && this.modelOwner(d.name, path, new Set()));
    return models?.length === 1 ? models[0].name : null;
  }

  /** Ruby evaluates the receiver lexically before Rails applies compute_type
   * to its fully qualified name, which has no leading ::. */
  private associationClassName(ref: Reference): string | null {
    if (!ref.classNameCall) return ref.reference;
    const {method, nesting} = ref.classNameCall;
    const path = ref.reflection!.path;
    const name = this.lexicalName(ref.reference, nesting, this.consumerDeclarations.get(path));
    const declarations = this.declarations.get(name);
    if (declarations?.length !== 1 || declarations[0].kind !== "class" || this.overridesClassMethod(name, method)) return null;
    const target = this.lookupConstant(ref.reference, {nesting, path, line: ref.line,
      macroTarget: "associationClassName", receiverCall: {method, offset: ref.classNameCall.offset}}, this.mixinResolution)?.target;
    return target === declarations[0].path && this.bindings.get(name)?.has(target) ? name : null;
  }

  private overridesClassMethod(name: string, method: string, seen = new Set<string>()): boolean {
    if (seen.has(name) || this.blockedPrefix(name)) return true;
    seen.add(name);
    return (this.declarations.get(name) ?? []).some(d =>
      d.methods?.publicSingleton?.has(method) || d.methods?.unavailableSingleton === "unknown" || d.methods?.unavailableSingleton?.has(method)
      || method === "new" && d.mixins.some(m => m.replace(/^::/, "") === "Singleton")
      || !!d.superclass && this.overridesClassMethod(this.lexicalName(d.superclass, d.nesting), method, new Set(seen)));
  }

  private throughTarget(ref: Reference): string | null {
    const {owner, reflection, through} = ref;
    if (!owner || !reflection || !through || this.dynamicReflections.has(owner)) return null;
    const own = this.reflections.get(owner);
    if (own?.get(reflection.name) !== ref || this.inheritedReflection(owner, reflection.name)
      || this.inheritedReflection(owner, through.join)) return null;
    const join = own.get(through.join);
    if (!join?.reflection || join.through || reflection.macro === "has_one" && !["belongs_to", "has_one"].includes(join.reflection.macro)) return null;
    const resolve = (reference: string | null, r: Reference, path: string) => reference && this.lookupConstant(reference, {
      association: true, nesting: r.nesting, line: r.line, path,
    }, "strict")?.target;
    const joinPath = resolve(this.associationClassName(join), join, join.reflection.path);
    if (!joinPath || joinPath === reflection.path) return null;
    const joinOwner = this.uniqueModelAt(joinPath);
    if (!joinOwner || this.dynamicReflections.has(joinOwner) || through.sources.some(name => this.inheritedReflection(joinOwner, name))) return null;
    const available = this.reflections.get(joinOwner);
    const names = through.sources.filter(name => available?.has(name));
    const source = names.length === 1 && available?.get(names[0]);
    if (!source || source.through || !source.reflection || source.reflection.path !== joinPath) return null;
    const sourceName = this.associationClassName(source);
    const endpoint = resolve(sourceName, source, joinPath);
    // The through reflection computes its class from the outer model. Require
    // the same file as the source reflection even when namespaces differ.
    const outerName = through.override ? this.associationClassName(ref) : sourceName;
    return endpoint && this.uniqueModelAt(endpoint) && resolve(outerName, ref, reflection.path) === endpoint ? endpoint : null;
  }

  private grapeEndpoint(name: string, path?: string): boolean {
    const declarations = this.declarations.get(name);
    if (declarations?.length !== 1 || this.blockedPrefix(name)) return false;
    const endpoint = declarations[0];
    return (!path || endpoint.path === path) && !!this.bindings.get(name)?.has(endpoint.path) && endpoint.kind === "class" && !!endpoint.superclass
      && this.lexicalName(endpoint.superclass, endpoint.nesting) === "Grape::API"
      && !this.declarations.has("Grape::API") && !this.blockedPrefix("Grape::API");
  }

  getDependencies(path: string): DependencyFact[] {
    const cached = this.dependencyCache.get(path);
    if (cached) return cached;
    const found: DependencyFact[] = this.inferenceBlocked ? [] : this.specRegistry.dependencies(path, this.applicationRootKnown);
    for (const ref of this.facts.get(path)?.references ?? []) {
      if (ref.kind === "route" || ref.kind === "grape_helper") {
        const name = this.lexicalName(ref.reference, ref.nesting, this.consumerDeclarations.get(path));
        const corroborated = ref.owner && this.grapeEndpoint(ref.owner, path) && (ref.kind === "route"
          ? this.grapeEndpoint(name) : this.declarations.get(name)?.every(d => d.kind === "module"));
        const match = this.lookupConstant(ref.reference, {path, line: ref.line, nesting: ref.nesting,
          valueRead: true, macroTarget: corroborated ? "grape" : undefined}, this.mixinResolution);
        if (!match || match.target === path) continue;
        if (corroborated) found.push({...match, kind: ref.kind, type: ref.kind === "route" ? "routes" : "depends_on",
          reference: (ref.kind === "route" ? "mount " : "helpers ") + ref.reference, line: ref.line});
        // Keep ordinary lexical facts as well. An inferred DSL match already
        // accounts for the reference across the uninspected framework ancestor.
        if (!match.resolution) found.push({...match, kind: "constant", type: "depends_on", reference: ref.reference, line: ref.line});
        continue;
      }
      if (ref.kind === "validator") {
        // Built-in validation options do not imply a project dependency.
        const name = this.lexicalName(ref.reference, ref.nesting);
        const defs = this.declarations.get(name);
        if (defs?.length !== 1 || defs[0].kind !== "class" || !defs[0].superclass) continue;
        const base = this.lexicalName(defs[0].superclass, defs[0].nesting);
        if (!["ActiveModel::Validator", "ActiveModel::EachValidator"].includes(base) || this.bindings.has(base)
          || !ref.owner || !this.modelOwner(ref.owner, path, new Set())) continue;
      }
      if (ref.kind === "association" && ref.owner && !this.modelOwner(ref.owner, path, new Set())) {
        this.addDiagnostic({path, code:"unsupported_association_context", line:ref.line, message:`Association owner ${ref.owner} is not a known ActiveRecord model or model concern`});
        continue;
      }
      if (ref.through) {
        const target = this.throughTarget(ref);
        if (!target) this.addDiagnostic({path, code: "unsupported_association", line: ref.line,
          message: "Through association lacks two unique, local direct model reflections"});
        else if (target !== path) found.push({target, type: "depends_on", kind: "association", line: ref.line,
          reference: ref.displayReference, resolution: "inferred"});
        continue;
      }
      const name = this.associationClassName(ref);
      if (!name) continue;
      const match = this.lookupConstant(name, {
        nesting: ref.nesting, path, line: ref.line, association: ref.kind === "association",
        macroTarget: ref.kind === "serializer" || ref.kind === "validator" ? ref.kind : undefined,
        valueRead: ref.kind === "constant", receiverCall: ref.receiverCall, mixin: ref.kind === "include" || ref.kind === "extend", mixinOffset: ref.mixinOffset,
      }, this.mixinResolution);
      if (!match || match.target === path) continue;
      const display = match.resolution && ref.receiverCall ? ref.reference + "." + ref.receiverCall.method : ref.displayReference ?? ref.reference;
      found.push({...match, ...(ref.classNameCall ? {resolution: "inferred" as const} : {}),
        type:ref.kind === "superclass" ? "inherits" : "depends_on", kind:ref.kind, reference:display, line:ref.line});
    }
    const unique = [...new Map(found.map(f => [JSON.stringify(f),f])).values()].sort((a,b) => compare(a.target,b.target) || compare(a.type,b.type) || compare(a.kind,b.kind) || compare(a.reference ?? "",b.reference ?? "") || (a.line ?? 0) - (b.line ?? 0));
    this.dependencyCache.set(path, unique);
    return unique;
  }

  private modelOwner(name: string, path: string, seen: Set<string>): boolean {
    if (seen.has(name) || this.blockedPrefix(name)) return false;
    seen.add(name);
    const declarations = this.declarations.get(name) ?? [];
    if (declarations.length !== 1) return false;
    const declaration = declarations[0];
    if (declaration.kind === "module") return /(?:^|\/)app\/models\/concerns\//.test(path);
    const base = declaration.superclass;
    if (!base) return false;
    const parent = this.lexicalName(base, declaration.nesting);
    if (this.blockedPrefix(parent)) return false;
    if (parent === "ActiveRecord::Base" && !this.bindings.has(parent)) return true;
    return this.declarations.has(parent) && this.modelOwner(parent, path, seen);
  }
}

export function createRubyDependencyResolver(options: RubyDependencyResolverOptions): RubyDependencyResolver {
  return new RubyDependencyResolver(options);
}
