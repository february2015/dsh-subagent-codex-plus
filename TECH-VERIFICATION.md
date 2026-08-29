# dsh-subagent-codex-plus 技术验证报告

> 状态：**全部核心项已实测验证**（2026-08-29）
> 验证方式：真实 `codex app-server --stdio` 子进程 + dsh 本机运行时源码审计 + UI 槽位/悬浮层源码审计
> 项目：`/Users/robin/myProject/dsh-subagent-codex-plus`

## 0. 验证环境

| 项 | 值 |
| --- | --- |
| dsh | `@deepseek-ai/dsh@0.1.0-rc.7`（npm 全局） |
| Codex | `codex-cli 0.150.1`，`codex app-server --stdio` |
| Codex 配置 | `~/.codex/config.toml`：`model=deepseek-v4-flash`、`model_provider=ocgw`、`approval_policy=never`、`sandbox_mode=danger-full-access` |
| dsh 源码根 | `~/.dsh/profiles/node_modules/@deepseek-ai/`（rc.7 全部包） |
| 协议探针 | `docs/verification/probe2.mjs`（临时线程+steer）、`probe3.mjs`（持久线程+队列+图片）、`probe4.mjs`（队列生命周期） |

结论前置：**R1（中间过程全量透出）、R2（排队/插入）、R3（真网关）、Q3（图片透传）、C3（持久绑定重启恢复）全部具备可实现的技术路径**，且真网关**无需给 dsh 打核心补丁**（见 §5）。

---

## 1. 运行时环境盘点（实测）

- 本机 dsh 运行时为 profile 式插件架构，`~/.dsh/profiles/node_modules/@deepseek-ai/` 下含 `dsh-agent`、`dsh-agent-loop`、`dsh-host-apiproxy`、`dsh-client-runtime`、`dsh-client-ui-*`、`dsh-subagent`、`dsh-session` 等全部包。
- 官方 `subagent-codex` 的 spawn 链（本 fork `src/run.ts:135`）：`[process.execPath, CODEX_PACKAGE_BIN, 'app-server', '--stdio']` —— 用包内 `@openai/codex` 的 bin，而非环境 PATH。
- Codex app-server 协议为 **stdio JSON-RPC 2.0**（每行一个 JSON 报文），`experimentalApi: true` 的 initialize 被正常接受（probe2/probe3/probe4 均实测通过）。
- 官方插件默认 one-shot：每次委派新建临时线程 + 子进程，跑完销毁（`dsh-subagent` 的 `NO_START_CAPABILITIES`、`inheritsParentContext=false`）。

## 2. Codex 协议实测（关键发现）

### 2.1 临时线程不支持队列（决定性约束）

- `thread/start { ephemeral: true }` + `thread/queue/add` → **报错** `-32600 "ephemeral thread does not support queued submissions"`（probe2 实测）。
- **结论：R2 连续对话/排队必须使用持久线程 `ephemeral: false`**。这也同时满足 C3（持久绑定可重启恢复）与可审计性。

### 2.2 持久线程 + 队列生命周期（probe3/probe4 实测）

- `thread/start { cwd, ephemeral: false }` 成功，返回线程 id。
- **忙时 `thread/queue/add`**：进入队列，当前 turn 完成后**自动启动下一条**（auto-drain，实测见 probe3：turn1 完成后自动出现新 `turn/started`，无需手动触发）。
- **空闲时 `thread/queue/add`**：立即作为新 turn 启动（probe4 实测：连续 add 两条，queue/list 只剩 1 条，第一条直接开始跑）。
- 队列 API 全集（`v2-thread.rs`，字段 camelCase）：
  - `thread/queue/add` `{threadId, input, clientUserMessageId}` → `{queuedSubmission}`
  - `thread/queue/list` `{threadId, cursor?, limit?}` → `{data, nextCursor}`
  - `thread/queue/update` `{threadId, queuedSubmissionId, input}`
  - `thread/queue/delete` `{threadId, queuedSubmissionId}` → `{deleted}`
  - `thread/queue/reorder` `{threadId, queuedSubmissionIds}`
  - `thread/queue/start` `{threadId, queuedSubmissionId?}` → `{turn}`（无活动 turn 但有排队项时手动触发用）
