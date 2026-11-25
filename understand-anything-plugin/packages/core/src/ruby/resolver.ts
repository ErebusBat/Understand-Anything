import { readFileSync, realpathSync } from "node:fs";
import { isAbsolute, posix, relative, resolve, sep } from "node:path";
import type { TreeSitterPlugin } from "../plugins/tree-sitter-plugin.js";
import { rubyCall, rubyConstant, rubyLiteral, rubyOptions, rubyStatements, walkRuby, type RubyAstNode } from "./ast.js";
import { classicRailsMajor, detectRailsApplication, initialRubyConfiguration, readRubyConfiguration, type RubyConfiguration } from "./config.js";
import type { DependencyDiagnostic, DependencyFact, RubyDependencyFailure, RubyInventoryFile } from "./types.js";

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
  literalValue?: boolean;
}
interface Reference {
  reference: string;
  displayReference?: string;
  nesting: string[];
  kind: DependencyFact["kind"];
  line: number;
  owner?: string;
  mixinOffset?: number;
}
interface RubyFileFacts {
  declarations: Declaration[];
  references: Reference[];
  requiredFiles: {path: string; end: number}[];
}

export interface RubyResolveOptions {
  nesting?: string[];
  path?: string;
  line?: number;
  association?: boolean;
  valueRead?: boolean;
  mixin?: boolean;
  mixinOffset?: number;
}

const ASSOCIATIONS = new Set(["belongs_to", "has_one", "has_many", "has_and_belongs_to_many"]);
const CONDITIONAL = new Set(["if", "unless", "if_modifier", "unless_modifier", "case", "case_match", "conditional", "while", "until", "while_modifier", "until_modifier", "for", "rescue", "rescue_modifier", "ensure", "begin"]);
const FRAMEWORK_BASES = new Set(["ActiveRecord::Base", "ActionController::Base", "ActionController::API", "ActionMailer::Base", "ActiveJob::Base", "Object", "BasicObject"]);

function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function compare(a: string, b: string): number { return a < b ? -1 : a > b ? 1 : 0; }

