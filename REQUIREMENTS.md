# dsh-subagent-codex-plus 需求文档

> 状态：v1.0 定稿（R0-R3 全部确认，2026-08-29）
> 项目：`/Users/robin/myProject/dsh-subagent-codex-plus`
> 基底：fork 官方 `@deepseek-ai/dsh-subagent-codex`（master TS 源码 0.1.2-alpha.1，包/插件/provider 已改名）

## 总目标

在 DeepSeek Harness（dsh，本机 0.1.0-rc.7）的统一界面里，把 Codex 变成一等公民：
既能委派式调用（保留官方 one-shot），也能连续对话（排队/插入），还能**真网关直连**
（用户输入输出与 Codex 直接互通，dsh 不经过任何大模型，只做搬运）。

## R0 基线（已确定）

- 保留官方 one-shot 行为：一次委派 = 一个 Codex 子进程（`codex app-server --stdio`）跑完返回最终答案，作为可回退基线。
- 包名 `dsh-subagent-codex-plus` / 插件名 `subagent-codex-plus` / provider 名 `codex-plus`。

## R1 中间过程全量透出

**需求**：Codex 执行过程中的输出实时、原样呈现在 dsh 里，不只是最终答案。

透出范围：推理摘要、agent 消息增量、工具调用（工具名+参数）、命令输出、文件修改、turn/hook/token 状态。
实时可见、可回放（本地 JSONL）。

**已定决策**
- A1：第一版用**事件块级注入**（无需改 dsh，近实时）。
- A1-b（**未来任务，已记录**）：字节级流式渲染，需要给 dsh 打补丁 + 实测 Web UI 流式渲染能力。后续可能要做，列为待办。
- A2：中间过程**默认不进 dsh 模型上下文**（省 token、不干扰模型），仅在网关/调试模式可选项开启。
- A3：推理接受**摘要级**为上限（Codex 侧全文默认加密，不为此改 Codex 配置）。

## R2 同会话连续对话 + 排队 + 直接插入

**需求**：一个 dsh 对话对应一个 Codex 线程（持久、可跨重启恢复）；Codex 忙时新消息可排队，
也可直接插入（打断当前轮）。

**已定决策**
- B1：**按 dsh 语义**：
  - 排队 = dsh `followup`（FIFO inbox），当前轮结束后依次执行；
  - 直接插入 = dsh `interrupt` 语义（中断当前轮，消息成为下一轮立即执行）。
- B2：**默认排队 + 显式插入**（如 `/steer` 或 `codex_steer` 工具触发）。
- B3（用户定稿）：**选择/控制类 → 悬浮窗口；状态显示类 → 官方槽位**。
  - 控制类（队列查看/取消/改序、steer/插入、网关开关）→ 悬浮窗口（`dsh-pet` 模式：
    `document.body` 全局 React root，经 `dsh.client.inject` 客户端插件注入）。
  - 状态类（直连 Codex 徽标、排队状态条）→ 官方槽位：
    - `conversation.session.header`（single/session）：会话头部直连徽标；
    - `conversation.composer.dock`（list/session）：composer 下方状态条（直连状态、排队计数）；
    - `conversation.input.dock`（list/session）：输入区上方堆叠条（排队列表实时展示）；
    - `conversation.session.header.actions`（list/session）：挂悬浮窗的打开按钮；
    - 悬浮窗入口另可挂 `conversation.input.right`（输入卡右侧工具行）。
  - 本地指令：`/codex-attach` 走官方命令体系，`conversation.chat.commandview`
    （keyed on `command/run.name`）原生支持斜杠命令渲染，零注册即可显示。

## R3 真网关（直连模式）

**需求**：一条本地指令（如 `/codex-attach`）把当前 dsh 对话绑定到一个**新的** Codex 会话；
绑定后，dsh 界面上的所有输入输出与 Codex 直接互通，**dsh 不经过任何大模型，只做搬运**。

**已定决策**
- C1：**真网关**（传输级直通，非模型转发壳）。需要给 dsh 核心打补丁（消息路由绕过 agent loop）+ 验证 Web UI 流式渲染。
- C2：新 Codex 会话参数 = dsh 当前会话 cwd + Codex 全局配置（模型/权限等）。
- C3：**1:1 持久绑定**：dsh 会话 ID ↔ Codex 线程 ID 一一对应，绑定关系持久化，
  关机/重启后重新进入该 dsh 会话即自动直连同一个 Codex 会话。
- 新增（用户补充，已定稿）：**直连状态显示**——状态显示类用官方槽位：
  会话头部 `conversation.session.header` 徽标 + `conversation.composer.dock` 状态条；
  选择/控制类用悬浮窗口（队列操作、网关开关）。
- 新增（Q3=B 定稿）：**图片/附件透传**——网关模式 v1 即支持把 dsh 输入框的图片/附件原样转给 Codex。

## 已确认决策（Q1-Q5，2026-08-29 定稿）

- Q1：**保留解除绑定**。断开直连后 dsh 恢复普通模式；Codex 线程保留，可随时重新 attach 回同一会话。
- Q2：**网关模式下 R2 全部生效**。忙时新消息排队、悬浮窗可插入/打断/看队列；悬浮窗与队列逻辑在委派式/网关式两种模式下共用同一套组件。
- Q3：**v1 即支持图片/附件透传**（非文本先行）。实现要点：
  - dsh composer 的附件 → Codex `turn/start`/queue 的 image UserInput（本地路径/URL）转换；
  - 图片大小/格式校验、失败提示；附件类型（图片先行，文件类后续评估）。
- Q4：**双向唯一**。一个 Codex 线程只允许被一个 dsh 会话绑定，重复绑定拒绝；
  同一 dsh 会话多标签页共享同一绑定（天然串行，不算冲突）。
- Q5：**委派式与网关式并存**。一个 dsh 对话可挂多个委派式 Codex 子会话（模型触发），
  同时至多一个用户直连网关会话；网关模式下 dsh 模型不参与，两者按需切换。

## 技术验证（已完成，2026-08-29）

> 全部验证记录见 **[TECH-VERIFICATION.md](./TECH-VERIFICATION.md)**，探针脚本在 `docs/verification/`。

- ✅ dsh 核心消息路由位置：`session.prompt`（api-proxy.js:2116）→ `agent.steer/followup`；唯一 model 检查点在 `turnAgentFor`（:1547）。
- ✅ 真网关无需打 dsh 补丁：`AgentRegistry.register`（dsh-agent/lib/index.js:580）可注册自定义 `GatewayAgent`（实现 send/followup/steer/inject/cancel），UI 输入输出经 `session.prompt` 直通。
- ✅ 斜杠命令：`conversation.chat.commandview` 按命令名 keyed，原生可渲染 `/codex-attach`。
- ✅ 槽位：官方清单实证（`conversation.session.header` / `conversation.input.dock` / `conversation.composer.dock` / `conversation.session.header.actions` / `conversation.input.left/right`）。
- ✅ 悬浮层：dsh-pet 实证（document.body React root + client.inject）。
- ✅ 队列/steer 协议实测：临时线程拒绝队列（`-32600`）；持久线程 queue/add+auto-drain、queue/list/update/delete/reorder/start、`turn/steer` 全部通过。
- ✅ 图片透传实测：`localImage` 被 app-server 接受并转为 `input_image` base64；dsh `session.prompt` 图片原生支持（子代理续聊被拒 `SUBAGENT_IMAGE_UNSUPPORTED`，网关不走该路径）。
- ✅ C3 持久绑定实测：持久线程 JSONL 落盘 `~/.codex/sessions/...`，`thread/resume {threadId}` 原生支持重启恢复。