- **R2-B1 语义映射成立**：dsh `followup`（FIFO 排队）≈ 忙时 add+auto-drain；dsh `interrupt`/steer ≈ `turn/steer` + 下一轮立即执行。

### 2.3 steer / interrupt（probe2/probe3 实测）

- `turn/steer` `{threadId, expectedTurnId, input}` **可用**，steer 后 turn 正常走向 completed（副作用式重定向当前轮）。
- `turn/interrupt` 只在**活动 turn 期间**有效；turn 已结束后调用被拒（`"no active turn to interrupt"`）。
- 实现要点：插入（steer）要在 turn 进行中发送；排队在任意时刻 add 均可。

### 2.4 图片/附件协议（probe3 实测）

- `UserInput` 类型（`v2/UserInput.ts`）：`text` | `image(url)` | `localImage(path)` | `audio` | `localAudio` | `skill` | `mention`。
- `localImage` **实测通过**：`turn/start` 直接接受本地路径；Codex 在 JSONL 中自动转为 `input_image`（base64 data URL + detail）下发给模型（见 `~/.codex/sessions/2026/08/29/rollout-2026-08-29T13-18-57-01a04bf4-*.jsonl`）。
- `turn/start` 还支持 per-turn 覆盖：`cwd`、`model`、`effort`、`approvalPolicy`、`sandboxPolicy`、`summary`（`v2/TurnStartParams.ts`）—— C2（用当前 cwd + 全局配置）可逐轮控制。

#### 2.4.1 视觉兜底渠道（R4，实测）

- 渠道：ocgo 网关 `https://ocgo.zlxy.sd.cn/v1`（OpenAI 兼容），`GET /v1/models` 实测含 `glm-5.3-flash`、`glm-5.1`、`deepseek-v4-flash/pro`、`kimi-k2.6`、`qwen3.6-plus`。
- 视觉实测：`POST /v1/chat/completions`，`image_url` 传 base64 data URL（1x1 红色 PNG），glm-5.3-flash 回答 `Maroon` —— 视觉能力确认。
- 实现形态：Vision Bridge（图片→glm-5.3-flash 结构化描述→文本注入），Codex 内与 DSH 内同策略；Codex 侧另可选 per-turn `model` 覆盖直接跑视觉模型（`TurnStartParams.model`）。

### 2.5 中间过程事件流（R1 依据，probe2/probe3 实测）

app-server 会推送全量中间事件（消息中间件层）：
- `item/started`/`item/completed`（`userMessage`/`reasoning`/`agentMessage`）、`item/reasoning/textDelta`、`item/agentMessage/delta`
- `hook/started`/`hook/completed`、`thread/tokenUsage/updated`、`turn/completed`
- 线程/队列状态：`thread/started`、`thread/status/changed`、`thread/queue/changed`、`turn/started`

**结论**：R1-A1（事件块级注入）数据源完全够用，中间过程全量可得，无需改 dsh 即可近实时呈现；A1-b（字节级流式渲染）才是需要给 dsh 打补丁/验证 Web UI 流式能力的部分。

### 2.6 持久化（C3 依据，实测）

- 持久线程自动落盘：`~/.codex/sessions/<yyyy>/<mm>/<dd>/rollout-<timestamp>-<threadId>.jsonl`（probe3 实测生成 93KB）。
- `thread/resume {threadId}`（`v2/ThreadResumeParams.ts`：按 thread_id 从磁盘加载恢复）→ **C3 的“dsh 会话 ID ↔ Codex 线程 ID 1:1 持久绑定、重启后 thread/resume 直连”在协议层原生支持**。

## 3. dsh 宿主层验证（真网关路径）

### 3.1 客户端动词（dsh-client-runtime）

