import type { TreeSitterPlugin } from "../plugins/tree-sitter-plugin.js";
import { rubyCall, rubyLiteral, rubyStatements, type RubyAstNode } from "./ast.js";

interface Expression {
  code: string;
  line: number;
}

function* erbExpressions(source: string): Generator<Expression> {
  let line = 1, offset = 0;
  for (const tag of source.matchAll(/<%([\s\S]*?)%>/g)) {
    line += source.slice(offset, tag.index).split("\n").length - 1;
    offset = tag.index;
    // Match entire tags so escaped output (<%%=) and ERB comments cannot
    // contribute snippets that merely contain the text of an output tag.
    const output = /^=(\s*)(render\b[\s\S]*)$/.exec(tag[1]);
    if (output) yield {code: output[2].replace(/-$/, ""), line: line + output[1].split("\n").length - 1};
  }
}

function* indentedExpressions(path: string, source: string): Generator<Expression> {
  const lines = source.split(/\r?\n/);
  const slim = path.endsWith(".slim");
  let ignoredIndent: number | null = null;
  for (let i = 0; i < lines.length; i++) {
    const content = lines[i].trimStart();
    if (!content) continue;
    const indent = lines[i].length - content.length;
    if (ignoredIndent !== null && indent > ignoredIndent) continue;
    // Haml silent comments/filters and Slim comments/embedded engines/plain
    // text own their indented bodies. Their contents are not output tags.
    if (slim ? /^(?:\/|[|']|[\w-]+:(?:\s|$))/.test(content) : /^(?:-#|\/|:[\w-]+\s*$)/.test(content)) {
      ignoredIndent = indent;
      continue;
    }
    ignoredIndent = null;
    const output = /^=\s*(render\b.*)$/.exec(content);
    if (!output) continue;
    const line = i + 1;
    let code = output[1];
    while (code.trimEnd().endsWith(",") && i + 1 < lines.length) {
      const next = lines[i + 1];
      if (next.length - next.trimStart().length <= indent) break;
      code += "\n" + next;
      i++;
    }
    yield {code, line};
  }
}

function literalPartial(node: RubyAstNode): string | null {
  const call = rubyCall(node);
  if (call?.method !== "render" || call.receiver || call.block) return null;
  const [first, ...rest] = call.args;
  if (!first) return null;
  let name: unknown;
  if (first.type === "string") {
    // The second argument to a view's render("path", locals) supplies locals.
    if (!rest.every(arg => ["hash", "pair"].includes(arg.type))) return null;
    name = rubyLiteral(first);
  } else {
    const options = call.args.flatMap(arg => arg.type === "hash" ? rubyStatements(arg) : [arg]);
    const seen = new Set<string>();
    for (const pair of options) {
      if (pair.type !== "pair") return null;
      const key = rubyLiteral(pair.childForFieldName("key"));
      if (typeof key !== "string" || !["partial", "locals", "collection", "object", "as"].includes(key) || seen.has(key)) return null;
      seen.add(key);
      if (key === "partial") {
        const value = pair.childForFieldName("value");
        if (value?.type === "string") name = rubyLiteral(value);
      }
    }
  }
  return typeof name === "string" && /^(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+$/.test(name) ? name : null;
}

/** Read standalone Ruby output expressions; markup, strings and dynamic
 * options cannot supply a partial path. No template handler is executed. */
export function* templatePartials(plugin: TreeSitterPlugin, path: string, source: string): Generator<{name: string; line: number}> {
  const expressions = path.endsWith(".erb") ? erbExpressions(source) : indentedExpressions(path, source);
  for (const {code, line} of expressions) {
    let name;
    try {
      name = plugin.withSyntaxTree("template.rb", code, root => {
        const statements = rubyStatements(root);
        return statements.length === 1 ? literalPartial(statements[0]) : null;
      });
    } catch {
      // Multi-statement template control flow and handler-specific syntax
      // can span markup boundaries and do not form standalone Ruby calls.
      continue;
    }
    if (name) yield {name, line};
  }
}
