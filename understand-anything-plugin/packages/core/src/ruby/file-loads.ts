import { posix } from "node:path";
import { rubyCall, rubyConstant, rubyLiteral, walkRuby, type RubyAstNode } from "./ast.js";

interface PathContext {
  file: string;
  railsRoot: string | null;
  shadows: Set<string>;
}

interface RubyImport {
  kind: "relative" | "absolute" | "computed";
  source: string;
}

function builtin(node: RubyAstNode | null, name: string, ctx: PathContext): boolean {
  return rubyConstant(node)?.replace(/^::/, "") === name && !ctx.shadows.has(name);
}

function pathString(node: RubyAstNode): string | null {
  const value = node.type === "string" ? rubyLiteral(node) : null;
  return typeof value === "string" && value.length && !value.includes("\0") ? value : null;
}

/** Interpret rooted path expressions in workspace coordinates. A plain string
 * alone has no known working directory. Preserve leading .. during normalization
 * so an escape cannot be clamped back onto an inventory entry. */
function anchoredPath(node: RubyAstNode | null, ctx: PathContext): string | null {
  if (!node) return null;
  if ((node.type === "file" || node.type === "identifier") && node.text === "__FILE__") return ctx.file;
  if (node.type === "binary" && node.childForFieldName("operator")?.text === "+") {
    const left = node.childForFieldName("left"), right = node.childForFieldName("right");
    // String + concatenates (Pathname + has different rules for a leading /).
    const call = rubyCall(left);
    if (call?.method !== "dirname" || !builtin(call.receiver, "File", ctx)) return null;
    const base = anchoredPath(left, ctx), suffix = right && pathString(right);
    return base !== null && suffix?.startsWith("/") ? posix.normalize(base + suffix) : null;
  }
  const call = rubyCall(node);
  if (!call || call.block) return null;
  if (call.method === "root" && !call.args.length && builtin(call.receiver, "Rails", ctx)) return ctx.railsRoot;
  if (call.method === "join" && rubyCall(call.receiver)?.method === "root" && call.args.length) {
    const base = anchoredPath(call.receiver, ctx);
    const parts = call.args.map(pathString);
    if (base !== null && parts.every((p): p is string => p !== null && !/^(?:[~/]|[a-z]:)/i.test(p))) {
      return posix.join(base, ...parts);
    }
  }
  if (!builtin(call.receiver, "File", ctx)) return null;
  if (call.method === "dirname" && call.args.length === 1) {
    const path = anchoredPath(call.args[0], ctx);
    return path === null ? null : posix.dirname(path);
  }
  if (call.method === "expand_path") {
    if (call.args.length === 1) return anchoredPath(call.args[0], ctx);
    if (call.args.length === 2) {
      const part = pathString(call.args[0]), base = anchoredPath(call.args[1], ctx);
      if (part !== null && !/^(?:[~/]|[a-z]:)/i.test(part) && base !== null) return posix.join(base, part);
    }
  }
  return null;
}

export function collectRubyFileLoads(root: RubyAstNode, file: string, railsRoot: string | null): RubyImport[] {
  const imports: RubyImport[] = [];
  const computed: {arg: RubyAstNode; receiver: RubyAstNode | null; method: string}[] = [];
  const shadows = new Set<string>();
  // An application binding or reopening may override the builtin's methods.
  // Suppress computed paths in this file when the same constant is declared.
  walkRuby(root, node => {
    const declared = ["class","module"].includes(node.type) ? node.childForFieldName("name")
      : ["assignment","operator_assignment"].includes(node.type) ? node.childForFieldName("left") : null;
    const name = rubyConstant(declared)?.split("::").pop();
    if (name) shadows.add(name);
    if (node.type === "method" || node.type === "singleton_method") shadows.add(node.childForFieldName("name")?.text ?? "");

    const call = rubyCall(node);
    if (!call || !["require","require_relative"].includes(call.method) || call.block || call.args.length !== 1) return;
    if (call.receiver && rubyConstant(call.receiver)?.replace(/^::/, "") !== "Kernel") return;
    const source = pathString(call.args[0]);
    if (source !== null) {
      imports.push({kind: call.method === "require_relative" ? "relative" : "absolute", source});
    } else {
      computed.push({arg:call.args[0], receiver:call.receiver, method:call.method});
    }
  });
  const ctx = {file, railsRoot, shadows};
  for (const {arg, receiver, method} of computed) {
    if (shadows.has(method) || (receiver && !builtin(receiver, "Kernel", ctx))) continue;
    const call = rubyCall(arg);
    if (!call || (call.method !== "join" && call.method !== "expand_path")) continue;
    const source = anchoredPath(arg, ctx);
    if (source !== null) imports.push({kind:"computed", source});
  }
  return imports;
}