`~/.dsh/profiles/node_modules/@deepseek-ai/dsh-client-runtime/lib/client.js`：
- `prompt(content, mode)` `:7196` —— mode 为 `queue`/`steer`，UI 原生发送
- `updateQueue(itemId, action)` `:7284` —— edit/remove/steer
- `cancel()` `:7304`、`command(line)` `:7365`
- 子代理提示走 `api.subagents.prompt` `:7227`；其中 **图片在子代理续聊中被拒**（`SUBAGENT_IMAGE_UNSUPPORTED` `:7223`）—— 网关模式不受影响（走 session.prompt）。

### 3.2 宿主 handler（dsh-host-apiproxy）

`~/.dsh/profiles/node_modules/@deepseek-ai/dsh-host-apiproxy/lib/types/api-proxy.js`：
- `session.prompt` `:2116`：`mode==='steer' ? agent.steer(message) : agent.followup(message)`（`:2154-2157`）；图片经 `durablePromptContent`（`:57`，base64→saveImages→attachment 块）原生支持。
- `session.updateQueue` `:2227`：动作 `edit|remove|steer`。
- `turnAgentFor` `:1547`：**唯一强制 model adapter 检查点**（`routeServed` `:1534` 检查 llm registry）——自定义 Agent 只要绕过它即可纯转发。

### 3.3 Agent 契约（真网关无需打补丁的根据）

- `AgentRegistry.register(agent)`：`~/.dsh/profiles/node_modules/@deepseek-ai/dsh-agent/lib/index.js:580`，任意插件可注册自定义 Agent。
- `ReactLoopAgent`（`dsh-agent-loop/lib/types/agent.d.ts`）实现的接口 = 原生 Agent 契约：`send` / `followup` / `steer` / `inject` / `cancel` / `runMaintenance` / `whenIdle`。
- **真网关设计**：注册一个 `GatewayAgent`（实现同一契约，内部转发到 Codex app-server 的 `turn/start`/`thread/queue/add`/`turn/steer`），dsh 核心无需改。网关模式下 UI 的 `session.prompt` 直接被 GatewayAgent 吃掉，dsh LLM 不参与。
- 子代理服务原语（`dsh-subagent/lib/index.js`）：`startContinuable` `:771`、`followup` `:840`、`reportFrom` `:907`、`listChildren` `:1678`—— 委派式会话与网关式会话可并存（Q5）。

### 3.4 会话输出流词汇（$@deepseek-ai/dsh-session）

`user/message`、`assistant/chunk`（token 级）、`assistant/message`、`tool/call`、`tool/result`、`turn/start|end`、`step/start|end`、`request/header`。
网关/透出层可以把 Codex 中间事件映射为 `assistant/chunk`→`assistant/message` 输出，UI 原生渲染、无需补丁。

### 3.5 真实宿主探针（probe-attach，0.1.1-rc.2 实测）

- 探针 profile `~/.dsh/profiles/probe-attach`（`@deepseek-ai/dsh-base` + `dsh-gateway-probe` bundle），跑 `dsh --profile probe-attach`。
- **20 项断言 ALL PASS**（`/tmp/probe-attach.log` 尾行 `[PROBE-COMPLETE]`），覆盖：真实插件 apply（`ctx.plugin()` 装载 `subagent-codex-plus`，provider `codex-plus` + `/codex-attach`、`/codex-detach` 注册成功）→ 建 loop agent → attach（真实 codex app-server、注册表原地换 agent）→ 绑定持久化 → followup 到 Codex（running→idle）→ 用户消息经 inbox 入 session 日志 → Q4（同 session 重复 attach 拒绝；同 thread 跨 session 拒绝）→ detach（entries 清空、binding 删除、child 停止）→ Q1（`ctx.agents.resume` 恢复 ReactLoopAgent 普通模式）→ C3（持久绑定下 resume 出版新 loop agent 后自动替换为 GatewayAgent，**同一 threadId**，继续对话）。
- **routeServed 绕过**：`routeServed` 只检查 `selection.provider` 在 `llm.listProviders()` 里，不检查 model adapter；给 GatewayAgent 传 `provider:'deepseek'`（registry 里的 provider）即可过（实测 `deepseek-official/deepseek-v4-flash` 通过）。
- **注册表换 agent 的约束**：`ctx.agents.register/enter` 同 id 会抛 `already registered`；正确做法是把旧 loop agent 的 store entry 用注册表私有 `detachEntered` 退役（发 `agent/disposed`），再 `enter+announce` 自己的 agent。
- **persistence live-owner 教训**：detach 时 session entry 必须走 entry 自己的 `detach()`，不能直接 `store.delete`，否则 persistence 的 live-owner 不释放，Q1 resume 会报 `already has a live persistence owner`。
- **detachEntered 的 `this`**：`detachEntered` 是 Cordis trace 包装方法，调用必须 `Reflect.apply(detachEntered, registry, [entry])` 保 `this`。
- **插件手动 apply 陷阱**：直接 `plugin.apply(ctx, config)` 会跳过 Cordis inject，`ctx.subagents` 抛 `cannot get property "subagents" without inject`；必须 `ctx.plugin(plugin, config)`（loader 同款装载路径）。
- 网关冒烟：`docs/verification/gateway-agent-smoke.ts`（agent 契约，约 15s，含 1.6 事件透出断言）、`docs/verification/gateway-smoke.ts`（调度，约 70s，`thread/resume` 重连也过）。

