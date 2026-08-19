# Longtime Harness Architecture

## 1. 产品边界

Longtime 不是另一个更大的 Prompt，也不是让多个 Agent 无限递归。它是一套位于模型与工作区之间的控制系统。

依赖方向固定为：

```text
Terminal UI -> Application -> Harness Core -> Provider Port
                                |           -> Workspace Port
                                |           -> Auditor Port
                                -> Event Log / State Store
```

核心层不能依赖 TUI、具体模型 SDK 或具体文件系统实现。

## 2. 四个必须分离的对象

### 2.1 Transcript 与 State

Transcript 是发生过什么，State 是目前可依赖什么。模型摘要不能直接成为可信状态。

### 2.2 Claim 与 Verified Fact

Executor 的输出默认是 `claim`。只有绑定宿主观察证据，并通过对应审计器后，才能提交为 `verified fact`。

### 2.3 Step Budget 与 Run Budget

单轮模型调用只获得局部额度；所有 Executor、Auditor、恢复轮次和子任务共享 Run 级预算。预算默认是软控制，不以节省 Token 为最高目标。

### 2.4 Online Runtime 与 Offline Evolution

在线运行只应用冻结策略。Harness 的 Prompt、路由、模型画像和阈值通过离线回放与成对评测更新，不在用户任务过程中自我修改。

## 3. Durable State

一个 Run 至少包含：

```text
RunState
  contract        原始目标、要求、约束、停止条件
  requirements    pending / active / claimed / verified / blocked
  facts           带证据和 mutation epoch 的可信事实
  artifacts       文件、测试、构建、页面等可定位产物
  unknowns        尚未解决的问题
  conflicts       相互矛盾的观察或并发修改
  frontier        下一轮允许处理的有界工作
  progress        最近可信增量和停滞计数
  health          连续/累计模型错误与最近失败
  budget          Run 级 Token、时间和工具调用消耗
```

状态采用 fsync 后原子替换的快照保存，Event Log 采用 append-only JSONL。快照可以重建，事件不可被模型改写。热快照会清理已过期的普通 Evidence 并设硬上限，完整审计仍保留在 Event Log，避免 72 小时运行出现每次保存都复制无限增长数组的二次复杂度。

## 4. Context Compiler

每轮构建新工作集，而不是把全部历史继续塞给模型：

1. 不可变的 Goal Contract；
2. 当前 Frontier；
3. 与 Frontier 相关的 verified facts；
4. 最近的失败和恢复指令；
5. 必需的原始证据引用；
6. 本轮工具、权限和输出契约。

完整日志保留在磁盘，由程序检索；自然语言摘要只作为索引，不是事实来源。

Artifacts、Facts、Unknowns、Conflicts 和 Evidence 在模型可见上下文中分别有相位相关上限，同时附总数。超出窗口不等于删除磁盘审计记录。

## 5. Executor

Executor 每轮只能处理一个有界 Frontier。它可以：

- 检查和修改工作区；
- 运行命令；
- 提交 Claim；
- 引用本轮宿主观察到的 Evidence ID；
- 报告 Unknown、Conflict 或 Blocker。

它不能直接把 Requirement 设为 `verified`，也不能决定整个 Run 已完成。

## 6. ProofGraph、Evidence Ledger 与精确失效

每次写入工作区都会增加 `mutationEpoch`。证据记录：

```text
Evidence {
  id
  kind
  source
  subject
  summary
  mutationEpoch
  observedAt
  contentHash?
  dependencyPaths?
  globalScope?
  invalidatedAt?
}
```

Executor 可以进一步提交 Requirement–Claim–Evidence 关系：

```text
Requirement
  -> Claim(statement, risk, dependencyPaths)
       -> Evidence IDs
```

读取单个文件产生路径依赖证据；测试、构建和全局搜索默认是 workspace 全局证据。修改 `src/a.ts` 时，与它相关的 Evidence 和 Claim 会变 stale，但 `src/b.ts` 的路径证据仍可继续使用。旧 Run 中没有 dependency metadata 的 Evidence 继续采用原来的全局 Mutation Epoch 语义，保证版本 1 状态可恢复。

当前 Claim 状态为 `proposed / supported / stale / rejected`。Completion Kernel 要求每个 required Requirement 至少存在一个 current supported Claim。

## 7. Adaptive Audit Router 与 Completion Kernel

每轮 `report_state` 后，确定性风险路由器输出：

1. `continue`：现有证据足够，继续当前单 Executor 路径；
2. `verify`：最新 mutation 缺少 build/test 等确定性证据；
3. `semantic_audit`：高风险或语义 Claim、stale proof、反复停滞或证据冲突；
4. `human_review`：缺少授权、凭据、付款或外部发布权限。

`semantic_audit` 现在可以通过 `--semantic-audit shadow` 接入最小 Falsification Auditor：

- 验收清单直接锁定自不可变 Goal Contract，不额外调用 Planner；
- 使用同一 Model Selection，但创建独立 Session，不携带 Executor transcript；
- 复制最多 100 MiB 的源工作集到临时只读快照，记录 snapshot hash、文件数、字节数和跳过路径；
- Auditor 只有 `audit_read_file / audit_list_files / audit_search / submit_semantic_audit`；
- 每条 Requirement 必须引用 Auditor 新生成的 `audit-ev-*`；
- Audit Evidence 保留 bounded excerpt 与内容 Hash，审计结束再次核对 snapshot hash；
- `pass` 如果没有覆盖全部 required criteria，会被程序降级为 `inconclusive`；
- `reject` 如果没有至少一个带新反证的 failed criterion，也会被降级为 `inconclusive`；
- 当前 shadow verdict 持久化但不影响 Completion Kernel，先用 traces 校准误杀、漏检和 token 开销。

