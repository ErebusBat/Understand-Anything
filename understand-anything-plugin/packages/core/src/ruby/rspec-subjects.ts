import type { TreeSitterPlugin } from "../plugins/tree-sitter-plugin.js";
import { rubyCall, rubyConstant, rubyStatements, walkRuby, type RubyAstNode } from "./ast.js";
import type { RubyDependencyResolver } from "./resolver.js";
import type { DependencyFact } from "./types.js";

/** A described constant is static test intent, never evidence that examples ran.
 * Follow only example-group bodies, avoiding arbitrary blocks and runtime code. */
export function rspecSubjects(path: string, resolver: RubyDependencyResolver, plugin: TreeSitterPlugin): DependencyFact[] {
  const source = resolver.sources.get(path);
  if (!/(?:^|\/)spec\/.*_spec\.rb$/.test(path) || source === undefined || resolver.inferenceBlocked) return [];
  if (resolver.resolveConstant("::RSpec", {path})) return [];
  return plugin.withSyntaxTree(path, source, root => {
    let bareOverridden = false, registryOverridden = false;
    walkRuby(root, node => {
      if (["method", "singleton_method"].includes(node.type) && node.childForFieldName("name")?.text === "describe") bareOverridden = true;
      const name = rubyConstant(node.childForFieldName(node.type === "assignment" ? "left" : "name"));
      if (name?.split("::").pop() === "RSpec") registryOverridden = true;
    });
    if (registryOverridden) return [];
    const facts: DependencyFact[] = [];
    const visit = (body: RubyAstNode | null, nesting: string[]) => {
      for (const node of rubyStatements(body)) {
        if (node.type === "module") {
          const raw = rubyConstant(node.childForFieldName("name"));
          if (raw && !(nesting.length && raw.includes("::") && !raw.startsWith("::"))) {
            const name = raw.startsWith("::") ? raw.slice(2) : nesting[0] ? nesting[0] + "::" + raw : raw;
            visit(node.childForFieldName("body"), [name, ...nesting]);
          }
          continue;
        }
        const call = rubyCall(node);
        if (!call?.block || !["describe", "context", "fdescribe", "xdescribe"].includes(call.method)
          || (call.receiver ? rubyConstant(call.receiver)?.replace(/^::/, "") !== "RSpec" : bareOverridden)) continue;
        const reference = rubyConstant(call.args[0]);
        if (reference && call.method !== "context") {
          const line = node.startPosition.row + 1;
          const target = resolver.resolveConstant(reference, {path, nesting, line, valueRead: true});
          if (target && target !== path && !/(?:^|\/)(?:spec|test|features)\//.test(target)) {
            facts.push({target, type: "depends_on", kind: "rspec_subject", reference, line});
          }
        }
        visit(call.block.childForFieldName("body"), nesting);
      }
    };
    visit(root, []);
    return facts;
  });
}