### 3.6 1.6 事件透出实测（R1-A1/A2，2026-08-29）

**真实 app-server 通知流抓包**（`codex app-server --stdio`，本机 deepseek-v4-flash via ocgw；脚本 `/tmp/capture-notifs*.mjs`）：
一轮普通 turn 的实际通知序列：`thread/started` → `thread/status/changed` → `turn/started` → `hook/started|completed` → `item/started`/`item/completed`（item 类型：`userMessage`、`reasoning`、`agentMessage`）→ `item/reasoning/textDelta`（`{threadId, turnId, itemId, delta, contentIndex}`）→ `item/agentMessage/delta`（`{threadId, turnId, itemId, delta}`）→ `thread/tokenUsage/updated` → `account/rateLimits/updated` → `turn/completed`（final `turn.status` ∈ `completed|interrupted|failed`）。另有 `warning`、`skills/changed`、`mcpServer/startupStatus/updated`、`remoteControl/status/changed`。
- 工具调用 item 形状（协议文档，本机模型不调函数无真实样本）：`item/started|completed` 的 `item.type = dynamicToolCall`（`{id, tool, arguments, status}`）；旧式 `functionCall` 按 `{id, name, arguments}` 兜底映射。
- `turn/completed` 的 `turn` 含最终 `agentMessage` 摘要（`itemsView:"summary"`）；完整条目仍需消费 `item/*` 流 —— 与我们的逐 item 映射一致。

**GatewayEventForwarder 映射**（`src/gateway/events.ts`，纯 log-only，A2）：
| Codex 通知 | dsh 会话事件 | 说明 |
| --- | --- | --- |
| `turn/started` | `turn/start` + `step/start` | turn 计数递增；每 turn 一个 step |
| `turn/completed` | `step/end` + `turn/end` | status→reason：`completed`/`interrupted`(→aborted/user)/`failed`(→error/UNKNOWN) |
| `item/reasoning/textDelta` | `assistant/chunk`（`reasoning-delta`） | 保留 `contentIndex` |
| `item/agentMessage/delta` | `assistant/chunk`（`text-delta`） | 逐 delta 追加 |
| `item/started`（tool item） | `tool/call` | name/arguments JSON；`callId`=item id |
- `Session.append` 是类方法（读 `this.log`），**必须 `.bind(session)` 后调用**，否则 detached 调用抛 TypeError 且 dsh 宿主吞掉 console.error —— 实测教训。
- 新配置：`gatewayEventForwarding`（默认 true）、`gatewayAppendFinalMessage`（默认 false，防 surface 污染）。

**验证结果**：
- 单测 `docs/verification/events-smoke.ts`（真实抓包形状喂入，14 断言 ALL PASS）。
- 真实宿主 probe-attach：followup 一轮后 session 日志出现 `turn/start → step/start → assistant/chunk* → step/end → turn/end`（chunks 含 `reasoning-delta`/`text-delta`），**除用户消息 inbox 记录外无任何 surface 事件**（A2 成立）；20 项断言 ALL PASS。
- `gateway-agent-smoke.ts` 同样断言中间事件落日志、无 surface 泄漏。

