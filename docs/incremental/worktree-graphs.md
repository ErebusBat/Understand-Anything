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

1. **Create the base once.** In your long-lived checkout, run the `understand` skill at a clean, committed base. To keep a first-time graph private in a project with neither data directory, run `mkdir .ua && printf '*\n' > .ua/.gitignore` before analysis. If the base checkout itself is a linked worktree, use the session setting below here as well.
2. **Work on the branch.** Seed the worktree. You can read the copied graph immediately. After committing code changes, run `understand` in the worktree with `UNDERSTAND_NO_WORKTREE_REDIRECT=1` in the analyzer's environment. The planner compares the recorded baseline to the branch. A current graph can skip semantic analysis. Large changes or extractor upgrades can require more work.
3. **Refresh and clean up.** Rerun `understand` in the long-lived checkout as the base advances. New worktrees will pick up that graph. Remove finished worktrees normally with T3 Code or Worktrunk. Their local copies go with them.

For an interactive agent launched from a shell, set the variable on the process that runs the skill, for example `UNDERSTAND_NO_WORKTREE_REDIRECT=1 claude`. In an existing T3 conversation, give the agent this instruction.

> Run the understand skill on this worktree's Git root. Set UNDERSTAND_NO_WORKTREE_REDIRECT=1 when resolving the project root and keep the analysis in this checkout.

## Install the shared command

From an Understand Anything source checkout, copy the two files to your shared worktrees directory.

```sh
mkdir -p "$HOME/src/worktrees"
cp scripts/worktrees/ua.just scripts/worktrees/seed-graph.mjs "$HOME/src/worktrees/"
```

Add `import? "ua.just"` to your shared justfile. You can also use the standalone module directly with `just --justfile "$HOME/src/worktrees/ua.just" ua-seed`.

In **T3 Code**, use the setup command at the top of this page as a worktree command, with the new checkout as its working directory.

In **Worktrunk**, add this named hook to the user configuration (`~/.config/worktrunk/config.toml`) to seed automatically before the first command runs in a new worktree. If you already have a `[pre-start]` table, add the entry to it.

```toml
[pre-start]
ua-seed = 'just --justfile "$HOME/src/worktrees/justfile" ua-seed'
```
