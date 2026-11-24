import { realpathSync, statSync } from "node:fs";
import { isAbsolute, posix, relative, resolve, sep } from "node:path";
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

const ROOT_KEYS = ["config.autoload_paths", "config.autoload_once_paths", "config.eager_load_paths"];
interface RootPath { path: string; expanded?: boolean }
interface ConfigurationContext { projectRoot: string; applicationRootKnown: boolean; engineRoot?: string }

function rootBase(node: RubyAstNode | null, context: ConfigurationContext): string | null {
  const value = chain(node);
  if (value === "Rails.root") return context.applicationRootKnown ? "" : null;
  if (value === "config.root" || value === "root") return context.engineRoot ?? "";
  return null;
}

function rootExpression(node: RubyAstNode, path: string, context: ConfigurationContext, allowLocal = true): RootPath | null {
  const value = rubyLiteral(node);
  if (typeof value === "string" && ["string", "bare_string"].includes(node.type)) return {path:value};
  // Rails' generated legacy configuration uses %W(#{config.root}/extras).
  // Interpret only a leading application-root interpolation plus literal path
  // text. No Ruby expression, escape, glob, or environment variable is evaluated.
  if (["string", "bare_string"].includes(node.type)) {
    const [first, ...rest] = node.namedChildren;
    if (first?.type === "interpolation" && first.namedChildren.length === 1
      && rootBase(first.namedChildren[0], context) !== null
      && rest.length > 0 && rest.every(child => child.type === "string_content")) {
      const suffix = rest.map(child => child.text).join("");
      if (suffix.startsWith("/") && !suffix.includes("\\")) return {path:[rootBase(first.namedChildren[0], context), suffix.slice(1)].filter(Boolean).join("/")};
    }
  }
  const call = rubyCall(node);
  if (call?.method === "join" && rootBase(call.receiver, context) !== null && !call.block && call.args.length) {
    const parts = call.args.map(rubyLiteral);
    if (parts.every(p => typeof p === "string" && !p.startsWith("/"))) return {path:[rootBase(call.receiver, context), ...parts].filter(Boolean).join("/")};
  }
  if (call?.method === "expand_path" && chain(call.receiver) === "File" && !call.block && call.args.length === 2) {
    const value = rubyLiteral(call.args[0]);
    const baseNode = call.args[1];
    const base = baseNode.type === "file" || baseNode.type === "identifier" && baseNode.text === "__FILE__" ? path : rootBase(baseNode, context);
    if (typeof value === "string" && !/^[~/]/.test(value) && !value.includes("\\") && base !== null) {
      return {path:posix.normalize(posix.join(base, value)), expanded:true};
    }
  }
  if (allowLocal && node.type === "identifier") {
    let scope = node.parent;
    while (scope && scope.type !== "class") scope = scope.parent;
    if (!scope) return null;
    const assignments: RubyAstNode[] = [];
    let escaped = false;
    // A local is supported only if assigned once, before use, in this static
    // class body, and used exclusively as an additive loader path. Unknown
    // calls can mutate objects, so they invalidate the binding as well.
    walkRuby(scope, child => {
      if (child !== scope && ["class", "module", "method", "singleton_method"].includes(child.type)) return false;
      if (["assignment", "operator_assignment"].includes(child.type) && child.childForFieldName("left")?.text === node.text) assignments.push(child);
      if (child.type !== "identifier" || child.text !== node.text) return;
      if (child.parent?.childForFieldName("method")?.id === child.id) return;
      if (child.parent?.childForFieldName("left")?.id === child.id && child.parent.type === "assignment") return;
      let consumer = child.parent;
      while (consumer && consumer.id !== scope!.id && !ROOT_KEYS.includes(chain(consumer.childForFieldName("left")) ?? "")) consumer = consumer.parent;
      if (!consumer || consumer.id === scope!.id) escaped = true;
    });
    const assignment = assignments[0];
    if (!escaped && assignments.length === 1 && assignment.type === "assignment" && assignment.startIndex < node.startIndex && withinStaticConfiguration(assignment)) {
      const right = assignment.childForFieldName("right");
      if (right) return rootExpression(right, path, context, false);
    }
  }
  return null;
}

function rootArray(node: RubyAstNode, path: string, context: ConfigurationContext): (RootPath | null)[] {
  if (["array", "string_array"].includes(node.type)) return rubyStatements(node).map(n => rootExpression(n, path, context));
  const map = rubyCall(node);
  const block = map?.args[0];
  const method = block?.type === "block_argument" ? rubyCall(block.namedChildren[0]) : null;
  if (map?.method === "map" && !map.block && map.args.length === 1 && map.receiver
    && ["array", "string_array"].includes(map.receiver.type) && method?.method === "method" && !method.block
    && method.args.length === 1 && rubyLiteral(method.args[0]) === "join" && rootBase(method.receiver, context) !== null) {
    return rubyStatements(map.receiver).map(n => {
      const value = rubyLiteral(n);
      return typeof value === "string" && !value.startsWith("/") ? {path:[rootBase(method.receiver, context), value].filter(Boolean).join("/")} : null;
    });
  }
  return [null];
}

function withinStaticConfiguration(node: RubyAstNode): boolean {
  let inApplication = false;
  let foundClass = false;
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (["if", "unless", "if_modifier", "unless_modifier", "case", "case_match", "conditional", "while", "until", "while_modifier", "until_modifier", "rescue_modifier", "rescue", "ensure", "for", "method", "singleton_method", "do_block", "block", "lambda"].includes(parent.type)) return false;
    if (parent.type === "class" && !foundClass) {
      const base = rubyConstant(parent.childForFieldName("superclass")?.namedChildren[0]);
      // Only the nearest class supplies the config/root receiver.
      inApplication = ["Rails::Application", "Rails::Engine"].includes(base?.replace(/^::/, "") ?? "");
      foundClass = true;
    }
  }
  return inApplication;
}

