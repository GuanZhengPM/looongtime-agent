# looongtime-agent

> Long-horizon execution harness for coding agents, featuring durable task state and verifiable completion.  
> 面向 Coding Agent 的长程任务执行框架：提供状态持久化、断点恢复与基于外部证据的完成判定。

[简体中文](#简体中文) · [English](#english) · [Architecture / 架构](docs/architecture.md)

---

<a id="简体中文"></a>

## 简体中文

### 背景与解决的问题

长程软件工程任务（Long-horizon tasks）无法仅靠扩大模型的上下文窗口或简单增加运行循环来解决。在实际长耗时运行中，Agent 普遍面临三个运行时问题：

1. **中断恢复成本高**：进程因异常、超时或系统重启中断后，缺少结构化的任务状态落盘，往往只能从头重跑；
2. **完成判定的自述幻觉**：任务是否完成如果依赖模型自身的自然语言汇报，容易出现“模型宣称已实现，但实际测试未能通过”的伪完成现象；
3. **证据的过期与失效**：Agent 在修改后续模块时可能破坏前序已验证的代码，若缺少证据依赖追踪，早期的验证结论会掩盖新产生的回归错误。

Looongtime 将模型交互逻辑与底层的**任务运行时状态、执行证据收集、完成裁决策略**解耦，确保长时间运行是由可复查的真实进展驱动。

### 核心机制

- **任务状态持久化与原子恢复**：采用原子状态快照结合追加式 Event Log，记录任务 Frontier；进程崩溃或主动暂停后，可基于当前 Goal Contract 与已验证状态直接恢复，无需回放完整对话。
- **证据驱动的完成判定**：普通 Shell 输出仅作为诊断参考。修复或实现类目标，必须由绑定的 `verify` 测试命令输出真实通过结果，并确认工作区产生有效的净代码变更，Harness 才会判定任务完成。
- **ProofGraph 依赖图与自动失效**：将任务目标拆解为 `Requirement → Claim → Evidence` 依赖链。当工作区相关文件发生改动时，自动将对应证明标记为失效，触发重新验证，避免回归盲区。
- **预算与执行治理**：对 Token 消耗、活跃执行时间、循环轮次、单轮超时及停滞（Stall）状态分别设置有界配额，在持续无进展时安全阻塞并报警。
- **语义审计（Semantic Audit）**：支持配置独立的 `--audit-model` 对高风险变更进行跨模型交叉审查，减少同模型因固有偏见产生的误判。

### 快速开始

#### 环境要求
* Bun `1.3.14+`

```sh
git clone https://github.com/GuanZhengPM/looongtime-agent.git
cd looongtime-agent
bun install --ignore-scripts
bun run check
bun test
```

#### 登录 Provider

Looongtime 支持基于 OAuth 或 API Key 接入主流模型：

```sh
# 使用 ChatGPT / Codex 订阅登录
bun src/cli.ts auth login openai-codex oauth
bun src/cli.ts auth status openai-codex

# 或直接配置 API Key
bun src/cli.ts auth login openai api_key
bun src/cli.ts auth login anthropic oauth
```

#### 启动长程任务

```sh
bun src/cli.ts run \
  --model openai-codex/gpt-5.6-sol \
  --reasoning high \
  --require "登录成功时返回有效 token" \
  --constraint "不得修改公共 API 接口签名" \
  --verify-command "bun test auth.test.ts" \
  --require-change \
  --max-cost 25 \
  --cwd /path/to/project \
  "修复认证模块并运行相关测试，直到有当前测试证据证明完成"
```

#### 后台运行与恢复

使用 `--detach` 可以在后台持久化运行，并获取独立的 Run ID：

```sh
# 后台启动 72 小时耐力模式
bun src/cli.ts run \
  --detach \
  --endurance 72h \
  --model openai-codex/gpt-5.6-sol \
  --cwd /path/to/dedicated-worktree \
  "实现 TASK.md 所述功能并确保所有测试通过"

# 查看运行状态与事件流
bun src/cli.ts status <run-id>
bun src/cli.ts events <run-id>

# 中断后继续执行（支持调整模型或预算配置）
bun src/cli.ts resume <run-id>
bun src/cli.ts resume --model openai/gpt-5.4 <run-id>
```

### 长程运行配额（Endurance Profiles）

| Profile | Token 硬上限 | 活跃执行时间 | 最大轮次 (Round) | 最大工具调用数 |
| :--- | ---: | ---: | ---: | ---: |
| `24h` | 100M | 24 小时 | 4,000 | 25,000 |
| `48h` | 250M | 48 小时 | 8,000 | 50,000 |
| `72h` | 500M | 72 小时 | 12,000 | 75,000 |

*注：时间仅统计模型推理与工具调用的实际活跃时间，等待与退避重试不消耗活跃时长。*

### 安全边界

1. Looongtime 默认在启动用户的权限下运行，隔离级别依赖操作系统的用户与工作区权限；强安全隔离需配合 Docker 或专用 VM。
2. 本地沙箱默认禁用网络访问，仅在显式传入 `--allow-network` 时开放。
3. 凭据文件保存在 `~/.looongtime/credentials.json`（权限 `0600`），不会被写入任务的公共 Event Log。

---

<a id="english"></a>

## English

### Overview

Looongtime is an execution harness designed for long-horizon software engineering tasks. It decouples model reasoning from persistent task state, execution evidence collection, and completion gating, enabling agents to operate across multiple rounds, recover reliably from interruptions, and verify success based on real execution outputs rather than self-reported claims.

### Problem Statement & Background

Long-horizon software engineering tasks cannot be solved simply by expanding context window limits or blindly increasing loop iterations. In practice, long-running agents face three fundamental operational challenges:

1. **High Interruption Cost**: When an agent halts due to network timeouts, process failures, or system restarts, the lack of structured persistence forces the entire run to restart from scratch.
2. **Self-Report Hallucinations**: When task completion relies on the model's natural language assertion, agents frequently claim "the feature is implemented" even when underlying tests fail.
3. **Proof Staleness**: Edits made late in a session often break earlier components. Without dependency tracking, stale passing proofs can mask new regressions.

Looongtime decouples model reasoning from **runtime task state, execution evidence collection, and completion gating**, ensuring long runs are driven solely by verifiable progress.

### Core Architecture

```text
Goal Contract
  → Compile verified task state
  → Execute bounded frontier
  → Collect host test evidence
  → Update ProofGraph (invalidate stale proofs upon file changes)
  → Judge completion on Net Workspace Changes + Test Pass
```

* **Durable Task Checkpoints**: Combines atomic state snapshots with append-only Event Logs to record execution frontiers. Interrupted runs resume from the Goal Contract and verified state without replaying full conversational transcripts.
* **Evidence-Gated Completion**: Standard Shell output serves purely as diagnostics. For repair or feature goals, completion requires designated `verify` commands to output genuine passing evidence alongside verified net workspace changes.
* **ProofGraph & Dynamic Invalidation**: Deconstructs tasks into `Requirement → Claim → Evidence` chains. Whenever relevant workspace files are modified, dependent proofs are automatically marked stale, triggering re-verification.
* **Budget & Execution Governance**: Enforces bounded budgets across token consumption, active wall-clock time, iteration rounds, single-round timeouts, and stall detection.
* **Semantic Audit**: Supports cross-model verification via `--audit-model` to reduce blind spots on high-risk code changes.

### Quick Start

#### Requirements
* Bun `1.3.14+`

```sh
git clone https://github.com/GuanZhengPM/looongtime-agent.git
cd looongtime-agent
bun install --ignore-scripts
bun run check
bun test
```

#### Provider Login

Connect via OAuth or API Key:

```sh
# Login via ChatGPT / Codex subscription OAuth
bun src/cli.ts auth login openai-codex oauth
bun src/cli.ts auth status openai-codex

# Or configure direct API keys
bun src/cli.ts auth login openai api_key
bun src/cli.ts auth login anthropic oauth
```

#### Dispatching a Task

```sh
bun src/cli.ts run \
  --model openai-codex/gpt-5.6-sol \
  --reasoning high \
  --require "Return valid token upon successful login" \
  --constraint "Do not modify public API signatures" \
  --verify-command "bun test auth.test.ts" \
  --require-change \
  --max-cost 25 \
  --cwd /path/to/project \
  "Fix authentication regression and ensure tests pass"
```

#### Detached Execution & Resuming

Use `--detach` to run long-running tasks in the background:

```sh
# Launch in 72h endurance mode
bun src/cli.ts run \
  --detach \
  --endurance 72h \
  --model openai-codex/gpt-5.6-sol \
  --cwd /path/to/dedicated-worktree \
  "Implement features in TASK.md and verify all tests pass"

# Check status and stream events
bun src/cli.ts status <run-id>
bun src/cli.ts events <run-id>

# Resume an interrupted run (with optional budget/model adjustment)
bun src/cli.ts resume <run-id>
bun src/cli.ts resume --model openai/gpt-5.4 <run-id>
```

### Endurance Profiles

| Profile | Token Hard Cap | Active Execution Time | Max Rounds | Max Tool Calls |
| :--- | ---: | ---: | ---: | ---: |
| `24h` | 100M | 24 Hours | 4,000 | 25,000 |
| `48h` | 250M | 48 Hours | 8,000 | 50,000 |
| `72h` | 500M | 72 Hours | 12,000 | 75,000 |

*Note: Execution time tracks active model inference and tool execution; sleep and backoff delays do not consume this budget.*

### Security Boundaries

1. Looongtime runs under the launching user's OS permissions. Strong sandboxing requires containerized or VM environments.
2. Local sandboxes deny network access by default; access must be explicitly granted via `--allow-network`.
3. Credentials are stored securely under `~/.looongtime/credentials.json` (mode `0600`) and are never written to the public Event Log.

### License

[MIT](LICENSE)
