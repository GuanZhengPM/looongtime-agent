# Open-source readiness / 开源准备度

Audit date / 审计日期: 2026-08-19

This is an evidence-based release checklist for the current checkout. It distinguishes implemented behavior, locally tested behavior, and work still required before a public release.

这是针对当前工作区的证据化发布清单，明确区分已实现、已本地测试和公开发布前仍需完成的工作。

## Summary / 结论

Longtime is ready for private technical review, but not for a public open-source release yet. The code has a coherent long-run state machine, a pinned dependency lockfile, owner-only credential-file permissions, and a local test suite. The release blockers are legal licensing, public packaging, CI, security hardening, and reproducible live-provider validation.

Longtime 已适合私下技术评审，但尚不适合直接公开发布。当前已有完整的长程状态机、固定依赖锁文件、`0600` 凭据文件和本地测试；主要阻塞项是 License、公开打包、CI、安全加固，以及可复现的真实 Provider 验证。

## P0 — release blockers / 发布阻塞项

| Gap / 缺口 | Current evidence / 当前证据 | Exit criterion / 验收标准 |
| --- | --- | --- |
| License | No `LICENSE` file. `package.json` also has no project license. / 没有项目 License。 | Owner selects an OSI-approved license, adds `LICENSE`, and records third-party notices. / 项目所有者选择 OSI 许可证并补充第三方声明。 |
| Repository identity | The repository has no commit and no remote. / 当前仓库没有 commit 和 remote。 | Initial reviewed commit, public remote, stable project name, and documented governance owner. |
| Publishability | `package.json` contains `"private": true`; package name, `files`, exports, and global-install smoke tests are not defined. | Choose npm/GitHub Releases or source-only distribution; add a pack/install smoke test before removing `private`. |
| CI and platform support | Tests run locally only; no workflow exists. macOS is the primary observed environment. | CI runs typecheck/tests on supported macOS, Linux, and Windows versions, or README narrows support explicitly. |
| Credential security | Credentials use an atomic `0600` JSON file, but there is no Keychain/keystore, external SecretRef, encryption at rest, or cross-process file lock. | Threat model the store; add a system-keystore or SecretRef path; prevent cross-process lost updates; add permission/migration tests. |
| Codex import contract | `auth import-codex` copies refresh credentials from Codex's local `auth.json`, which is a private compatibility surface and duplicates the credential lifecycle. | Either isolate it behind an explicit experimental warning with upstream-format tests, or replace it with a supported delegation/import contract. |
| Live authentication validation | `auth status` is a local presence/refresh check. Unit tests use a Faux Provider. | Add opt-in, secret-safe live probes for every advertised priority provider, with categorized auth/rate-limit/billing/timeout errors. |
| Security boundary | The harness executes shell commands with the launching user's OS permissions. Workspace checks are not process isolation. | Publish a threat model and one supported isolation recipe; test path escape, symlink race, process-tree timeout, and secret exfiltration controls. |

## P1 — strongly recommended / 强烈建议

| Gap / 缺口 | Recommended work / 建议 |
| --- | --- |
| Contributor policy | Add `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, issue templates, PR template, and an `AGENTS.md` for agent contributors. |
| Security response | Add `SECURITY.md` with supported versions, private disclosure channel, credential-leak response, and log-redaction guidance. |
| Release integrity | Add `CHANGELOG.md`, signed tags, checksums, SBOM/provenance, dependency audit, and isolated install smoke tests. |
| Configuration evolution | Add a versioned config schema, validation, migrations, `config doctor`, and redacted diagnostic export. |
| Custom providers | Longtime currently constructs only Pi's built-in provider catalog. Add a reviewed `models.json` or plugin path before claiming arbitrary local/OpenAI-compatible endpoints. |
| CLI backend delegation | Claude Code CLI, GLM CLI, Kimi CLI, and similar agent login reuse are not generic Longtime backends. If added, keep host credential ownership with the source CLI and define tool/environment isolation. |
| Multi-account auth | Current credential storage keeps one credential per provider. Named profiles, pinning, failover order, and per-session account selection are not implemented. |
| Observability | Add stable JSON output, run metrics export, token/cost attribution tests, log rotation, redaction, and a documented event schema. |
| Benchmark reproducibility | Move a small benchmark runner/config into this repo, pin datasets and containers, publish raw results, and separate infrastructure-invalid runs from model failures. |
| Real semantic-audit E2E | The same-model isolated auditor has regression coverage with a Faux Provider, but no paid-model E2E artifact. Add one adversarial semantic case and preserve independent audit evidence. |
| Backward compatibility | Define state/event schema versions and test resume from older fixtures before public users create long-lived runs. |

## Already present / 已具备

- Bun lockfile and exact direct dependency versions. / Bun 锁文件和固定的直接依赖版本。
- TypeScript typecheck and local test command. / TypeScript 类型检查和本地测试命令。
- Atomic run snapshots and append-only event log. / 原子 Run 快照与 append-only Event Log。
- Pause/resume, lease, heartbeat, retry, round timeout, and process-tree handling. / 暂停恢复、租约、心跳、重试、单轮超时与进程树处理。
- Requirement–Claim–Evidence ProofGraph and mutation-aware evidence invalidation. / ProofGraph 与变更感知的证据失效。
- Owner-only credential-file mode and secret-free credential enumeration. / `0600` 凭据文件与不暴露 Secret 的认证枚举。
- Pinned Pi provider catalog with OAuth/API-key discovery through `longtime auth list`. / 固定 π Provider 目录及认证发现入口。
- README distinguishes implemented behavior from roadmap items. / README 明确区分已实现能力与 Roadmap。

## Suggested release sequence / 建议顺序

1. Decide the license, public project name, and distribution channel. / 决定 License、项目名和分发方式。
2. Add CI, package/install smoke tests, and supported-platform boundaries. / 补 CI、安装测试和平台边界。
3. Harden credentials and publish `SECURITY.md` plus a threat model. / 加固凭据并发布安全政策和威胁模型。
4. Add opt-in live probes for Codex, Anthropic, Kimi, GLM, and Qwen. / 为主要 Provider 增加可选真实探测。
5. Tag `0.1.0-alpha` only after all P0 rows have owners and evidence. / P0 全部有责任人和证据后再发布 alpha。

## Reference projects / 参考项目

- [Pi Agent Harness](https://github.com/earendil-works/pi): pinned provider abstraction, OAuth/API-key separation, TUI, and supply-chain practices.
- [OpenClaw](https://github.com/openclaw/openclaw): provider discovery, named auth profiles, live probes, doctor workflow, SecretRef, and explicit gateway security documentation.

Reference does not mean feature parity. The README and CLI should continue to label borrowed ideas, implemented behavior, and roadmap items separately.

“参考”不等于“已经对齐”。后续文档和 CLI 必须继续区分借鉴的设计、当前已实现能力与 Roadmap。
