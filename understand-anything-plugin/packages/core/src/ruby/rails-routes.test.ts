import { beforeAll, describe, expect, it } from "vitest";
import { TreeSitterPlugin } from "../plugins/tree-sitter-plugin.js";
import { builtinLanguageConfigs } from "../languages/index.js";
import { extractRailsRouteDependencies } from "./rails-routes.js";

const plugin = new TreeSitterPlugin(builtinLanguageConfigs.filter(config => config.id === "ruby"));
beforeAll(async () => { await plugin.init(); });

function extract(source: string, path = "config/routes.rb", isRails = true) {
  const references: string[] = [];
  const targets: Record<string, string> = {
    "::PeopleController": "app/controllers/people_controller.rb",
    "::GeocodersController": "app/controllers/geocoders_controller.rb",
    "::Admin::PeopleController": "app/controllers/admin/people_controller.rb",
    "::HTMLParsersController": "app/controllers/html_parsers_controller.rb",
  };
  const plurals: Record<string, string> = { person: "people", geocoder: "geocoders", html_parser: "html_parsers" };
  const result = extractRailsRouteDependencies({ path, source, plugin, resolver: {
    isRails,
    camelize: value => value.split("/").map(part => part.split("_").map(word => word === "html" ? "HTML" : word[0].toUpperCase() + word.slice(1)).join("")).join("::"),
    pluralize: value => plurals[value] ?? null,
    resolveConstant: reference => { references.push(reference); return targets[reference] ?? null; },
  } });
  return { ...result, references };
}

describe("restricted Rails routes", () => {
  it("resolves literal HTTP and resource declarations to files, using shared inflections", () => {
    const result = extract(`Rails.application.routes.draw do
      get '/people/:id', to: 'admin/people#show'
      post '/people', to: 'people#create'
      resources :people
      resource :person
      resource :geocoder
      resource :html_parser
    end`);
    expect(result.diagnostics).toEqual([]);
    expect(result.dependencies).toHaveLength(6);
    expect(result.references).toEqual(["::Admin::PeopleController", "::PeopleController", "::PeopleController", "::PeopleController", "::GeocodersController", "::HTMLParsersController"]);
    expect(result.dependencies.every(fact => fact.type === "routes" && fact.kind === "route" && fact.line)).toBe(true);
  });

  it("rejects unsupported scopes, conditionals, overrides, filters, dynamic options, mounts and drawn files without flattening", () => {
    const result = extract(`Rails.application.routes.draw do
      namespace :admin, module: dynamic do
        resources :people
      end
      scope module: :admin do
        resources :people
      end
      if enabled?
        resources :people
      end
      resources :people, only: :index
      resources :people, controller: :people
      resources name
      get '/people', to: "#{controller}#index"
      get '/people', to: 'people#index', constraints: allowed
      get '/people' => 'people#index'
      mount App => '/'
      draw :extra
      root to: 'people#index'
    end`);
    expect(result.dependencies).toEqual([]);
    expect(result.references).toEqual([]);
    expect(result.diagnostics).toHaveLength(12);
    expect(result.diagnostics.every(d => d.code === "unsupported-route" && d.line)).toBe(true);
  });

  it("preserves the controller module when a literal namespace changes its URL prefix", () => {
    const result = extract(`Rails.application.routes.draw do
      namespace :admin, path: "staff" do
        get "people", to: "people#index"
      end
    end`);
    expect(result.diagnostics).toEqual([]);
    expect(result.dependencies).toEqual([
      expect.objectContaining({target: "app/controllers/admin/people_controller.rb", line: 3}),
    ]);
  });

  it("does not enter draw blocks hidden inside conditionals or arbitrary receivers", () => {
    for (const source of [
      "if enabled?\n Rails.application.routes.draw { resources :people }\nend",
      "Something.routes.draw { resources :people }",
      "Rails.application.routes.draw do |map|\n map.resources :people\nend",
    ]) {
      const result = extract(source);
      expect(result.dependencies).toEqual([]);
      expect(result.diagnostics).toHaveLength(1);
    }
  });

  it("reports unknown controller targets and unsupported inflections", () => {
    const result = extract("Rails.application.routes.draw { resources :missing; resource :unknown }");
    expect(result.dependencies).toEqual([]);
    expect(result.diagnostics.map(d => d.code)).toEqual(["unresolved-route", "unsupported-route"]);
  });

  it("restricts inference to the main application's routes file", () => {
    const source = "Rails.application.routes.draw { resources :people }";
    expect(extract(source, "lib/routes.rb").dependencies).toEqual([]);
    expect(extract(source, "config/routes.rb", false).diagnostics).toEqual([]);
    const engine = extract(source, "engines/blog/config/routes.rb");
    expect(engine.dependencies).toEqual([]);
    expect(engine.diagnostics).toHaveLength(1);
  });
});
