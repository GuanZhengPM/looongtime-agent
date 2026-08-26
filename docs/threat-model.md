# Threat model

## Assets

- Source code and uncommitted workspace changes
- Provider credentials and OAuth refresh tokens
- Host files outside the selected workspace
- Network and external-system authority
- Run State, Evidence, Event Log, and model/tool output

## Trust boundaries

The model and workspace content are untrusted. The Harness, Tool Registry, Completion Kernel, and credential broker are trusted application code. The local sandbox is defense in depth; the operating system or an external container/VM is the strong isolation boundary.

## Defenses in this repository

- Structured file tools canonicalize reads, reject symbolic links in writable paths (including dangling links), use same-directory atomic replacement, reject absolute or parent-traversing glob patterns, and refuse workspace escape. Semantic-audit glob tools enforce the same boundary inside their snapshot.
- Shell commands require policy authorization and run in a local or inherited sandbox when available.
- Explicit deletion or overwrite, in-place edits, output redirection, Git history or worktree mutation, dependency installation, dynamic command execution, external-service CLIs, and named home or sensitive paths are classified as high risk even when they target the workspace.
- Sandboxed network access is denied by default; enabling it is an explicit Run setting.
- Common credential directories, including Longtime's own credential store, are masked from local sandbox reads.
- Provider secrets are removed from the Shell environment and never written to Run events.
- Tool schemas bound paths, commands, arrays, and write payloads. Text reads, repository searches, streamed Shell output, and model-facing tool responses have explicit size limits; search rejects common exponential-backtracking regular expressions and observes cancellation between files and line batches.
- Arbitrary Shell success cannot produce completion verification. Trusted verification must be recognized or locked into the Goal Contract and mapped to Requirement IDs.
- Workspace fingerprints invalidate current proof after edits made outside Longtime.
- High-risk semantic completion can be configured to require a passing isolated audit.

## Residual risks

- Regex risk classification cannot understand arbitrary program behavior. A project test/build script or authorized interpreter can perform actions not visible in its top-level command. High-risk classification is a guardrail, not a shell-language security proof.
- Verification inspects top-level and recursively referenced package scripts for common failure masking and no-ops, but cannot prove the internal semantics of every custom binary or script.
- Prompt injection in repository content can still influence a model. The executor contract treats workspace content and durable memory as untrusted data, but this is a model-level defense rather than a hard parser boundary.
- An inherited outer sandbox may have different network and filesystem guarantees.
- High-risk authorization can still permit destructive workspace-local behavior.
- Same-model semantic audit can share executor blind spots and is not independent assurance.
- Credentials remain in an owner-only local JSON file unless the Provider supplies another credential source; encryption at rest and system-keystore integration are not implemented.
- Full workspace fingerprinting is conservative and may be expensive in very large repositories.
- Windows isolation and descendant-process termination are experimental.

## Recommended deployment

Use an ephemeral, rootless container or VM with a read-only base image, a disposable workspace mount, no host home mount, no Docker socket, no cloud metadata route, and network disabled by default. Keep model credentials in the host-side Provider layer rather than the tool container.
