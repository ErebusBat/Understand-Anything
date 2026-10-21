import { posix } from "node:path";
import type { RubyAstNode } from "./ast.js";
import { rubyCall, rubyConstant, rubyLiteral, rubyOptions, rubyStatements, walkRuby } from "./ast.js";
import { RubyInflections } from "./inflections.js";
import type { DependencyDiagnostic, RubyAutoloadRoot } from "./types.js";

export interface RubyConfiguration {
  isRails: boolean;
  roots: RubyAutoloadRoot[];
  ignored: string[];
  inflections: RubyInflections;
  unsafe: boolean;
}

/** Recognize applications by actual AST inheritance in config/application.rb,
 * not arbitrary mentions of Rails, an app directory, or capitalized tokens. */
export function detectRailsApplication(root: RubyAstNode): boolean {
  let found = false;
  walkRuby(root, node => {
    if (node.type === "class") {
      const parent = node.childForFieldName("superclass")?.namedChildren[0];
      if (rubyConstant(parent)?.replace(/^::/, "") === "Rails::Application") found = true;
    }
  });
  return found;
}

export function initialRubyConfiguration(paths: string[], isRails: boolean): RubyConfiguration {
  const roots = new Set<string>();
  if (isRails) for (const path of paths) {
    const match = path.match(/^app\/([^/]+)\/(.+)$/);
    if (!match || ["assets", "javascript", "views"].includes(match[1])) continue;
    roots.add(`app/${match[1]}`);
    if (match[2].startsWith("concerns/")) roots.add(`app/${match[1]}/concerns`);
  }
  return {
    isRails,
    roots: [...roots].sort().map(path => ({path, provenance: "Rails app/{*,*/concerns}", kind: "conventional"})),
    ignored: [], inflections: new RubyInflections(), unsafe: false,
  };
}

function chain(node: RubyAstNode | null): string | null {
  if (!node) return null;
  if (["identifier", "constant"].includes(node.type)) return node.text;
  if (node.type === "scope_resolution") return rubyConstant(node);
  const call = rubyCall(node);
  if (!call || call.args.length || call.block) return null;
  const receiver = chain(call.receiver);
  return receiver ? `${receiver}.${call.method}` : call.method;
}

function rootExpression(node: RubyAstNode): string | null {
  const value = rubyLiteral(node);
  if (typeof value === "string" && node.type === "string") return value;
  const call = rubyCall(node);
  if (call?.method === "join" && chain(call.receiver) === "Rails.root" && !call.block && call.args.length) {
    const parts = call.args.map(rubyLiteral);
    if (parts.every(p => typeof p === "string")) return (parts as string[]).join("/");
  }
  return null;
}

function withinStaticApplication(node: RubyAstNode): boolean {
  let inApplication = false;
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (["if", "unless", "if_modifier", "unless_modifier", "case", "case_match", "conditional", "while", "until", "while_modifier", "until_modifier", "rescue_modifier", "rescue", "ensure", "for", "method", "singleton_method", "do_block", "block", "lambda"].includes(parent.type)) return false;
    if (parent.type === "class") {
      const base = rubyConstant(parent.childForFieldName("superclass")?.namedChildren[0]);
      if (base?.replace(/^::/, "") === "Rails::Application") inApplication = true;
    }
  }
  return inApplication;
}

function isTopLevel(node: RubyAstNode): boolean {
  return node.parent?.type === "program";
}

