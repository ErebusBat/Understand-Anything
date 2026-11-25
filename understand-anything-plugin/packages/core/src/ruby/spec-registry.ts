import { rubyCall, rubyConstant, rubyLiteral, rubyStatements, walkRuby, type RubyAstNode } from "./ast.js";
import { exampleForBuilder, SpecFactorySyntax } from "./spec-factory-syntax.js";
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

type Site = {kind: "rspec_shared_group" | "factory"; registry: "RSpec" | FactoryRegistry; key: string; reference: string; line: number; bareBuilder?: string};
type Providers = Map<string, string | null>;

/** A second definition, including one with uncertain visibility, rules out
 * selecting a unique provider from this RSpec registry. */
function register(providers: Providers, key: string, target: string | null): void {
  providers.set(key, providers.has(key) ? null : target);
}

export class RubySpecRegistry {
  private readonly factorySyntax = new SpecFactorySyntax();
  private readonly shared = new Map<string, string | null>();
  private readonly factories: Record<FactoryRegistry, Providers> = {FactoryBot: new Map(), FactoryGirl: new Map()};
  private readonly uses = new Map<string, Site[]>();
  private readonly replacedRegistries = new Set<string>();
  private readonly localReplacements = new Map<string, Set<string>>();
  private readonly incomplete = new Set<FactoryRegistry>();

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
      if ((spec && namePart === "RSpec") || namePart === "FactoryBot" || namePart === "FactoryGirl") {
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
      const {method, receiver, args} = call;
      if (method === "factory" && !receiver) {
        const definition = factoryDefinition(node);
        if (!factoryFile && !definition) return;
        const provider = factoryFile && definition ? path : null;
        // A declaration under unknown DSL control can collide with either registry.
        const registries = definition ? [definition] : factoryRegistries;
        const name = rubyLiteral(args[0]);
        const names = typeof name === "string" ? [name] : [];
        let complete = typeof name === "string";
        for (const opt of args.slice(1).flatMap(arg => arg.type === "hash" ? rubyStatements(arg) : [arg])) {
          if (opt.type !== "pair") { complete = false; continue; }
          if (rubyLiteral(opt.childForFieldName("key")) !== "aliases") continue;
          const aliases = rubyLiteral(opt.childForFieldName("value"));
          if (!Array.isArray(aliases)) { complete = false; continue; }
          for (const alias of aliases) {
            if (typeof alias === "string") names.push(alias);
          }
        }
        for (const registry of registries) {
          if (!complete) this.incomplete.add(registry);
          for (const key of names) register(this.factories[registry], key, provider);
        }
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
    const facts: DependencyFact[] = [];
    for (const site of this.uses.get(path) ?? []) {
      const registry = site.registry;
      if (this.replacedRegistries.has(registry) || this.localReplacements.get(path)?.has(registry)
        || registry !== "RSpec" && this.incomplete.has(registry)) continue;
      if (site.bareBuilder && (this.replacedRegistries.has("RSpec") || this.localReplacements.get(path)?.has("RSpec")
        || !this.factorySyntax.available(path, site.bareBuilder, hasRailsRoot))) continue;
      const target = (registry === "RSpec" ? this.shared : this.factories[registry]).get(site.key);
      if (target && target !== path && !this.localReplacements.get(target)?.has(registry)) {
        facts.push({target, type: "depends_on", kind: site.kind, reference: site.reference, line: site.line, resolution: "inferred"});
      }
    }
    return facts;
  }
}
