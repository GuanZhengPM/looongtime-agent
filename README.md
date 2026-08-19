# Looooongtime

> Long-horizon execution for coding agents, with durable state and verifiable completion.
> 面向 Coding Agent 的长程执行、持久状态与可验证完成。

[简体中文](#简体中文) · [English](#english) · [Architecture / 架构](docs/architecture.md)

Longtime 是一个面向长程软件工程任务的 Agent Harness。它将模型交互与持久任务状态、执行证据和完成判定解耦，使 Agent 能够跨多轮持续工作、在中断后恢复，并以当前证据而非模型自述作为完成依据。

Longtime is a long-horizon execution harness for software-engineering agents. It separates model interaction from durable task state, execution evidence, and completion policy so an agent can work across many rounds, recover from interruption, and finish on current evidence rather than self-reported success.

---

<a id="简体中文"></a>

## 简体中文

### 概览

长程任务需要处理的不只是上下文窗口，还包括状态持久化、证据时效、重复探索、暂时性故障和可复核的完成标准。仅延长对话或增加循环次数，无法解决这些运行时问题。

Longtime 将任务组织为可恢复的执行 Frontier，并维护 `Requirement → Claim → Evidence` 证明图：

```text
Goal Contract
  → compile relevant verified state
  → execute one bounded frontier
  → collect host evidence
  → accept or reject the state delta
  → continue while verified progress is positive
```

模型负责探索、推理与实现；Harness 负责状态提交、证据失效、预算控制、故障恢复与完成裁决。长时间运行由可信进展驱动，而不是由固定轮数或单次完成声明驱动。

### 核心能力

- **长程调度**：只要存在可信状态增量就继续执行；持续停滞、预算耗尽或缺少必要权限时进入阻塞状态。
- **完成判定**：Executor 提交完成声明，确定性 Completion Kernel 根据当前宿主证据决定是否接受。
- **ProofGraph**：每个必需 Requirement 都需要受 Evidence 支持的 Claim；相关文件变化会使对应证明精确失效。
- **故障恢复**：原子状态快照、append-only Event Log、租约、心跳、暂停与跨进程恢复共同维护 Run 一致性。
- **预算治理**：Token、活跃时间、Round、工具调用、单轮超时、重试和停滞分别设限。
- **权限策略**：工作区内可逆操作默认自主执行；高影响 Shell、边界外访问和外部副作用需要显式授权。
- **语义审计**：`shadow` 模式在高风险完成声明出现时，以同一模型的新 Session 审查隔离只读快照。
- **多 Provider 接入**：模型与认证基于固定版本的 [`@earendil-works/pi-ai`](https://github.com/earendil-works/pi)，核心状态机不绑定单一模型协议。

### 安装

当前需要 Bun `1.3.14+`：

```sh
git clone https://github.com/GuanZhengPM/longtime-agent.git
cd longtime-agent
bun install --ignore-scripts
bun run check
bun test
```

从源码启动交互终端：

```sh
bun src/cli.ts
```

当前提供源码运行方式，npm 发布尚未开放。

### 快速开始

先查看认证目录和模型：

```sh
bun src/cli.ts auth list
bun src/cli.ts models openai-codex
```

使用 ChatGPT/Codex 订阅登录：

```sh
bun src/cli.ts auth login openai-codex oauth
bun src/cli.ts auth status openai-codex
```

运行一次任务：

```sh
bun src/cli.ts run \
  --model openai-codex/gpt-5.6-sol \
  --reasoning high \
  --semantic-audit shadow \
  --cwd /path/to/project \
  "修复认证模块并运行相关测试，直到有当前证据证明完成"
```

### Provider 与认证

Longtime 的认证入口与固定版本的 π Provider 目录对齐。使用统一的 `provider/model-id`，凭据不会写入 Run Event Log。

| 使用场景 | Provider | 当前登录方式 | 示例 |
| --- | --- | --- | --- |
| Codex / ChatGPT 订阅 | `openai-codex` | ChatGPT OAuth | `auth login openai-codex oauth` |
| OpenAI API | `openai` | API Key / `OPENAI_API_KEY` | `auth login openai api_key` |
| Claude 模型 | `anthropic` | Anthropic API Key 或 Claude Pro/Max OAuth | `auth login anthropic oauth` |
| Kimi Code Plan | `kimi-coding` | Kimi API Key 或订阅 OAuth | `auth login kimi-coding oauth` |
| GLM Coding Plan 国际站 | `zai` | API Key / `ZAI_API_KEY` | `auth login zai api_key` |
| GLM Coding Plan 国内站 | `zai-coding-cn` | API Key / `ZAI_CODING_CN_API_KEY` | `auth login zai-coding-cn api_key` |
| Qwen Token Plan 国际站 | `qwen-token-plan` | API Key / `QWEN_TOKEN_PLAN_API_KEY` | `auth login qwen-token-plan api_key` |
| Qwen Token Plan 国内站 | `qwen-token-plan-cn` | API Key / `QWEN_TOKEN_PLAN_CN_API_KEY` | `auth login qwen-token-plan-cn api_key` |
| GitHub Copilot | `github-copilot` | Token 或订阅 OAuth | `auth login github-copilot oauth` |
| OpenRouter | `openrouter` | API Key 或 OAuth | `auth login openrouter oauth` |

完整目录以本地固定依赖为准：

```sh
bun src/cli.ts auth list
bun src/cli.ts models
bun src/cli.ts models <provider>
```

认证边界：

- `openai-codex` OAuth 对应 ChatGPT 订阅访问；`openai` API Key 对应 API 按量访问，两者不是同一计费入口。OpenAI 官方 Codex 客户端也区分这两种本地登录方式。
- `anthropic` 当前是直接 API Key／订阅 OAuth，不是把 Claude Code CLI 当作子进程后端，也不会复用 Claude Code CLI 的自动刷新生命周期。
- GLM、Qwen 当前按 π Provider 的 Coding/Token Plan API Key 接入；尚未实现从它们各自 CLI 自动导入登录态。
- Provider 目录和模型可用性会随固定的 `pi-ai` 版本变化；升级依赖后建议重新运行认证和模型回归测试。

如果本机 Codex CLI 已执行过 `codex login`，可以选择导入当前会话：

```sh
bun src/cli.ts auth import-codex
```

该兼容命令会将 Codex CLI 的 OAuth 凭据复制到 Longtime 独立的 `0600` 文件。此方式依赖 Codex 本地凭据格式，两个客户端也可能共享 refresh token 生命周期；长期任务建议使用 `auth login openai-codex oauth` 建立独立会话。

凭据默认保存在：

```text
~/.longtime/credentials.json
```

可以通过 `LONGTIME_HOME` 修改存储根目录。macOS Keychain、系统密钥环和外部 SecretRef 尚未接入，已列入发布前安全工作。

为兼容已有本地数据，若 `~/.longtime` 尚不存在但检测到 `~/.continuum`，Longtime 会继续读取旧目录；`CONTINUUM_HOME` 和 `CONTINUUM_MODEL` 也保留为兼容别名。新配置统一使用 `LONGTIME_HOME` 和 `LONGTIME_MODEL`。

### 长程运行配置

`--endurance` 配置的是 Run 级上限；显式 `--max-*` 参数会覆盖 Profile：

| Profile | Token 硬上限 | 活跃执行时间 | Round | Tool calls |
| --- | ---: | ---: | ---: | ---: |
| `24h` | 100M | 24h | 4,000 | 25,000 |
| `48h` | 250M | 48h | 8,000 | 50,000 |
| `72h` | 500M | 72h | 12,000 | 75,000 |

```sh
bun src/cli.ts run \
  --detach \
  --endurance 72h \
  --model openai-codex/gpt-5.6-sol \
  --reasoning high \
  --permission autonomous \
  --cwd /path/to/dedicated-worktree \
  "完成 TASK.md，持续测试和修复，直到证据化完成"
```

`--detach` 会返回 Run ID、后台 PID 和 `runner.log`。Profile 中的小时数统计模型与工具活跃时间；休眠和退避等待不消耗该预算。高风险命令在无 TTY 后台默认拒绝，只有在专用、可恢复工作区中才应考虑 `--allow-high-risk`。

### 恢复与检查

```sh
bun src/cli.ts status <run-id>
bun src/cli.ts events <run-id>
bun src/cli.ts resume <run-id>
bun src/cli.ts resume --endurance 72h --max-stalls 12 <run-id>
bun src/cli.ts resume --model openai/gpt-5.4 <run-id>
```

恢复依赖 Goal Contract、Verified State、Evidence 和 Frontier，不要求模型记住此前完整对话。

### 安全边界

- Longtime 不是容器或虚拟机；它默认拥有启动用户在工作区内的权限。
- 路径和符号链接会做工作区边界检查，但强隔离仍应由容器、VM 或专用系统账户提供。
- `runner.log`、状态和 Event Log 可能包含源码片段、命令与模型输出，不应提交到公开仓库。
- `--allow-high-risk` 是显式预授权，不应在包含真实凭据或不可恢复数据的工作区使用。
- `auth status` 当前只确认凭据存在且可解析／可刷新；首个模型请求才验证服务端是否接受。

### 开发验证

提交变更前运行：

```sh
bun run check
bun test
bun src/cli.ts --help
bun src/cli.ts auth list
```

### 致谢

Longtime 的 Provider/TUI 基础来自 [Pi Agent Harness](https://github.com/earendil-works/pi)。README 的 Provider 发现、认证状态和安全文档组织参考了 [OpenClaw](https://github.com/openclaw/openclaw)。Longtime 自己的重点是长程任务的 durable state、ProofGraph、失效语义、进度治理和可恢复执行。

---

<a id="english"></a>

## English

### Overview

Long-horizon work involves more than a larger context window: durable task state, evidence freshness, bounded exploration, transient-failure recovery, and completion criteria that can be independently reviewed.

Longtime organizes a run into recoverable execution frontiers and maintains a `Requirement → Claim → Evidence` proof graph:

```text
Goal Contract
  → compile relevant verified state
  → execute one bounded frontier
  → collect host evidence
  → accept or reject the state delta
  → continue while verified progress is positive
```

The model owns exploration, reasoning, and implementation. The harness owns state commits, evidence invalidation, budgets, recovery, and completion policy. Continued execution is driven by verified progress rather than a fixed turn count.

### What it provides

- **Long-horizon scheduling**: continue while trusted state changes are being produced; block on sustained stalls, exhausted budgets, or missing authority.
- **Completion policy**: the executor submits a completion claim; a deterministic kernel evaluates it against current host evidence.
- **ProofGraph**: each required requirement needs a supported claim, and relevant mutations precisely invalidate stale proof.
- **Durable recovery**: atomic snapshots, append-only events, leases, heartbeats, pause, and cross-process resume preserve run consistency.
- **Budget governance**: tokens, active time, rounds, tool calls, round timeouts, retries, and stalls have separate limits.
- **Permission policy**: reversible workspace-local actions run autonomously; high-impact shell commands, boundary crossings, and external effects require explicit authority.
- **Semantic audit**: `shadow` mode starts a fresh same-model session against an isolated read-only snapshot for risky completion claims.
- **Multi-provider integration**: model protocols and authentication come from a pinned [`@earendil-works/pi-ai`](https://github.com/earendil-works/pi) version while the durable state machine remains provider-neutral.

### Install

Bun `1.3.14+` is currently required:

```sh
git clone https://github.com/GuanZhengPM/longtime-agent.git
cd longtime-agent
bun install --ignore-scripts
bun run check
bun test
bun src/cli.ts
```

The project currently runs from source; npm distribution is not yet available.

### Quick start

Inspect authentication methods and models:

```sh
bun src/cli.ts auth list
bun src/cli.ts models openai-codex
```

Sign in with a ChatGPT/Codex subscription:

```sh
bun src/cli.ts auth login openai-codex oauth
bun src/cli.ts auth status openai-codex
```

Run a task:

```sh
bun src/cli.ts run \
  --model openai-codex/gpt-5.6-sol \
  --reasoning high \
  --semantic-audit shadow \
  --cwd /path/to/project \
  "Fix the authentication module and run the relevant tests until current evidence proves completion"
```

### Models and authentication

Longtime exposes the authentication catalog of its pinned Pi provider layer. Models use one `provider/model-id` convention, and credentials are not written to run events.

| Use case | Provider | Current authentication | Example |
| --- | --- | --- | --- |
| Codex / ChatGPT subscription | `openai-codex` | ChatGPT OAuth | `auth login openai-codex oauth` |
| OpenAI API | `openai` | API key / `OPENAI_API_KEY` | `auth login openai api_key` |
| Claude models | `anthropic` | Anthropic API key or Claude Pro/Max OAuth | `auth login anthropic oauth` |
| Kimi Code Plan | `kimi-coding` | Kimi API key or subscription OAuth | `auth login kimi-coding oauth` |
| GLM Coding Plan, international | `zai` | API key / `ZAI_API_KEY` | `auth login zai api_key` |
| GLM Coding Plan, China | `zai-coding-cn` | API key / `ZAI_CODING_CN_API_KEY` | `auth login zai-coding-cn api_key` |
| Qwen Token Plan, international | `qwen-token-plan` | API key / `QWEN_TOKEN_PLAN_API_KEY` | `auth login qwen-token-plan api_key` |
| Qwen Token Plan, China | `qwen-token-plan-cn` | API key / `QWEN_TOKEN_PLAN_CN_API_KEY` | `auth login qwen-token-plan-cn api_key` |
| GitHub Copilot | `github-copilot` | Token or subscription OAuth | `auth login github-copilot oauth` |
| OpenRouter | `openrouter` | API key or OAuth | `auth login openrouter oauth` |

Use the pinned local dependency as the source of truth:

```sh
bun src/cli.ts auth list
bun src/cli.ts models
bun src/cli.ts models <provider>
```

Authentication boundaries:

- `openai-codex` OAuth is ChatGPT subscription access. `openai` API-key access is usage-based API access. They are separate authentication and billing paths.
- `anthropic` currently means direct API-key or subscription OAuth access. Longtime does not delegate inference to the Claude Code CLI and does not inherit the CLI's credential-refresh lifecycle.
- GLM and Qwen currently use the Coding/Token Plan API-key routes exposed by Pi. Automatic import from their CLIs is not implemented.
- Provider and model availability follows the pinned `pi-ai` dependency. An upgrade requires authentication and model regression testing.

An optional compatibility command can copy an existing local Codex CLI session:

```sh
bun src/cli.ts auth import-codex
```

This copies the Codex CLI OAuth credential into Longtime's independent `0600` file. The compatibility path depends on Codex's local credential format and may share refresh-token lifecycle across clients. For long-lived runs, prefer `auth login openai-codex oauth` to establish an independent session.

Credentials are stored at `~/.longtime/credentials.json` by default. `LONGTIME_HOME` changes the root. Keychain/system-keystore and external SecretRef support are not implemented yet.

For backward compatibility, Longtime continues to read `~/.continuum` when `~/.longtime` does not yet exist. `CONTINUUM_HOME` and `CONTINUUM_MODEL` remain accepted as legacy aliases; new configuration should use `LONGTIME_HOME` and `LONGTIME_MODEL`.

### Endurance profiles

`--endurance` configures run-level ceilings. Explicit `--max-*` flags override the profile:

| Profile | Hard token limit | Active execution | Rounds | Tool calls |
| --- | ---: | ---: | ---: | ---: |
| `24h` | 100M | 24h | 4,000 | 25,000 |
| `48h` | 250M | 48h | 8,000 | 50,000 |
| `72h` | 500M | 72h | 12,000 | 75,000 |

```sh
bun src/cli.ts run \
  --detach \
  --endurance 72h \
  --model openai-codex/gpt-5.6-sol \
  --reasoning high \
  --permission autonomous \
  --cwd /path/to/dedicated-worktree \
  "Complete TASK.md, continuously test and repair, and stop only on evidence-gated completion"
```

`--detach` returns a run ID, background PID, and `runner.log`. Profile hours count active model/tool time; sleep and retry backoff do not consume that budget. High-risk commands remain denied without a TTY unless `--allow-high-risk` is explicitly supplied in a dedicated, recoverable workspace.

### Resume and inspect

```sh
bun src/cli.ts status <run-id>
bun src/cli.ts events <run-id>
bun src/cli.ts resume <run-id>
bun src/cli.ts resume --endurance 72h --max-stalls 12 <run-id>
bun src/cli.ts resume --model openai/gpt-5.4 <run-id>
```

Recovery compiles the Goal Contract, Verified State, Evidence, and Frontier. It does not rely on the model remembering the previous full conversation.

### Security boundary

- Longtime is not a container or VM; it runs with the launching user's permissions.
- Workspace path and symlink checks are defense in depth, not strong isolation. Use a container, VM, or dedicated OS account for hostile tasks.
- State, events, and `runner.log` may contain source snippets, commands, and model output. Do not publish them blindly.
- `--allow-high-risk` is explicit preauthorization and should not be used around irreplaceable data or real secrets.
- `auth status` checks credential presence and local refreshability. The first model request is the current live server-side acceptance check.

### Development checks

Run the following before submitting changes:

```sh
bun run check
bun test
bun src/cli.ts --help
bun src/cli.ts auth list
```

### Acknowledgements

Longtime builds its provider/TUI foundation on the [Pi Agent Harness](https://github.com/earendil-works/pi). Its provider discovery, auth status, and security-document organization are informed by [OpenClaw](https://github.com/openclaw/openclaw). Longtime's own focus is long-horizon durable state, ProofGraph semantics, evidence invalidation, progress governance, and recoverable execution.

## License

No project license has been selected yet. Until a `LICENSE` file is added, the repository is source-visible but not an open-source release. This is intentionally left as an owner decision.
