# Longtime Architecture / Longtime 架构

[简体中文](#简体中文) · [English](#english)

---

<a id="简体中文"></a>

## 简体中文

### 概览

Longtime 是一个面向长程软件工程任务的 Agent Harness。模型负责分析和执行任务，Harness 负责保存任务状态、管理工具和权限、记录证据、恢复中断的 Run，并判断任务是否完成。

一次 Run 由多个有界 Round 组成。每个 Round 从持久状态生成一份当前工作上下文，模型完成一个 Frontier，工具记录执行结果，Harness 再把有效变化写回状态。

```text
Goal Contract
    ↓
Context Compiler → Executor → Tools / Workspace
    ↑                           ↓
Run State ← Progress + Evidence + Completion
    ↕
Event Log / Snapshot / Lease
```

### 组件

```text
CLI / TUI
   │
   ▼
Harness Core
   ├── Context Compiler
   ├── Progress Governor
   ├── Completion Kernel
   ├── Semantic Audit
   └── Budget / Permission Policy
          │
          ├── ModelPort ── pi-ai Providers
          ├── Tool Registry ── Workspace / Shell
          └── RunRepository ── State / Events / Lease
```

| 组件 | 职责 |
| --- | --- |
| CLI / TUI | 创建、恢复和查看 Run；显示模型输出、工具执行与状态摘要 |
| Harness Core | 组织 Round，提交状态变化，处理重试、暂停和完成判定 |
| ModelPort | 将统一的消息、工具、Usage 和 Session 接口映射到具体 Provider |
| Tool Registry | 提供文件读取、搜索、写入、Shell 和验证工具 |
| RunRepository | 保存原子状态快照、append-only Event Log 和单写者租约 |
| Semantic Audit | 在隔离只读快照上执行可选的同模型审查 |

### Run 生命周期

```text
create / resume
      ↓
load durable state
      ↓
compile current context
      ↓
execute one frontier
      ↓
collect tool evidence
      ↓
apply state report
      ↓
continue / verify / audit / complete / block
```

新 Run 从用户目标生成 `GoalContract` 和 Requirements。恢复 Run 时，Longtime 读取已保存的 State 与 Event Log，不依赖模型保留此前完整对话。

每个 Round 结束时，Executor 通过 `report_state` 提交摘要、Requirement、Evidence、Claim、未知项、冲突和下一 Frontier。Harness 对报告进行校验后再更新持久状态。

### 持久状态

`RunState` 保存当前 Run 可继续执行所需的信息：

| 字段 | 内容 |
| --- | --- |
| `contract` | 原始目标、Requirements 与约束 |
| `requirements` | 各项要求的当前状态 |
| `proof` | Requirement–Claim–Evidence 关系 |
| `evidence` | 文件、命令、测试、构建和观察结果 |
| `artifacts` | Run 产生或确认的工作区产物 |
| `unknowns` / `conflicts` | 尚未解决的问题和冲突 |
| `frontier` | 下一 Round 的有界工作范围 |
| `progress` | 最近状态增量与连续停滞计数 |
| `usage` / `budget` | Token、时间、Round 和工具调用统计 |
| `health` | 模型错误、重试与最近失败 |

状态快照写入 `state.json`，事件追加到 `events.jsonl`。热状态会压缩已失效的普通 Evidence，Event Log 保留完整事件顺序。

### Context Compiler

Context Compiler 每轮从持久状态构建新的模型上下文，主要包含：

- 不可变的 Goal Contract；
- 当前 Frontier；
- 与 Frontier 相关的 Requirements、Claims 和 Evidence；
- 最近失败与恢复信息；
- 本轮可用工具、权限和输出格式。

完整历史保存在磁盘，模型上下文只携带当前工作所需的部分。摘要用于导航，Evidence ID 和宿主记录用于状态提交。

### Evidence 与 ProofGraph

工具执行后，Harness 生成 Evidence：

```text
Evidence
  id
  kind
  source
  subject
  summary
  mutationEpoch
  dependencyPaths?
  globalScope?
  contentHash?
```

Claim 将一个 Requirement 与一组 Evidence 关联：

```text
Requirement
  └── Claim
        ├── statement
        ├── risk
        ├── dependencyPaths
        └── evidenceIds
```

工作区发生写入后，`mutationEpoch` 增加。路径相关 Evidence 只在对应文件变化时失效；测试、构建和全局搜索等 workspace 级 Evidence 在后续修改后失效。Claim 状态为 `proposed`、`supported`、`stale` 或 `rejected`。

### 完成判定与语义审计

Completion Kernel 根据当前 State 计算结果。完成条件包括：

- required Requirements 均有 current supported Claim；
- 工作区修改后存在当前测试、构建或显式验证 Evidence；
- 没有未解决的完整性错误或开放冲突；
- Executor 引用的 Evidence ID 当前有效。

风险路由器提供四种结果：

| Route | 含义 |
| --- | --- |
| `continue` | 继续当前 Frontier |
| `verify` | 补充测试、构建或显式验证 |
| `semantic_audit` | 对高风险或语义 Claim 运行独立审查 |
| `human_review` | 等待外部信息或授权 |

启用 `--semantic-audit shadow` 后，Auditor 使用相同 Model Selection 和新的 Session，在临时只读快照上检查原始 Requirements。Auditor 只能列出、读取和搜索文件，并通过独立的 `audit-ev-*` Evidence 提交结构化结果。Shadow Verdict 会写入 State 和 Event Log，但不改变当前 Completion 结果。

### Progress、Budget 与 Permission

Progress Governor 统计 Requirement、Evidence、Artifact、Unknown 和 Conflict 的变化。连续多个 Round 没有可信状态增量时，Run 进入 blocked 状态并保留恢复说明。

预算覆盖 Token、活跃时间、Round、工具调用、单轮超时和连续模型错误。预算阶段为 `normal`、`observe` 和 `reserve`；显式硬上限结束失控运行。

权限模式包括：

| Mode | 行为 |
| --- | --- |
| `autonomous` | 自动执行低、中风险工作区操作；高风险操作需要授权 |
| `guarded` | 自动执行低风险检查，其余操作请求授权 |
| `locked` | Shell 操作均请求授权 |

路径解析会检查工作区边界和符号链接。Shell 可继承外层 Codex Sandbox，或在支持的平台上使用本地沙箱。stdout 与 stderr 使用有界流式捕获。

### 恢复与并发

Longtime 的默认数据目录为 `~/.longtime`：

```text
~/.longtime/
├── config.json
├── credentials.json
└── runs/<workspace-key>/<run-id>/
    ├── state.json
    ├── events.jsonl
    ├── run.lock
    └── runner.log
```

一次性 CLI 在收到 SIGINT 或 SIGTERM 时保存 `paused` 状态。`resume` 从最近状态继续执行。`run.lock` 保存 PID、随机 Token 和心跳，同一 Run 同时只有一个写入者；死亡进程遗留的 Lease 可以恢复。

### Provider 与终端

Longtime 通过 `@earendil-works/pi-ai` 接入 Provider。ModelPort 统一模型选择、Reasoning、工具调用、Usage、Session 与缓存信息；OAuth 和 API Key 由 Provider 层处理。

终端提供流式输出与以下主要命令：

```text
/model provider/model-id
/permission autonomous|guarded|locked
/allow-risky on|off
/resume <run-id>
/status
/exit
```

### 代码位置

| 目录 | 内容 |
| --- | --- |
| `src/core/` | Run 循环、状态、ProofGraph、Progress、Budget 与 Semantic Audit |
| `src/providers/` | pi-ai ModelPort、认证与凭据存储 |
| `src/tools/` | Workspace、Shell 与工具注册 |
| `src/ui/` | 终端输出与交互 TUI |
| `src/cli.ts` | CLI 入口与 Endurance Profiles |
| `test/` | 状态、恢复、权限、Provider Bridge 与 Auditor 回归测试 |

---

<a id="english"></a>

## English

### Overview

Longtime is an agent harness for long-horizon software-engineering tasks. The model analyzes and executes the task; the harness persists task state, manages tools and permissions, records evidence, recovers interrupted runs, and evaluates completion.

A run consists of bounded rounds. Each round compiles a current working context from durable state, lets the model execute one frontier, records tool results, and commits valid changes back to state.

```text
Goal Contract
    ↓
Context Compiler → Executor → Tools / Workspace
    ↑                           ↓
Run State ← Progress + Evidence + Completion
    ↕
Event Log / Snapshot / Lease
```

### Components

```text
CLI / TUI
   │
   ▼
Harness Core
   ├── Context Compiler
   ├── Progress Governor
   ├── Completion Kernel
   ├── Semantic Audit
   └── Budget / Permission Policy
          │
          ├── ModelPort ── pi-ai Providers
          ├── Tool Registry ── Workspace / Shell
          └── RunRepository ── State / Events / Lease
```

| Component | Responsibility |
| --- | --- |
| CLI / TUI | Create, resume, and inspect runs; render model output, tool activity, and state summaries |
| Harness Core | Orchestrate rounds, commit state changes, handle retries and pauses, and evaluate completion |
| ModelPort | Map a shared message, tool, usage, and session interface to concrete providers |
| Tool Registry | Expose file reads, search, writes, shell execution, and verification |
| RunRepository | Store atomic state snapshots, an append-only event log, and the single-writer lease |
| Semantic Audit | Run an optional same-model review against an isolated read-only snapshot |

### Run lifecycle

```text
create / resume
      ↓
load durable state
      ↓
compile current context
      ↓
execute one frontier
      ↓
collect tool evidence
      ↓
apply state report
      ↓
continue / verify / audit / complete / block
```

A new run derives a `GoalContract` and Requirements from the task. A resumed run loads State and the Event Log; it does not depend on the model retaining the full earlier conversation.

At the end of each round, the executor calls `report_state` with a summary, Requirements, Evidence, Claims, unknowns, conflicts, and the next frontier. The harness validates the report before updating durable state.

### Durable state

`RunState` contains the information required to continue a run:

| Field | Contents |
| --- | --- |
| `contract` | Original objective, Requirements, and constraints |
| `requirements` | Current status of each requirement |
| `proof` | Requirement–Claim–Evidence relationships |
| `evidence` | File, command, test, build, and observation results |
| `artifacts` | Workspace outputs produced or confirmed by the run |
| `unknowns` / `conflicts` | Unresolved questions and conflicting observations |
| `frontier` | Bounded work for the next round |
| `progress` | Recent state deltas and consecutive stall count |
| `usage` / `budget` | Token, time, round, and tool-call accounting |
| `health` | Model errors, retries, and the latest failure |

Snapshots are written to `state.json`; events are appended to `events.jsonl`. Hot state compacts invalidated ordinary Evidence while the Event Log preserves event order.

### Context Compiler

The Context Compiler builds a fresh model context for every round. It includes:

- the immutable Goal Contract;
- the current frontier;
- Requirements, Claims, and Evidence relevant to that frontier;
- recent failures and recovery information;
- available tools, permissions, and the output contract.

Full history remains on disk, while the model context carries the current working set. Summaries support navigation; Evidence IDs and host records support state commits.

### Evidence and ProofGraph

The harness creates Evidence after tool execution:

```text
Evidence
  id
  kind
  source
  subject
  summary
  mutationEpoch
  dependencyPaths?
  globalScope?
  contentHash?
```

A Claim associates one Requirement with a set of Evidence:

```text
Requirement
  └── Claim
        ├── statement
        ├── risk
        ├── dependencyPaths
        └── evidenceIds
```

Each workspace write advances `mutationEpoch`. Path-scoped Evidence becomes stale when its related files change. Workspace-wide Evidence, including tests, builds, and global searches, becomes stale after a later mutation. Claim status is `proposed`, `supported`, `stale`, or `rejected`.

### Completion and semantic audit

The Completion Kernel evaluates the current State. Completion requires:

- a current supported Claim for every required Requirement;
- current test, build, or explicit verification Evidence after workspace mutations;
- no unresolved integrity error or open conflict;
- current Evidence IDs in the executor report.

The risk router produces four routes:

| Route | Meaning |
| --- | --- |
| `continue` | Continue with the current frontier |
| `verify` | Add test, build, or explicit verification evidence |
| `semantic_audit` | Review a high-risk or semantic Claim independently |
| `human_review` | Wait for external information or authority |

With `--semantic-audit shadow`, the auditor uses the same Model Selection in a fresh Session and evaluates the original Requirements against a temporary read-only snapshot. Its tools are limited to listing, reading, and searching files, and it submits structured results with independent `audit-ev-*` Evidence. The Shadow Verdict is stored in State and the Event Log without changing the current completion result.

### Progress, budget, and permission

The Progress Governor measures changes to Requirements, Evidence, Artifacts, Unknowns, and Conflicts. After several consecutive rounds without a trusted state delta, the run becomes blocked and retains recovery guidance.

Budgets cover tokens, active time, rounds, tool calls, per-round timeout, and consecutive model errors. Budget phases are `normal`, `observe`, and `reserve`; explicit hard limits stop an unbounded run.

Permission modes are:

| Mode | Behavior |
| --- | --- |
| `autonomous` | Run low- and medium-risk workspace actions automatically; request authority for high-risk actions |
| `guarded` | Run low-risk checks automatically and request authority for other actions |
| `locked` | Request authority for every shell action |

Path resolution checks workspace boundaries and symlinks. Shell execution can inherit an outer Codex Sandbox or use a local sandbox where supported. stdout and stderr use bounded streaming capture.

### Recovery and concurrency

The default Longtime data directory is `~/.longtime`:

```text
~/.longtime/
├── config.json
├── credentials.json
└── runs/<workspace-key>/<run-id>/
    ├── state.json
    ├── events.jsonl
    ├── run.lock
    └── runner.log
```

The one-shot CLI saves a `paused` state on SIGINT or SIGTERM. `resume` continues from the latest state. `run.lock` stores a PID, random token, and heartbeat so one run has a single writer; a lease left by a dead process can be recovered.

### Providers and terminal

Longtime connects providers through `@earendil-works/pi-ai`. ModelPort normalizes model selection, reasoning, tool calls, usage, sessions, and cache metadata. OAuth and API-key handling remain in the provider layer.

The terminal provides streaming output and these primary commands:

```text
/model provider/model-id
/permission autonomous|guarded|locked
/allow-risky on|off
/resume <run-id>
/status
/exit
```

### Code map

| Directory | Contents |
| --- | --- |
| `src/core/` | Run loop, state, ProofGraph, progress, budget, and semantic audit |
| `src/providers/` | pi-ai ModelPort, authentication, and credential storage |
| `src/tools/` | Workspace, shell execution, and tool registration |
| `src/ui/` | Terminal output and interactive TUI |
| `src/cli.ts` | CLI entry point and endurance profiles |
| `test/` | Regression tests for state, recovery, permissions, provider bridge, and auditor |
