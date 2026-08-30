---
description: "Fork 自官方 @deepseek-ai/dsh-subagent-codex：保留官方 one-shot Codex 委派，并新增真网关直连、排队/插入连续对话、中间过程实时透出、图片透传与 GLM 视觉兜底。"
kind: "package-bundle"
---

# dsh-subagent-codex-plus

[English](README.md) | 中文

`dsh-subagent-codex-plus` 是**官方 `@deepseek-ai/dsh-subagent-codex` 插件的 fork**。它完整保留官方 one-shot Codex 委派能力，并在其上叠加扩展，让 **Codex 在 DeepSeek Harness（dsh）里成为一等公民**：连续对话、中间过程实时可见，以及"真网关"模式——dsh 只在你和 Codex 会话之间搬运数据，不经过任何大模型。

## 基于哪个官方插件

| | |
|---|---|
| 上游包 | [`@deepseek-ai/dsh-subagent-codex`](https://www.npmjs.com/package/@deepseek-ai/dsh-subagent-codex) |
| Fork 基线 | 上游 master TS 源码 `0.1.2-alpha.1`（与 dsh `0.1.1-rc.2` 同代） |
| 本 fork 改名 | 包 `dsh-subagent-codex-plus` · 插件 `subagent-codex-plus` · provider `codex-plus` |

上游机制（保持不变）：插件是可独立安装的 Profile Bundle。当 dsh 模型调用委派工具时，provider 在本地 spawn 一个真实的 Codex 子进程（`codex app-server --stdio`，stdio JSON-RPC——**不是 HTTP API，也不是 MCP**），在父会话的 cwd 下创建临时线程，跑一个自包含任务，返回选定的最终答案。Codex 鉴权保持原生（使用 Codex 自己的 `~/.codex` 配置与登录态）。

## 官方插件原本就有的能力（保留为基线）

- **one-shot 委派（R0）**——一次调用 = 一个全新 Codex 子进程 + 临时线程，按标准 subagent 结果契约返回最终答案。
- **Profile Bundle 安装**——默认休眠，绑定委派工具行后才生效；自带官方 wrapper 与平台载荷。
- **非交互权限模式**——`never` / `approve-for-me` / `dangerously-bypass-approvals-and-sandbox` 映射到线程的 approval/reviewer/sandbox 字段。
- **原生 Codex 配置与鉴权**保持权威。

以上官方能力在本 fork 中全部可用，并作为回退基线。

## 本 fork 新增的能力

### 1. 真网关直连（R3——核心功能）

一条本地指令把你的**当前 dsh 对话 1:1 绑定到一个持久的 Codex 线程**，此后你在 dsh 输入框里的一切输入都直达 Codex——**dsh 中间不跑任何模型，只做搬运**。

- `/codex-attach`：绑定当前会话到持久 Codex 线程（spawn `codex app-server --stdio`；重启后 `thread/resume` 恢复）。
- `/codex-detach`：解除绑定，恢复普通 dsh 智能体回路；Codex 线程保留，可随时重新 attach。
- 绑定持久化在 `$DSH_HOME/codex-plus-gateway.json`（`sessionId ↔ threadId`）；重新进入该 dsh 会话自动重连同一个 Codex 线程。若重启后旧 app-server 仍持有线程写锁，网关会按指数退避（1s→16s）自动重试直到连上。
- 双向唯一（Q4）：一个 Codex 线程只能被一个 dsh 会话绑定，重复绑定会被拒绝。

### 2. 连续对话：排队 + 直接插入（R2）

- Codex 忙时，新消息**排队**（FIFO `followup`，当前轮结束后自动依次执行）。
- 悬浮控制窗的 steer 输入**立即插入**：中断当前轮，消息作为下一轮立即执行。
- 队列完全可控：查看、取消、改序、更新。

### 3. 中间过程实时透出（R1）

Codex 的执行过程以近实时方式转发进 dsh 会话流：推理摘要、agent 消息增量、工具调用、状态事件。默认**仅作日志**——不进 dsh 模型上下文（省 token，不干扰模型）。

### 4. 状态用官方槽位 + 控制用悬浮窗（R2/B3）

- **状态显示**用官方槽位：`conversation.session.header` 直连徽标、`conversation.composer.dock` 状态条、`conversation.input.dock` 实时排队列表。
- **选择/控制**放在悬浮窗（dsh-pet 模式，`shell.overlay`）：队列操作、steer/插入、网关开关。

### 5. 图片/附件透传（Q3）

composer 附件透传为 Codex `localImage` 输入（本地路径/base64），可以直接贴截图让 Codex 看图干活。

### 6. 视觉兜底 Vision Bridge（R4）

当执行模型不支持视觉时，图片统一交给 `glm-5.3-flash`（经 ocgo 网关，OpenAI 兼容）生成结构化描述，描述文本随图片一起注入。该策略**在 Codex 内与 dsh 主对话内同样生效**——看图不再依赖目标模型自身的视觉能力。dsh 侧要求会话模型支持图片输入（如模型选择器里选 `GLM-5.3 Flash (OCGo)`）；随附的 `dsh-llm-deepseek` 已升级到 `0.1.1-rc.2`，`inputModalities` 原生保留。

### 7. 委派式与网关式并存（Q5）

同一个 dsh 对话可以同时挂多个 one-shot 委派的 Codex 子会话（模型触发），并至多一个用户直连的网关会话；按需自由切换。

## 快速开始

### 安装到 dsh profile

```sh
# 本地 link 安装（或任意已发布的 tarball/npm 包名）
dsh plugin --profile <name> add /path/to/dsh-subagent-codex-plus
dsh --profile <name>
```

profile 的 `package.json` 会写入 `"dsh-subagent-codex-plus": "link:<本仓库>"`；在本仓库执行 `npm run build` 重建后重启 profile 即生效。

### 使用网关

```sh
# 在 dsh 对话里输入
/codex-attach    # 把本会话绑定到一个新的持久 Codex 线程
/codex-detach    # 解除绑定；Codex 线程保留，可稍后重新 attach
```

会话头部出现直连徽标，composer 下方显示网关状态条，头部按钮可打开悬浮窗查看队列与 steer 控制。

### 委派（官方基线，用法不变）

```yaml
# dsh profile settings
- id: tool-subagent-codex
  name: '@deepseek-ai/dsh-tool-subagent'
  config:
    provider: codex-plus
    toolName: subagent_codex
    backgroundMode: one-shot
```

## 网关配置字段

| 字段 | 默认值 | 含义 |
|---|---|---|
| `gatewayEnabled` | `true` | 网关功能总开关 |
| `gatewayBindingFile` | `$DSH_HOME/codex-plus-gateway.json` | 1:1 绑定持久化存储（会话 ↔ 线程） |
| `gatewayApprovalPolicy` | — | 网关轮次的审批策略（Codex 原生模式） |
| `gatewayEventForwarding` | `true` | 把 Codex 中间事件转发进 dsh 会话流 |
| `gatewayAppendFinalMessage` | — | 把最终答复作为普通消息追加进 dsh 会话 |
| `gatewayVisionEnabled` | `true` | 开启 GLM 视觉兜底 |
| `gatewayVisionEndpoint` | ocgo 网关 | `https://ocgo.zlxy.sd.cn/v1` |
| `gatewayVisionApiKey` | — | 视觉端点密钥（与 `~/.codex/config.toml` 中的 `ocgo_…` 相同） |
| `gatewayVisionModel` | `glm-5.3-flash` | 图片描述用视觉模型 |

## 文档

- [`REQUIREMENTS.md`](REQUIREMENTS.md)——需求定稿（R0–R4、Q1–Q5；真网关 = V1 首发核心）。
- [`IMPLEMENTATION.md`](IMPLEMENTATION.md)——功能开发清单与逐项完成状态。
- [`TECH-VERIFICATION.md`](TECH-VERIFICATION.md)——已验证事实：协议探针、真机端到端、图片门禁与视觉兜底证据。

## 已知限制

- **one-shot 委派**仍是每次运行新建进程/线程（官方行为）；持续对话请走网关路径。
- **鉴权保持原生**——插件提供 CLI 但不负责登录、信任项目或改写 Codex 设置。
- **视觉兜底依赖 ocgo 网关**——默认端点/密钥为个人配置；不用 ocgo 时请把 `gatewayVisionEndpoint`/`gatewayVisionApiKey` 指向自己的网关。
- **字节级流式渲染（A1-b）**暂缓：中间事件按事件块粒度注入，近实时，非逐字节。
