import { rubyCall, rubyConstant, rubyLiteral, rubyOptions, rubyStatements, walkRuby, type RubyAstNode } from "./ast.js";
import { exampleForBuilder, SpecFactorySyntax } from "./spec-factory-syntax.js";
import { VcrCassettes } from "./vcr-cassettes.js";
import type { DependencyFact } from "./types.js";

const sharedDefinitions = new Set(["shared_examples", "shared_examples_for", "shared_context"]);
const sharedUses = new Set(["include_examples", "include_context", "it_behaves_like", "it_should_behave_like"]);
const exampleGroups = new Set(["describe", "context", "fdescribe", "fcontext", "xdescribe", "xcontext", "it_behaves_like", "it_should_behave_like", ...sharedDefinitions]);

/** The call whose block directly contains this statement (do/end or {}). */
function blockOwner(node: RubyAstNode): RubyAstNode | null {
  const body = node.parent;
  if (body?.type !== "body_statement" && body?.type !== "block_body") return null;
  const block = body.parent;
  return block?.type === "do_block" || block?.type === "block" ? block.parent : null;
}

function inExampleGroup(node: RubyAstNode): boolean {
  for (let owner = blockOwner(node); owner; owner = blockOwner(owner)) {
    const group = rubyCall(owner);
    if (!group || !exampleGroups.has(group.method)
      || group.receiver && rubyConstant(group.receiver)?.replace(/^::/, "") !== "RSpec") return false;
    if (owner.parent?.type === "program") return true;
  }
  return false;
}

const factoryUses = new Set(["create", "create_list", "build", "build_list", "build_stubbed", "build_stubbed_list", "attributes_for", "attributes_for_list"]);
const factoryRegistries = ["FactoryBot", "FactoryGirl"] as const;
type FactoryRegistry = typeof factoryRegistries[number];

function factoryReceiver(node: RubyAstNode | null): FactoryRegistry | undefined {
  const name = rubyConstant(node)?.replace(/^::/, "");
  return factoryRegistries.find(registry => registry === name);
}

type FactoryNameBounds = {prefix: string; suffix: string};

/** Interpolation can supply any value, but cannot replace literal text
 * outside it. Unknown escapes and other expressions can match any name. */
function factoryNameBounds(node: RubyAstNode | undefined): FactoryNameBounds {
  const parts = node?.namedChildren ?? [];
  if (!node || !["string", "delimited_symbol"].includes(node.type)
    || !parts.some(part => part.type === "interpolation")) return {prefix: "", suffix: ""};
  const literal = (part: RubyAstNode) => part.type === "string_content" && /^\w+$/.test(part.text) ? part.text : "";
  return {prefix: literal(parts[0]), suffix: literal(parts[parts.length - 1])};
}

function topLevelBinding(node: RubyAstNode): boolean {
  for (let owner = node.parent; owner; owner = owner.parent) {
    if (["class", "module", "method", "singleton_class", "singleton_method"].includes(owner.type)) return false;
  }
  return true;
}

function factoryDefinition(node: RubyAstNode): FactoryRegistry | undefined {
  for (let owner = blockOwner(node); owner; owner = blockOwner(owner)) {
    const call = rubyCall(owner);
    if (!call) return;
    if (call.method === "define" && !call.args.length && owner.parent?.type === "program") {
      return factoryReceiver(call.receiver);
    }
    if (call.receiver || call.method !== "factory") return;
  }
}

type Site = {kind: "rspec_shared_group" | "factory" | "factory_association" | "factory_sequence"; registry: "RSpec" | FactoryRegistry; key: string; reference: string; line: number; bareBuilder?: string};
type Providers = Map<string, string | null>;

/** A second definition, including one with uncertain visibility, rules out
 * selecting a unique provider from this RSpec registry. */
function register(providers: Providers, key: string, target: string | null): void {
  providers.set(key, providers.has(key) ? null : target);
}

function factoryScopedSequence(node: RubyAstNode): boolean {
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (parent.type !== "block" && parent.type !== "do_block") continue;
    const call = rubyCall(parent.parent);
    if (call?.method === "define" && factoryReceiver(call.receiver)) return false;
    if (call && !call.receiver && ["factory", "trait"].includes(call.method)) return true;
  }
  return false;
}

function symbolOptions(args: RubyAstNode[]): RubyAstNode[] {
  // 'factory': is a symbol label, while 'factory' => is a string override.
  return args.flatMap(arg => arg.type === "hash" ? rubyStatements(arg) : [arg])
    .filter(opt => opt.childForFieldName("key")?.type !== "string" || !opt.children.some(child => child.type === "=>"));
}

