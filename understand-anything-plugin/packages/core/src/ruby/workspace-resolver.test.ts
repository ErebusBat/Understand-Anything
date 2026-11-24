import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { TreeSitterPlugin } from "../plugins/tree-sitter-plugin.js";
import { builtinLanguageConfigs } from "../languages/index.js";
import { createRubyWorkspaceDependencyResolver } from "./workspace-resolver.js";

const plugin = new TreeSitterPlugin(builtinLanguageConfigs.filter(c => c.id === "ruby"));
const temporary: string[] = [];
beforeAll(async () => { await plugin.init(); });
afterEach(() => { for (const root of temporary.splice(0)) rmSync(root, {recursive: true, force: true}); });

const application = "module Demo; class Application < Rails::Application; end; end";
const app = {
  "config/application.rb": application,
  "app/models/user.rb": "class User; end",
  "app/controllers/users_controller.rb": "class UsersController; def show; User.find; end; end",
  "config/routes.rb": "Rails.application.routes.draw { resources :users }",
};
function nested(prefix: string, sources: Record<string, string> = app) {
  return Object.fromEntries(Object.entries(sources).map(([path, source]) => [prefix + path, source]));
}
function fixture(sources: Record<string, string>) {
  const root = mkdtempSync(join(tmpdir(), "ua-ruby-workspace-"));
  temporary.push(root);
  for (const [path, source] of Object.entries(sources)) {
    mkdirSync(dirname(join(root, path)), {recursive: true});
    writeFileSync(join(root, path), source);
  }
  const files = Object.keys(sources).map(path => ({path, language: "ruby", fileCategory: "code"}));
  return {root, files, resolve: () => createRubyWorkspaceDependencyResolver({projectRoot: root, files, plugin})};
}

