# Changelog

## Unreleased

### Changed

- Renamed the project to Looongtime: the CLI binary is now `looongtime`, configuration reads `LOOONGTIME_HOME`/`LOOONGTIME_MODEL`, and state lives in `~/.looongtime`. `~/.longtime` and the `LONGTIME_*` variables are still honoured as legacy fallbacks, ahead of the older Continuum aliases.
- Goal Contracts now retain the original objective alongside additive hard requirements, constraints, and locked task-specific verification commands.
- Locked constraints are compiled into required proof criteria rather than remaining advisory prompt text; host risk routing prevents executors from downgrading them.
- Empty or oversized Goal Contracts are rejected, and resume now rejects attempts to silently change the locked workspace, requirements, constraints, or verification commands.
- Change-oriented goals lock an initial workspace fingerprint and cannot complete without a net workspace change; CLI overrides make the policy explicit at run creation.
- Completion after workspace mutation requires host-created `verify` evidence linked to every required Requirement; ordinary Shell success is diagnostic only.
- Verification rejects trivial commands, no-op package scripts, failure-masking pipelines, and recursively referenced package scripts that hide failure.
- Added mandatory `gate` semantic-audit mode while retaining advisory `shadow` mode and supporting a distinct audit model.
- A semantic-audit `pass` is downgraded to `inconclusive` when size limits make the isolated snapshot incomplete.
- Semantic-audit tool arguments and submitted result collections now have explicit bounds aligned with the maximum Goal Contract size.
- Semantic-audit wall-clock execution is included in Run and audit Usage so review cannot bypass active-time budgets.
- Host risk classification is now a floor: executor-supplied Claim risk can increase scrutiny but cannot downgrade a semantic or security-sensitive Claim.
- Workspace fingerprints now invalidate stale proof after external edits or resume.
- Added cost budgets, default-denied sandbox network access, stronger command-risk classification, credential-store locking, and protected credential paths.
- Shell policy now treats explicit deletion/overwrite, output redirection, dependency installation, Git worktree/history mutation, dynamic execution, external-service CLIs, and unknown executables as high risk; safe `&&` chains are classified per command instead of by loose keywords.
- File/search tools reject absolute and parent-traversing globs, canonicalize every match, refuse dangling writable symlinks, atomically replace files, reject common exponential-backtracking regexes, observe cancellation, and bound tool arguments, text reads, aggregate search bytes, writes, and returned text.
- Non-Git workspace fingerprints stream file contents, so same-size edits with preserved timestamps still invalidate stale proof; Run IDs are validated before repository path or Glob construction.
- Progress scoring now recognizes supported claims and evidence-backed facts, prioritizes proof-linked and Frontier-relevant evidence, and does not reward repeated identical observations. Facts are invalidated when their supporting workspace evidence becomes stale.
- Durable report fields have bounded item and string sizes, and the executor contract explicitly treats workspace content, Evidence, Claims, and Facts as untrusted data rather than instructions.
- Artifacts, Unknowns, and Conflicts are bounded in hot state; unresolved overflow leaves an explicit open sentinel instead of being silently erased as if no risk remained.
- Run snapshots retain a recoverable previous copy, `resume <id>` can locate that fallback, event appends are synchronized to disk, and hot-state proof collections are bounded without leaving valid-looking dangling references.
- Saving after backup recovery no longer overwrites the good fallback with a corrupt primary snapshot; atomic state and credential renames synchronize directory metadata where the platform supports it.
- Run leases no longer steal a newly created lock during the short interval before its ownership record is fully written; unreadable locks receive a bounded initialization grace period.
- Credential locking can reclaim an old corrupt lock record while preserving the grace period for a concurrently initializing writer.

### Added

- macOS/Linux CI, security policy, threat model, and contribution guidance.

### Compatibility

- Existing version-one Run State is normalized on load.
- Models must pass `requirementIds` to the `verify` tool.
- `--require` is now additive to the original objective rather than replacing it.
