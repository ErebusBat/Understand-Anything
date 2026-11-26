import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { TreeSitterPlugin } from "../plugins/tree-sitter-plugin.js";
import { builtinLanguageConfigs } from "../languages/index.js";
import { createRubyWorkspaceDependencyResolver } from "./workspace-resolver.js";
import type { RubyMixinResolution } from "./types.js";

const plugin = new TreeSitterPlugin(builtinLanguageConfigs.filter(c => c.id === "ruby"));
const temporary: string[] = [];
beforeAll(async () => { await plugin.init(); });
afterEach(() => { for (const path of temporary.splice(0)) rmSync(path, {recursive: true, force: true}); });
const app = "module Demo; class Application < Rails::Application; end; end";
const helper = "app/api/atelier/sheets/panels/helpers/palette_helpers.rb";
const caller = "app/api/atelier/sheets/layouts.rb";
const token_rule = "app/models/atelier/token_rule.rb";
const engine = "engines/pigments/lib/pigments/engine.rb";
const engineSource = "module Pigments; class Engine < ::Rails::Engine; isolate_namespace Pigments; end; end";
function setup(files: Record<string, string>, mixinResolution: RubyMixinResolution = "pragmatic") {
  const root = mkdtempSync(join(tmpdir(), "ua-rails-local-recovery-"));
  temporary.push(root);
  const sources = {"config/application.rb": app, ...files};
  for (const [path, source] of Object.entries(sources)) {
    mkdirSync(dirname(join(root, path)), {recursive: true});
    writeFileSync(join(root, path), source);
  }
  return createRubyWorkspaceDependencyResolver({projectRoot: root, plugin, mixinResolution,
    files: Object.keys(sources).map(path => ({path, language: "ruby"}))});
}
const helperFiles = {
  [helper]: "module Atelier; module Sheets::Panels::Helpers::PaletteHelpers; ::User; end; end",
  "app/models/user.rb": "class User; end",
  "probe.rb": "::Atelier::Sheets::Panels::Helpers::PaletteHelpers",
  "app/api/atelier/sheets/panels/root.rb": "module Atelier; module Sheets; module Panels; class Root < Grape::API; helpers Atelier::Sheets::Panels::Helpers::PaletteHelpers; end; end; end; end",
};

