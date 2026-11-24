import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { TreeSitterPlugin } from "../plugins/tree-sitter-plugin.js";
import { builtinLanguageConfigs } from "../languages/index.js";
import { createRubyDependencyResolver, type RubyDependencyResolver } from "./resolver.js";
import { RubyInflections } from "./inflections.js";

let plugin: TreeSitterPlugin;
const temporary: string[] = [];
beforeAll(async () => {
  plugin = new TreeSitterPlugin(builtinLanguageConfigs.filter(c => c.id === "ruby"));
  await plugin.init();
});
afterEach(() => { for (const path of temporary.splice(0)) rmSync(path, {recursive:true,force:true}); });

const application = "module Demo; class Application < Rails::Application; end; end";
const record = "class ApplicationRecord < ActiveRecord::Base; end";
function setup(files: Record<string,string>, rails = true) {
  const root = mkdtempSync(join(tmpdir(), "ua-ruby-resolver-"));
  temporary.push(root);
  const sources = {...(rails ? {"config/application.rb": application, "app/models/application_record.rb":record} : {}), ...files};
  for (const [path,source] of Object.entries(sources)) {
    mkdirSync(dirname(join(root,path)), {recursive:true}); writeFileSync(join(root,path),source);
  }
  const inventory = Object.keys(sources).map(path => ({path, language:"ruby", fileCategory:"code"}));
  return {root, inventory, resolver:createRubyDependencyResolver({projectRoot:root,files:inventory,plugin})};
}
function targets(resolver: RubyDependencyResolver, path: string, kind?: string) {
  return resolver.getDependencies(path).filter(f => !kind || f.kind === kind).map(f => f.target);
}

