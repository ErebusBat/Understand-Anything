# Static Rails dependencies

Rails dependency extraction runs as part of `extract-import-map.mjs`. It parses Ruby with the existing tree-sitter grammar and reads only files in the selected inventory within the project boundary. It does not boot Rails or execute application configuration.

Explicit `require` and `require_relative` relationships remain in `importMap`. The additional scan fields are:

- `dependencyMap`: source file paths mapped to facts with `target`, `type`, `kind`, optional `reference`, and optional source `line`. A convention-based match carries `resolution: "inferred"`. Graph search and explain display that marker alongside the source line.
- `dependencyDiagnostics`: unsupported or ambiguous cases, with a code, message, source path, optional line, and optional `candidateTarget` file for a mixin. Read and parse failures remain in `failures`.
- `dependencyResolverVersion`: the persisted version of the dependency resolver.
- `rubyMixinResolution`: the effective project mode, either `pragmatic` (default) or `strict`.

Constants, associations and literal template renders produce `depends_on`, superclasses produce `inherits`, and supported routes produce `routes`. `include` and `extend` keep their distinct evidence while both use `depends_on`. All endpoints are files: a model's `find` call or a route action name does not create a method node.

Batching uses the union of imports and typed dependencies for communities and neighbor context. It passes explicit imports in `batchImportData` and typed facts in `batchDependencyData`. Merge recovery restores missing facts deterministically, deduplicates file/type pairs, and keeps source evidence in edge descriptions.

## Supported subset

The resolver recognizes Rails applications through their configuration's `Rails::Application` inheritance. Conventional roots include existing `app` subdirectories except assets, javascript, and views. Rails 3 requires explicit configuration for nested concern roots. Rails 4 adds `app/models/concerns` and `app/controllers/concerns`. Rails 5 extends this convention to other `app/*/concerns` directories. `lib` requires explicit configuration. [Rails 3.2 paths](https://github.com/rails/rails/blob/v3.2.22.5/railties/lib/rails/engine/configuration.rb#L39-L49), [Rails 4.2 paths](https://github.com/rails/rails/blob/v4.2.10/railties/lib/rails/engine/configuration.rb), [Rails 5.2 paths](https://github.com/rails/rails/blob/v5.2.8.1/railties/lib/rails/engine/configuration.rb)

By default, the deepest matching root determines the expected constant name. For a classic Rails application, the resolver checks each overlapping root for an unconditional matching declaration. For example, `app/models/concerns/searchable.rb` can declare `Searchable` or `Concerns::Searchable`. The same rule applies to explicitly configured directories such as `lib` and `lib/toolbox`. Classic Rails also derives a path from the declared spelling, so `QR::Badge` can resolve to `qr/badge.rb` without a configured acronym. Competing file paths produce an ambiguity diagnostic.

Classic root lookup requires one unconditional, top-level, two-argument Rails gem declaration in the application's own selected Gemfile. The supported version forms are a numeric Rails 3–5 version, an exact requirement such as `'= 5.2.8'`, and a pessimistic requirement such as `'~> 4.2.10'`. Other requirements use the default root lookup.

Local engines contribute conventional roots when a static `Rails::Engine` declaration appears in a known `<engine-prefix>/lib/.../engine.rb` location. Root provenance is retained; duplicate constants do not get an invented load-order winner. Engine initializer declarations participate in shadowing checks. Unknown engine contexts and engine loader/inflection customization are diagnosed and suppress inferred facts. Missing external engine sources cannot be resolved.

A hosted engine's verified declaration can also identify a literal route mount without adding its `lib` directory to the autoload roots. Competing engine declarations, namespace assignments, and local framework substitutes prevent that match. Nested applications, including engine dummy applications, retain independent inventories.

Relative qualified declarations inside a lexical body, such as `module Atelier; module Sheets::Helpers::PaletteHelpers`, use the indexed lexical and autoload namespaces to establish their owner. The qualified spelling does not introduce intermediate lexical nesting. Unknown owners and conflicting or shadowed namespaces remain diagnosed.

