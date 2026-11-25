import { rubyCall, rubyConstant, rubyLiteral, rubyStatements, type RubyAstNode } from "./ast.js";

const SCOPES = new Set(["group", "namespace", "resource", "resources", "segment", "route_param", "version"]);

type GrapeArgument = {node: RubyAstNode; kind: "route" | "grape_helper"};

/** These Grape DSL blocks retain the endpoint class as their receiver. */
export function grapeDependencyArguments(body: RubyAstNode): GrapeArgument[] {
  const argumentsFound: GrapeArgument[] = [];
  for (const statement of rubyStatements(body)) {
    const call = rubyCall(statement);
    if (!call || call.receiver) continue;
    if (call.method === "helpers" && !call.block && call.args.every(arg => rubyConstant(arg))) {
      for (const node of call.args) argumentsFound.push({node, kind: "grape_helper"});
    }
    if (call.args.length !== 1) continue;
    const [argument] = call.args;
    if (call.method === "mount" && !call.block) {
      const location = argument.childForFieldName("value");
      const endpoint = argument.type === "pair"
        ? location?.type === "string" && typeof rubyLiteral(location) === "string" && argument.childForFieldName("key")
        : argument;
      if (endpoint && rubyConstant(endpoint)) argumentsFound.push({node: endpoint, kind: "route"});
    }
    const nested = call.block?.childForFieldName("body");
    if (nested && !call.block?.childForFieldName("parameters") && SCOPES.has(call.method)
      && typeof rubyLiteral(call.args[0]) === "string") argumentsFound.push(...grapeDependencyArguments(nested));
  }
  return argumentsFound;
}
