import { posix } from "node:path";
import type { TreeSitterPlugin } from "../plugins/tree-sitter-plugin.js";
import { rubyCall, rubyConstant, rubyLiteral, rubyOptions, rubyStatements, walkRuby, type RubyAstNode } from "./ast.js";

interface LocalGem {
  dir: string;
  name: string;
  loadPaths: string[];
}

interface BundledGem {
  gem: LocalGem;
  unconditional: boolean;
}

function gemDirectory(base: string, value: unknown): string | undefined {
  if (typeof value !== "string" || !value || /^(?:[~/]|[a-z]:)/i.test(value) || value.includes("\\")) return;
  const dir = posix.join(base, value);
  if (dir !== ".." && !dir.startsWith("../")) return dir;
}

/** A gemspec is executable Ruby. Only a direct specification block with literal
 * name and load-path settings supplies evidence. Absent require_paths uses
 * RubyGems' lib default; a conditional or mutated setting has no known default. */
function readGemspec(root: RubyAstNode, dir: string): LocalGem | undefined {
  const specs = rubyStatements(root).map(rubyCall).filter(call =>
    call?.method === "new" && rubyConstant(call.receiver)?.replace(/^::/, "") === "Gem::Specification");
  if (root.hasError || specs.length !== 1) return;
  const block = specs[0]?.block;
  const params = rubyStatements(block?.childForFieldName("parameters"));
  const body = block?.childForFieldName("body");
  if (!body || params.length !== 1 || params[0].type !== "identifier") return;
  let name: string | undefined;
  let loadPaths: string[] | undefined;
  let supported = true;
  walkRuby(body, node => {
    if (node.type === "identifier" && node.text === params[0].text
      && node.parent?.childForFieldName("receiver")?.id !== node.id) supported = false;
    const call = rubyCall(node);
    if (call?.receiver?.text === params[0].text && ["send", "public_send", "__send__", "instance_eval", "instance_exec"].includes(call.method)) {
      supported = false;
    }
    if (call?.receiver?.text !== params[0].text || !["name", "require_path", "require_paths"].includes(call.method)) return;
    const assignment = node.parent;
    if (assignment?.type !== "assignment" || assignment.parent?.id !== body.id
      || assignment.childForFieldName("left")?.id !== node.id) { supported = false; return; }
    const right = assignment.childForFieldName("right");
    const value = rubyLiteral(right);
    if (call.method === "name") {
      if (name !== undefined || right?.type !== "string" || typeof value !== "string") supported = false;
      else name = value;
      return;
    }
    const paths = Array.isArray(value) ? value : [value];
    const strings = right?.type === "string" || (right && ["array", "string_array"].includes(right.type)
      && rubyStatements(right).every(part => ["bare_string", "string"].includes(part.type)));
    if (!strings || loadPaths || !paths.every(path => typeof path === "string" && gemDirectory(".", path) !== undefined)) {
      supported = false;
    } else loadPaths = paths.map(path => posix.join(dir, String(path)));
  });
  if (supported && name) return {dir, name, loadPaths: loadPaths ?? [posix.join(dir, "lib")]};
}

