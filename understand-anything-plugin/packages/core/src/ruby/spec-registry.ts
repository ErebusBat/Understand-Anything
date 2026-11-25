import { rubyCall, rubyConstant, rubyLiteral, walkRuby, type RubyAstNode } from "./ast.js";
import type { DependencyFact } from "./types.js";

const sharedDefinitions = new Set(["shared_examples", "shared_examples_for", "shared_context"]);
const sharedUses = new Set(["include_examples", "include_context", "it_behaves_like", "it_should_behave_like"]);
const exampleGroups = new Set(["describe", "context", "fdescribe", "fcontext", "xdescribe", "xcontext", ...sharedDefinitions]);

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

type Site = {key: string; reference: string; line: number};
type Providers = Map<string, string | null>;

/** A second definition, including one with uncertain visibility, rules out
 * selecting a unique provider from this RSpec registry. */
function register(providers: Providers, key: string, target: string | null): void {
  providers.set(key, providers.has(key) ? null : target);
}

export class RubySpecRegistry {
  private readonly shared = new Map<string, string | null>();
  private readonly uses = new Map<string, Site[]>();

  index(path: string, root: RubyAstNode): void {
    if (!path.startsWith("spec/") || !path.endsWith(".rb")) return;
    const sites: Site[] = [];
    walkRuby(root, node => {
      const call = rubyCall(node);
      if (!call || !sharedDefinitions.has(call.method) && !sharedUses.has(call.method)) return;
      const name = rubyLiteral(call.args[0]);
      if (typeof name !== "string") return;
      // RSpec stores string and symbol names as distinct registry keys.
      const key = call.args[0].type + ":" + name;
      if (sharedDefinitions.has(call.method)) {
        if (call.receiver && rubyConstant(call.receiver)?.replace(/^::/, "") !== "RSpec") return;
        const global = path.startsWith("spec/support/") && node.parent?.type === "program" && !!call.block;
        register(this.shared, key, global ? path : null);
      } else if (!call.receiver && inExampleGroup(node)) {
        sites.push({key, reference: call.method + " " + call.args[0].text, line: node.startPosition.row + 1});
      }
    });
    if (sites.length) this.uses.set(path, sites);
  }

  dependencies(path: string): DependencyFact[] {
    const facts: DependencyFact[] = [];
    for (const site of this.uses.get(path) ?? []) {
      const target = this.shared.get(site.key);
      if (target && target !== path) {
        facts.push({target, type: "depends_on", kind: "rspec_shared_group", reference: site.reference, line: site.line, resolution: "inferred"});
      }
    }
    return facts;
  }
}