Static configuration support includes literal root additions through `<<` and `+=`, literal arrays and `%w`, `Rails.root.join` with literal arguments, and `config.autoload_lib(ignore: [...])` or its once-loader equivalent. Inflection handling separates loader basename overrides from association naming and supports literal acronyms, irregulars, and uncountables.

Constant lookup preserves actual Ruby lexical nesting, compact namespaces, and leading `::`. Ambiguous roots, conflicting declarations, and unsupported shadowing remain unresolved rather than choosing a basename match.

The default `pragmatic` mode handles literal, qualified mixins such as `include Concerns::Auditable`. The resolver first checks the enclosing namespaces and inspectable ancestors. If an external ancestor is unknown, the top-level spelling identifies one local module, and there is no evidence of shadowing, the resolver emits a file dependency with `resolution: "inferred"`. Graph search and explain show `inferred include` or `inferred extend` and the source line. An explicit root-qualified reference such as `::Concerns::Auditable` uses top-level lookup directly. Pragmatic mode can also infer a constant used as a method receiver when the uniquely identified local provider directly defines the public singleton method at that call site. An unqualified mixin can use the same fallback when its provider directly extends `ActiveSupport::Concern`. For receiver calls, other evidence includes a public Ruby module function, a class with an explicit initializer, or a known Active Record model receiving a standard query method. Strict mode disables these ancestry fallbacks. Test registrations and templates use their own matching rules in both modes.

A qualified, unique Active Record model with its own public singleton `method_missing` can corroborate an inferred receiver after the same shadowing checks. This supplies file-level receiver evidence for a dynamic accessor, without claiming that its selector has a static method declaration. Strict mode retains the unknown-ancestry diagnostic.

Uninspected Devise ancestors and dynamic ancestry keep the mixin in diagnostics when lookup is uncertain. In `strict` mode, all such uncertain mixins stay in diagnostics. A unique local candidate appears as `candidateTarget`. To switch modes, run `/understand --ruby-mixin-resolution strict` or `/understand --ruby-mixin-resolution pragmatic`. The command saves the preference in the project's analysis configuration.

A literal `require` can resolve against local path gems declared in the owning Gemfile. The gemspec supplies the ordered `require_paths` or the RubyGems `lib` default. Competing providers suppress the match. For a literal Rails `require_dependency`, the resolver checks the application autoload roots before the regular load paths.

Ruby imports also accept selected paths constructed with `File.expand_path`, `__FILE__`, and a known `Rails.root.join`. A rooted `Dir.glob` or `Dir[...].each` can supply files to `require` or `File.read`. Expansion uses the inventory of the owning application. File reads produce a dependency at the read site.

A constant read can point to the unique unconditional assignment that supplies its value. This covers Rails initializers and autoload files such as a GraphQL type assigned by `GraphQL::ObjectType.define`. Resolving the assignment locates the source file without evaluating its right-hand side.

A literal, top-level `require_relative` can also establish where a subsequent `include` or `extend` gets its module. The required file must be in the selected inventory and declare the named top-level module unconditionally. This evidence applies to the consumer that loads it, including when the provider's filename differs from its Rails autoload name.

The Ruby structural extractor also reads method definitions in modules that directly extend `ActiveSupport::Concern`. It records the names, parameters, and source lines of methods defined directly inside `included` and `class_methods` blocks, including singleton methods written with `def self.name` or `class << self`. Methods in an `included` block carry `owner: null` because the host is selected at runtime. Methods in a `class_methods` block belong to the concern's `ClassMethods` module.

Direct `belongs_to`, `has_one`, `has_many`, and `has_and_belongs_to_many` associations use local model names, including on declarations with a scope lambda. An initializer can reopen `ActiveRecord::Base` while preserving its model identity. A `class_name` override can use a literal name or a resolvable local model’s `.name` or `.to_s`. The resolver can trace a `through:` declaration over two known direct model associations, including a literal `source:`, and marks the resulting association inferred. Polymorphic and dynamic associations stay unresolved. A literal `validates :code, label_code: true` can link to a local `LabelCodeValidator`. Serializer options can link to the explicitly named local serializer.

