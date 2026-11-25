# Static Rails dependencies

Rails dependency extraction runs as part of `extract-import-map.mjs`. It parses Ruby with the existing tree-sitter grammar and reads only files in the selected inventory within the project boundary. It does not boot Rails or execute application configuration.

Explicit `require` and `require_relative` relationships remain in `importMap`. The additional scan fields are:

- `dependencyMap`: source file paths mapped to facts with `target`, `type`, `kind`, optional `reference`, and optional source `line`.
- `dependencyDiagnostics`: unsupported or ambiguous cases, with a code, message, source path, optional line, and optional `candidateTarget` file for a qualified mixin. Read and parse failures remain in `failures`.
- `dependencyResolverVersion`: the persisted version of the dependency resolver.

Constants, associations and literal template renders produce `depends_on`, superclasses produce `inherits`, and supported routes produce `routes`. `include` and `extend` keep their distinct evidence while both use `depends_on`. All endpoints are files: a model's `find` call or a route action name does not create a method node.

Batching uses the union of imports and typed dependencies for communities and neighbor context. It passes explicit imports in `batchImportData` and typed facts in `batchDependencyData`. Merge recovery restores missing facts deterministically, deduplicates file/type pairs, and keeps source evidence in edge descriptions.

## Supported subset

The resolver recognizes Rails applications through their configuration's `Rails::Application` inheritance. Conventional roots include existing `app` subdirectories except assets, javascript, and views. Both `app/models` and `app/models/concerns` are roots when they contain Ruby sources. `lib` requires explicit configuration.

By default, the deepest matching root determines the expected constant name. For a classic Rails application, the resolver checks each overlapping root for an unconditional matching declaration. For example, `app/models/concerns/searchable.rb` can declare `Searchable` or `Concerns::Searchable`. The same rule applies to explicitly configured directories such as `lib` and `lib/toolbox`. Competing file paths produce an ambiguity diagnostic.

Classic root lookup requires one unconditional, top-level, two-argument Rails gem declaration in the application's own selected Gemfile. The supported version forms are a numeric Rails 3–5 version, an exact requirement such as `'= 5.2.8'`, and a pessimistic requirement such as `'~> 4.2.10'`. Other requirements use the default root lookup.

Local engines contribute conventional roots when a static `Rails::Engine` declaration appears in a known `<engine-prefix>/lib/.../engine.rb` location. Root provenance is retained; duplicate constants do not get an invented load-order winner. Engine initializer declarations participate in shadowing checks. Unknown engine contexts and engine loader/inflection customization are diagnosed and suppress inferred facts. Missing external engine sources cannot be resolved.

Static configuration support includes literal root additions through `<<` and `+=`, literal arrays and `%w`, `Rails.root.join` with literal arguments, and `config.autoload_lib(ignore: [...])` or its once-loader equivalent. Inflection handling separates loader basename overrides from association naming and supports literal acronyms, irregulars, and uncountables.

Constant lookup preserves actual Ruby lexical nesting, compact namespaces, and leading `::`. Ambiguous roots, conflicting declarations, and unsupported shadowing remain unresolved rather than choosing a basename match.

An external ancestor can define the first name in a qualified `include` or `extend`. If its top-level spelling identifies one local module and the resolver finds no known shadow, the `unsupported_ancestor_lookup` diagnostic includes that file as `candidateTarget`. The diagnostic retains the source line for inspection. Confirmed mixins enter the dependency graph.

Direct `belongs_to`, `has_one`, `has_many`, and `has_and_belongs_to_many` associations are recognized in model and concern contexts when their names/options and local model targets can be resolved. Collection naming uses singularization; explicit `class_name` uses model namespace lookup. Polymorphic `belongs_to`, `through`, dynamic options, callback simulation, and join-model inference are outside this subset.

Routes accept immediate literal HTTP declarations with `to: "controller#action"` and option-free `resources`/`resource` in the main application's `routes.draw` block. Both `Rails.application` and the statically declared application class can be the receiver. Literal `namespace` blocks qualify controller names, including when `path:` or `as:` changes the URL or route helpers. Singular resources pluralize the controller name. Other scopes, conditions, arbitrary blocks, mounts, drawn files, engine routes, and resource options produce diagnostics.

A literal controller `render` can resolve to a single HTML ERB, Haml, or Slim template under the application's `app/views`. The lookup checks the controller's ancestry, view path overrides, and competing formats or variants. Each fact identifies the render call's source line. Implicit renders and runtime-selected templates remain unresolved.

Ruby test pairing recognizes exact Minitest/RSpec unit-test paths, including `*_helper` units under `app/helpers`, and gem `lib` conventions, preserving namespaces and engine prefixes. Both files must exist. The direction is production → test. Request, system, integration, shared-example, and test-support paths are excluded; pairing is a naming heuristic, not proof of coverage.

## Incremental updates

Ruby source changes conservatively refresh Ruby dependency facts, including consumers whose source did not change. Inventory changes, resolver version migration, and missing dependency baselines also trigger refresh. Empty refreshed fact lists replace old lists, and merge removes prior deterministic edges before recovering the current facts. Existing unrelated semantic relationships are preserved.

The resolver diagnoses explicit loader overrides such as `config.autoloader = :classic` and disables inference for that application. Unsupported loader configuration, custom executable inflections, or an incomplete Ruby read/parse pass likewise suppress inferred Ruby facts. Safe explicit imports remain available, and incremental preparation stops on read/parse failures.

Fixture tests cover recovered and rejected edges, pipeline propagation, repeatability, and incremental replacement. They do not establish compatibility with every Rails version or a full application/LLM analysis run.
