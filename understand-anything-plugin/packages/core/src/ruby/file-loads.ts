import { posix } from "node:path";
import { rubyCall, rubyConstant, rubyLiteral, rubyStatements, walkRuby, type RubyAstNode } from "./ast.js";

interface PathContext {
  file: string;
  railsRoot: string | null;
  shadows: Set<string>;
}

interface RubyImport {
  kind: "relative" | "absolute" | "computed";
  source: string;
}

interface RubyGlob {
  kind: "require_glob" | "file_read";
  source: string;
  line: number;
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
  if (node.type === "string") {
    const [first, suffix] = rubyStatements(node);
    if (node.namedChildren.length !== 2 || first?.type !== "interpolation" || first.namedChildCount !== 1
      || suffix?.type !== "string_content" || !suffix.text.startsWith("/") || suffix.text.includes("\\")) return null;
    const base = anchoredPath(first.namedChildren[0], ctx);
    return base === null ? null : posix.join(base, suffix.text.slice(1));
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

/** A path local can only supply the immediately following enumeration. This
 * avoids inferring anything from conditional bindings, aliases or intervening
 * mutations. Both the assignment and enumeration must be sibling statements. */
function globPattern(arg: RubyAstNode, loop: RubyAstNode, ctx: PathContext): string | null {
  if (arg.type !== "identifier") return anchoredPath(arg, ctx);
  let previous = loop.previousNamedSibling;
  while (previous?.type === "comment") previous = previous.previousNamedSibling;
  if (previous?.type !== "assignment" || previous.childForFieldName("left")?.text !== arg.text) return null;
  return anchoredPath(previous.childForFieldName("right"), ctx);
}

function readOfParameter(node: RubyAstNode | null, parameter: string, ctx: PathContext): RubyAstNode | null {
  if (!node) return null;
  if (node.type === "assignment" && node.childForFieldName("left")?.type === "identifier") {
    return readOfParameter(node.childForFieldName("right"), parameter, ctx);
  }
  const call = rubyCall(node);
  if (!call || call.block || node.childForFieldName("operator")?.text === "&.") return null;
  if (call.method === "read" && builtin(call.receiver, "File", ctx) && call.args.length === 1
    && call.args[0].type === "identifier" && call.args[0].text === parameter) return node;
  for (const child of [call.receiver, ...call.args]) {
    const read = readOfParameter(child, parameter, ctx);
    if (read) return read;
  }
  return null;
}

function fileGlob(loop: RubyAstNode, ctx: PathContext): RubyGlob | null {
  const call = rubyCall(loop);
  if (!call?.block) return null;
  let patternArg: RubyAstNode;
  if (call.method === "glob" && builtin(call.receiver, "Dir", ctx) && call.args.length === 1) {
    patternArg = call.args[0];
  } else if (call.method === "each" && !call.args.length) {
    const recv = call.receiver;
    const glob = rubyCall(recv);
    if (glob?.method === "glob" && !glob.block && glob.args.length === 1 && builtin(glob.receiver, "Dir", ctx)) {
      patternArg = glob.args[0];
    } else if (recv?.type === "element_reference" && builtin(recv.childForFieldName("object"), "Dir", ctx)
      && recv.namedChildCount === 2) {
      patternArg = recv.namedChildren[1];
    } else return null;
  } else return null;

  const params = rubyStatements(call.block.childForFieldName("parameters"));
  const first = rubyStatements(call.block.childForFieldName("body"))[0];
  if (params.length !== 1 || params[0].type !== "identifier" || !first) return null;
  const parameter = params[0].text;
  const source = globPattern(patternArg, loop, ctx);
  if (source === null) return null;
  const loader = rubyCall(first);
  if (loader?.method === "require" && !ctx.shadows.has("require")
    && (!loader.receiver || builtin(loader.receiver, "Kernel", ctx)) && !loader.block
    && loader.args.length === 1 && loader.args[0].type === "identifier" && loader.args[0].text === parameter) {
    return {kind:"require_glob", source, line:first.startPosition.row + 1};
  }
  // Only the first expression can establish a read for every yielded path.
  // A second use in that expression could mutate the string before File.read.
  const read = readOfParameter(first, parameter, ctx);
  if (!read) return null;
  let uses = 0;
  walkRuby(first, node => { if (node.type === "identifier" && node.text === parameter) uses++; });
  return uses === 1 ? {kind:"file_read", source, line:read.startPosition.row + 1} : null;
}

export function collectRubyFileLoads(root: RubyAstNode, file: string, railsRoot: string | null): (RubyImport | RubyGlob)[] {
  const imports: (RubyImport | RubyGlob)[] = [];
  const loops: RubyAstNode[] = [];
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
    if (call?.block && (call.method === "each" || call.method === "glob")) loops.push(node);
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
  for (const loop of loops) {
    const glob = fileGlob(loop, ctx);
    if (glob) imports.push(glob);
  }
  return imports;
}

/** Match inventory paths with the literal directory, recursion and extension
 * rules shared by Ruby glob consumers and configuration-provider evidence. */
export function rubyFileGlobMatcher(source: string, rubyOnly = false): ((path: string) => boolean) | null {
  const parts = source.split("/");
  const suffix = /^\*\.([a-zA-Z0-9]+)$/.exec(parts.pop()!);
  if (!suffix || (rubyOnly && suffix[1] !== "rb")) return null;
  const recursive = parts.at(-1) === "**";
  if (recursive) parts.pop();
  if (parts.some(part => !part || part === "." || part === ".." || /[?*{}[\]]/.test(part))) return null;
  const prefix = parts.length ? parts.join("/") + "/" : "";
  return path => {
    if (!path.startsWith(prefix) || !path.endsWith("." + suffix[1])) return false;
    const rest = path.slice(prefix.length).split("/");
    return (recursive || rest.length === 1) && rest.every(part => !part.startsWith("."));
  };
}