In the main application's `routes.draw` block, literal HTTP verbs, `match`, `root`, resources, and their nested routes can link to controllers. The resolver follows literal namespaces, URL scopes, module overrides, and a local zero-argument route lambda mounted by a namespace. It retains a constant or configuration guard such as `if PREVIEW_ENABLED` or `if SiteOptions.routes.preview` in the source evidence, including the inverse guard for an `else` branch. Literal Rack mounts link to resolvable local constants. Dynamic destinations and mount targets that require external boot code produce diagnostics. A local Grape API can link to mounted endpoint classes and helper modules inside its routing scopes. Pragmatic mode can use a corroborated endpoint or helper when the unresolved ancestor is `Grape::API`.

Controller renders, layout declarations and literal partials in ERB, Haml, and Slim can link to local templates. A public empty action and a relative partial with an established rendering controller can produce inferred links. Competing formats, variants, or overridden view lookup can prevent a match. In Rails assets using standard `handlebars_assets` registration, literal Handlebars partial tags can link to the registered template.

A Resque scheduler initializer can identify its YAML schedule directly or through a local configuration accessor. Literal job names and class overrides link to a local job implementation with inferred evidence at the schedule line. The evidence retains the environment section when present.

RSpec shared-group names and explicit FactoryBot or FactoryGirl builder calls can link to unique declarations in the owning suite. Literal factory associations can link to their target factories, and explicit sequence generation can link to a global sequence declaration. Each package registry checks both `spec/factories` and `test/factories` for calls in Ruby specs, tests and Cucumber support code. These references carry inferred evidence. A receiver-less builder also requires an example context and a load path, from the spec or a literal helper requirement in the suite’s `.rspec`, to an unfiltered `RSpec.configure` inclusion of `FactoryBot::Syntax::Methods`. A conflicting declaration or local helper shadow suppresses the match.

Literal `VCR.use_cassette` calls can link to inventoried YAML files when the spec loads a helper that configures the cassette directory.

Ruby test pairing recognizes exact Minitest/RSpec unit-test paths, including `*_helper` units under `app/helpers`, and gem `lib` conventions, preserving namespaces and engine prefixes. Both files must exist. The direction is production → test. Request, system, integration, shared-example, and test-support paths are excluded; pairing is a naming heuristic, not proof of coverage.

## Incremental updates

Changes to Ruby sources, RSpec defaults, templates, or supported configuration refresh affected deterministic facts, including consumers whose source did not change. Inventory changes, resolver version migration, changing `rubyMixinResolution`, and missing dependency baselines also trigger refresh. A mode change at an unchanged Git commit updates the graph without reanalyzing source files. Empty refreshed fact lists replace old lists, and merge removes prior deterministic edges before recovering the current facts. Existing unrelated semantic relationships are preserved.

On the first incremental run with concern-hook extraction, the scanner identifies Ruby files that may contain hook methods. Preparation compares their new function counts with the saved fingerprints even when the source bytes match. Files that gain methods or lack structural fingerprints enter reanalysis. The following run can reuse the updated baseline.

The resolver diagnoses explicit loader overrides such as `config.autoloader = :classic` and disables inference for that application. Unsupported loader configuration, custom executable inflections, or an incomplete Ruby read/parse pass likewise suppress inferred Ruby facts. Safe explicit imports remain available, and incremental preparation stops on read/parse failures.

Fixture tests cover recovered and rejected edges, pipeline propagation, repeatability, and incremental replacement. They do not establish compatibility with every Rails version or a full application/LLM analysis run.

## Method and test evidence

The Ruby scanner records the location and outcome of each recognized call site.
For a uniquely resolved public singleton method, graph assembly links the caller
and callee across batches. A dynamic selector can retain its known receiver
without a method edge. For example, a synthetic fixture calling
`TileCatalog.tiles_for_sheet` exercises cross-file lookup and incremental refresh.

The graph also links supported mailer actions to templates and literal scenario
steps to unique definitions in the same suite. Static test associations record
whether the evidence came from an explicit RSpec subject or a filename match.
