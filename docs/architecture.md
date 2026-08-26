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
| Semantic Audit | 在隔离只读快照上执行可选的独立 Session 审查 |

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

新 Run 从用户目标生成 `GoalContract` 和 Requirements，并锁定初始工作区指纹。原始目标、额外 Requirement 和 Constraint 都会成为带来源标记的必需证明项；Constraint 不再只是提示词。修复、实现、创建等意图默认要求最终存在净变化；CLI 可用 `--require-change` 或 `--allow-no-change` 显式锁定。恢复 Run 不能改变这一 Contract。

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
| `facts` | 由当前 Evidence 支持的持久事实；支撑证据失效时事实也随之失效 |
| `unknowns` / `conflicts` | 尚未解决的问题和冲突 |
| `frontier` | 下一 Round 的有界工作范围 |
| `progress` | 最近状态增量与连续停滞计数 |
| `usage` / `budget` | Token、时间、Round 和工具调用统计 |
| `health` | 模型错误、重试与最近失败 |

状态快照写入 `state.json`，上一份可读快照保存在 `state.prev.json`，事件同步追加到 `events.jsonl`。热状态会压缩已失效且未被证明引用的普通 Evidence，绝不为了容量上限制造悬空 Claim 引用。Event Log 保留事件顺序，但当前并不是可以单独重建全部 State 的完整 Event Sourcing。

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
- Goal Contract 要求修改时，工作区与初始 Fingerprint 存在净差异；
- 工作区修改后，每个 required Requirement 都有由 `verify` 产生并显式映射的当前测试、构建或锁定验收 Evidence；普通 Shell Evidence 不参与完成证明；
- 没有未解决的完整性错误或开放冲突；
- Executor 引用的 Evidence ID 当前有效。

风险路由器提供四种结果：

| Route | 含义 |
| --- | --- |
| `continue` | 继续当前 Frontier |
| `verify` | 补充测试、构建或显式验证 |
| `semantic_audit` | 对高风险或语义 Claim 运行独立审查 |
| `human_review` | 等待外部信息或授权 |

启用 `--semantic-audit shadow` 后，Verdict 只写入 State 和 Event Log。启用 `gate` 后，路由到语义审计的完成声明必须在当前 Round 获得 `pass`，否则 Completion Kernel 拒绝完成。Auditor 使用新的 Session 和隔离只读快照；默认沿用 Executor Model，也可通过 `--audit-model` 指定不同模型以降低共同盲点。

### Progress、Budget 与 Permission

Progress Governor 统计 Requirement、Claim、Evidence、Fact、Artifact、Unknown 和 Conflict 的变化。Evidence 和 Artifact 按内容签名计数，重复相同的查询或命令不会伪装成新进展。连续多个 Round 没有可信状态增量时，Run 进入 blocked 状态并保留恢复说明。

预算覆盖 Token、费用、活跃时间、Round、工具调用、单轮超时和连续模型错误。预算阶段为 `normal`、`observe` 和 `reserve`；显式硬上限结束失控运行。

权限模式包括：

| Mode | 行为 |
| --- | --- |
| `autonomous` | 自动执行低、中风险工作区操作；高风险操作需要授权 |
| `guarded` | 自动执行低风险检查，其余操作请求授权 |
| `locked` | Shell 操作均请求授权 |

路径解析会检查工作区边界和符号链接；文件列表与搜索还会拒绝绝对 Glob 和父目录穿越，并对每个匹配结果重新做规范路径检查。工具参数、文本文件读取、搜索总字节、写入载荷和模型可见结果都有显式上限。Shell 可继承外层 Codex Sandbox，或在支持的平台上使用默认禁网、屏蔽凭据目录的本地沙箱。stdout 与 stderr 使用有界流式捕获。

Shell 风险分类按完整命令检查显式删除或覆盖、重定向写入、原地编辑、Git 工作区或历史修改、依赖安装、命令替换、外部服务 CLI 和敏感主目录路径。这些操作即使发生在工作区内也属于高风险；分类是保守的授权门槛，不是对任意脚本内部行为的安全证明。

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

