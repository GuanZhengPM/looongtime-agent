# Security policy

Looongtime executes model-selected tools and must be treated as security-sensitive software. It is not a container, VM, or privilege boundary.

## Supported versions

Until the first tagged release, only the current `main` branch receives security fixes.

## Reporting a vulnerability

Do not open a public issue for a suspected secret leak, sandbox escape, command-policy bypass, or credential vulnerability. Use GitHub's private vulnerability reporting when enabled, or contact the repository owner privately. Include the affected commit, platform, reproduction, impact, and whether any real credential was exposed.

## Operational requirements

- Run untrusted tasks in an ephemeral container, VM, or dedicated OS account.
- Use a disposable Git worktree with no irreplaceable uncommitted changes.
- Keep network access disabled unless the task explicitly requires it.
- Do not expose Docker sockets, cloud metadata, SSH agents, production credentials, or personal home directories.
- Do not use `--allow-high-risk` in unattended runs containing secrets or external authority.
- Treat `state.json`, `events.jsonl`, and `runner.log` as sensitive; they may contain source excerpts and model output.

See [docs/threat-model.md](docs/threat-model.md) for trust boundaries and residual risks.
