# Reuse a graph in a Git worktree

Keep a graph in a long-lived checkout of your base branch. From each new worktree, run this setup command before starting Understand Anything. It also works from a subdirectory or a checkout with its own justfile.

```sh
just --justfile "$HOME/src/worktrees/justfile" ua-seed
```

The recipe searches sibling checkouts registered with Git, including those backed by a bare repository. It prefers a graph at the worktree's exact HEAD, then the eligible ancestor with the fewest intervening commits. It checks the recorded commit in the graph, metadata, and versioned fingerprints. Supply a graph directory as the final argument to select a specific baseline, including an archive outside the worktree list.

```sh
just --justfile "$HOME/src/worktrees/justfile" ua-seed "/path/to/archive/.understand-anything"
```

The seed is an independent, Git-ignored copy in the new checkout's `.ua/`. It carries over the analyzed commit, fingerprints, scan inventory, settings, ignores, and code lessons when available. The helper requests a copy-on-write clone where the filesystem supports it. An existing data directory or tracked graph takes precedence. An automatic cache miss prints a message and exits successfully. An invalid explicitly selected source returns an error.

## Analyze and update

Run the same command to create the initial graph on your base branch, refresh it as the base advances, or analyze committed changes on a feature branch.

```sh
just --justfile "$HOME/src/worktrees/justfile" ua-analyze
```

The recipe runs `ua-seed`, then starts an interactive Claude Code session at the current Git root with `UNDERSTAND_NO_WORKTREE_REDIRECT=1`. If this is the first analysis and no graph is available, it creates a Git-ignored `.ua/` directory. Claude runs the fork's `/understand-anything:understand` skill and can prompt you to review file exclusions. The default uses incremental analysis when a baseline is available.

For a deliberate full rebuild, append `--full`. Pass multiple skill options together as one quoted string, for example `ua-analyze '--review --language en'`. The launcher loads the plugin from `~/src/vendor/Understand-Anything/understand-anything-plugin`. Set `UA_PLUGIN_ROOT` to the plugin directory if your fork lives elsewhere.

Remove finished worktrees normally with T3 Code or Worktrunk. Their local copies go with them.

## Install the shared command

From an Understand Anything source checkout, copy the recipes and helpers to your shared worktrees directory.

```sh
mkdir -p "$HOME/src/worktrees"
cp scripts/worktrees/ua.just scripts/worktrees/seed-graph.mjs scripts/worktrees/analyze-graph.sh "$HOME/src/worktrees/"
```

Add `import? "ua.just"` to your shared justfile. You can also use the standalone module directly with `just --justfile "$HOME/src/worktrees/ua.just" ua-seed`.

In **T3 Code**, use the setup command at the top of this page as a worktree command, with the new checkout as its working directory.

In **Worktrunk**, add this named hook to the user configuration (`~/.config/worktrunk/config.toml`) to seed automatically before the first command runs in a new worktree. If you already have a `[pre-start]` table, add the entry to it.

```toml
[pre-start]
ua-seed = 'just --justfile "$HOME/src/worktrees/justfile" ua-seed'
```
