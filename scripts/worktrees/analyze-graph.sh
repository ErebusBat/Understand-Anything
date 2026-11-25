#!/bin/sh
set -eu

root=$(git rev-parse --show-toplevel)
plugin=${UA_PLUGIN_ROOT:-"$HOME/src/vendor/Understand-Anything/understand-anything-plugin"}
if [ ! -f "$plugin/skills/understand/SKILL.md" ]; then
    echo "Cannot find the understand skill in $plugin. Set UA_PLUGIN_ROOT to its plugin directory." >&2
    exit 1
fi
plugin=$(cd "$plugin" && pwd -P)
command -v claude >/dev/null || { echo "ua-analyze requires the Claude Code CLI (claude)." >&2; exit 1; }
cd "$root"

# A first analysis should have the same Git visibility as a seeded graph.
data_dir=.ua
if [ -d .understand-anything ]; then data_dir=.understand-anything; fi
if [ -L "$data_dir" ]; then
    echo "Cannot run worktree-local analysis through the symlink $root/$data_dir." >&2
    exit 1
fi
if [ ! -e "$data_dir" ] && [ -z "$(git ls-files -- "$data_dir")" ]; then
    mkdir "$data_dir"
    printf '*\n' > "$data_dir/.gitignore"
fi

export UNDERSTAND_NO_WORKTREE_REDIRECT=1
exec claude --plugin-dir "$plugin" -- "/understand-anything:understand${1:+ $1}"