describe("Ruby workspace contexts", () => {
  it("keeps duplicate constants and routes local across sibling roots", () => {
    const f = fixture({
      ...nested("alpha/master/"), ...nested("beta/"),
      "beta/app/models/only_beta.rb": "class OnlyBeta; end",
      "alpha/master/app/services/check.rb": "class Check; OnlyBeta.find; end",
    });
    const resolver = f.resolve();
    expect(resolver.failures).toEqual([]);
    for (const prefix of ["alpha/master/", "beta/"]) {
      expect(resolver.getDependencies(prefix + "app/controllers/users_controller.rb")).toEqual([
        expect.objectContaining({target: prefix + "app/models/user.rb", kind: "constant"}),
      ]);
      expect(resolver.getDependencies(prefix + "config/routes.rb")).toEqual([
        expect.objectContaining({target: prefix + "app/controllers/users_controller.rb", kind: "route"}),
      ]);
    }
    expect(resolver.getDependencies("alpha/master/app/services/check.rb")).toEqual([]);
    expect(resolver.diagnostics.some(d => d.code === "ambiguous_constant")).toBe(false);
    expect(resolver.contexts).toEqual([
      {root: "alpha/master", isRails: true, blocked: false}, {root: "beta", isRails: true, blocked: false},
    ]);
  });

  it.each(["broken.rb", "config/application.rb"])("contains a parse failure in %s to its owning application", path => {
    const resolver = fixture({
      ...nested("good/"), ...nested("bad/"), ["bad/" + path]: "class Broken <",
    }).resolve();
    expect(resolver.failures).toEqual([expect.objectContaining({path: "bad/" + path, stage: "ruby-file-parse"})]);
    expect(resolver.getDependencies("bad/app/controllers/users_controller.rb")).toEqual([]);
    expect(resolver.getDependencies("good/app/controllers/users_controller.rb")).toEqual([
      expect.objectContaining({target: "good/app/models/user.rb"}),
    ]);
    expect(resolver.sources.has("bad/" + path)).toBe(false);
    expect(resolver.contexts.find(c => c.root === "bad")?.blocked).toBe(true);
  });

  it("contains unsafe configuration and rebases diagnostic locations", () => {
    const resolver = fixture({
      ...nested("good/"), ...nested("bad/"),
      "bad/config/application.rb": "module Demo; class Application < Rails::Application; config.autoload_paths += dynamic_roots; end; end",
    }).resolve();
    expect(resolver.failures).toEqual([]);
    expect(resolver.getDependencies("bad/app/controllers/users_controller.rb")).toEqual([]);
    expect(resolver.getDependencies("good/app/controllers/users_controller.rb")).not.toEqual([]);
    expect(resolver.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({path: "bad/config/application.rb", code: "unsupported_autoload_config", line: 1}),
      expect.objectContaining({path: "bad/config/application.rb", code: "ruby-context-blocked"}),
    ]));
  });

  it("separates nested dummy applications from the host and its engines", () => {
    const resolver = fixture({
      ...app, ...nested("engines/shop/spec/dummy/"),
      "engines/shop/lib/shop/engine.rb": "module Shop; class Engine < Rails::Engine; end; end",
      "engines/shop/app/models/shop/item.rb": "module Shop; class Item; end; end",
      "app/services/check.rb": "class Check; Shop::Item.find; end",
    }).resolve();
    expect(resolver.getDependencies("app/controllers/users_controller.rb")).toEqual([
      expect.objectContaining({target: "app/models/user.rb"}),
    ]);
    expect(resolver.getDependencies("app/services/check.rb")).toEqual([
      expect.objectContaining({target: "engines/shop/app/models/shop/item.rb"}),
    ]);
    expect(resolver.getDependencies("engines/shop/spec/dummy/config/routes.rb")).toEqual([
      expect.objectContaining({target: "engines/shop/spec/dummy/app/controllers/users_controller.rb"}),
    ]);
  });

  it("recognizes a nested standalone engine without treating ordinary Ruby as Rails", () => {
    const resolver = fixture({
      ...nested("packages/shop/", {
        "lib/shop/engine.rb": "module Shop; class Engine < Rails::Engine; end; end",
        "app/models/shop/item.rb": "module Shop; class Item; end; end",
        "app/services/shop/check.rb": "module Shop; class Check; Item.find; end; end",
      }),
      "ordinary/config/application.rb": "# Rails::Application is only a comment",
      "ordinary/app/models/user.rb": "class User; end",
      "ordinary/main.rb": "User.find",
    }).resolve();
    expect(resolver.getDependencies("packages/shop/app/services/shop/check.rb")).toEqual([
      expect.objectContaining({target: "packages/shop/app/models/shop/item.rb"}),
    ]);
    expect(resolver.getDependencies("ordinary/main.rb")).toEqual([]);
  });

  it("rebases configured roots without changing their application-relative meaning", () => {
    const resolver = fixture(nested("service/master/", {
      "config/application.rb": "module Demo; class Application < Rails::Application; config.autoload_paths << Rails.root.join('extras'); end; end",
      "extras/widget.rb": "class Widget; end",
      "app/services/check.rb": "class Check; Widget.find; end",
    })).resolve();
    expect(resolver.getDependencies("service/master/app/services/check.rb")).toEqual([
      expect.objectContaining({target: "service/master/extras/widget.rb"}),
    ]);
    expect(resolver.diagnostics).toEqual([]);
  });

  it.skipIf(process.platform === "win32")("does not read an application root symlink that escapes the selected workspace", () => {
    const outside = fixture(app);
    const inside = fixture(nested("good/"));
    symlinkSync(outside.root, join(inside.root, "escape"), "dir");
    inside.files.push(...outside.files.map(file => ({...file, path: "escape/" + file.path})));
    const resolver = inside.resolve();
    expect([...resolver.sources.keys()].some(path => path.startsWith("escape/"))).toBe(false);
    expect(resolver.failures).toHaveLength(outside.files.length);
    expect(resolver.failures.every(f => f.path?.startsWith("escape/") && f.message.includes("boundary"))).toBe(true);
    expect(resolver.getDependencies("good/app/controllers/users_controller.rb")).not.toEqual([]);
  });

  it.skipIf(process.platform === "win32")("rejects a file symlink into a sibling application's context", () => {
    const f = fixture({...nested("alpha/"), ...nested("beta/")});
    symlinkSync(join(f.root, "beta/app/models/user.rb"), join(f.root, "alpha/app/models/copy.rb"));
    f.files.push({path: "alpha/app/models/copy.rb", language: "ruby", fileCategory: "code"});
    const resolver = f.resolve();
    expect(resolver.failures).toEqual([expect.objectContaining({path: "alpha/app/models/copy.rb", stage: "ruby-file-read"})]);
    expect(resolver.sources.has("alpha/app/models/copy.rb")).toBe(false);
    expect(resolver.getDependencies("alpha/app/controllers/users_controller.rb")).toEqual([]);
    expect(resolver.getDependencies("beta/app/controllers/users_controller.rb")).not.toEqual([]);
  });
});
