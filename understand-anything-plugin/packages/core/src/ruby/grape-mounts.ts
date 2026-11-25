import { rubyCall, rubyConstant, rubyLiteral, rubyStatements, type RubyAstNode } from "./ast.js";

const SCOPES = new Set(["group", "namespace", "resource", "resources", "segment", "route_param", "version"]);

/** These Grape DSL blocks retain the endpoint class as the mount receiver. */
export function grapeMountArguments(body: RubyAstNode): RubyAstNode[] {
  const mounts: RubyAstNode[] = [];
  for (const statement of rubyStatements(body)) {
    const call = rubyCall(statement);
    if (!call || call.receiver || call.args.length !== 1) continue;
    const [argument] = call.args;
    if (call.method === "mount" && !call.block) {
      const location = argument.childForFieldName("value");
      const endpoint = argument.type === "pair"
        ? location?.type === "string" && typeof rubyLiteral(location) === "string" && argument.childForFieldName("key")
        : argument;
      if (endpoint && rubyConstant(endpoint)) mounts.push(endpoint);
    }
    const nested = call.block?.childForFieldName("body");
    if (nested && !call.block?.childForFieldName("parameters") && SCOPES.has(call.method)
      && typeof rubyLiteral(call.args[0]) === "string") mounts.push(...grapeMountArguments(nested));
  }
  return mounts;
}