一次性 CLI 在收到 SIGINT 或 SIGTERM 时保存 `paused` 状态。`resume` 从最近状态继续执行，并用工作区 Fingerprint 检测 Longtime 外部发生的修改；发现变化时会推进全局 Mutation Epoch、清空可能过期的 Artifact 导航并失效旧 Evidence/Claim。`run.lock` 保存 PID、随机 Token 和心跳，同一 Run 同时只有一个写入者；死亡进程遗留的 Lease 可以恢复。

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
| Semantic Audit | Run an optional independent-session review against an isolated read-only snapshot |

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

A new run derives a `GoalContract` and Requirements from the task and locks the initial workspace fingerprint. The objective, additive Requirements, and Constraints all become required proof criteria with origin metadata; Constraints are not advisory prompt text. Fix, implement, and create intents require a net final change by default; `--require-change` and `--allow-no-change` make that policy explicit. Resume cannot change the locked policy.

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
| `facts` | Durable facts backed by current Evidence and invalidated when that Evidence becomes stale |
| `unknowns` / `conflicts` | Unresolved questions and conflicting observations |
| `frontier` | Bounded work for the next round |
| `progress` | Recent state deltas and consecutive stall count |
| `usage` / `budget` | Token, time, round, and tool-call accounting |
| `health` | Model errors, retries, and the latest failure |

Snapshots are written to `state.json`, with the previous readable snapshot retained as `state.prev.json`; events are synchronously appended to `events.jsonl`. Hot state compacts unreferenced ordinary Evidence without creating dangling Claim references. The Event Log preserves ordering but is not yet a complete event-sourced reducer capable of rebuilding all State by itself.

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
- a net difference from the starting workspace fingerprint when the Goal Contract requires change;
- current host-created `verify` Evidence mapped to every required Requirement after workspace mutations; ordinary Shell success is diagnostic only;
- no unresolved integrity error or open conflict;
- current Evidence IDs in the executor report.

The risk router produces four routes:

| Route | Meaning |
| --- | --- |
| `continue` | Continue with the current frontier |
| `verify` | Add test, build, or explicit verification evidence |
| `semantic_audit` | Review a high-risk or semantic Claim independently |
| `human_review` | Wait for external information or authority |

With `--semantic-audit shadow`, the verdict is recorded but advisory. With `gate`, a completion routed to semantic audit must receive a current `pass` verdict or the Completion Kernel rejects it. The auditor uses a fresh Session against an isolated read-only snapshot; it defaults to the executor model, while `--audit-model` can select a different model to reduce shared blind spots.

### Progress, budget, and permission

The Progress Governor measures changes to Requirements, Claims, Evidence, Facts, Artifacts, Unknowns, and Conflicts. Evidence and Artifacts are counted by content signature, so repeating an identical query or command does not masquerade as progress. After several consecutive rounds without a trusted state delta, the run becomes blocked and retains recovery guidance.

Budgets cover tokens, cost, active time, rounds, tool calls, per-round timeout, and consecutive model errors. Budget phases are `normal`, `observe`, and `reserve`; explicit hard limits stop an unbounded run.

Permission modes are:

| Mode | Behavior |
| --- | --- |
| `autonomous` | Run low- and medium-risk workspace actions automatically; request authority for high-risk actions |
| `guarded` | Run low-risk checks automatically and request authority for other actions |
| `locked` | Request authority for every shell action |

Path resolution checks workspace boundaries and symlinks. File listing and search also reject absolute or parent-traversing globs and canonicalize every match. Tool arguments, text-file reads, aggregate search bytes, write payloads, and model-visible results have explicit bounds. Shell execution can inherit an outer Codex Sandbox or use a supported local sandbox with network denied by default and common credential directories masked. stdout and stderr use bounded streaming capture.

Shell risk classification inspects the complete command for explicit deletion or overwrite, output redirection, in-place edits, Git worktree or history mutation, dependency installation, command substitution, external-service CLIs, and sensitive home paths. These operations are high risk even inside the workspace. Classification is a conservative authorization gate, not a proof of arbitrary script behavior.

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

The one-shot CLI saves a `paused` state on SIGINT or SIGTERM. `resume` continues from the latest state and reconciles a workspace fingerprint; externally changed work advances a global Mutation Epoch and invalidates old Evidence and Claims. `run.lock` stores a PID, random token, and heartbeat so one run has a single writer; a lease left by a dead process can be recovered.

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