## 4. UI 槽位与悬浮窗验证

### 4.1 官方槽位（`dsh-client-ui-conversation/lib/types/client/contract/slots.d.ts`）

- `conversation.session.header` `:43`（single/session）—— 直连徽标
- `conversation.session.header.actions` `:57`（list）—— 悬浮窗打开按钮
- `conversation.chat.commandview` `:104`（keyed on command name）—— `/codex-attach` 斜杠命令原生渲染
- `conversation.input.dock` `:190`（list）—— 输入区上方堆叠（排队列表）
- `conversation.composer.dock` `:203`（list）—— composer 下方状态条
- `conversation.input.left` `:216` / `conversation.input.right` `:228` / `conversation.input.plan` `:260`

槽位注册包：`@deepseek-ai/dsh-client-ui-slots`（`kind`: single/list/keyed/chain；`scope`: root/session-maybe/session）。

### 4.2 悬浮窗模式（dsh-pet 实证）

`~/.dsh/profiles/web/node_modules/@linxin666/dsh-pet/lib/types/client/index.js:189-195`：客户端插件在 `document.body` 上 `appendChild` + `createRoot`，React portal 悬浮层；入口 `inject` 由插件设置提供。控制类浮层（队列操作/steer/网关开关）照此模式实现。

## 5. 结论映射（需求 → 验证结论）

| 需求 | 验证结论 | 依据 |
| --- | --- | --- |
| R1 中间过程全量透出 | ✅ 事件级全量可得（A1 可行）；字节级流式（A1-b）需 dsh 补丁，列为后续任务 | §2.5 |
| R2 排队/插入 | ✅ 持久线程 queue/steer 全链路实测通过；语义=dsh followup/steer | §2.1-2.3 |
| R3 真网关 | ✅ 注册 GatewayAgent 即实现，**无需打 dsh 核心补丁**；UI 输入输出经 session.prompt 直通 Codex | §3 |
| Q3 图片透传 | ✅ `localImage` 实测通过；dsh session.prompt 图片原生支持（子代理续聊除外，网关不走那条路） | §2.4、§3.1 |
| C3 1:1 持久绑定 | ✅ 持久线程 JSONL 落盘 + `thread/resume` 原生支持 | §2.6 |
| 状态→槽位 / 控制→浮层 | ✅ 官方槽位清单 + dsh-pet 悬浮层模式均实证 | §4 |

## 6. 关键风险/注意点

1. **队列自动排空**：`queue/add` 在空闲时会立即开 turn；网关排队逻辑要与 UI 状态（turn 是否 inProgress）对齐，避免“插队”误解。
2. **steer 的 expectedTurnId 竞态**：steer 需要知道当前 turn id，需从 `turn/started` 事件缓存。
3. **子代理路径图片受限**：委派式（subagent）续聊带图会被 dsh 拒；图片透传只在网关（session.prompt）路径完整可用。
4. **Codex 侧模型能力**：本机默认 `deepseek-v4-flash`（ocgw 代理），图片是否被模型真正理解取决于该 provider；协议层已通。
5. **experimentalApi 依赖**：queue/steer 属于实验 API，Codex 升级需回归验证。

## 7. 复现命令

```bash
# 环境
codex --version                    # 0.150.1
node ~/.dsh/profiles/node_modules/@deepseek-ai/dsh-client-runtime/... # 运行时包在 ~/.dsh/profiles/node_modules/@deepseek-ai/

# 协议探针（stdio JSON-RPC，直连真实 codex app-server）
node docs/verification/probe2.mjs  # 临时线程 + queue 拒绝 + steer
node docs/verification/probe3.mjs  # 持久线程 + 忙时队列 + localImage
node docs/verification/probe4.mjs  # 队列生命周期（空闲即启动 / auto-drain / update / delete）

# 持久化产物
ls ~/.codex/sessions/<yyyy>/<mm>/<dd>/rollout-*.jsonl
```
