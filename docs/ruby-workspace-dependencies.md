# Ruby dependencies in workspaces

The resolver handles nested Rails applications independently. An inventory
path such as `service/master/app/models/user.rb` stays workspace-relative in
the graph, while its application uses `service/master` as its resolution root.

The extractor discovers candidate application boundaries from inventory entries
ending in `config/application.rb`. It discovers standalone engine boundaries from
`lib/**/engine.rb` when they are outside an application. The existing Ruby AST
checks still determine whether a candidate contains a Rails application or engine;
filenames alone do not enable autoload inference.

Each file belongs to its nearest boundary. Nested dummy applications have their
own contexts. An engine inside an application remains with its host. Constants,
autoload configuration, inflections, and parse failures do not leak between
independent applications. Ordinary Ruby outside those contexts retains explicit
require resolution without inferred Rails dependencies.

Explicit `require` probes use the owning application's `lib/`, `app/`, and root.
`require_relative` keeps its source-relative behavior. Inferred constants do not
fall back to a sibling application even when that sibling has a unique matching
class name. Symlinks must stay within both the workspace and the owning context.

Supported root expressions include literal paths/arrays, `%w`/`%W`, root joins,
leading root interpolation, literal arrays mapped with `&Rails.root.method(:join)`,
and local paths assigned once and used only for additive loader configuration.
`File.expand_path` accepts literal relative paths with a known root or `__FILE__`
base. In a hosted engine, `root` and `config.root` refer to the engine while
`Rails.root` refers to the application. An unknown standalone engine host remains
unsupported. No Ruby or application configuration is executed.

Read-only `config.paths['log']` access does not customize loading. Literal
`config.paths.add` file globs (`*.rb`, `**/*.rb`) without loading flags are
recognized separately from autoload entries. Rails treats `autoload_paths`
entries literally; the resolver never expands a `*` in those entries. Missing
directories receive `inactive_autoload_root` diagnostics. Metadata checks can
establish that a statically expanded external directory is absent, but source
outside the owning context is never read. Existing external directories, symlink
escapes, inaccessible paths, and dynamic configuration still block inference.

Repeated module declarations preserve a namespace's identity. They no longer
block every child constant merely because library files reopen that namespace.
Class conflicts, assignments, conditional declarations, and competing autoload
roots remain ambiguous, and module mixins remain part of ancestor checks.

The resolver follows reads of unique nested literal constants and constants
defined in Rails initializers. It records references in assignment right-hand
sides and checks file-local shadows in tests and Rake tasks. For example, a
locally defined test double can shadow the application model of the same name.
An unconditional module declaration can establish a namespace even when an
initializer conditionally reopens that module.

The [vendored Ruby grammar](../understand-anything-plugin/packages/tree-sitter-ruby-wasm/BUILD.md)
fixes adjacent append operators being mistaken for heredocs and parenthesized
calls chained after command blocks. Strict structural and dependency analysis
share it; malformed Ruby still fails closed.

## Running the parser

Build the checkout's core package first:

```sh
pnpm --filter @understand-anything/core build
```

The existing extractor accepts a complete workspace inventory:

```json
{
  "projectRoot": "/path/to/workspace",
  "files": [
    {"path": "service/master/config/application.rb", "language": "ruby", "fileCategory": "code"},
    {"path": "service/master/app/models/user.rb", "language": "ruby", "fileCategory": "code"},
    {"path": "service/master/app/controllers/users_controller.rb", "language": "ruby", "fileCategory": "code"}
  ]
}
```

```sh
node understand-anything-plugin/skills/understand/extract-import-map.mjs input.json output.json
```

An optional `analysisPaths` array limits emitted facts, but `files` must still
contain the full selected inventory, including application configuration and
unchanged declarations. Output paths, failure locations, and diagnostic locations
are all workspace-relative. `dependencyContexts` lists each constructed context's
root, Rails detection result, and blocked status. Rejected context roots appear in
`failures` without reading their sources.

## Completeness and upgrades

A read or parse failure in a `.rb` file, or unsupported loader configuration,
blocks inferred dependencies within its owning context. Ruby tasks, manifests
and binstubs can consume autoloaded constants. A failed parse in one of those
consumers is reported against that file. Other application contexts can complete.
Inspect `failures`, `dependencyDiagnostics`, and `dependencyContexts`; a completed
extractor process does not establish complete dependency coverage. Dynamic Ruby,
ambiguous constants, unknown ancestors, and unsupported route DSL constructs
remain explicit limitations. Zero parse failures does not mean zero unresolved
references, and isolated graph nodes are not a count of failed parses.

Incremental analysis detects the resolver-version change and refreshes both Ruby
dependency facts and explicit imports, even with no source edits. Existing
incremental publication checks still reject extraction failures. A non-Git
workspace cannot use the Git-based incremental command; a dependency-only repair
must preserve the saved graph, validate unchanged inputs and graph references,
and retain explicit diagnostics for incomplete contexts.
