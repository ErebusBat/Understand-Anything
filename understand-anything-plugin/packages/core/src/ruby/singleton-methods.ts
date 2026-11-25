import { rubyCall, rubyLiteral, rubySelfSingletonClass, rubyStatements, type RubyAstNode } from "./ast.js";

/** Only ordinary, directly defined singleton methods corroborate a receiver.
 * Instance methods, inherited methods, conditional declarations and method
 * factories can all give the same selector to unrelated receiver objects. */
export function publicSingletonMethods(body: RubyAstNode): Set<string> | undefined {
  const methods = new Set<string>(), hidden = new Set<string>();
  for (const node of rubyStatements(body)) {
    const singleton = rubySelfSingletonClass(node);
    let isPublic = true;
    for (const member of singleton ? rubyStatements(node.childForFieldName("body")) : [node]) {
      if (singleton && ["public", "protected", "private"].includes(member.text)) {
        isPublic = member.text === "public";
        continue;
      }
      const name = member.childForFieldName("name")?.text;
      if (name && (singleton ? member.type === "method"
        : member.type === "singleton_method" && member.childForFieldName("object")?.type === "self")) {
        if (isPublic) methods.add(name);
        else hidden.add(name);
        continue;
      }
      if (singleton && member.type === "undef") return undefined;
      const call = rubyCall(member);
      const modifiers = singleton ? ["private", "protected", "remove_method", "undef_method"] : ["private_class_method"];
      if (call && (!call.receiver || call.receiver.type === "self") && modifiers.includes(call.method)) {
        for (const arg of call.args) {
          const selector = ["method", "singleton_method"].includes(arg.type) ? arg.childForFieldName("name")?.text : rubyLiteral(arg);
          if (typeof selector !== "string") return undefined;
          hidden.add(selector);
        }
      }
    }
  }
  for (const name of hidden) methods.delete(name);
  return methods.size ? methods : undefined;
}
