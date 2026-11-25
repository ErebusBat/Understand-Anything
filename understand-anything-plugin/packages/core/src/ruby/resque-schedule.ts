import { readFileSync } from "node:fs";
import { posix, resolve } from "node:path";
import { isAlias, isMap, isNode, isScalar, LineCounter, parseDocument, visit, type YAMLMap } from "yaml";
import type { TreeSitterPlugin } from "../plugins/tree-sitter-plugin.js";
import { rubyCall, rubyConstant, rubyLiteral, rubyStatements, walkRuby, type RubyAstNode } from "./ast.js";
import { collectRubyFileLoads, rubyFileGlobMatcher } from "./file-loads.js";
import { safeRubySourcePath, type RubyDependencyResolver } from "./resolver.js";
import type { DependencyFact } from "./types.js";

export const isResqueSchedulePath = (path: string): boolean =>
  /(?:^|\/)config\/(?:[^/]+\/)*(?:resque|resque[_-]schedule|schedule)\.ya?ml$/.test(path);

interface Binding {
  path: string;
  sections: boolean;
}

/** Match the initializer's explicit YAML path, or a named configuration
 * accessor whose own Ruby provider reads that unique YAML file. */
function bindingFor(value: RubyAstNode | null, paths: string[], resolver: RubyDependencyResolver, plugin: TreeSitterPlugin): Binding | null {
  let call = rubyCall(value);
  while (call && ["to_hash", "with_indifferent_access"].includes(call.method) && !call.args.length && !call.block) {
    call = rubyCall(call.receiver);
  }
  if (!call || call.block) return null;
  if (call.method === "load_file" && rubyConstant(call.receiver)?.replace(/^::/, "") === "YAML" && call.args.length === 1) {
    const arg = call.args[0];
    let path = arg.type === "string" ? rubyLiteral(arg) : null;
    const join = rubyCall(arg), root = rubyCall(join?.receiver);
    if (join?.method === "join" && !join.block && join.args.length && root?.method === "root"
      && !root.block && !root.args.length && rubyConstant(root.receiver)?.replace(/^::/, "") === "Rails") {
      const parts = join.args.map(part => part.type === "string" ? rubyLiteral(part) : null);
      if (parts.every((p): p is string => typeof p === "string" && /^[\w.-]+(?:\/[\w.-]+)*$/.test(p))) {
        path = parts.join("/");
      }
    }
    return typeof path === "string" && paths.includes(path) ? {path, sections:false} : null;
  }
  const section = rubyCall(call.receiver);
  if (call.method !== "schedule" || call.args.length || !section || section.args.length || section.block) return null;
  const providerName = rubyConstant(section.receiver);
  if (!providerName) return null;
  const provider = resolver.resolveConstant("::" + providerName.replace(/^::/, ""));
  const source = provider && resolver.sources.get(provider);
  if (!provider || !source) return null;
  const candidates = paths.filter(path => posix.basename(path).replace(/\.ya?ml$/, "") === section.method);
  const reads = plugin.withSyntaxTree(provider, source, root => collectRubyFileLoads(root, provider, "")
    .filter(load => load.kind === "file_read").map(load => rubyFileGlobMatcher(load.source)));
  const matched = candidates.filter(path => reads.some(matches => matches?.(path)));
  return matched.length === 1 ? {path:matched[0], sections:true} : null;
}

