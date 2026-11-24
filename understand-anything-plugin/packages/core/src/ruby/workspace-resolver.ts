import { realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { TreeSitterPlugin } from "../plugins/tree-sitter-plugin.js";
import { RubyDependencyResolver } from "./resolver.js";
import { extractRailsRouteDependencies } from "./rails-routes.js";
import type { DependencyDiagnostic, DependencyFact, RubyDependencyFailure, RubyInventoryFile } from "./types.js";

interface Context {
  prefix: string;
  resolver: RubyDependencyResolver;
}

const compare = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;

/** Each application's constants and configuration belong to its own root.
 * Rebase only at this boundary; public paths always use the workspace inventory.
 * Engines inside an application stay with their host, while nested applications
 * (including engine dummy apps) get independent contexts. A filename identifies
 * a candidate boundary; the existing AST checks still establish Rails support.
 */
export class RubyWorkspaceDependencyResolver {
  readonly sources = new Map<string, string>();
  readonly failures: RubyDependencyFailure[] = [];
  private readonly projects: Context[] = [];
  private readonly owners = new Map<string, Context>();
  private readonly dependencyCache = new Map<string, DependencyFact[]>();
  private readonly contextDiagnostics: DependencyDiagnostic[] = [];
  private readonly prefixes: string[];

  constructor(private readonly options: { projectRoot: string; files: RubyInventoryFile[]; plugin: TreeSitterPlugin }) {
    const files = [...new Map(options.files.filter(f => f.path.endsWith(".rb")).map(f => [f.path, f])).values()]
      .sort((a, b) => compare(a.path, b.path));
    const applications = new Set<string>();
    for (const {path} of files) {
      const application = path.match(/^(.*\/)?config\/application\.rb$/);
      if (application) applications.add(application[1] ?? "");
    }
    const roots = new Set(applications);
    for (const {path} of files) {
      const engine = path.match(/^(.*?)lib\/(?:[^/]+\/)*engine\.rb$/);
      if (engine && ![...applications].some(prefix => path.startsWith(prefix))) roots.add(engine[1]);
    }
    roots.add(""); // Explicit requires and ordinary Ruby outside Rails projects.
    const prefixes = [...roots].sort((a, b) => b.length - a.length || compare(a, b));
    this.prefixes = prefixes;
    const groups = new Map<string, RubyInventoryFile[]>();
    for (const file of files) {
      const prefix = prefixes.find(prefix => file.path.startsWith(prefix))!;
      const group = groups.get(prefix) ?? [];
      group.push({...file, path: file.path.slice(prefix.length)});
      groups.set(prefix, group);
    }
    const boundary = realpathSync(options.projectRoot);
    for (const [prefix, inventory] of [...groups].sort(([a], [b]) => compare(a, b))) {
      let projectRoot: string;
      try {
        // Do not turn a symlinked nested root into a new, wider read boundary.
        if (prefix && (isAbsolute(prefix) || /^[a-z]:/i.test(prefix) || prefix.includes("\\")
          || prefix.slice(0, -1).split("/").some(part => !part || part === "." || part === ".."))) {
          throw new Error("Unsafe workspace-relative Ruby application root");
        }
        projectRoot = realpathSync(resolve(boundary, prefix));
        const rel = relative(boundary, projectRoot);
        if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
          throw new Error("Ruby application root escapes workspace boundary");
        }
      } catch (error) {
        for (const file of inventory) this.failures.push({path: prefix + file.path, stage: "ruby-file-read", message: error instanceof Error ? error.message : String(error)});
        continue;
      }
      const resolver = new RubyDependencyResolver({projectRoot, files: inventory, plugin: options.plugin});
      const context = {prefix, resolver};
      this.projects.push(context);
      for (const {path} of inventory) this.owners.set(prefix + path, context);
      for (const [path, source] of resolver.sources) this.sources.set(prefix + path, source);
      this.failures.push(...resolver.failures.map(failure => ({...failure, path: failure.path === null ? null : prefix + failure.path})));
      if (resolver.isRails && (resolver.configuration.unsafe || resolver.failures.length)) {
        this.contextDiagnostics.push({
          path: inventory.some(file => file.path === "config/application.rb") ? prefix + "config/application.rb" : null,
          code: "ruby-context-blocked",
          message: `Dependency inference for ${prefix || "."} is disabled by read/parse failures or unsupported autoload configuration in this context. Other applications are resolved independently.`,
        });
      }
    }
    this.failures.sort((a, b) => compare(a.path ?? "", b.path ?? "") || compare(a.stage, b.stage));
  }

  get contexts(): { root: string; isRails: boolean; blocked: boolean }[] {
    return this.projects.map(({prefix, resolver}) => ({
      root: prefix.slice(0, -1) || ".", isRails: resolver.isRails,
      blocked: resolver.configuration.unsafe || resolver.failures.length > 0,
    }));
  }

  /** Also scopes explicit require probes in extensionless Ruby and Rake files. */
  rootPrefixFor(path: string): string {
    return this.prefixes.find(prefix => path.startsWith(prefix)) ?? "";
  }

  get diagnostics(): DependencyDiagnostic[] {
    const all = [...this.contextDiagnostics, ...this.projects.flatMap(({prefix, resolver}) =>
      resolver.diagnostics.map(d => ({...d, path: d.path === null ? null : prefix + d.path})))];
    return [...new Map(all.map(d => [JSON.stringify(d), d])).values()].sort((a, b) =>
      compare(a.path ?? "", b.path ?? "") || (a.line ?? 0) - (b.line ?? 0)
      || compare(a.code, b.code) || compare(a.message, b.message));
  }

  getDependencies(path: string): DependencyFact[] {
    const cached = this.dependencyCache.get(path);
    if (cached) return cached;
    const context = this.owners.get(path);
    if (!context) return [];
    const {prefix, resolver} = context;
    const localPath = path.slice(prefix.length);
    const facts = [...resolver.getDependencies(localPath)];
    const source = resolver.sources.get(localPath);
    if (source !== undefined && resolver.isRails && /(^|\/)config\/routes\.rb$/.test(localPath)) {
      const routes = extractRailsRouteDependencies({
        path: localPath, source, applicationSource: resolver.sources.get("config/application.rb"), plugin: this.options.plugin, resolver,
      });
      facts.push(...routes.dependencies);
      resolver.diagnostics.push(...routes.diagnostics);
    }
    const result = facts.map(fact => ({...fact, target: prefix + fact.target})).sort((a, b) =>
      compare(a.target, b.target) || compare(a.type, b.type) || compare(a.kind, b.kind)
      || compare(a.reference ?? "", b.reference ?? "") || (a.line ?? 0) - (b.line ?? 0));
    this.dependencyCache.set(path, result);
    return result;
  }
}

export function createRubyWorkspaceDependencyResolver(options: { projectRoot: string; files: RubyInventoryFile[]; plugin: TreeSitterPlugin }): RubyWorkspaceDependencyResolver {
  return new RubyWorkspaceDependencyResolver(options);
}
