import { rubyCall, rubyConstant, rubyLiteral, rubyStatements, walkRuby, type RubyAstNode } from "./ast.js";
import type { SpecFactorySyntax } from "./spec-factory-syntax.js";
import type { DependencyFact } from "./types.js";

const safePath = /^[\w-]+(?:\/[\w-]+)*$/;
const otherSettings = new Set(["filter_sensitive_data", "allow_http_connections_when_no_cassette", "ignore_hosts",
  "ignore_localhost", "hook_into", "configure_rspec_metadata!", "ignore_request"]);
type Directory = {path: string; needsRailsRoot: boolean};

function directory(value: RubyAstNode | null): Directory | null {
  const literal = rubyLiteral(value);
  if (value?.type === "string" && typeof literal === "string" && safePath.test(literal)) return {path: literal, needsRailsRoot: false};
  const join = rubyCall(value), root = rubyCall(join?.receiver);
  if (join?.method !== "join" || join.block || !join.args.length || root?.method !== "root"
    || root.args.length || root.block || rubyConstant(root.receiver)?.replace(/^::/, "") !== "Rails") return null;
  const parts = join.args.map(arg => arg.type === "string" ? rubyLiteral(arg) : null);
  if (!parts.every((part): part is string => typeof part === "string" && safePath.test(part))) return null;
  return {path: parts.join("/"), needsRailsRoot: true};
}

/** VCR's default filesystem persister and YAML serializer use the cassette
 * name beneath cassette_library_dir. Other persisters and options can redirect it. */
export class VcrCassettes {
  private configuration?: {source: string; dir: Directory};
  private unsupported = false;
  private readonly uses = new Map<string, {name: string; line: number; reference: string}[]>();

  inspect(path: string, node: RubyAstNode, call: NonNullable<ReturnType<typeof rubyCall>>): void {
    if (rubyConstant(call.receiver)?.replace(/^::/, "") !== "VCR") return;
    if (call.method === "configuration") this.unsupported = true;
    if (call.method === "use_cassette" && call.block && call.args.length === 1) {
      const arg = call.args[0], name = rubyLiteral(arg);
      if (typeof name !== "string" || !safePath.test(name)) return;
      const sites = this.uses.get(path) ?? [];
      sites.push({name, line: node.startPosition.row + 1, reference: "VCR.use_cassette " + arg.text});
      this.uses.set(path, sites);
    }
    if (call.method !== "configure") return;
    const param = rubyStatements(call.block?.childForFieldName("parameters"));
    if (this.configuration || node.parent?.type !== "program" || call.args.length || !call.block
      || param.length !== 1 || param[0].type !== "identifier") { this.unsupported = true; return; }
    let dir: Directory | null = null;
    walkRuby(call.block, child => {
      if (child.type === "identifier" && child.text === param[0].text && child.id !== param[0].id
        && child.parent?.childForFieldName("receiver")?.id !== child.id) this.unsupported = true;
      const operation = rubyCall(child);
      if (operation?.receiver?.type !== "identifier" || operation.receiver.text !== param[0].text) return;
      if (operation.method !== "cassette_library_dir") {
        if (!otherSettings.has(operation.method)) this.unsupported = true;
        return;
      }
      const assignment = child.parent;
      if (dir || assignment?.type !== "assignment" || assignment.childForFieldName("left")?.id !== child.id
        || assignment.parent?.parent?.id !== call.block!.id) { this.unsupported = true; return; }
      dir = directory(assignment.childForFieldName("right"));
      if (!dir) this.unsupported = true;
    });
    if (dir) this.configuration = {source: path, dir};
    else this.unsupported = true;
  }

  dependencies(path: string, hasRailsRoot: boolean, loads: SpecFactorySyntax, shadowed: (path: string, name: string) => boolean): DependencyFact[] {
    const config = this.configuration, uses = this.uses.get(path);
    if (!config || !uses || this.unsupported || shadowed(path, "VCR") || shadowed(config.source, "VCR")
      || config.dir.needsRailsRoot && (!hasRailsRoot || shadowed(config.source, "Rails"))
      || !loads.loadsHelper(path, config.source, hasRailsRoot)) return [];
    return uses.map(({name, line, reference}) => ({target: config.dir.path + "/" + name + ".yml", line, reference,
      type: "depends_on", kind: "vcr_cassette", resolution: "inferred"}));
  }
}