function bindings(paths: string[], resolver: RubyDependencyResolver, plugin: TreeSitterPlugin): Binding | null {
  const gemfile = resolver.sources.get("Gemfile");
  if (!gemfile || !plugin.withSyntaxTree("Gemfile", gemfile, root => rubyStatements(root).some(node => {
    const call = rubyCall(node);
    return call?.method === "gem" && !call.receiver && !call.block && call.args[0]?.type === "string"
      && rubyLiteral(call.args[0]) === "resque-scheduler" && call.args.slice(1).every(arg => arg.type === "string");
  }))) return null;

  const found: (Binding | null)[] = [];
  for (const [path, source] of resolver.sources) {
    if (!path.startsWith("config/initializers/") || !source.includes("schedule")) continue;
    plugin.withSyntaxTree(path, source, root => walkRuby(root, node => {
      if (node.type !== "assignment") return;
      const left = rubyCall(node.childForFieldName("left"));
      if (left?.method === "schedule" && rubyConstant(left.receiver)?.replace(/^::/, "") === "Resque") {
        let scope = node.parent;
        while (scope && !["class", "module", "method", "singleton_method", "lambda", "block", "do_block"].includes(scope.type)) scope = scope.parent;
        found.push(scope ? null : bindingFor(node.childForFieldName("right"), paths, resolver, plugin));
      }
    }));
  }
  return found.length === 1 ? found[0] : null;
}

function scheduleFacts(source: string, binding: Binding, resolver: RubyDependencyResolver): DependencyFact[] {
  const unsupported = (message: string): DependencyFact[] => {
    resolver.diagnostics.push({path:binding.path, code:"unsupported_resque_schedule", message});
    return [];
  };
  if (source.includes("<%")) return unsupported("ERB prevents static resolution of the Resque schedule");
  const lines = new LineCounter();
  const document = parseDocument(source, {lineCounter:lines, schema:"core"});
  if (document.errors.length || document.warnings.length || !isMap(document.contents)) return unsupported("Expected a single YAML mapping with unique keys");
  let unsafe = false;
  visit(document, (_key, node) => { if (isAlias(node) || (isNode(node) && node.tag) || (isScalar(node) && node.value === "<<")) unsafe = true; });
  if (unsafe) return unsupported("Aliases, tags and merge keys are unsupported in Resque schedules");

  const facts: DependencyFact[] = [];
  const jobs = (map: YAMLMap, section?: string) => {
    for (const {key, value} of map.items) {
      if (!isScalar(key) || typeof key.value !== "string" || !key.range || !isMap(value)) continue;
      if (value.has("custom_job_class") || !["cron","every"].some(field => typeof value.get(field) === "string")) continue;
      const name = value.has("class") ? value.get("class") : key.value;
      if (typeof name !== "string" || !/^(?:::)?[A-Z]\w*(?:::[A-Z]\w*)*$/.test(name)) continue;
      const target = resolver.resolveScheduledJob(name.replace(/^::/, ""));
      if (!target) continue;
      const label = section ? section + "." + key.value : key.value;
      facts.push({target, type:"depends_on", kind:"resque_schedule", reference:label + " => " + name,
        line:lines.linePos(key.range[0]).line, resolution:"inferred"});
    }
  };
  if (binding.sections) {
    for (const {key, value} of document.contents.items) {
      if (!isScalar(key) || typeof key.value !== "string" || !isMap(value)) continue;
      const schedule = value.get("schedule", true);
      if (isMap(schedule)) jobs(schedule, key.value);
    }
  } else jobs(document.contents);
  return facts;
}

export function resqueScheduleDependencies(paths: string[], projectRoot: string, resolver: RubyDependencyResolver, plugin: TreeSitterPlugin): Map<string, DependencyFact[]> {
  const result = new Map<string, DependencyFact[]>();
  if (!paths.length || !resolver.applicationRootKnown || resolver.inferenceBlocked) return result;
  const binding = bindings(paths, resolver, plugin);
  if (!binding) return result;
  try {
    const path = safeRubySourcePath(projectRoot, binding.path);
    if (path === resolve(projectRoot, binding.path)) {
      result.set(binding.path, scheduleFacts(readFileSync(path, "utf8"), binding, resolver));
    }
  } catch (error) {
    resolver.failures.push({path:binding.path, stage:"resque-schedule-read", message:error instanceof Error ? error.message : String(error)});
  }
  return result;
}