function isTopLevel(node: RubyAstNode): boolean {
  return node.parent?.type === "program";
}

export function readRubyConfiguration(
  path: string, root: RubyAstNode, config: RubyConfiguration, diagnostics: DependencyDiagnostic[],
  context: ConfigurationContext,
): void {
  const diagnose = (node: RubyAstNode, code: string, message: string, unsafe = true) => {
    diagnostics.push({path, code, message, line: node.startPosition.row + 1});
    if (unsafe) config.unsafe = true;
  };
  const addRoot = (root: RootPath, node: RubyAstNode) => {
    const value = root.path;
    if (!value || value.startsWith("/") || value.includes("\\") || /^[a-z]:/i.test(value) || !root.expanded && value.split("/").includes("..")) {
      diagnose(node, "unsupported_root_path", `Autoload root is outside the supported relative path subset: ${value}`);
      return;
    }
    const normalized = posix.normalize(value).replace(/\/$/, "");
    if (normalized === ".") {
      diagnose(node, "unsupported_root_path", "The entire project cannot be an inferred autoload root");
      return;
    }
    // autoload_paths entries are literal paths, not Dir.glob expressions.
    // Metadata checks may establish an inactive path; never read source beyond
    // the project boundary or suppress an inaccessible/existing external root.
    const absolute = resolve(context.projectRoot, normalized);
    try {
      if (!statSync(absolute).isDirectory()) {
        diagnose(node, "inactive_autoload_root", `Autoload entry is not a directory: ${normalized}`, false);
        return;
      }
      const rel = relative(realpathSync(context.projectRoot), realpathSync(absolute));
      if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
        diagnose(node, "unsupported_root_path", `Existing autoload root escapes the project boundary: ${normalized}`);
        return;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        diagnose(node, "inactive_autoload_root", `Autoload directory does not exist: ${normalized}`, false);
      } else diagnose(node, "unsupported_root_path", `Cannot inspect autoload directory: ${normalized}`);
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
    if (ROOT_KEYS.includes(key ?? "")) {
      const operator = node.childForFieldName("operator")?.text;
      const right = node.childForFieldName("right");
      if (!(path === "config/application.rb" || context.engineRoot !== undefined && /(?:^|\/)engine\.rb$/.test(path)) || !withinStaticConfiguration(node) || !right || !["<<", "+="].includes(operator ?? "")) {
        diagnose(node, "unsupported_autoload_config", "Only unconditional application/engine config << and += root additions are supported");
        return false;
      }
      const values = operator === "<<" ? [rootExpression(right, path, context)] : rootArray(right, path, context);
      if (values.some(v => v === null)) diagnose(node, "unsupported_autoload_config", "Root expressions must be static literal paths, root joins/maps, immutable local paths, or File.expand_path with a known root/__FILE__ base");
      else for (const value of values) addRoot(value!, node);
      return false;
    }
    if (call && ["autoload_lib", "autoload_lib_once"].includes(call.method) && chain(call.receiver) === "config") {
      const options = rubyOptions(call.args);
      const ignore = options?.get("ignore");
      if (path !== "config/application.rb" || !withinStaticConfiguration(node) || call.block || !options || options.size !== 1 || !Array.isArray(ignore) || !ignore.every(p => typeof p === "string" && /^[\w/-]+$/.test(p) && !p.split("/").includes(".."))) {
        diagnose(node, "unsupported_autoload_config", "autoload_lib requires a literal ignore: array in the application class");
      } else {
        addRoot({path:"lib"}, node);
        config.ignored.push(...ignore.map(p => `lib/${p}`));
      }
      return false;
    }
    if (call?.method === "add" && chain(call.receiver) === "config.paths") {
      const value = rubyLiteral(call.args[0]);
      const options = rubyOptions(call.args.slice(1));
      // Rails Paths has no loading flags by default. A file-only glob without
      // flags neither adds autoload roots nor subtracts conventional directories
      // from the parent's eager-load paths. Other path mutations remain unsafe.
      if (withinStaticConfiguration(node) && !call.block && typeof value === "string" && /^app\/[\w/-]+$/.test(value)
        && options?.size === 1 && ["*.rb", "**/*.rb"].includes(options.get("glob") as string)) return false;
      diagnose(node, "unsupported_autoload_config", "Only literal file-only config.paths.add globs without loading flags are supported");
      return false;
    }
    if (node.type === "element_reference" && chain(node.childForFieldName("object")) === "config.paths") {
      const args = node.namedChildren.slice(1);
      // Only the logging path is known not to participate in source loading.
      if (args.length === 1 && rubyLiteral(args[0]) === "log") return false;
    }
    if (call && ["to_a", "first", "last"].includes(call.method) && !call.args.length && !call.block) {
      let receiver = call.receiver;
      while (rubyCall(receiver) && ["to_a", "first", "last"].includes(rubyCall(receiver)!.method) && !rubyCall(receiver)!.args.length && !rubyCall(receiver)!.block) receiver = rubyCall(receiver)!.receiver;
      if (receiver?.type === "element_reference" && chain(receiver.childForFieldName("object")) === "config.paths"
        && receiver.namedChildren.length === 2 && rubyLiteral(receiver.namedChildren[1]) === "log") return false;
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