export function readRubyConfiguration(
  path: string, root: RubyAstNode, config: RubyConfiguration, diagnostics: DependencyDiagnostic[],
): void {
  const diagnose = (node: RubyAstNode, code: string, message: string, unsafe = true) => {
    diagnostics.push({path, code, message, line: node.startPosition.row + 1});
    if (unsafe) config.unsafe = true;
  };
  const addRoot = (value: string, node: RubyAstNode) => {
    if (!value || value.startsWith("/") || value.includes("\\") || /^[a-z]:/i.test(value) || value.split("/").includes("..") || /[*?{}[\]]/.test(value)) {
      diagnose(node, "unsupported_root_path", `Autoload root is outside the supported relative path subset: ${value}`);
      return;
    }
    const normalized = posix.normalize(value).replace(/\/$/, "");
    if (normalized === ".") {
      diagnose(node, "unsupported_root_path", "The entire project cannot be an inferred autoload root");
      return;
    }
    config.roots.push({path: normalized, provenance: `${path}:${node.startPosition.row + 1}`, kind: "configured"});
  };
  walkRuby(root, node => {
    const call = rubyCall(node);
    // Inflections have a known global context only in an unconditional,
    // top-level English inflections block in config/initializers.
    if (call?.method === "inflections" && chain(call.receiver)?.replace(/^::/, "") === "ActiveSupport::Inflector") {
      const locale = call.args.length ? rubyLiteral(call.args[0]) : "en";
      const block = call.block;
      const params = rubyStatements(block?.childForFieldName("parameters"));
      if (!isTopLevel(node) || !path.startsWith("config/initializers/") || !block || call.args.length > 1 || locale !== "en" || params.length !== 1 || params[0].type !== "identifier") {
        diagnose(node, "unsupported_inflections", "Only unconditional English literal inflection blocks are supported");
        config.inflections.supported = false;
        return false;
      }
      for (const statement of rubyStatements(block.childForFieldName("body"))) {
        const rule = rubyCall(statement);
        const values = rule?.args.map(rubyLiteral) ?? [];
        let supported = !!rule && chain(rule.receiver) === params[0].text && !rule.block;
        if (supported && rule!.method === "acronym" && values.length === 1 && typeof values[0] === "string" && /^[A-Z]\w*$/.test(values[0])) {
          config.inflections.acronyms.set(values[0].toLowerCase(), values[0]);
        } else if (supported && rule!.method === "irregular" && values.length === 2 && values.every(v => typeof v === "string" && /^[a-z]+$/.test(v))) {
          config.inflections.addIrregular(values[0] as string, values[1] as string);
        } else if (supported && rule!.method === "uncountable" && values.length && values.flat().every(v => typeof v === "string" && /^[a-z]+$/.test(v))) {
          for (const v of values.flat()) config.inflections.uncountable.add(v as string);
        } else {
          supported = false;
        }
        if (!supported) {
          diagnose(statement, "unsupported_inflections", "Dynamic, regex, conditional, or custom inflection rules are unsupported");
          config.inflections.supported = false;
        }
      }
      return false;
    }
    if (call?.method === "inflect" && /^Rails\.autoloaders\.(main|once)\.inflector$/.test(chain(call.receiver) ?? "")) {
      const options = rubyOptions(call.args);
      if (!isTopLevel(node) || !path.startsWith("config/initializers/") || call.block || !options || [...options].some(([k,v]) => !/^[a-z]\w*$/.test(k) || typeof v !== "string" || !/^[A-Z]\w*$/.test(v))) {
        diagnose(node, "unsupported_inflections", "Only unconditional literal basename inflector overrides are supported");
        config.inflections.supported = false;
      } else for (const [key,value] of options) {
        const previous = config.inflections.overrides.get(key);
        if (previous && previous !== value) {
          diagnose(node, "ambiguous_inflections", `Conflicting loader override for ${key}`);
          config.inflections.supported = false;
        }
        config.inflections.overrides.set(key, value as string);
      }
      return false;
    }
    // Inspect the enclosing mutation, not its autoload_paths receiver again.
    const left = node.childForFieldName("left");
    const key = chain(left);
    // This changes $LOAD_PATH exposure, not the Rails/Zeitwerk root set.
    // Explicit requires have their own resolver and are never inferred facts.
    if (key === "config.add_autoload_paths_to_load_path" && node.type === "assignment") return false;
    if ((node.type === "assignment" || node.type === "operator_assignment") && /\bconfig\.(?:paths|autoloader)\b/.test(left?.text ?? "")) {
      diagnose(node, "unsupported_autoload_config", "Custom Rails paths and loader mode changes are unsupported");
      return false;
    }
    if (["config.autoload_paths", "config.autoload_once_paths", "config.eager_load_paths"].includes(key ?? "")) {
      const operator = node.childForFieldName("operator")?.text;
      const right = node.childForFieldName("right");
      if (path !== "config/application.rb" || !withinStaticApplication(node) || !right || !["<<", "+="].includes(operator ?? "")) {
        diagnose(node, "unsupported_autoload_config", "Only unconditional application config << and += root additions are supported");
        return false;
      }
      let values: (string | null)[];
      if (operator === "<<") values = [rootExpression(right)];
      else if (["array", "string_array"].includes(right.type)) values = rubyStatements(right).map(n => right.type === "string_array" ? rubyLiteral(n) as string | null : rootExpression(n));
      else values = [null];
      if (values.some(v => typeof v !== "string")) diagnose(node, "unsupported_autoload_config", "Root expressions must be literal strings, arrays, %w, or Rails.root.join literals");
      else for (const value of values) addRoot(value!, node);
      return false;
    }
    if (call && ["autoload_lib", "autoload_lib_once"].includes(call.method) && chain(call.receiver) === "config") {
      const options = rubyOptions(call.args);
      const ignore = options?.get("ignore");
      if (path !== "config/application.rb" || !withinStaticApplication(node) || call.block || !options || options.size !== 1 || !Array.isArray(ignore) || !ignore.every(p => typeof p === "string" && /^[\w/-]+$/.test(p) && !p.split("/").includes(".."))) {
        diagnose(node, "unsupported_autoload_config", "autoload_lib requires a literal ignore: array in the application class");
      } else {
        addRoot("lib", node);
        config.ignored.push(...ignore.map(p => `lib/${p}`));
      }
      return false;
    }
    if (call && /(?:autoload_paths|autoload_once_paths|eager_load_paths|autoload_lib|autoloaders|inflector|config\.paths)/.test(chain(node) ?? node.childForFieldName("receiver")?.text ?? "")) {
      diagnose(node, "unsupported_autoload_config", "Loader customization or dynamic root configuration is unsupported");
      return false;
    }
    if (node.type === "assignment" && /(?:autoloaders|inflector)/.test(left?.text ?? "")) {
      diagnose(node, "unsupported_inflections", "Executable inflector customization is unsupported");
      config.inflections.supported = false;
      return false;
    }
  });
}
