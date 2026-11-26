import { readFileSync } from "node:fs";
import type { TreeSitterPlugin } from "../plugins/tree-sitter-plugin.js";
import { rubyCall, rubyLiteral, walkRuby } from "./ast.js";
import { safeRubySourcePath } from "./resolver.js";
import type { DependencyDiagnostic, DependencyFact, RubyDependencyFailure, RubyInventoryFile } from "./types.js";

type Definition = {path: string; line: number; pattern: RegExp | null; prefix: string};
const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Deliberately small, linear regexp subset shared by Ruby and JavaScript.
 * Unsupported patterns remain possible competitors based on their literal
 * prefix. Never execute Ruby or evaluate interpolation. */
function regexp(source: string): {pattern: RegExp | null; prefix: string} {
  const body = source.startsWith("/^") ? source.slice(2, source.endsWith("$/") ? -2 : -1) : "";
  let translated = "", prefix = "", literal = true;
  if (!source.startsWith("/^") || !source.endsWith("$/")) return {pattern: null, prefix};
  let depth = 0;
  for (let i = 0; i < body.length; i++) {
    if (body[i] === "\\") { i++; continue; }
    if (body[i] === "(") depth++;
    if (body[i] === ")") depth--;
    if (body[i] === "|" && depth === 0) return {pattern: null, prefix: ""};
  }
  const tokens = ["(?:|I )", "(?:I am )?", "(.*?)", "(.+?)", "([^:]+)", "([^\\/]*)", "([^\"]*)", "([^\"]+)", "(.*)", "(.+)", "(\\d+)", "(\\d*)"];
  for (let i = 0; i < body.length;) {
    const token = tokens.find(token => body.startsWith(token, i));
    if (token) { translated += token; literal = false; i += token.length; continue; }
    const char = body[i++];
    if (char === "\\" && i < body.length && /["'\/.$^()[\]{}*+?|\\-]/.test(body[i])) {
      const value = body[i++];
      translated += escape(value);
      if (literal) prefix += value;
    } else if (/[.*+?^$()[\]{}|\\]/.test(char)) return {pattern: null, prefix: char === "|" ? "" : /[?*{]/.test(char) ? prefix.slice(0, -1) : prefix};
    else { translated += escape(char); if (literal) prefix += char; }
  }
  return {pattern: new RegExp("^" + translated + "$"), prefix};
}

export class CucumberSteps {
  readonly diagnostics: DependencyDiagnostic[] = [];
  private readonly definitions = new Map<string, Definition[]>();
  private readonly sources = new Map<string, string>();
  private readonly prefixes: string[];

  constructor(files: RubyInventoryFile[], projectRoot: string, plugin: TreeSitterPlugin, failures: RubyDependencyFailure[]) {
    const prefixes = new Set([""]);
    for (const {path} of files) {
      const prefix = path.match(/^(.+\/)(?:[^/]+\.gemspec|Gemfile|\.rspec|config\/application\.rb)$/)?.[1];
      if (prefix) prefixes.add(prefix);
    }
    this.prefixes = [...prefixes].sort((a, b) => b.length - a.length || a.localeCompare(b));
    for (const {path} of [...files].sort((a, b) => a.path.localeCompare(b.path))) {
      const suite = this.suite(path), local = path.slice(suite.length);
      if (!/^features\/(?:.*\.feature|step_definitions\/.*\.rb)$/.test(local)) continue;
      try {
        const source = readFileSync(safeRubySourcePath(projectRoot, path), "utf8");
        if (path.endsWith(".feature")) { this.sources.set(path, source); continue; }
        plugin.withSyntaxTree(path, source, root => {
          walkRuby(root, node => {
            const call = rubyCall(node);
            if (!call || call.receiver || !call.block || call.args.length !== 1 || !["Given", "When", "Then", "And", "But"].includes(call.method)) return;
            const arg = call.args[0], value = rubyLiteral(arg);
            const expression = arg.type === "string" && typeof value === "string" && !/[{}]/.test(value)
              ? {pattern: new RegExp("^" + escape(value) + "$"), prefix: value}
              : arg.type === "regex" ? regexp(arg.text) : {pattern: null, prefix: ""};
            if (node.parent?.type !== "program") expression.pattern = null;
            const definitions = this.definitions.get(suite) ?? [];
            definitions.push({path, line: node.startPosition.row + 1, ...expression});
            this.definitions.set(suite, definitions);
            if (!expression.pattern) this.diagnostics.push({path, line: node.startPosition.row + 1,
              code: "unsupported_cucumber_pattern", message: "Step definition is outside the literal/anchored simple regexp subset; it remains a possible competitor."});
          });
        });
      } catch (error) {
        failures.push({path, stage: "cucumber-read-parse", message: error instanceof Error ? error.message : String(error)});
        // An unreadable definition could match any step in this suite.
        if (path.endsWith(".rb")) {
          const definitions = this.definitions.get(suite) ?? [];
          definitions.push({path, line: 1, pattern: null, prefix: ""});
          this.definitions.set(suite, definitions);
        }
      }
    }
  }

  private suite(path: string): string { return this.prefixes.find(prefix => path.startsWith(prefix))!; }

  dependencies(path: string): DependencyFact[] {
    const source = this.sources.get(path);
    if (source === undefined) return [];
    const facts: DependencyFact[] = [];
    const definitions = this.definitions.get(this.suite(path)) ?? [];
    let docString = false, inScenario = false;
    source.split(/\r?\n/).forEach((text, index) => {
      if (/^\s*(?:"""|```)/.test(text)) { docString = !docString; return; }
      if (docString) return;
      if (/^\s*(?:Scenario(?: Outline| Template)?|Example|Background):/.test(text)) inScenario = true;
      if (/^\s*(?:Feature|Rule|Examples|Scenarios):/.test(text)) inScenario = false;
      const step = inScenario && /^\s*(?:Given|When|Then|And|But|\*)\s+(.+?)\s*$/.exec(text);
      if (!step) return;
      const reference = step[1], line = index + 1;
      const candidates = definitions.filter(def => def.pattern ? def.pattern.test(reference) : reference.startsWith(def.prefix));
      // Outline values require expansion; a placeholder is not execution text.
      if (reference.includes("<") || candidates.length !== 1 || !candidates[0].pattern) {
        const code = reference.includes("<") ? "unsupported_cucumber_outline" : candidates.length ? "ambiguous_cucumber_step" : "unmatched_cucumber_step";
        this.diagnostics.push({path, line, code, message: `${reference}: ${candidates.length} possible definitions in owning suite`});
        return;
      }
      facts.push({target: candidates[0].path, type: "depends_on", kind: "cucumber_step", line,
        reference, resolution: "inferred"});
    });
    return facts;
  }
}
