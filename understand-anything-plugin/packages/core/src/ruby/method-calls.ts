import { rubyCall, rubyConstant, rubyMethodName, rubyStatements, type RubyAstNode } from "./ast.js";

/** Declaration location disambiguates reopened owners and instance/singleton selectors. */
export interface RubyMethodSymbol {
  owner: string | null;
  name: string;
  dispatch: "singleton" | "instance";
  line: number;
  endLine: number;
}
export interface RubyMethodSite {
  caller?: RubyMethodSymbol;
  nesting: string[];
  receiver?: string;
  selector: string;
  dispatch: "constant" | "implicit" | "dynamic";
  line: number;
  column: number;
  offset: number;
}
export interface RubyMethodCallFact extends RubyMethodSite {
  outcome: "resolved" | "dynamic" | "external_or_ambiguous" | "unclassified";
  receiverTarget?: string;
  target?: string;
  callee?: RubyMethodSymbol;
  resolution?: "inferred";
}

/** Walk DSL blocks as well as normal bodies: a named helper remains a declaration.
 * No block receiver or runtime-installed method is inferred. */
export function collectRubyMethodCalls(root: RubyAstNode): {symbols: RubyMethodSymbol[]; sites: RubyMethodSite[]} {
  const symbols: RubyMethodSymbol[] = [];
  const sites: RubyMethodSite[] = [];
  const visit = (node: RubyAstNode, nesting: string[], caller?: RubyMethodSymbol, uncertainOwner = false) => {
    if (node.type === "class" || node.type === "module") {
      const raw = rubyConstant(node.childForFieldName("name"));
      if (!raw) return;
      const owner = raw.startsWith("::") ? raw.slice(2) : nesting[0] ? nesting[0] + "::" + raw : raw;
      const body = node.childForFieldName("body");
      const nestedQualified = !raw.startsWith("::") && raw.includes("::") && nesting.length > 0;
      if (body) visit(body, [owner, ...nesting], undefined, uncertainOwner || nestedQualified);
      return;
    }
    if (node.type === "method" || node.type === "singleton_method") {
      const method = rubyMethodName(node);
      if (!method) return;
      const singleton = method.startsWith("self.");
      const object = node.type === "singleton_method" ? node.childForFieldName("object") : null;
      const unknownReceiver = object !== null && object.type !== "self";
      caller = {
        owner: uncertainOwner || unknownReceiver ? null : nesting[0] ?? "",
        name: method.replace(/^self\./, ""),
        dispatch: singleton ? "singleton" : "instance",
        line: node.startPosition.row + 1,
        endLine: node.endPosition.row + 1,
      };
      symbols.push(caller);
    }
    const call = rubyCall(node);
    if (call) {
      const receiver = rubyConstant(call.receiver);
      sites.push({
        ...(caller && { caller }),
        nesting: [...nesting],
        ...(receiver && { receiver }),
        selector: call.method,
        dispatch: receiver ? "constant" : call.receiver ? "dynamic" : "implicit",
        line: node.startPosition.row + 1,
        column: node.startPosition.column + 1,
        offset: node.startIndex,
      });
    }
    for (const child of rubyStatements(node)) {
      const dynamicBlock = call?.block?.id === child.id && (call.receiver !== null || call.method !== "helpers" || call.args.length > 0);
      const dynamicSingleton = node.type === "singleton_class" && node.childForFieldName("value")?.type !== "self";
      visit(child, nesting, caller, uncertainOwner || dynamicBlock || dynamicSingleton);
    }
  };
  visit(root, []);
  return {symbols, sites};
}