describe("bounded Rails dependency resolver", () => {
  it("detects actual Rails declarations; ordinary Ruby never gets autoload roots", () => {
    const {resolver} = setup({"app/models/user.rb":"class User; end", "main.rb":"User.find; Rails.to_s"},false);
    expect(resolver.isRails).toBe(false);
    expect(resolver.getDependencies("main.rb")).toEqual([]);
    expect(resolver.diagnostics).toEqual([]);
  });

  it("resolves Rake consumers without using their declarations or failures as autoload evidence", () => {
    const {resolver} = setup({
      "app/models/user.rb": "class User; end",
      "config/initializers/probe.rake": "class TaskOnly < Rails::Engine; end; task(:probe) { User.find }",
      "app/models/user.rake": "class User; end",
      "lib/tasks/incomplete.rake": "class",
    });
    expect(resolver.inferenceBlocked).toBe(false);
    expect(resolver.failures).toEqual([expect.objectContaining({path: "lib/tasks/incomplete.rake", stage: "ruby-file-parse"})]);
    expect(resolver.resolveConstant("TaskOnly")).toBeNull();
    expect(targets(resolver, "config/initializers/probe.rake")).toEqual(["app/models/user.rb"]);
    expect(resolver.getDependencies("lib/tasks/incomplete.rake")).toEqual([]);
  });

  it("finds conventional models/controllers, nested concerns, superclass and distinct include/extend", () => {
    const {resolver} = setup({
      "app/controllers/application_controller.rb":"class ApplicationController < ActionController::Base; end",
      "app/controllers/users_controller.rb":"class UsersController < ApplicationController; include Trackable; extend Helper; def show; User.find(1); end; end",
      "app/models/user.rb":"class User < ApplicationRecord; end",
      "app/models/concerns/trackable.rb":"module Trackable; include Auditable; end",
      "app/models/concerns/auditable.rb":"module Auditable; end",
      "app/controllers/concerns/helper.rb":"module Helper; end",
      "lib/hidden.rb":"class Hidden; end",
      "app/services/check.rb":"class Check; Hidden.run; Concerns::Trackable.run; end",
    });
    expect(resolver.failures).toEqual([]);
    expect(resolver.getDependencies("app/controllers/users_controller.rb")).toEqual(expect.arrayContaining([
      expect.objectContaining({target:"app/controllers/application_controller.rb",type:"inherits",kind:"superclass"}),
      expect.objectContaining({target:"app/models/user.rb",type:"depends_on",kind:"constant"}),
      expect.objectContaining({target:"app/models/concerns/trackable.rb",type:"depends_on",kind:"include"}),
      expect.objectContaining({target:"app/controllers/concerns/helper.rb",type:"depends_on",kind:"extend"}),
    ]));
    expect(targets(resolver,"app/models/concerns/trackable.rb","include")).toEqual(["app/models/concerns/auditable.rb"]);
    expect(targets(resolver,"app/services/check.rb")).toEqual([]);
  });

  it("preserves lexical nesting rather than splitting a compact namespace", () => {
    const {resolver} = setup({
      "app/models/admin/user.rb":"module Admin; class User < ApplicationRecord; end; end",
      "app/services/admin/nested.rb":"module Admin; class Nested; User.find; end; end",
      "app/services/admin/compact.rb":"class Admin::Compact; User.find; end",
      "app/services/top.rb":"class Top; User.find; end",
    });
    expect(targets(resolver,"app/services/admin/nested.rb")).toEqual(["app/models/admin/user.rb"]);
    expect(targets(resolver,"app/services/admin/compact.rb")).toEqual([]);
    expect(targets(resolver,"app/services/top.rb")).toEqual([]);
  });

  it("does not independently autoload unrelated classes beside a matching declaration", () => {
    const {resolver} = setup({
      "app/services/provider.rb":"class Provider; class Item; end; end; class Extra; end",
      "app/services/probe.rb":"class Probe; Provider::Item.new; Extra.new; end",
    });
    expect(resolver.resolveConstant("Extra")).toBeNull();
    expect(resolver.resolveConstant("Provider::Item")).toBe("app/services/provider.rb");
    expect(resolver.getDependencies("app/services/probe.rb")).toEqual([
      expect.objectContaining({target:"app/services/provider.rb",reference:"Provider::Item"}),
    ]);
  });

  it("distinguishes relative and leading :: references and stops at a shadowing namespace", () => {
    const {resolver} = setup({
      "app/models/admin/user.rb":"module Admin; class User < ApplicationRecord; end; end",
      "app/models/other/admin/user.rb":"module Other; module Admin; class User < ApplicationRecord; end; end; end",
      "app/services/other/probe.rb":"module Other; class Probe; Admin::User.find; ::Admin::User.find; end; end",
      "app/services/outer/admin.rb":"module Outer; module Admin; end; end",
      "app/services/outer/probe.rb":"module Outer; class Probe; Admin::User.find; end; end",
    });
    expect(targets(resolver,"app/services/other/probe.rb")).toEqual(["app/models/admin/user.rb","app/models/other/admin/user.rb"]);
    expect(targets(resolver,"app/services/outer/probe.rb")).toEqual([]);
  });

  it("rejects collisions, reopened classes, aliases, and local constant shadowing", () => {
    const {resolver} = setup({
      "app/models/user.rb":"class User < ApplicationRecord; end",
      "app/services/user.rb":"class User; end",
      "app/models/person.rb":"class Person < ApplicationRecord; end",
      "app/services/reopen.rb":"class Person; end",
      "app/models/thing.rb":"class Thing < ApplicationRecord; end",
      "app/services/alias.rb":"Thing = Object",
      "app/models/item.rb":"class Item < ApplicationRecord; end",
      "app/services/probe.rb":"class Probe; Item = 123; User.find; Person.find; Thing.find; Item.find; end",
    });
    expect(targets(resolver,"app/services/probe.rb")).toEqual([]);
    expect(resolver.diagnostics.map(d=>d.code)).toContain("ambiguous_constant");
    expect(resolver.diagnostics.map(d=>d.code)).toContain("unsupported_constant_assignment");
  });

  it("does not fabricate mappings for mismatched filenames or dynamic declarations", () => {
    const {resolver} = setup({
      "app/models/html_parser.rb":"class HTMLParser; end",
      "app/models/user.rb":"if enabled?; class User; end; end",
      "app/services/probe.rb":"class Probe; HTMLParser.run; HtmlParser.run; User.find; end",
    });
    expect(targets(resolver,"app/services/probe.rb")).toEqual([]);
    expect(resolver.diagnostics.map(d=>d.code)).toContain("unsupported_constant_mapping");
    expect(resolver.diagnostics.map(d=>d.code)).toContain("unsupported_conditional_declaration");
  });

  it("extracts constant reads from initializers without turning assigned aliases into autoload targets", () => {
    const {resolver} = setup({
      "app/models/user.rb": "class User; end",
      "app/services/team/helper.rb": "module Team; class Helper; end; end",
      "app/services/team/probe.rb": `module Team; class Probe
        ALIAS = ::User
        DEFAULTS ||= [Helper.new, "User"]
        ALIAS.new
      end; end`,
      "other.rb": "Team::Probe::ALIAS.new",
    });
    expect(resolver.getDependencies("app/services/team/probe.rb")).toEqual([
      expect.objectContaining({target: "app/models/user.rb", reference: "::User", line: 2}),
      expect.objectContaining({target: "app/services/team/helper.rb", reference: "Helper", line: 3}),
    ]);
    expect(resolver.getDependencies("other.rb")).toEqual([]);
  });

  it("uses literal configured roots, Rails.root.join, %w, arrays and lib ignore lists", () => {
    const {resolver} = setup({
      "config/application.rb":`module Demo; class Application < Rails::Application
        config.autoload_paths << Rails.root.join("extras", "services")
        config.autoload_paths += %w(other)
        config.autoload_once_paths += ["once"]
        config.autoload_lib(ignore: %w(tasks assets))
      end; end`,
      "extras/services/extra.rb":"class Extra; end",
      "other/other.rb":"class Other; end",
      "once/once.rb":"class Once; end",
      "lib/visible.rb":"class Visible; end",
      "lib/tasks/hidden.rb":"module Tasks; class Hidden; end; end",
      "app/services/probe.rb":"class Probe; Extra.run; Other.run; Once.run; Visible.run; Tasks::Hidden.run; end",
    });
    expect(resolver.diagnostics).toEqual([]);
    expect(targets(resolver,"app/services/probe.rb")).toEqual(["extras/services/extra.rb","lib/visible.rb","once/once.rb","other/other.rb"]);
  });

  it("resolves literal application-root interpolation in arrays and %W paths", () => {
    const {resolver} = setup({
      "config/application.rb": 'module Demo; class Application < Rails::Application\n' +
        'config.autoload_paths += %W(#{config.root}/extras #{Rails.root}/other)\n' +
        'config.autoload_paths << "#{Rails.root}/once"\nend; end',
      "extras/extra.rb": "class Extra; end",
      "other/other.rb": "class Other; end",
      "once/once.rb": "class Once; end",
      "app/services/probe.rb": "class Probe; Extra.run; Other.run; Once.run; end",
    });
    expect(resolver.diagnostics).toEqual([]);
    expect(targets(resolver, "app/services/probe.rb")).toEqual(["extras/extra.rb", "once/once.rb", "other/other.rb"]);
  });

  it.each([
    'config.autoload_paths << "#{Rails.root}/#{ENV[\'DIR\']}"',
    'config.autoload_paths << "prefix/#{config.root}/lib"',
    'config.autoload_paths << "#{config.root}/../external"',
    'config.autoload_paths << "#{custom.root}/lib"',
  ])("rejects dynamic or unsafe interpolated roots: %s", expression => {
    const {resolver} = setup({
      "config/application.rb": `module Demo; class Application < Rails::Application; ${expression}; end; end`,
      "app/models/user.rb": "class User; end", "probe.rb": "User.find",
    });
    expect(resolver.configuration.unsafe).toBe(true);
    expect(resolver.getDependencies("probe.rb")).toEqual([]);
  });

  it("resolves static root-join maps and immutable local Pathnames", () => {
    const {resolver} = setup({
      "config/application.rb": `module Demo; class Application < Rails::Application
        config.autoload_paths += ['extras', 'services'].map(&Rails.root.method(:join))
        lib = root.join('lib')
        config.autoload_paths << lib
        config.eager_load_paths << lib
      end; end`,
      "extras/extra.rb":"class Extra; end", "services/service.rb":"class Service; end",
      "lib/helper.rb":"class Helper; end", "probe.rb":"Extra.run; Service.run; Helper.run",
    });
    expect(resolver.configuration.unsafe).toBe(false);
    expect(targets(resolver, "probe.rb")).toEqual(["extras/extra.rb", "lib/helper.rb", "services/service.rb"]);
  });

  it.each([
    "lib = root.join('lib'); lib = ENV['LIB']; config.autoload_paths << lib",
    "lib = root.join('lib'); lib.replace(ENV['LIB']); config.autoload_paths << lib",
    "lib = root.join('lib') if enabled?; config.autoload_paths << lib",
    "config.autoload_paths += ['lib'].map(&custom.method(:join))",
  ])("rejects dynamic maps and mutable local paths: %s", expression => {
    const {resolver} = setup({"config/application.rb": `module Demo; class Application < Rails::Application; ${expression}; end; end`});
    expect(resolver.configuration.unsafe).toBe(true);
  });

  it("allows read-only logging paths without allowing path mutations", () => {
    const {resolver} = setup({
      "config/application.rb": `module Demo; class Application < Rails::Application
        log_sink = config.paths['log'].to_a.first
        config.logger = Logger.new(config.paths['log'].first)
      end; end`,
      "app/models/user.rb":"class User; end", "probe.rb":"User.find",
    });
    expect(resolver.configuration.unsafe).toBe(false);
    expect(targets(resolver, "probe.rb")).toEqual(["app/models/user.rb"]);
  });

  it("keeps file-only Rails path globs separate from literal autoload path entries", () => {
    const {resolver} = setup({
      "config/application.rb": 'module Demo; class Application < Rails::Application\n' +
        'config.paths.add "app/api", :glob => "**/*.rb"\n' +
        'config.autoload_paths += ["#{Rails.root}/app/api/*"]\nend; end',
      "app/api/nested/item.rb":"module Nested; class Item; end; end",
      "probe.rb":"Nested::Item.new; Item.new",
    });
    expect(resolver.configuration.unsafe).toBe(false);
    expect(resolver.resolveConstant("Item")).toBeNull();
    expect(targets(resolver, "probe.rb")).toEqual(["app/api/nested/item.rb"]);
    expect(resolver.diagnostics.map(d => d.code)).toContain("inactive_autoload_root");
  });

  it("resolves engine __FILE__ and root against the engine, Rails.root against the host", () => {
    const {resolver} = setup({
      "engines/blog/lib/blog/engine.rb": `module Blog; class Engine < ::Rails::Engine
        config.autoload_paths << File.expand_path('..', __FILE__)
        config.autoload_paths << root.join('extras')
        config.autoload_paths << Rails.root.join('host')
      end; end`,
      "engines/blog/lib/blog/helper.rb":"class Helper; end",
      "engines/blog/extras/extra.rb":"class Extra; end", "host/host.rb":"class Host; end",
      "probe.rb":"Helper.run; Extra.run; Host.run",
    });
    expect(resolver.configuration.unsafe).toBe(false);
    expect(targets(resolver, "probe.rb")).toEqual(["engines/blog/extras/extra.rb", "engines/blog/lib/blog/helper.rb", "host/host.rb"]);
  });

  it("diagnoses a missing external expanded root without reading external source", () => {
    const {resolver} = setup({
      "engines/blog/lib/blog/engine.rb": `class Engine < Rails::Engine
        config.autoload_paths << File.expand_path('../ua-nonexistent-external-root', Rails.root)
      end`,
      "app/models/user.rb":"class User; end", "probe.rb":"User.find",
    });
    expect(resolver.configuration.unsafe).toBe(false);
    expect(targets(resolver, "probe.rb")).toEqual(["app/models/user.rb"]);
    expect(resolver.diagnostics.map(d => d.code)).toContain("inactive_autoload_root");
  });

  it("blocks existing external expanded roots", () => {
    const external = mkdtempSync(join(tmpdir(), "ua-external-root-")); temporary.push(external);
    const {resolver} = setup({
      "engines/blog/lib/blog/engine.rb": `class Engine < Rails::Engine
        config.autoload_paths << File.expand_path('../${external.split('/').pop()}', Rails.root)
      end`,
      "app/models/user.rb":"class User; end", "probe.rb":"User.find",
    });
    expect(resolver.configuration.unsafe).toBe(true);
    expect(targets(resolver, "probe.rb")).toEqual([]);
  });

  it("blocks autoload-root symlinks that escape the selected project", () => {
    const external = mkdtempSync(join(tmpdir(), "ua-external-root-")); temporary.push(external);
    const f = setup({"config/application.rb":"class Application < Rails::Application; config.autoload_paths << 'extras'; end"});
    symlinkSync(external, join(f.root, "extras"));
    const resolver = createRubyDependencyResolver({projectRoot:f.root, files:f.inventory, plugin});
    expect(resolver.configuration.unsafe).toBe(true);
    expect(resolver.diagnostics.map(d => d.code)).toContain("unsupported_root_path");
  });

  it("does not substitute a standalone engine root for an unknown Rails application root", () => {
    const {resolver} = setup({
      "lib/blog/engine.rb":"module Blog; class Engine < Rails::Engine; config.autoload_paths << Rails.root.join('lib'); end; end",
      "lib/helper.rb":"class Helper; end", "probe.rb":"Helper.run",
    }, false);
    expect(resolver.configuration.unsafe).toBe(true);
    expect(targets(resolver, "probe.rb")).toEqual([]);
  });

  it.each([
    "config.autoload_paths += Dir.glob('lib/*')",
    "config.autoload_paths = []",
    "config.autoload_paths.delete('app/models')",
    "config.autoload_paths << '../external'",
    "config.autoload_paths << '/external'",
    "config.autoload_paths << Rails.root.join(ENV['CODE'])",
    "config.autoload_paths << \"#{ENV['CODE']}\"",
    "config.autoload_paths << 'lib' if enabled?",
    "config.paths['app/models'] = []",
    "config.autoloader = :classic",
    "Rails.autoloaders.main.ignore(Rails.root.join('app/models/user.rb'))",
  ])("suppresses inferred facts for unsupported root config: %s", expression => {
    const {resolver} = setup({
      "config/application.rb":`module Demo; class Application < Rails::Application; ${expression}; end; end`,
      "app/models/user.rb":"class User < ApplicationRecord; end",
      "app/services/probe.rb":"class Probe; User.find; end",
    });
    expect(resolver.failures).toEqual([]);
    expect(resolver.diagnostics.length).toBeGreaterThan(0);
    expect(targets(resolver,"app/services/probe.rb")).toEqual([]);
  });

  it("supports acronym, basename override, irregular and uncountable literals", () => {
    const {resolver} = setup({
      "config/initializers/inflections.rb":`ActiveSupport::Inflector.inflections(:en) do |inflect|
        inflect.acronym 'HTML'
        inflect.irregular 'human', 'humanses'
        inflect.uncountable %w(fish)
      end
      Rails.autoloaders.main.inflector.inflect('api_client' => 'APIClient')`,
      "app/models/html_parser.rb":"class HTMLParser < ApplicationRecord; end",
      "app/services/api_client.rb":"class APIClient; end",
      "app/models/human.rb":"class Human < ApplicationRecord; end",
      "app/models/fish.rb":"class Fish < ApplicationRecord; end",
      "app/models/person.rb":"class Person < ApplicationRecord; end",
      "app/models/group.rb":"class Group < ApplicationRecord; has_many :humanses; has_many :fish; has_many :people; HTMLParser.run; APIClient.run; end",
    });
    expect(resolver.diagnostics).toEqual([]);
    expect(targets(resolver,"app/models/group.rb","association")).toEqual(["app/models/fish.rb","app/models/human.rb","app/models/person.rb"]);
    expect(targets(resolver,"app/models/group.rb","constant")).toEqual(["app/models/html_parser.rb","app/services/api_client.rb"]);
  });

  it.each([
    "ActiveSupport::Inflector.inflections(:en) { |i| i.singular(/foos/, 'foo') }",
    "ActiveSupport::Inflector.inflections(:en) { |i| i.acronym ENV['NAME'] }",
    "Rails.autoloaders.main.inflector = MyInflector.new",
  ])("diagnoses unsupported inflections: %s", source => {
    const {resolver} = setup({"config/initializers/inflections.rb":source,"app/models/user.rb":"class User; end","probe.rb":"User.find"});
    expect(resolver.diagnostics.length).toBeGreaterThan(0);
    expect(resolver.getDependencies("probe.rb")).toEqual([]);
    expect(resolver.camelize("user")).toBeNull();
    expect(resolver.pluralize("user")).toBeNull();
  });

  it("resolves literal AR associations with compute_type and collection-only singularization", () => {
    const {resolver} = setup({
      "app/models/person.rb":"class Person < ApplicationRecord; end",
      "app/models/people.rb":"class People < ApplicationRecord; end",
      "app/models/admin/person.rb":"module Admin; class Person < ApplicationRecord; end; end",
      "app/models/admin/group.rb":`class Admin::Group < ApplicationRecord
        has_many :people
        belongs_to :people
        belongs_to :owner, class_name: '::Person'
        has_one :boss, class_name: 'Person'
        has_and_belongs_to_many :friends, class_name: '::Person'
        has_many :pictures, class_name: '::Person', as: :imageable
      end`,
    });
    const facts = resolver.getDependencies("app/models/admin/group.rb").filter(f=>f.kind === "association");
    expect(facts).toHaveLength(6);
    expect(facts).toEqual(expect.arrayContaining([
      expect.objectContaining({target:"app/models/admin/person.rb",reference:"has_many :people => Person"}),
      expect.objectContaining({target:"app/models/people.rb",reference:"belongs_to :people => People"}),
      expect.objectContaining({target:"app/models/person.rb",reference:"belongs_to :owner, class_name: '::Person' => ::Person"}),
    ]));
  });

  it("rejects polymorphic, through, dynamic options/scopes and arbitrary DSL methods", () => {
    const {resolver} = setup({
      "app/models/person.rb":"class Person < ApplicationRecord; end",
      "app/models/group.rb":`class Group < ApplicationRecord
        belongs_to :person, polymorphic: true
        has_many :people, through: :links, class_name: 'Person'
        has_many :people, class_name: target_name
        has_many :people, -> { active }
        has_many :people, **options
        has_many dynamic_name
        has_many :people if enabled?
        def foo; has_many :people; end
      end`,
      "app/services/builder.rb":"class Builder; has_many :people; end",
      "app/models/plain.rb":"class Plain; has_many :people; end",
      "app/models/concerns/groupable.rb":"module Groupable; extend ActiveSupport::Concern; included do; has_many :people; end; end",
    });
    expect(targets(resolver,"app/models/group.rb","association")).toEqual([]);
    expect(targets(resolver,"app/services/builder.rb","association")).toEqual([]);
    expect(targets(resolver,"app/models/plain.rb","association")).toEqual([]);
    expect(targets(resolver,"app/models/concerns/groupable.rb","association")).toEqual(["app/models/person.rb"]);
    expect(resolver.diagnostics.map(d=>d.code)).toContain("unsupported_association");
    expect(resolver.diagnostics.map(d=>d.code)).toContain("unsupported_association_context");
  });

  it("does not invent bare references from dynamic namespace receivers or capitalized methods", () => {
    const {resolver} = setup({"app/models/user.rb":"class User; end", "probe.rb":"context::User.find; context.User; :User; 'User'; # User\n"});
    expect(targets(resolver,"probe.rb")).toEqual([]);
    expect(resolver.diagnostics.map(d=>d.code)).toContain("unsupported_constant_expression");
  });

  it("reports unknown ancestor lookup instead of fabricating a top-level fallback", () => {
    const {resolver} = setup({"app/models/user.rb":"class User; end","app/services/probe.rb":"class Probe < UnknownExternal; User.find; ::User.find; end"});
    expect(resolver.getDependencies("app/services/probe.rb")).toEqual([expect.objectContaining({reference:"::User",target:"app/models/user.rb"})]);
    expect(resolver.diagnostics.map(d=>d.code)).toContain("unsupported_ancestor_lookup");
  });

  it("keeps engine conventional roots and collisions, including concerns", () => {
    const {resolver} = setup({
      "engines/blog/lib/blog/engine.rb":"module Blog; class Engine < Rails::Engine; isolate_namespace Blog; end; end",
      "engines/blog/app/models/blog/post.rb":"module Blog; class Post < ApplicationRecord; end; end",
      "engines/blog/app/models/concerns/taggable.rb":"module Taggable; end",
      "app/services/probe.rb":"class Probe; Blog::Post.find; Taggable.run; end",
    });
    expect(targets(resolver,"app/services/probe.rb")).toEqual(["engines/blog/app/models/blog/post.rb","engines/blog/app/models/concerns/taggable.rb"].sort());
    expect(resolver.configuration.roots).toContainEqual(expect.objectContaining({path:"engines/blog/app/models",provenance:"engines/blog/lib/blog/engine.rb"}));
  });

  it("does not treat repeated namespace modules in engine library files as conflicting identities", () => {
    const {resolver} = setup({
      "engines/blog/lib/blog/engine.rb": "module Blog; class Engine < Rails::Engine; config.autoload_paths << File.expand_path('..', __FILE__); end; end",
      "engines/blog/lib/blog/helper.rb": "module Blog; class Helper; end; end",
      "engines/blog/lib/blog/version.rb": "module Blog; VERSION = '1'; end",
      "engines/blog/app/models/blog/post.rb": "module Blog; class Post; end; end",
      "probe.rb": "Blog::Post.new; Blog::Helper.run; Blog::VERSION",
    });
    expect(resolver.configuration.unsafe).toBe(false);
    expect(targets(resolver, "probe.rb")).toEqual(["engines/blog/app/models/blog/post.rb"]);
    expect(resolver.diagnostics.some(d => d.code === "ambiguous_constant" && d.message.startsWith("Multiple declarations of Blog:"))).toBe(false);
  });

  it.each(["class Blog; end", "Blog = Object", "module Blog; end if enabled?"])("keeps conflicting namespace declarations blocked: %s", source => {
    const {resolver} = setup({
      "app/models/blog.rb":"module Blog; end",
      "app/models/reopen.rb":source,
      "app/models/blog/post.rb":"module Blog; class Post; end; end",
      "probe.rb":"Blog::Post.new",
    });
    expect(targets(resolver, "probe.rb")).toEqual([]);
  });

  it("keeps read/parse failures separate from unsupported diagnostics and suppresses incomplete facts", () => {
    const {resolver} = setup({"app/models/user.rb":"class User; end","app/models/broken.rb":"class Broken <","probe.rb":"User.find"});
    expect(resolver.failures).toEqual([expect.objectContaining({path:"app/models/broken.rb",stage:"ruby-file-parse"})]);
    expect(resolver.diagnostics).toEqual([]);
    expect(resolver.getDependencies("probe.rb")).toEqual([]);
  });

  it("rejects escaping symlinks and traversal inventory paths", () => {
    const {root,inventory} = setup({"app/models/user.rb":"class User; end","probe.rb":"User.find"});
    const outside = mkdtempSync(join(tmpdir(),"ua-ruby-outside-")); temporary.push(outside);
    writeFileSync(join(outside,"evil.rb"),"class Evil; end");
    symlinkSync(join(outside,"evil.rb"),join(root,"app/models/evil.rb"));
    const resolver = createRubyDependencyResolver({projectRoot:root,files:[...inventory,{path:"app/models/evil.rb"},{path:"../escape.rb"}],plugin});
    expect(resolver.failures).toHaveLength(2);
    expect(resolver.sources.has("app/models/evil.rb")).toBe(false);
    expect(resolver.getDependencies("probe.rb")).toEqual([]);
  });

  it("is deterministic for inventory order and repeated resolution", () => {
    const {root,inventory,resolver} = setup({"app/models/user.rb":"class User; end","probe.rb":"User.find; ::User.find"});
    const reverse = createRubyDependencyResolver({projectRoot:root,files:[...inventory].reverse(),plugin});
    expect(reverse.getDependencies("probe.rb")).toEqual(resolver.getDependencies("probe.rb"));
    expect(reverse.diagnostics).toEqual(resolver.diagnostics);
    expect(resolver.getDependencies("probe.rb")).toEqual(resolver.getDependencies("probe.rb"));
  });

  it.each([
    "Rails.autoloaders.main.ignore(Rails.root.join('app', 'models', 'user.rb'))",
    "ActiveSupport::Inflector.inflections(:en) { |i| i.irregular 'human', 'people' }",
  ])("diagnoses engine loader/inflection configuration with unknown host context: %s", source => {
    const {resolver} = setup({
      "engines/blog/lib/blog/engine.rb":"module Blog; class Engine < Rails::Engine; end; end",
      "engines/blog/config/initializers/loader.rb":source,
      "app/models/user.rb":"class User < ApplicationRecord; end",
      "probe.rb":"User.find",
    });
    expect(resolver.failures).toEqual([]);
    expect(resolver.diagnostics).toContainEqual(expect.objectContaining({path:"engines/blog/config/initializers/loader.rb",code:expect.stringMatching(/^unsupported_/)}));
    expect(targets(resolver,"probe.rb")).toEqual([]);
  });

  it("indexes known local engine initializer shadowing", () => {
    const {resolver} = setup({
      "engines/blog/lib/blog/engine.rb":"module Blog; class Engine < Rails::Engine; end; end",
      "engines/blog/config/initializers/shadow.rb":"User = Struct.new(:id)",
      "app/models/user.rb":"class User < ApplicationRecord; end",
      "probe.rb":"User.find",
    });
    expect(targets(resolver,"probe.rb")).toEqual([]);
    expect(resolver.diagnostics).toContainEqual(expect.objectContaining({path:"engines/blog/config/initializers/shadow.rb",code:"unsupported_constant_assignment"}));
  });

  it("honors initializer constant shadowing on a framework ancestor before allowlisting it", () => {
    const {resolver} = setup({
      "config/initializers/shadow.rb":"class ActiveRecord::Base; User = Struct.new(:id); end",
      "app/models/user.rb":"class User < ApplicationRecord; end",
      "app/models/report.rb":"class Report < ApplicationRecord; User.find; ::User.find; end",
    });
    expect(resolver.getDependencies("app/models/report.rb").filter(f=>f.kind === "constant")).toEqual([expect.objectContaining({reference:"::User",target:"app/models/user.rb"})]);
    expect(resolver.diagnostics.map(d=>d.code)).toContain("unsupported_ancestor_lookup");
  });

  it("does not mistake a lexically shadowed ActiveRecord namespace for the framework", () => {
    const {resolver} = setup({
      "app/models/admin/active_record/base.rb":"module Admin; module ActiveRecord; class Base; def self.belongs_to(*args); end; end; end; end",
      "app/models/admin/report.rb":"module Admin; class Report < ActiveRecord::Base; belongs_to :user; end; end",
      "app/models/admin/real_report.rb":"module Admin; class RealReport < ::ActiveRecord::Base; belongs_to :user; end; end",
      "app/models/user.rb":"class User < ApplicationRecord; end",
    });
    expect(targets(resolver,"app/models/admin/report.rb","association")).toEqual([]);
    expect(targets(resolver,"app/models/admin/real_report.rb","association")).toEqual(["app/models/user.rb"]);
  });

  it("prioritizes custom irregular rules over defaults and earlier overlapping rules", () => {
    const {resolver} = setup({
      "config/initializers/inflections.rb":`ActiveSupport::Inflector.inflections(:en) do |i|
        i.irregular 'human', 'people'
        i.irregular 'person', 'humans'
      end`,
      "app/models/person.rb":"class Person < ApplicationRecord; end",
      "app/models/human.rb":"class Human < ApplicationRecord; end",
      "app/models/group.rb":"class Group < ApplicationRecord; has_many :people; has_many :humans; end",
    });
    expect(resolver.getDependencies("app/models/group.rb").filter(f=>f.kind === "association")).toEqual([
      expect.objectContaining({target:"app/models/human.rb",reference:"has_many :people => Human"}),
      expect.objectContaining({target:"app/models/person.rb",reference:"has_many :humans => Person"}),
    ]);
    const inflections = new RubyInflections();
    inflections.addIrregular("human","people");
    inflections.addIrregular("human","humans");
    expect(inflections.singularize("people")).toBe("human");
    expect(inflections.pluralize("human")).toBe("humans");
    inflections.addIrregular("person","people");
    expect(inflections.singularize("people")).toBe("person");
  });

  it.each(["while", "until"])("rejects %s modifier declarations and root config", modifier => {
    const declared = setup({"app/models/user.rb":`class User < ApplicationRecord; end ${modifier} enabled?`,"probe.rb":"User.find"}).resolver;
    expect(targets(declared,"probe.rb")).toEqual([]);
    expect(declared.diagnostics.map(d=>d.code)).toContain("unsupported_conditional_declaration");
    const configured = setup({
      "config/application.rb":`module Demo; class Application < Rails::Application; config.autoload_paths << 'lib' ${modifier} false; end; end`,
      "lib/user.rb":"class User; end", "probe.rb":"User.find",
    }).resolver;
    expect(targets(configured,"probe.rb")).toEqual([]);
    expect(configured.diagnostics.map(d=>d.code)).toContain("unsupported_autoload_config");
  });

  it("does not confuse harmless load-path exposure with root changes", () => {
    const {resolver} = setup({
      "config/application.rb":"module Demo; class Application < Rails::Application; config.add_autoload_paths_to_load_path = false; end; end",
      "app/models/user.rb":"class User < ApplicationRecord; end", "probe.rb":"User.find",
    });
    expect(targets(resolver,"probe.rb")).toEqual(["app/models/user.rb"]);
    expect(resolver.diagnostics).toEqual([]);
  });
});

describe("RubyInflections", () => {
  it.each(["user_", "user/", "user__group", "user//group"])("rejects malformed singular/plural input %s", value => {
    expect(new RubyInflections().pluralize(value)).toBeNull();
    expect(new RubyInflections().singularize(value)).toBeNull();
  });
  it.each(["foo__bar","foo_","foo::_Bar","_foo","foo//bar"])("rejects malformed camelize input %s without throwing",value=>{
    expect(new RubyInflections().camelize(value)).toBeNull();
  });
  it("separates singular and plural mappings",()=>{
    const inflections = new RubyInflections();
    expect(inflections.singularize("people")).toBe("person");
    expect(inflections.singularize("statuses")).toBe("status");
    expect(inflections.singularize("news")).toBe("news");
    expect(inflections.pluralize("geocoder")).toBe("geocoders");
    expect(inflections.pluralize("person")).toBe("people");
  });
});
