# Static Rails dependencies

Rails dependency extraction runs as part of `extract-import-map.mjs`. It parses Ruby with the existing tree-sitter grammar and reads only files in the selected inventory within the project boundary. It does not boot Rails or execute application configuration.

Explicit `require` and `require_relative` relationships remain in `importMap`. The additional scan fields are:

- `dependencyMap`: source file paths mapped to facts with `target`, `type`, `kind`, optional `reference`, and optional source `line`.
- `dependencyDiagnostics`: unsupported or ambiguous cases, with a code, message, source path, and optional line. Read and parse failures remain in `failures`.
- `dependencyResolverVersion`: the persisted resolver format/version, currently `1`.

Constants and associations produce `depends_on`, superclasses produce `inherits`, and supported routes produce `routes`. `include` and `extend` keep their distinct evidence while both use `depends_on`. All endpoints are files: a model's `find` call or a route action name does not create a method node.

Batching uses the union of imports and typed dependencies for communities and neighbor context. It passes explicit imports in `batchImportData` and typed facts in `batchDependencyData`. Merge recovery restores missing facts deterministically, deduplicates file/type pairs, and keeps source evidence in edge descriptions.

## Supported subset

The resolver recognizes Rails applications through their configuration's `Rails::Application` inheritance. Conventional roots include existing `app` subdirectories except assets, javascript, and views; nested `concerns` directories are independent roots. `lib` requires explicit configuration.

Local engines contribute conventional roots when a static `Rails::Engine` declaration appears in a known `<engine-prefix>/lib/.../engine.rb` location. Root provenance is retained; duplicate constants do not get an invented load-order winner. Engine initializer declarations participate in shadowing checks. Unknown engine contexts and engine loader/inflection customization are diagnosed and suppress inferred facts. Missing external engine sources cannot be resolved.

Static configuration support includes literal root additions through `<<` and `+=`, literal arrays and `%w`, `Rails.root.join` with literal arguments, and `config.autoload_lib(ignore: [...])` or its once-loader equivalent. Inflection handling separates loader basename overrides from association naming and supports literal acronyms, irregulars, and uncountables.

Constant lookup preserves actual Ruby lexical nesting, compact namespaces, and leading `::`. Ambiguous roots, conflicting declarations, and unsupported shadowing remain unresolved rather than choosing a basename match.

Direct `belongs_to`, `has_one`, `has_many`, and `has_and_belongs_to_many` associations are recognized in model and concern contexts when their names/options and local model targets can be resolved. Collection naming uses singularization; explicit `class_name` uses model namespace lookup. Polymorphic `belongs_to`, `through`, dynamic options, callback simulation, and join-model inference are outside this subset.

Routes accept immediate literal HTTP declarations with `to: "controller#action"` and option-free `resources`/`resource` in the main application's `Rails.application.routes.draw` block. Singular resources pluralize the controller name. Nested scopes, conditions, blocks, mounts, drawn files, engine routes, and resource options produce diagnostics.

Ruby test pairing recognizes exact Minitest/RSpec unit-test paths and gem `lib` conventions, preserving namespaces and engine prefixes. Both files must exist. The direction is production → test. Request, system, integration, shared-example, support, and helper paths are excluded; pairing is a naming heuristic, not proof of coverage.

## Incremental updates

Ruby source changes conservatively refresh Ruby dependency facts, including consumers whose source did not change. Inventory changes, resolver version migration, and missing dependency baselines also trigger refresh. Empty refreshed fact lists replace old lists, and merge removes prior deterministic edges before recovering the current facts. Existing unrelated semantic relationships are preserved.

This resolver uses a bounded subset of Zeitwerk-style conventions; explicit classic-loader configuration disables inference with a diagnostic. Unsupported loader configuration, custom executable inflections, or an incomplete Ruby read/parse pass suppress inferred Ruby facts rather than choose uncertain targets. Safe explicit imports remain available, and incremental preparation stops on read/parse failures.

Fixture tests cover recovered and rejected edges, pipeline propagation, repeatability, and incremental replacement. They do not establish compatibility with every Rails version or a full application/LLM analysis run.