function readBundle(root: RubyAstNode, dir: string, specs: Map<string, LocalGem[]>): BundledGem[] {
  const gems: BundledGem[] = [];
  if (root.hasError) return gems;
  walkRuby(root, node => {
    const call = rubyCall(node);
    const topLevel = node.parent?.type === "program";
    if ((node.type === "identifier" && node.text === "gemspec" && node.parent?.type !== "call")
      || (call?.method === "gemspec" && !call.receiver && !call.block && !call.args.length)) {
      const local = specs.get(dir);
      if (local?.length === 1) gems.push({gem: local[0], unconditional: topLevel});
      return;
    }
    if (call?.method !== "gem" || call.receiver || call.block || call.args[0]?.type !== "string") return;
    const name = rubyLiteral(call.args[0]);
    // Literal version requirements can precede either Ruby hash syntax.
    const optionsAt = call.args.findIndex(arg => arg.type !== "string");
    if (optionsAt === -1) return;
    const pairs = call.args.slice(optionsAt).flatMap(arg => arg.type === "hash" ? rubyStatements(arg) : [arg]);
    const paths = pairs.filter(arg => rubyLiteral(arg.childForFieldName("key")) === "path");
    const value = paths.length === 1 ? paths[0].childForFieldName("value") : null;
    if (value?.type !== "string") return;
    const path = gemDirectory(dir, rubyLiteral(value));
    if (path === undefined) return;
    const candidates = specs.get(path)?.filter(gem => gem.name === name);
    if (candidates?.length !== 1) return;
    const options = rubyOptions(pairs);
    const unconditional = topLevel && options !== null && [...options.keys()].every(key => ["path", "require"].includes(key))
      && call.args.slice(1, optionsAt).every(arg => typeof rubyLiteral(arg) === "string");
    gems.push({gem: candidates[0], unconditional});
  });
  return gems;
}

function contains(dir: string, path: string): boolean {
  return dir === "." || dir === path || path.startsWith(dir + "/");
}

/** Resolve explicit imports against only local gems selected by the caller's
 * bundle. A path gem's own development Gemfile does not replace the host
 * bundle when its code runs inside that host. Independent Gemfiles form
 * boundaries. Neither Bundler nor gemspec Ruby is executed. */
export function createBundledGemLookup(plugin: TreeSitterPlugin, sources: Map<string, string>, inventory: Set<string>) {
  const specs = new Map<string, LocalGem[]>();
  for (const [path, source] of sources) {
    if (!path.endsWith(".gemspec")) continue;
    const dir = posix.dirname(path);
    const spec = plugin.withSyntaxTree(path, source, root => readGemspec(root, dir));
    if (!spec) continue;
    const local = specs.get(dir) ?? [];
    local.push(spec);
    specs.set(dir, local);
  }

  const bundles = [...inventory].filter(path => posix.basename(path) === "Gemfile").map(path => {
    const dir = posix.dirname(path);
    const source = sources.get(path);
    const gems = source ? plugin.withSyntaxTree(path, source, root => readBundle(root, dir, specs)) : [];
    return {dir, gems};
  }).sort((a, b) => b.dir.length - a.dir.length || Number(a.dir === ".") - Number(b.dir === "."));

  return (consumer: string, application: string, feature: string, appTarget?: string): string[] => {
    const fallback = appTarget ? [appTarget] : [];
    if (feature.split("/").some(part => !part || part === "." || part === "..")) return fallback;
    const ancestors = bundles.filter(bundle => contains(bundle.dir, consumer));
    let bundle = ancestors[0];
    if (!bundle) return fallback;
    // An unrelated nested Rails app cannot borrow its parent's dependency
    // list. Engine dummy apps can access the package that hosts them.
    const appDir = application.replace(/\/$/, "") || ".";
    if (!contains(appDir, bundle.dir) && !bundle.gems.some(binding => binding.unconditional && contains(binding.gem.dir, appDir))) return fallback;
    for (const host of ancestors.slice(1)) {
      if (!host.gems.some(binding => binding.unconditional && binding.gem.dir === bundle.dir)) break;
      bundle = host;
    }
    const matches = new Set(fallback);
    let certain = Boolean(appTarget);
    for (const {gem, unconditional} of bundle.gems) {
      for (const dir of gem.loadPaths) {
        const target = posix.join(dir, feature);
        if (inventory.has(target)) {
          matches.add(target);
          certain ||= unconditional;
          break;
        }
      }
    }
    // Activation order across packages (including an optional package) is
    // unknown. Inside one package RubyGems preserves its require_paths order.
    return certain && matches.size === 1 ? [...matches] : [];
  };
}
