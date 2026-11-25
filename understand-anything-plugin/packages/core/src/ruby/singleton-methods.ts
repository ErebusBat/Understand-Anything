import { rubyCall, rubyLiteral, rubySelfSingletonClass, rubyStatements, type RubyAstNode } from "./ast.js";

interface MethodEvidence {
  publicSingleton?: Set<string>;
  unavailableSingleton?: Set<string> | "unknown";
  declaresInitializer?: boolean;
}

/** Only direct method declarations supply evidence for a receiver. Keep
 * visibility changes as counterevidence to inherited framework methods. */
export function rubyMethodEvidence(body: RubyAstNode): MethodEvidence | undefined {
  const methods = new Set<string>(), hidden = new Set<string>();
  let declaresInitializer = false;
  for (const node of rubyStatements(body)) {
    if (node.type === "method" && node.childForFieldName("name")?.text === "initialize") declaresInitializer = true;
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
      if (singleton && member.type === "undef") return {unavailableSingleton: "unknown"};
      const call = rubyCall(member);
      const modifiers = singleton ? ["private", "protected", "remove_method", "undef_method"] : ["private_class_method"];
      if (call && (!call.receiver || call.receiver.type === "self") && modifiers.includes(call.method)) {
        for (const arg of call.args) {
          const selector = ["method", "singleton_method"].includes(arg.type) ? arg.childForFieldName("name")?.text : rubyLiteral(arg);
          if (typeof selector !== "string") return {unavailableSingleton: "unknown"};
          hidden.add(selector);
        }
      }
    }
  }
  for (const name of hidden) methods.delete(name);
  return methods.size || hidden.size || declaresInitializer ? {
    publicSingleton: methods.size ? methods : undefined,
    unavailableSingleton: hidden.size ? hidden : undefined,
    declaresInitializer,
  } : undefined;
}
