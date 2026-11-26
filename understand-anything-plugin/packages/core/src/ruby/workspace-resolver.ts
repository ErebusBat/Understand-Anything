import { realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { RubyDependencyResolver, type RubyDependencyResolverOptions } from "./resolver.js";
import { isResqueSchedulePath, resqueScheduleDependencies } from "./resque-schedule.js";
import { RailsViewResolver } from "./rails-views.js";
import { extractRailsRouteDependencies } from "./rails-routes.js";
import type { DependencyDiagnostic, DependencyFact, RubyDependencyFailure, RubyInventoryFile } from "./types.js";

interface Context {
  prefix: string;
  resolver: RubyDependencyResolver;
  views: RailsViewResolver;
  schedules: Map<string, DependencyFact[]>;
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

  constructor(private readonly options: RubyDependencyResolverOptions) {
    const files = [...new Map(options.files.filter(f => f.path.endsWith(".rb") || f.language === "ruby" || /(?:^|\/)\.rspec$/.test(f.path)).map(f => [f.path, f])).values()]
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
    const schedulePaths = new Map<string, string[]>();
    const viewPaths = new Map<string, Set<string>>();
    const yamlFiles = new Map<string, RubyInventoryFile[]>();
    for (const file of options.files) {
      if (file.path.endsWith(".yml") && file.language !== "ruby") {
        const prefix = this.rootPrefixFor(file.path);
        if (!yamlFiles.has(prefix)) yamlFiles.set(prefix, []);
        yamlFiles.get(prefix)!.push({...file, path: file.path.slice(prefix.length)});
      }
      if (isResqueSchedulePath(file.path)) {
        const prefix = this.rootPrefixFor(file.path);
        const localPath = file.path.slice(prefix.length);
        if (localPath.startsWith("config/")) {
          if (!schedulePaths.has(prefix)) schedulePaths.set(prefix, []);
          schedulePaths.get(prefix)!.push(localPath);
        }
      }
      if (!file.path.includes("app/views/")) continue;
      const prefix = this.rootPrefixFor(file.path);
      const path = file.path.slice(prefix.length);
      if (!path.startsWith("app/views/")) continue;
      if (!viewPaths.has(prefix)) viewPaths.set(prefix, new Set());
      viewPaths.get(prefix)!.add(path);
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
      const resolver = new RubyDependencyResolver({...options, projectRoot, files: [...inventory, ...(yamlFiles.get(prefix) ?? [])]});
      const views = new RailsViewResolver([...(viewPaths.get(prefix) ?? [])], projectRoot, resolver, options.plugin);
      const schedules = resqueScheduleDependencies(schedulePaths.get(prefix) ?? [], projectRoot, resolver, options.plugin);
      const context = {prefix, resolver, views, schedules};
      this.projects.push(context);
      for (const path of schedules.keys()) this.owners.set(prefix + path, context);
      for (const {path} of inventory) this.owners.set(prefix + path, context);
      for (const path of viewPaths.get(prefix) ?? []) this.owners.set(prefix + path, context);
      for (const [path, source] of resolver.sources) this.sources.set(prefix + path, source);
      this.failures.push(...resolver.failures.map(failure => ({...failure, path: failure.path === null ? null : prefix + failure.path})));
      if (resolver.isRails && resolver.inferenceBlocked) {
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
      blocked: resolver.inferenceBlocked,
    }));
  }

  /** Also scopes explicit require probes in extensionless Ruby and Rake files. */
  rootPrefixFor(path: string): string {
    return this.prefixes.find(prefix => path.startsWith(prefix)) ?? "";
  }

  /** Rails.root belongs to the host application, including code inside a hosted engine. */
  railsRootFor(path: string): string | null {
    const owner = this.owners.get(path);
    return owner?.resolver.applicationRootKnown ? owner.prefix : null;
  }

  /** Rails searches autoload_paths before Ruby's load path. The configured
   * root list is unordered, so several matching files cannot select a winner. */
  requireDependencyTargets(path: string, feature: string): string[] | null {
    const owner = this.owners.get(path);
    if (!owner?.resolver.isRails || owner.resolver.inferenceBlocked) return null;
    return [...new Set(owner.resolver.configuration.roots
      .map(root => owner.prefix + root.path + "/" + feature)
      .filter(target => this.owners.get(target) === owner && this.sources.has(target)))];
  }

  get diagnostics(): DependencyDiagnostic[] {
    const all = [...this.contextDiagnostics, ...this.projects.flatMap(({prefix, resolver}) =>
      resolver.diagnostics.map(d => ({
        ...d, path: d.path === null ? null : prefix + d.path,
        ...(d.candidateTarget ? {candidateTarget: prefix + d.candidateTarget} : {}),
      })))];
    return [...new Map(all.map(d => [JSON.stringify(d), d])).values()].sort((a, b) =>
      compare(a.path ?? "", b.path ?? "") || (a.line ?? 0) - (b.line ?? 0)
      || compare(a.code, b.code) || compare(a.message, b.message));
  }

  getMethodCalls(path: string) {
    const context = this.owners.get(path);
    if (!context) return [];
    const {prefix, resolver} = context;
    return resolver.getMethodCalls(path.slice(prefix.length)).map(fact => ({...fact,
      ...(fact.target ? {target: prefix + fact.target} : {}),
      ...(fact.receiverTarget ? {receiverTarget: prefix + fact.receiverTarget} : {}),
    }));
  }

  getDependencies(path: string): DependencyFact[] {
    const cached = this.dependencyCache.get(path);
    if (cached) return cached;
    const context = this.owners.get(path);
    if (!context) return [];
    const {prefix, resolver} = context;
    const localPath = path.slice(prefix.length);
    const facts = [...resolver.getDependencies(localPath), ...context.views.dependencies(localPath),
      ...(context.schedules.get(localPath) ?? [])];
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

export function createRubyWorkspaceDependencyResolver(options: RubyDependencyResolverOptions): RubyWorkspaceDependencyResolver {
  return new RubyWorkspaceDependencyResolver(options);
}