function assignsLiteral(node: RubyAstNode | null): boolean {
  const call = rubyCall(node);
  const value = call?.method === "freeze" && !call.block && !call.args.length ? call.receiver : node;
  return !!value && (["array", "hash", "float", "regex"].includes(value.type) || rubyLiteral(value) !== undefined);
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
  readonly configuration: RubyConfiguration;
  private readonly facts = new Map<string, RubyFileFacts>();
  private readonly bindings = new Map<string, Set<string>>();
  private readonly literalBindings = new Map<string, string>();
  private readonly declarations = new Map<string, Declaration[]>();
  private readonly consumerDeclarations = new Map<string, Map<string, Declaration[]>>();
  private readonly namespaces = new Set<string>();
  private readonly blocked = new Set<string>();
  private readonly dependencyCache = new Map<string, DependencyFact[]>();
  private readonly diagnosticKeys = new Set<string>();
  private readonly initializerPaths = new Set<string>();
  private indexIncomplete = false;

  constructor(options: { projectRoot: string; files: RubyInventoryFile[]; plugin: TreeSitterPlugin }) {
    const {projectRoot, plugin} = options;
    const paths = [...new Set(options.files.filter(f => f.path.endsWith(".rb") || f.language === "ruby").map(f => f.path))].sort(compare);
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
    this.isRails = [...trees.values()].some(t => t.application || t.engines);
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
          projectRoot, applicationRootKnown:[...trees.values()].some(t => t.application), engineRoot:engineRoots.get(path),
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
      if (call?.method !== "require_relative" || call.receiver || call.block || call.args.length !== 1 || call.args[0].type !== "string") continue;
      const source = rubyLiteral(call.args[0]);
      if (typeof source !== "string" || !source || source.startsWith("/") || /^[a-z]:/i.test(source) || source.includes("\\")) continue;
      if (posix.extname(source) && !source.endsWith(".rb")) continue;
      const target = posix.join(posix.dirname(path), source.endsWith(".rb") ? source : source + ".rb");
      if (this.sources.has(target)) result.requiredFiles.push({path: target, end: statement.endIndex});
    }
    const reference = (node: RubyAstNode, nesting: string[], kind: Reference["kind"], owner?: string) => {
      const name = rubyConstant(node);
      if (name) result.references.push({
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
            literalValue: node.type === "assignment" && !raw.includes("::") && assignsLiteral(value),
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
          // Extend does not participate in instance/class constant ancestors.
          if (call.method === "include") owner.mixins.push(rubyConstant(arg)!);
          reference(arg, nesting, call.method as "include" | "extend", owner.name);
        }
        return;
      }
      if (call && !call.receiver && ASSOCIATIONS.has(call.method)) {
        const modelContext = /(?:^|\/)app\/models\//.test(path) && owner;
        if (!modelContext) return;
        const line = node.startPosition.row + 1;
        const reject = (message: string) => this.addDiagnostic({path, code: "unsupported_association", line, message});
        const name = rubyLiteral(call.args[0]);
        const options = rubyOptions(call.args.slice(1));
        if (inMethod || conditional || call.block || typeof name !== "string" || !/^[a-z][a-z_\d]*$/.test(name) || !options) {
          reject("Association must be an unconditional class/concern macro with literal name and options");
          return;
        }
        if (options.has("through") || options.has("source") || options.has("source_type") || options.get("polymorphic") !== undefined && options.get("polymorphic") !== false) {
          reject("Through, source, and polymorphic association targets are unresolved");
          return;
        }
        const override = options.get("class_name");
        const collection = ["has_many", "has_and_belongs_to_many"].includes(call.method);
        const singular = collection ? this.configuration.inflections.singularize(name) : name;
        const target = override === undefined ? singular && this.camelize(singular) : typeof override === "string" && /^(?:::)?[A-Z]\w*(?:::[A-Z]\w*)*$/.test(override) ? override : null;
        if (!target) { reject("Association class name or inflection is outside the supported literal subset"); return; }
        // compute_type uses the model FQN, not the Ruby lexical nesting.
        const modelNesting: string[] = [];
        const parts = owner.name.split("::");
        while (parts.length) { modelNesting.push(parts.join("::")); parts.pop(); }
        result.references.push({reference: target, displayReference: `${node.text.replace(/\s+/g, " ")} => ${target}`, nesting: modelNesting, kind: "association", line, owner: owner.name});
        return;
      }
      if (rubyConstant(node)) { reference(node, nesting, "constant", owner?.name); return; }
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
    const classWrappers = new Set<Declaration>();
    const literalCandidates = new Set<Declaration>();
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
      const expected = [...new Set(eligibleRoots
        .map(root => this.configuration.inflections.camelize(path.slice(root.path.length + 1, -3), true))
        .filter(name => name !== null))];
      for (const name of expected) expectedOwners.set(name, [...(expectedOwners.get(name) ?? []), path]);
      const corroborated = expected.filter(name => facts.declarations.some(d => d.name === name && d.kind !== "assignment" && !d.conditional));
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
        if (declaration.literalValue && !declaration.conditional && (initializer || nested)) {
          literalCandidates.add(declaration);
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
      if (definitions.length === 1 && literalCandidates.has(definition) && !expectedOwners.has(name)) {
        this.literalBindings.set(name, definition.path);
        this.blocked.add(name); // A literal cannot supply a class, module or child namespace.
        continue;
      }
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
    {declaration: Declaration; locals?: Map<string, Declaration[]>} | null | undefined {
    const name = reference.replace(/^::/, "");
    const offset = options.mixinOffset;
    if (!options.mixin || offset === undefined || !options.path || name.includes("::")) return;
    const requires = this.facts.get(options.path)?.requiredFiles ?? [];
    if (!requires.length) return;
    const paths = new Set(requires.filter(load => load.end <= offset).map(load => load.path));
    const loaded = [...paths].flatMap(path => this.facts.get(path)?.declarations ?? []);
    const matching = loaded.filter(d => d.name === name);
    if (!matching.length) return;
    const declaration = matching.find(d => d.kind === "module" && !d.conditional && !d.nesting.length);
    if (!declaration || matching.some(d => d.kind !== "module" || d.path !== declaration.path)) return null;
    const canonical = this.bindings.get(name)?.has(declaration.path);
    if (!canonical && matching.length !== 1) return null;
    if (this.declarations.get(name)?.some(d => d.kind !== "module" || (!canonical && d.path !== declaration.path))) return null;
    // Other explicitly loaded files can introduce a lexical shadow or reopen
    // an ancestor, even outside the autoload roots. Keep their evidence local.
    const extra = loaded.filter(d => d.name !== name && !this.declarations.get(d.name)?.includes(d));
    if (extra.length) {
      locals = new Map(locals);
      for (const d of extra) locals.set(d.name, [...(locals.get(d.name) ?? []), d]);
    }
    return {declaration, locals};
  }

  private exact(name: string, options: RubyResolveOptions, required?: Declaration): string | null {
    const locals = options.path && this.consumerDeclarations.get(options.path);
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
    if (options.valueRead && this.literalBindings.has(name)) {
      const separator = name.lastIndexOf("::");
      if (separator < 0 || !this.blockedPrefix(name.slice(0, separator))) return this.literalBindings.get(name)!;
    }
    if (this.blockedPrefix(name)) {
      this.addDiagnostic({path: options.path ?? null, code: "ambiguous_constant_reference", message: `Constant ${name} has shadowing or multiple-definition evidence`, ...(options.line ? {line:options.line} : {})});
      return null;
    }
    const targets = this.bindings.get(name);
    if (targets?.size) return targets.size === 1 ? [...targets][0] : null;
    return required?.name === name ? required.path : null;
  }

  /** Returns a file endpoint only. A known namespace with a missing child
   * stops relative lookup; there is no globally-unique-basename fallback. */
  resolveConstant(reference: string, options: RubyResolveOptions = {}): string | null {
    if (!this.isRails || this.inferenceBlocked || !/^(?:::)?[A-Z]\w*(?:::[A-Z]\w*)*$/.test(reference)) return null;
    if (reference.startsWith("::")) {
      const required = this.requiredMixin(reference, options);
      if (required === null) return null;
      const target = this.exact(reference.slice(2), options, required?.declaration);
      return options.association && target && !/(?:^|\/)app\/models\//.test(target) ? null : target;
    }
    const nesting = options.nesting ?? [];
    let locals = options.path ? this.consumerDeclarations.get(options.path) : undefined;
    if (options.association) {
      // ActiveRecord tries the complete compute_type candidate at each level;
      // this differs from lexical first-component lookup.
      for (const scope of [...nesting, ""]) {
        const name = scope ? `${scope}::${reference}` : reference;
        if (this.blockedPrefix(name)) return this.exact(name, options);
        const target = this.exact(name, options);
        if (target && /(?:^|\/)app\/models\//.test(target)) return target;
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
    // Local inherited constants and mixin constants require Ruby's ancestor
    // rules. We deliberately suppress top-level fallback when those rules can
    // change a result, instead of pretending lexical search is complete.
    const qualifiedMixin = !!options.mixin && reference.includes("::");
    const ancestry = nesting[0] ? this.ancestorLookup(nesting[0], first, new Set(), locals, qualifiedMixin, required?.declaration) : "clear";
    if (ancestry !== "clear") {
      // A literal qualified mixin can still identify a file worth inspecting.
      // An inherited first component or an ambiguous provider rules that out.
      const candidateTarget = ancestry === "unknown" && qualifiedMixin
        && !this.blockedPrefix(reference) && this.declarations.get(reference)?.every(d => d.kind === "module")
        ? this.exact(reference, options) : null;
      this.addDiagnostic({
        path: options.path ?? null, code: "unsupported_ancestor_lookup",
        message: `Ancestor constant lookup for ${reference} in ${nesting[0]} is unresolved`,
        ...(options.line ? {line: options.line} : {}),
        ...(candidateTarget && candidateTarget !== options.path ? {candidateTarget} : {}),
      });
      return null;
    }
    return this.exact(reference, options, required?.declaration);
  }

  private ancestorLookup(
    name: string, first: string, seen: Set<string>, locals: Map<string, Declaration[]> | undefined, checkOtherAncestors: boolean,
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
        const inherited = this.declarations.has(resolved) || required?.name === resolved
          ? this.ancestorLookup(resolved, first, new Set(seen), locals, checkOtherAncestors, required) : "unknown";
        if (inherited !== "clear") {
          if (!checkOtherAncestors || inherited === "shadowed") return inherited;
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

  getDependencies(path: string): DependencyFact[] {
    const cached = this.dependencyCache.get(path);
    if (cached) return cached;
    const found: DependencyFact[] = [];
    for (const ref of this.facts.get(path)?.references ?? []) {
      if (ref.kind === "association" && ref.owner && !this.modelOwner(ref.owner, path, new Set())) {
        this.addDiagnostic({path, code:"unsupported_association_context", line:ref.line, message:`Association owner ${ref.owner} is not a known ActiveRecord model or model concern`});
        continue;
      }
      const target = this.resolveConstant(ref.reference, {
        nesting: ref.nesting, path, line: ref.line, association: ref.kind === "association",
        valueRead: ref.kind === "constant", mixin: ref.kind === "include" || ref.kind === "extend", mixinOffset: ref.mixinOffset,
      });
      if (!target || target === path) continue;
      found.push({target, type:ref.kind === "superclass" ? "inherits" : "depends_on", kind:ref.kind, reference:ref.displayReference ?? ref.reference, line:ref.line});
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

export function createRubyDependencyResolver(options: { projectRoot: string; files: RubyInventoryFile[]; plugin: TreeSitterPlugin }): RubyDependencyResolver {
  return new RubyDependencyResolver(options);
}
