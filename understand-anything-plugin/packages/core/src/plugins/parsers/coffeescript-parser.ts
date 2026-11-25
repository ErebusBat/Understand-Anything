import { createRequire } from "node:module";
import type { AnalyzerPlugin, StructuralAnalysis } from "../../types.js";

interface Location {
  first_line: number;
  last_line: number;
  first_column: number;
  last_column: number;
}

interface CoffeeNode {
  locationData: Location;
  eachChild(visit: (child: CoffeeNode) => void): void;
  // Fields depend on the AST node class.
  base?: CoffeeNode;
  properties?: CoffeeNode[];
  expressions?: CoffeeNode[];
  name?: CoffeeNode;
  variable?: CoffeeNode;
  value?: CoffeeNode;
  body?: CoffeeNode;
  params?: CoffeeNode[];
  context?: string;
}

type Token = [string, string, Location];
interface TokenStream {
  tokens: Token[];
  index: number;
  yytext?: string;
  yylloc?: Location;
  yylineno?: number;
  setInput(tokens: Token[]): void;
  lex(): string;
}

const require = createRequire(import.meta.url);
// Use the official lexer and generated parser directly. The Node compiler
// entry point also installs require hooks and replaces Error.prepareStackTrace.
const { Lexer } = require("coffeescript/lib/coffee-script/lexer") as {
  Lexer: new () => { tokenize(source: string): Token[] };
};
const { Parser } = require("coffeescript/lib/coffee-script/parser") as {
  Parser: new () => { yy: object; lexer: TokenStream; parse(tokens: Token[]): CoffeeNode };
};
const parser = new Parser();
parser.yy = require("coffeescript/lib/coffee-script/nodes");
parser.lexer = {
  tokens: [], index: 0,
  setInput(tokens) { this.tokens = tokens; this.index = 0; },
  lex() {
    const token = this.tokens[this.index++];
    if (!token) return "";
    this.yytext = token[1];
    this.yylloc = token[2];
    this.yylineno = this.yylloc.first_line;
    return token[0];
  },
};

function staticName(node: CoffeeNode | undefined, sourceOf: (node: CoffeeNode) => string): string | undefined {
  if (node?.constructor.name !== "Value" || !node.base) return undefined;
  if (!["IdentifierLiteral", "PropertyName", "ThisLiteral", "StringLiteral"].includes(node.base.constructor.name)) return undefined;
  if (node.properties?.some(property => property.constructor.name !== "Access" || property.name?.constructor.name !== "PropertyName")) return undefined;
  // A Value's own location can cover just its base. Access nodes retain
  // the remaining source spelling, including CoffeeScript's :: and @ forms.
  return sourceOf(node.base) + (node.properties ?? []).map(sourceOf).join("");
}

export class CoffeeScriptParser implements AnalyzerPlugin {
  name = "coffeescript-parser";
  languages = ["coffeescript"];

  analyzeFile(_path: string, content: string): StructuralAnalysis | null {
    let root: CoffeeNode;
    try {
      root = parser.parse(new Lexer().tokenize(content));
    } catch {
      return null;
    }
    const structure: StructuralAnalysis = { classes: [], functions: [], imports: [], exports: [] };
    const lineStarts = [0];
    for (let i = content.indexOf("\n"); i >= 0; i = content.indexOf("\n", i + 1)) lineStarts.push(i + 1);
    const sourceOf = (node: CoffeeNode) => {
      const loc = node.locationData;
      return content.slice(lineStarts[loc.first_line] + loc.first_column, lineStarts[loc.last_line] + loc.last_column + 1);
    };
    const range = (node: CoffeeNode): [number, number] =>
      [node.locationData.first_line + 1, node.locationData.last_line + 1];
    const methodOwners = new Map<CoffeeNode, string>();

    function visit(node: CoffeeNode, parent?: CoffeeNode) {
      if (node.constructor.name === "Class") {
        const lhs = parent?.constructor.name === "Assign" && parent.value === node ? parent.variable : undefined;
        const name = staticName(node.variable ?? lhs, sourceOf);
        if (name) {
          const cls: StructuralAnalysis["classes"][number] = { name, lineRange: range(node), methods: [], properties: [] };
          for (const item of node.body?.expressions ?? []) {
            if (item.base?.constructor.name !== "Obj") continue;
            for (const member of item.base.properties ?? []) {
              const key = staticName(member.variable, sourceOf);
              if (!key) continue;
              if (member.value?.constructor.name === "Code") {
                cls.methods.push(key);
                methodOwners.set(member, name);
              } else {
                cls.properties.push(key);
              }
            }
          }
          structure.classes.push(cls);
        }
      }
      if (node.constructor.name === "Assign" && node.value?.constructor.name === "Code") {
        const name = staticName(node.variable, sourceOf);
        if (name) structure.functions.push({
          name, lineRange: range(node), params: (node.value.params ?? []).map(sourceOf),
          owner: methodOwners.get(node) ?? (node.context === "object" ? null : ""),
        });
      }
      node.eachChild(child => visit(child, node));
    }
    visit(root);
    return structure;
  }
}