class FactoryRegistrations {
  private readonly providers: Record<FactoryRegistry, Providers> = {FactoryBot: new Map(), FactoryGirl: new Map()};
  private readonly unknownNames: Record<FactoryRegistry, FactoryNameBounds[]> = {FactoryBot: [], FactoryGirl: []};

  add(args: RubyAstNode[], registry: FactoryRegistry | undefined, provider: string | null, sequence: boolean): void {
    const name = rubyLiteral(args[0]);
    const names = typeof name === "string" ? [name] : [];
    let unknown = typeof name === "string" ? null : factoryNameBounds(args[0]);
    // A sequence may start at a literal value before its options hash.
    const optionsStart = sequence && args[1] && ["integer", "string", "simple_symbol"].includes(args[1].type) ? 2 : 1;
    for (const opt of symbolOptions(args.slice(optionsStart))) {
      const keyNode = opt.type === "pair" ? opt.childForFieldName("key") : null;
      const key = rubyLiteral(keyNode);
      if (typeof key !== "string") { unknown = {prefix: "", suffix: ""}; continue; }
      if (key !== "aliases") continue;
      const aliases = rubyLiteral(opt.childForFieldName("value"));
      if (!Array.isArray(aliases)) { unknown = {prefix: "", suffix: ""}; continue; }
      for (const alias of aliases) if (typeof alias === "string") names.push(alias);
    }
    // A declaration under unknown DSL control can collide with either registry.
    for (const owner of registry ? [registry] : factoryRegistries) {
      if (unknown) this.unknownNames[owner].push(unknown);
      for (const key of names) register(this.providers[owner], key, provider);
    }
  }

  lookup(registry: FactoryRegistry, key: string): string | null | undefined {
    if (this.unknownNames[registry].some(({prefix, suffix}) =>
      key.startsWith(prefix) && key.endsWith(suffix) && key.length >= prefix.length + suffix.length)) return null;
    return this.providers[registry].get(key);
  }
}

export class RubySpecRegistry {
  private readonly vcr = new VcrCassettes();
  private readonly factorySyntax = new SpecFactorySyntax();
  private readonly shared = new Map<string, string | null>();
  private readonly factories = new FactoryRegistrations();
  private readonly sequences = new FactoryRegistrations();
  private readonly uses = new Map<string, Site[]>();
  private readonly replacedRegistries = new Set<string>();
  private readonly localReplacements = new Map<string, Set<string>>();

  constructor(private readonly hasCassette: (path: string) => boolean = () => false) {}

  readDefaultOptions(content: string): void {
    this.factorySyntax.readDefaultOptions(content);
  }

  index(path: string, root: RubyAstNode): void {
    if (!/^(spec|test|features)\/.*\.rb$/.test(path)) return;
    const spec = path.startsWith("spec/");
    if (spec) this.factorySyntax.indexLoads(path, root);
    const sites: Site[] = [];
    const factoryFile = /^(spec|test)\/factories(?:\/|\.rb$)/.test(path);
    walkRuby(root, node => {
      if (spec) this.factorySyntax.inspect(path, node, factoryUses);
      // A local replacement can redirect even explicitly qualified builders.
      const binding = node.type === "class" || node.type === "module" ? node.childForFieldName("name")
        : node.type === "assignment" ? node.childForFieldName("left") : null;
      const qualified = rubyConstant(binding);
      const namePart = qualified?.split("::").pop();
      if ((spec && (namePart === "RSpec" || namePart === "VCR" || namePart === "Rails")) || namePart === "FactoryBot" || namePart === "FactoryGirl") {
        if (qualified === "::" + namePart || qualified === namePart && topLevelBinding(node)) {
          this.replacedRegistries.add(namePart);
        } else {
          const local = this.localReplacements.get(path) ?? new Set<string>();
          local.add(namePart);
          this.localReplacements.set(path, local);
        }
      }
      const call = rubyCall(node);
      if (!call) return;
      if (spec) this.vcr.inspect(path, node, call);
      const {method, receiver, args} = call;
      if (method === "association" && !receiver && !call.block && factoryFile) {
        const owner = blockOwner(node), enclosing = rubyCall(owner);
        const registry = owner && enclosing && !enclosing.receiver && ["factory", "trait"].includes(enclosing.method) && factoryDefinition(owner);
        const name = rubyLiteral(args[0]), options = rubyOptions(symbolOptions(args.slice(1)));
        if (!registry || typeof name !== "string" || !options) return;
        const key = options.has("factory") ? options.get("factory") : name;
        if (typeof key === "string") sites.push({kind: "factory_association", registry, key, line: node.startPosition.row + 1,
          reference: "association " + args[0].text + (options.has("factory") ? " => " + key : "")});
        return;
      }
      if ((method === "factory" || method === "sequence") && !receiver) {
        if (method === "sequence" && factoryScopedSequence(node)) return;
        const definition = factoryDefinition(node);
        if (!factoryFile && !definition) return;
        const names = method === "sequence" ? this.sequences : this.factories;
        names.add(args, definition, factoryFile && definition ? path : null, method === "sequence");
        return;
      }
      if (method === "generate" && args.length === 1 && !call.block) {
        const registry = factoryReceiver(receiver), name = rubyLiteral(args[0]);
        if (registry && typeof name === "string") sites.push({kind: "factory_sequence", registry, key: name,
          reference: registry + ".generate " + args[0].text, line: node.startPosition.row + 1});
        return;
      }
      if (factoryUses.has(method)) {
        const name = rubyLiteral(args[0]);
        if (typeof name !== "string") return;
        const explicit = factoryReceiver(receiver);
        const example = spec && !receiver && exampleForBuilder(node);
        if (explicit || example && inExampleGroup(example)) {
          sites.push({kind: "factory", registry: explicit ?? "FactoryBot", key: name, reference: (explicit ? explicit + "." : "") + method + " " + args[0].text,
            line: node.startPosition.row + 1, ...(explicit ? {} : {bareBuilder: method})});
        }
        return;
      }
      if (!spec || !sharedDefinitions.has(method) && !sharedUses.has(method)) return;
      const name = rubyLiteral(args[0]);
      if (typeof name !== "string") return;
      // RSpec stores string and symbol names as distinct registry keys.
      const key = call.args[0].type + ":" + name;
      if (sharedDefinitions.has(call.method)) {
        if (call.receiver && rubyConstant(call.receiver)?.replace(/^::/, "") !== "RSpec") return;
        const global = path.startsWith("spec/support/") && node.parent?.type === "program" && !!call.block;
        register(this.shared, key, global ? path : null);
      } else if (!call.receiver && inExampleGroup(node)) {
        sites.push({kind: "rspec_shared_group", registry: "RSpec", key, reference: call.method + " " + call.args[0].text, line: node.startPosition.row + 1});
      }
    });
    if (sites.length) this.uses.set(path, sites);
  }

