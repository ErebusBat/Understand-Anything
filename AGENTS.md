# Updating a feature branch from upstream

With the fork's feature branch checked out, run `git fetch upstream`, then
`git rebase upstream/main`. Push the updated branch to Gitea with
`git push origin HEAD`. If the rebase rewrote commits already published on
that branch, use `git push --force-with-lease origin HEAD` instead.

If Git rejects the lease, fetch `origin` and inspect the remote branch for
changes to incorporate before retrying. Gitea mirrors pushes to `github`.
