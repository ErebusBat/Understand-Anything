import { posix } from "node:path";
import { rubyCall, rubyConstant, rubyLiteral, rubyStatements, walkRuby, type RubyAstNode } from "./ast.js";
import { collectRubyFileLoads } from "./file-loads.js";

const standardHelper = /^spec\/(?:rails|spec)_helper\.rb$/;
const instanceBlocks = new Set(["let", "let!", "subject", "subject!", "it", "specify", "example", "before", "after", "around"]);
const helperDeclarations = new Set(["let", "let!", "subject", "subject!", "define_method", "alias_method", "attr_reader", "attr_accessor"]);

/** Only a block known to run with the example instance as self can use
 * FactoryBot's instance helpers. Unknown nested blocks can change self. */
export function exampleForBuilder(node: RubyAstNode): RubyAstNode | null {
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (["class", "module", "singleton_class", "method", "singleton_method", "lambda"].includes(parent.type)) return null;
    if (parent.type === "block" || parent.type === "do_block") {
      const owner = parent.parent;
      const call = rubyCall(owner);
      return call && !call.receiver && instanceBlocks.has(call.method) ? owner : null;
    }
  }
  return null;
}

type HelperLoads = {direct: Set<string>; supportGlob: boolean};
export class SpecFactorySyntax {
  private readonly defaultHelpers = new Set<string>();
  private readonly wiring = new Set<string>();
  private readonly loads = new Map<string, HelperLoads>();
  private readonly localShadows = new Map<string, Set<string>>();
  private readonly supportShadows = new Set<string>();

  /** RSpec evaluates ERB in option files. Restrict this pass to complete,
   * common literal option lines; custom options can change the load path. */
  readDefaultOptions(content: string): void {
    if (content.includes("<%")) return;
    const helpers: string[] = [];
    for (const raw of content.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith("#")) continue;
      const required = line.match(/^(?:--require(?:\s+|=)|-r\s*)(spec_helper|rails_helper)(?:\.rb)?$/);
      if (required) helpers.push("spec/" + required[1] + ".rb");
      else if (!/^(?:--(?:color|no-color|profile|fail-fast|warnings)|--(?:tag|format|order)\s+[~\w:.-]+)$/.test(line)) return;
    }
    for (const helper of helpers) this.defaultHelpers.add(helper);
  }

  indexLoads(path: string, root: RubyAstNode): void {
    const direct = new Set<string>();
    // Require the helper before the example groups can use its DSL. A require
    // inside a method or an arbitrary later block cannot establish that.
    for (const statement of rubyStatements(root)) {
      const call = rubyCall(statement);
      if (!call || call.receiver || call.block || !["require", "require_relative"].includes(call.method)) break;
      const name = rubyLiteral(call.args[0]);
      if (call.args.length !== 1 || call.args[0].type !== "string" || typeof name !== "string" || !/^[\w./-]+$/.test(name)) continue;
      const rubyPath = name.endsWith(".rb") ? name : name + ".rb";
      const target = call.method === "require_relative" ? posix.join(posix.dirname(path), rubyPath) : "spec/" + rubyPath;
      if (target.startsWith("spec/")) direct.add(target);
    }
    let supportGlob = false;
    if (standardHelper.test(path)) {
      const globLines = new Set(collectRubyFileLoads(root, path, ".")
        .filter(load => load.kind === "require_glob" && load.source === "spec/support/**/*.rb")
        .map(load => "line" in load ? load.line : 0));
      if (globLines.size) {
        walkRuby(root, node => {
          // A helper can define utilities or environment-specific setup that
          // never registers support in this suite. Keep those globs uncertain.
          if (["method", "singleton_method", "class", "module", "if", "unless", "if_modifier", "unless_modifier", "case"].includes(node.type)) return false;
          if (globLines.has(node.startPosition.row + 1) && rubyCall(node)?.method === "require") supportGlob = true;
        });
      }
    }
    if (direct.size || supportGlob) this.loads.set(path, {direct, supportGlob});
  }

  private indexShadow(path: string, name: string): void {
    const shadows = this.localShadows.get(path) ?? new Set<string>();
    shadows.add(name);
    this.localShadows.set(path, shadows);
    if (path.startsWith("spec/support/") || standardHelper.test(path)) this.supportShadows.add(name);
  }

  inspect(path: string, node: RubyAstNode, builders: Set<string>): void {
    let names: unknown[] = [];
    if (node.type === "method" || node.type === "singleton_method") names = [node.childForFieldName("name")?.text];
    if (node.type === "alias") names = [node.namedChildren[0]?.text.replace(/^:/, "")];
    const call = rubyCall(node);
    if (call && helperDeclarations.has(call.method)) {
      names = (call.method.startsWith("attr_") ? call.args : call.args.slice(0, 1)).map(rubyLiteral);
    }
    for (const name of names) if (typeof name === "string" && builders.has(name)) this.indexShadow(path, name);
    if (call?.method !== "configure" || rubyConstant(call.receiver)?.replace(/^::/, "") !== "RSpec"
      || node.parent?.type !== "program" || !call.block || call.args.length) return;
    const [param] = rubyStatements(call.block.childForFieldName("parameters"));
    const first = rubyCall(rubyStatements(call.block.childForFieldName("body"))[0]);
    if (param?.type === "identifier" && first?.receiver?.type === "identifier" && first.receiver.text === param.text
      && first.method === "include" && !first.block && first.args.length === 1
      && rubyConstant(first.args[0])?.replace(/^::/, "") === "FactoryBot::Syntax::Methods") this.wiring.add(path);
  }

  available(path: string, method: string, hasRailsRoot: boolean): boolean {
    if (!this.wiring.size || this.supportShadows.has(method) || this.localShadows.get(path)?.has(method)) return false;
    const direct = this.loads.get(path)?.direct ?? [];
    const defaults = path.endsWith("_spec.rb") ? this.defaultHelpers : [];
    for (const target of [...direct, ...defaults]) {
      if (this.wiring.has(target)) return true;
      if (!standardHelper.test(target)) continue;
      const helper = this.loads.get(target);
      for (const include of this.wiring) {
        if (helper?.direct.has(include) || hasRailsRoot && helper?.supportGlob && include.startsWith("spec/support/") && !include.split("/").some(part => part.startsWith("."))) return true;
      }
    }
    return false;
  }
}