  dependencies(path: string, hasRailsRoot = false): DependencyFact[] {
    const shadowed = (file: string, name: string) => this.replacedRegistries.has(name) || !!this.localReplacements.get(file)?.has(name);
    const facts = this.vcr.dependencies(path, hasRailsRoot, this.factorySyntax, shadowed).filter(f => this.hasCassette(f.target));
    for (const site of this.uses.get(path) ?? []) {
      const registry = site.registry;
      if (shadowed(path, registry)) continue;
      if (site.bareBuilder && (shadowed(path, "RSpec")
        || !this.factorySyntax.available(path, site.bareBuilder, hasRailsRoot))) continue;
      const names = site.kind === "factory_sequence" ? this.sequences : this.factories;
      const target = registry === "RSpec" ? this.shared.get(site.key) : names.lookup(registry, site.key);
      if (target && target !== path && !shadowed(target, registry)) {
        facts.push({target, type: "depends_on", kind: site.kind, reference: site.reference, line: site.line, resolution: "inferred"});
      }
    }
    return facts;
  }
}

/** A hosted engine shares its application's constants, but runs its own test
 * suite. Keep registry names, helper loads and ambiguities inside each package. */
export class RubyTestSuites {
  private readonly suites = new Map<string, RubySpecRegistry>();
  private readonly prefixes: string[];

  constructor(files: readonly {path: string}[]) {
    const prefixes = new Set([""]);
    const yml = new Set<string>();
    for (const {path} of files) {
      if (path.endsWith(".yml")) yml.add(path);
      const prefix = path.match(/^(.+\/)(?:[^/]+\.gemspec|Gemfile|\.rspec)$/)?.[1];
      if (prefix) prefixes.add(prefix);
    }
    this.prefixes = [...prefixes].sort((a, b) => b.length - a.length);
    for (const prefix of prefixes) this.suites.set(prefix, new RubySpecRegistry(path => yml.has(prefix + path)));
  }

  readDefaultOptions(path: string, content: string): void {
    this.suites.get(path.slice(0, -".rspec".length))?.readDefaultOptions(content);
  }

  index(path: string, root: RubyAstNode): void {
    const prefix = this.prefixes.find(candidate => path.startsWith(candidate))!;
    this.suites.get(prefix)!.index(path.slice(prefix.length), root);
  }

  dependencies(path: string, hasRailsRoot: boolean): DependencyFact[] {
    const prefix = this.prefixes.find(candidate => path.startsWith(candidate))!;
    // Rails.root in an engine's tests can designate its dummy app.
    const facts = this.suites.get(prefix)!.dependencies(path.slice(prefix.length), !prefix && hasRailsRoot);
    return prefix ? facts.map(fact => ({...fact, target: prefix + fact.target})) : facts;
  }
}
