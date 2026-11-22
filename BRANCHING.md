# Branching model

**Model followed:** a trimmed-down Git Flow.

| Branch      | Purpose                                                    | Who writes to it            |
|-------------|------------------------------------------------------------|-----------------------------|
| `main`      | Always deployable. Every merge here gets an annotated tag. | Merge from `develop` only   |
| `develop`   | Integration branch; what the next release will contain.     | Merges from `feature/*` only |
| `feature/*` | One branch per part of the work (A–E, plus UI extras).     | Direct commits              |

Rules I kept to:

- No direct commits to `main` or `develop` — every change arrives through a pull request with a
  description and at least one review comment.
- PRs are merged with a **merge commit**, not squash, so the history shows what each branch contained.
- `v1.0.0` was tagged when the Docker Compose stack worked end to end, `v1.1.0` when the same stack
  ran on Kubernetes.
- Commit subjects use a type prefix (`feat:`, `fix:`, `docs:`, `chore:`, `ci:`) and say what the change
  does, not "update" or "wip".

## Would I recommend it to a team of five shipping daily?

No — not as-is. Git Flow's `develop` branch is a second long-lived integration point; with daily
releases it mostly adds a merge step and a place for changes to wait. For five people shipping daily I
would use **trunk-based development**: short-lived branches (hours, not days) merged into `main`
behind CI, feature flags for unfinished work, and a tag per release. I kept `develop` here because
the brief asks for it and because with one person and a review step per part it costs very little.