`human_review` 仍为 advisory；语义 Auditor 的强制门禁属于后续阶段。

Completion Kernel 由代码执行，只有以下条件同时成立才结束：

- 所有硬要求已验证；
- 证据没有因后续修改过期；
- 没有未解决冲突或完整性违规；
- 端到端终态检查通过；
- 需要人工授权的外部动作已经授权。

## 8. Progress Governor

长程运行不使用“固定两轮”作为主要停止条件。每轮计算：

- 新增 verified requirements；
- 新增有效 evidence；
- 消除的 unknowns/conflicts；
- 新增或更新的 artifacts；
- 重复工具调用和连续失败；
- Token / wall time / tool call 消耗。

只要可信状态持续增长，就允许继续。连续无可信增量时依次：

```text
重写 Frontier
  -> 更换策略或工具
  -> 回滚到最近 verified checkpoint
  -> 更换模型（策略允许时）
  -> 所有自动路径耗尽后才请求用户
```

## 9. Budget Broker

预算分成三段：

- `normal`：完全自主运行；
- `observe`：缩小上下文、减少重复审计、降低模型成本；
- `reserve`：只用于恢复与最终验证。

硬上限用于防止失控，不作为常规早停条件。运行必须为最终审计保留额度。

模型请求还有独立的单轮超时和指数退避。暂时性错误不会被计入“无进展”，而是记录 `model_failed` / `model_retry_scheduled` 后从最新快照重新编译上下文；认证、未知模型等确定性错误快速失败。

## 10. Permissions

权限按影响而非工具名判断：

- 工作区内读取：自动；
- 工作区内可恢复写入：自动并记录快照；
- 沙箱内本地测试：自动；
- 网络读取：按域名策略；
- 越界读取、不可逆删除、发布、发送、付款、生产写入：请求授权；
- 同一 Run 中相同授权范围可缓存，避免重复询问。

## 11. Multi-model Strategy

模型通过统一 `ModelPort` 接入。Provider 层负责协议差异，Harness 只消费：

- messages；
- tools；
- reasoning/thinking 配置；
- usage；
- stop reason；
- provider session/caching metadata。

模型画像按 `provider + model + protocol + task slice` 保存，不能把一个模型在编码任务中的表现直接推广到 GUI 或研究任务。

## 12. Terminal UX

借鉴 π 的原则：差量渲染、流式输出、可恢复 Session、Slash Commands 和工具状态可见。Longtime 额外突出：

- 当前 Frontier；
- Verified / Claimed / Blocked 数量；
- 最近一次可信状态增量；
- Run 级 Token 和恢复预算；
- 当前权限模式；
- `/pause`、`/resume`、`/state`、`/evidence`、`/why-running`。

正常运行不通过弹窗频繁询问用户，只在权限升级或真正需要外部事实时打断。

Shell 执行前后对工作区做轻量元数据快照。无论模型通过结构化写工具还是 Shell 修改文件，都会推进 Mutation Epoch，使此前测试证据失效。stdout/stderr 采用流式有界捕获，只保留头尾和省略量。

如果 Longtime 运行在 Codex CLI 已有的 `CODEX_SANDBOX` 中，Shell 直接继承外层沙箱，禁止再次嵌套 macOS `sandbox-exec`。否则才建立自己的 Seatbelt/bwrap 沙箱。

一次性 CLI 捕获 SIGINT/SIGTERM，先保存 `paused` 再退出；后台 `--detach` 使用独立进程组和独立日志。同一 Run 的 `run.lock` 带 PID、token 和心跳，任何时刻只允许一个执行者写状态；死亡进程遗留的锁可恢复。

## 13. 实施阶段

当前实现状态：Phase 0 已打通；Phase 1 已实现 ProofGraph、路径依赖 Evidence、兼容旧状态的精确失效、Mutation Epoch、风险路由、最小 same-model shadow Falsification Auditor 与确定性 Completion Kernel；Phase 2 已实现有界 Context Compiler、软预算、暂时性错误恢复、No-progress Recovery 和 24–72h Profile；单写者租约已提前落地。语义审计强制门禁、程序化历史检索、自动换模型、隔离并行和离线进化仍属于后续阶段。

### Phase 0 — 可运行内核

- 多 Provider 模型调用；
- 基础终端；
- 工作区工具；
- Event Log 与 Run State；
- Progress Governor；
- Resume。

### Phase 1 — 可信完成

- Requirement Contract；
- Evidence Ledger；
- Requirement–Claim–Evidence ProofGraph；
- 路径依赖与精确证据失效；
- Mutation Epoch；
- Deterministic Auditor；
- Adaptive Audit Router（advisory）；
- same-model isolated Falsification Auditor（shadow）；
- Completion Kernel。

### Phase 2 — 长程效率

- Context Compiler；
- Programmatic Retrieval；
- Soft Budget Broker；
- No-progress Recovery；
- 模型切换。

### Phase 3 — 复杂协作

- Skill Transition；
- 隔离工作区；
- 单写者租约；
- 只读并行调查与证据化合并。

### Phase 4 — 离线进化

- Trace 回放；
- 成对消融；
- 隐藏开发集；
- Canary 与自动回滚。
