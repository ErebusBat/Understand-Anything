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

  it("rejects dynamic scopes, options and destinations without flattening", () => {
    const result = extract(`Rails.application.routes.draw do
      namespace :admin, module: dynamic do
        resources :people
      end
      scope module: dynamic do
        resources :people
      end
      if enabled?
        resources :people
      end
      resources :people, only: actions
      resources :people, controller: dynamic
      resources name
      get '/people', to: "#{controller}#index"
      get '/people', to: 'people#index', constraints: allowed
      get '/people' => handler
      mount App => '/'
      draw :extra
      root to: redirect('/')
    end`);
    expect(result.dependencies).toEqual([]);
    expect(result.references).toEqual([]);
    expect(result.diagnostics).toHaveLength(12);
    expect(result.diagnostics.every(d => d.code === "unsupported-route" && d.line)).toBe(true);
  });

  it("retains configuration guards and controller namespaces across literal route forms", () => {
    const result = extract(`Rails.application.routes.draw do
      if SiteOptions.routes.preview
        scope '/v1', module: :admin do
          resources :people, only: [] do
            collection do
              match '/find' => 'people#search', via: [:get, :post]
            end
            get :lookup, on: :member
          end
          root to: 'people#index'
        end
      else
        resource :geocoder, :only => %i[show], :defaults => { :format => 'json' }
      end
    end`);
    expect(result.diagnostics).toEqual([]);
    expect(result.dependencies.map(f => [f.reference, f.target])).toEqual([
      ["people#search if SiteOptions.routes.preview", "app/controllers/admin/people_controller.rb"],
      ["people#lookup if SiteOptions.routes.preview", "app/controllers/admin/people_controller.rb"],
      ["people#index if SiteOptions.routes.preview", "app/controllers/admin/people_controller.rb"],
      ["resource :geocoder unless SiteOptions.routes.preview", "app/controllers/geocoders_controller.rb"],
    ]);
  });

  it("retains bare constant guards on both branches of a route", () => {
    const result = extract(`Rails.application.routes.draw do
      unless ::Settings::INTERNAL
        resources :people
      else
        resources :people
      end
    end`);
    expect(result.diagnostics).toEqual([]);
    expect(result.dependencies.map(f => f.reference)).toEqual([
      "resources :people unless ::Settings::INTERNAL", "resources :people if ::Settings::INTERNAL",
    ]);
  });

  it("skips filtered actions and options that change the controller dynamically", () => {
    const result = extract(`Rails.application.routes.draw do
      resources :people, only: []
      resource :person, only: :index
      resources :people, defaults: {controller: 'other'}
      match '/x' => 'people#show'
      scope '/:controller' do
        get '/show', to: 'people#show'
      end
    end`);
    expect(result.dependencies).toEqual([]);
    expect(result.diagnostics).toHaveLength(3);
  });

  it("expands a local route lambda at its namespace mounts, once per controller prefix", () => {
    const result = extract(`Rails.application.routes.draw do
      if SiteOptions.routes.preview
        common = lambda { get '/people', to: 'people#index' }
        namespace :admin, &common
        namespace :preview, path: '/', module: :admin, &common
      end
      reassigned = lambda { root 'people#index' }
      reassigned = from_plugin
      namespace :admin, &reassigned
    end`);
    expect(result.dependencies).toEqual([expect.objectContaining({
      target: "app/controllers/admin/people_controller.rb", reference: "people#index if SiteOptions.routes.preview", line: 3,
    })]);
    expect(result.diagnostics.map(d => d.line)).toEqual([7, 8, 9]);
  });

  it("follows explicit child destinations when the resource controller is unknown", () => {
    const result = extract(`Rails.application.routes.draw do
      resource :unknown, only: [] do
        delete '/:id' => 'people#destroy'
      end
    end`);
    expect(result.dependencies).toEqual([expect.objectContaining({target: "app/controllers/people_controller.rb", line: 3})]);
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
