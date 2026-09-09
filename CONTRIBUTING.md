# Contributing

Looongtime is an early-stage security-sensitive agent harness. Changes should preserve deterministic state transitions, evidence provenance, and safe failure behavior.

## Development

```sh
bun install --ignore-scripts
bun run check
bun test
```

Before opening a pull request:

1. Add regression tests for every behavior change and bug fix.
2. Do not weaken verification, workspace-boundary, credential, or authorization checks for convenience.
3. Document state-schema and CLI changes in `CHANGELOG.md` and the architecture document.
4. Do not commit credentials, run stores, logs, traces, provider responses, or private benchmark data.
5. Describe the threat model impact of tool, shell, sandbox, network, or authentication changes.

The CI matrix currently supports macOS and Linux. Windows remains experimental until its shell isolation and process-tree behavior have dedicated coverage.
