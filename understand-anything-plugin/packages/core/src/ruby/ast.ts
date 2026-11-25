export type RubyAstNode = import("web-tree-sitter").Node;
export type RubyLiteral = string | boolean | number | null | RubyLiteral[];

export function rubyStatements(node: RubyAstNode | null | undefined): RubyAstNode[] {
  return node?.namedChildren.filter(child => child.type !== "comment") ?? [];
}

export function rubySelfSingletonClass(node: RubyAstNode | null | undefined): boolean {
  return node?.type === "singleton_class" && node.childForFieldName("value")?.type === "self";
}

/** "class << self; def foo" and "def self.foo" have the same receiver. */
export function rubyMethodName(node: RubyAstNode): string | null {
  const name = node.childForFieldName("name")?.text;
  if (!name) return null;
  const singletonBody = node.parent?.type === "body_statement" && rubySelfSingletonClass(node.parent.parent);
  return node.type === "singleton_method" || singletonBody ? `self.${name}` : name;
}

/** Return false from visit to skip descendants. Nodes are valid only inside
 * TreeSitterPlugin.withSyntaxTree's callback. */
export function walkRuby(node: RubyAstNode, visit: (node: RubyAstNode) => void | boolean): void {
  if (visit(node) === false) return;
  for (const child of rubyStatements(node)) walkRuby(child, visit);
}

export function rubyConstant(node: RubyAstNode | null | undefined): string | null {
  if (!node || !["constant", "scope_resolution"].includes(node.type)) return null;
  const text = node.text.replace(/\s+/g, "");
  return /^(?:::)?[A-Z]\w*(?:::[A-Z]\w*)*$/.test(text) ? text : null;
}

/** Deliberately rejects escapes/interpolation instead of evaluating Ruby. */
export function rubyLiteral(node: RubyAstNode | null | undefined): RubyLiteral | undefined {
  if (!node) return undefined;
  if (["string", "bare_string"].includes(node.type)) {
    if (node.namedChildren.some(c => c.type !== "string_content")) return undefined;
    const text = node.namedChildren.map(c => c.text).join("");
    return text.includes("\\") ? undefined : text;
  }
  if (node.type === "simple_symbol") return node.text.slice(1);
  if (node.type === "hash_key_symbol") return node.text;
  if (node.type === "true") return true;
  if (node.type === "false") return false;
  if (node.type === "nil") return null;
  if (node.type === "integer" && /^\d+$/.test(node.text)) return Number(node.text);
  if (["array", "string_array"].includes(node.type)) {
    const values = rubyStatements(node).map(rubyLiteral);
    return values.every(v => v !== undefined) ? values as RubyLiteral[] : undefined;
  }
  return undefined;
}

export function rubyCall(node: RubyAstNode | null | undefined): {
  method: string;
  receiver: RubyAstNode | null;
  args: RubyAstNode[];
  block: RubyAstNode | null;
} | null {
  if (!node || node.type !== "call") return null;
  const method = node.childForFieldName("method")?.text;
  if (!method) return null;
  return {
    method,
    receiver: node.childForFieldName("receiver"),
    args: rubyStatements(node.childForFieldName("arguments")),
    block: node.childForFieldName("block"),
  };
}

/** Static options only. A splat, nonliteral value or duplicate key rejects the
 * entire option set. The caller decides which literal options it supports. */
export function rubyOptions(nodes: RubyAstNode[], readValue: (key: string, value: RubyAstNode) => RubyLiteral | undefined =
  (_key, value) => rubyLiteral(value)): Map<string, RubyLiteral> | null {
  const result = new Map<string, RubyLiteral>();
  for (const node of nodes.flatMap(n => n.type === "hash" ? rubyStatements(n) : [n])) {
    if (node.type !== "pair") return null;
    const key = rubyLiteral(node.childForFieldName("key"));
    const valueNode = node.childForFieldName("value");
    if (typeof key !== "string" || !valueNode || result.has(key)) return null;
    const value = readValue(key, valueNode);
    if (value === undefined) return null;
    result.set(key, value);
  }
  return result;
}
