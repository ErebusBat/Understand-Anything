# Ruby grammar compatibility build

Source: [tree-sitter/tree-sitter-ruby](https://github.com/tree-sitter/tree-sitter-ruby),
revision `ad907a69da0c8a4f7a943a7fe012712208da6dee` (MIT).
The revision is also recorded in `.ruby-grammar-pin`.

The published 0.23.1 grammar rejects two valid Ruby constructs: an adjacent
`<<` operator inside a method and a parenthesized call chained after a command
with a `do` block. `compatibility.patch` fixes the scanner's heredoc/operator
distinction and admits chained command calls as receivers. No source rewriting,
error recovery bypass, Ruby interpreter, or application execution is involved.
Both strict structural analysis and dependency analysis use this grammar.

Rebuild from this package directory:

```sh
package_dir="$PWD"
build_dir="$(mktemp -d)"
git clone https://github.com/tree-sitter/tree-sitter-ruby.git "$build_dir/ruby"
cd "$build_dir/ruby"
git checkout ad907a69da0c8a4f7a943a7fe012712208da6dee
git apply "$package_dir/compatibility.patch"
npx -y tree-sitter-cli@0.26.9 generate
npx -y tree-sitter-cli@0.26.9 test
npx -y tree-sitter-cli@0.26.9 build --wasm
cp tree-sitter-ruby.wasm "$package_dir/"
```

The CLI uses WASI SDK 29 for this build. Validation: all 291 upstream corpus
parses plus highlighting assertions passed. Repository regression tests in
`core/src/ruby/parser-compatibility.test.ts` check AST shape, strict analysis,
heredocs, shifts, singleton classes, and continued rejection of invalid Ruby.

Artifact SHA-256:
`e211a7765cd05fe2eb7160dc219c56ef7bfbb2c0b5781916a488329d099be175`.

Replace this package with the upstream npm grammar when a release includes
these fixes and passes the regression tests.