describe("local Rails declaration and mount recovery", () => {
  it.each(["strict", "pragmatic"] as const)("recovers relative qualified modules with lexical/autoload namespace evidence in %s mode", mode => {
    const resolver = setup(helperFiles, mode);
    expect(resolver.getDependencies("probe.rb")).toContainEqual(expect.objectContaining({target: helper}));
    expect(resolver.getDependencies(helper)).toContainEqual(expect.objectContaining({target: "app/models/user.rb"}));
    expect(resolver.diagnostics.filter(d => d.path === helper)).toEqual([]);
  });

  it("resolves the first namespace lexically instead of always concatenating the innermost body", () => {
    const resolver = setup({
      "app/models/outer/shared.rb": "module Outer; module Shared; end; end",
      "app/models/outer/shared/tool.rb": "module Outer; module Inner; module Shared::Tool; end; end; end",
      "probe.rb": "Outer::Shared::Tool",
    });
    expect(resolver.getDependencies("probe.rb")).toEqual([expect.objectContaining({target: "app/models/outer/shared/tool.rb"})]);
  });

  it("preserves compact module lexical nesting when resolving references in the recovered body", () => {
    const resolver = setup({
      "app/models/outer/shared/tool.rb": "module Outer; module Shared::Tool; Item; end; end",
      "app/models/outer/shared/item.rb": "module Outer; module Shared; class Item; end; end; end",
      "app/models/outer/item.rb": "module Outer; class Item; end; end",
    });
    expect(resolver.getDependencies("app/models/outer/shared/tool.rb")).toEqual([
      expect.objectContaining({target: "app/models/outer/item.rb", reference: "Item"}),
    ]);
  });

  it.each([
    {"config/initializers/shadow.rb": "module Atelier; Sheets = Object; end"},
    {"app/api/atelier/sheets.rb": "module Atelier; class Sheets; end; end", "app/services/patch.rb": "module Atelier; class Sheets; end; end"},
    {"config/initializers/shadow.rb": "module Atelier; module Sheets; end; end if enabled?", "app/services/replacement.rb": "module Atelier; Sheets = Object; end"},
  ] as Record<string, string>[])("rejects shadowing or competing owners before accepting a relative declaration: %j", extra => {
    const resolver = setup({...helperFiles, ...extra});
    expect(resolver.getDependencies("app/api/atelier/sheets/panels/root.rb").some(f => f.target === helper)).toBe(false);
    expect(resolver.diagnostics).toContainEqual(expect.objectContaining({path: helper, code: "unsupported_declaration_scope"}));
  });

  it("keeps unproven and conditional relative declaration owners unresolved", () => {
    const resolver = setup({
      "probe.rb": "class Probe < External; module Missing::Tool; end; end",
      "app/models/conditional/tool.rb": "module Conditional; module Tool::Child; end if enabled?; end",
    });
    expect(resolver.diagnostics).toContainEqual(expect.objectContaining({path: "probe.rb", code: "unsupported_declaration_scope"}));
    expect(resolver.getDependencies("probe.rb")).toEqual([]);
  });

  it("keeps the same relative declaration in a nested application out of host lookup", () => {
    const dummy = "engines/pigments/spec/dummy/";
    const resolver = setup({...helperFiles,
      [dummy + "config/application.rb"]: app,
      [dummy + helper]: helperFiles[helper],
      [dummy + "app/models/user.rb"]: "class User; end",
      [dummy + "probe.rb"]: helperFiles["probe.rb"],
    });
    expect(resolver.getDependencies("probe.rb")).toEqual([expect.objectContaining({target: helper})]);
    expect(resolver.getDependencies(dummy + "probe.rb")).toEqual([expect.objectContaining({target: dummy + helper})]);
  });

  it.each(["strict", "pragmatic"] as const)("links a hosted engine mount without adding a lib autoload root in %s mode", mode => {
    const resolver = setup({[engine]: engineSource, "config/routes.rb": `Rails.application.routes.draw do
      scope 'atelier/sheets/:sheet_key' do
        mount Pigments::Engine => '/pigments'
      end
      mount External::Engine => '/external'
    end`}, mode);
    expect(resolver.getDependencies("config/routes.rb").filter(f => f.type === "routes")).toEqual([
      {target: engine, kind: "route", type: "routes", reference: "mount Pigments::Engine", line: 3},
    ]);
    expect(resolver.diagnostics).toContainEqual(expect.objectContaining({code: "unresolved-route", line: 5}));
  });

  it.each([
    {"engines/duplicate/lib/pigments/engine.rb": engineSource},
    {"app/models/pigments/engine.rb": engineSource},
    {"config/initializers/shadow.rb": "Pigments = Object"},
    {"config/initializers/shadow.rb": "module Pigments; Engine = Object; end"},
    {"app/models/rails/engine.rb": "module Rails; class Engine; end; end"},
  ] as Record<string, string>[])("rejects competing engines and local namespace substitutions: %j", extra => {
    const resolver = setup({[engine]: engineSource, ...extra,
      "config/routes.rb": "Rails.application.routes.draw do; mount Pigments::Engine => '/'; end"});
    expect(resolver.getDependencies("config/routes.rb").filter(f => f.type === "routes")).toEqual([]);
    expect(resolver.diagnostics).toContainEqual(expect.objectContaining({code: "unresolved-route"}));
  });

  it("rejects a relative engine superclass shadowed inside the engine source", () => {
    const resolver = setup({[engine]: "module Pigments; Rails = Object; class Engine < Rails::Engine; end; end",
      "config/routes.rb": "Rails.application.routes.draw do; mount Pigments::Engine => '/'; end"});
    expect(resolver.getDependencies("config/routes.rb").filter(f => f.type === "routes")).toEqual([]);
  });

  it("isolates dummy applications' engines and declarations from the host mount", () => {
    const resolver = setup({[engine]: engineSource,
      "config/routes.rb": "Rails.application.routes.draw do; mount Pigments::Engine => '/'; end",
      "engines/pigments/spec/dummy/config/application.rb": app,
      "engines/pigments/spec/dummy/config/routes.rb": "Rails.application.routes.draw do; mount Pigments::Engine => '/'; end",
      "engines/pigments/spec/dummy/app/models/pigments.rb": "Pigments = Object",
    });
    expect(resolver.getDependencies("config/routes.rb").filter(f => f.type === "routes")).toHaveLength(1);
    expect(resolver.getDependencies("engines/pigments/spec/dummy/config/routes.rb").filter(f => f.type === "routes")).toEqual([]);
  });
});

describe("dynamic token_rule receiver evidence", () => {
  const files = {
    [token_rule]: "module Atelier; class TokenRule < ActiveRecord::Base; def self.method_missing(name, *args); find_by(action: name) || super; end; end; end",
    [caller]: "module Atelier; module Sheets; class Layouts < Grape::API; before { Atelier::TokenRule.read_tiles }; end; end; end",
  };
  it("retains a qualified unique model receiver with its own dynamic hook as inferred file evidence", () => {
    const resolver = setup(files);
    expect(resolver.getDependencies(caller)).toEqual([
      {target: token_rule, type: "depends_on", kind: "constant", reference: "Atelier::TokenRule.read_tiles", line: 1, resolution: "inferred"},
    ]);
  });
  it.each([
    {[token_rule]: "module Atelier; class TokenRule < ActiveRecord::Base; end; end"},
    {[token_rule]: "module Atelier; class TokenRule; def self.method_missing(name); end; end; end"},
    {"app/api/atelier/sheets/layouts/atelier.rb": "module Atelier; module Sheets; class Layouts; Atelier = Object; end; end; end"},
    {"app/services/token_rule_patch.rb": files[token_rule]},
  ] as Record<string, string>[])("does not infer the dynamic receiver without unique independent evidence: %j", extra => {
    const resolver = setup({...files, ...extra});
    expect(resolver.getDependencies(caller).some(f => f.target === token_rule)).toBe(false);
  });
  it("keeps unknown ancestry in diagnostics in strict mode", () => {
    const resolver = setup(files, "strict");
    expect(resolver.getDependencies(caller)).toEqual([]);
    expect(resolver.diagnostics).toContainEqual(expect.objectContaining({path: caller, code: "unsupported_ancestor_lookup"}));
  });
});
