---
description: "Fork 自官方 @deepseek-ai/dsh-subagent-codex：保留官方 one-shot Codex 委派，并新增真网关直连、排队/插入连续对话、中间过程实时透出与图片透传（视觉兜底归 OCGW 体系）。"
kind: "package-bundle"
---

# dsh-subagent-codex-plus

[English](README.md) | 中文

**本插件基于官方 `@deepseek-ai/dsh-subagent-codex` 插件 fork 而来**。它完整保留官方 one-shot Codex 委派能力，并在此基础上叠加扩展，让 **Codex 在 DeepSeek Harness（dsh）里成为一等公民**：连续对话、中间过程实时可见，以及"真网关"直连模式——dsh 只在你和 Codex 会话之间搬运数据，不经过任何大模型。

## 功能

### 1. 真网关直连（核心功能）

一条本地指令把你的**当前 dsh 对话 1:1 绑定到一个持久的 Codex 线程**，此后你在 dsh 输入框里的一切输入输出都直达 Codex——**dsh 中间不跑任何模型，只做搬运**。

- `/codex-lock`：绑定当前会话到持久 Codex 线程。
- `/codex-unlock`：解除绑定，恢复普通 dsh 智能体回路；Codex 线程保留，可随时重新绑定。
- **绑定持久化**：关机/重启 dsh 后，重新进入该会话自动重连同一个 Codex 线程（自动处理连接竞争），无需人工干预。
- 一个 Codex 线程只能被一个 dsh 会话绑定。

### 2. 连续对话：排队 + 直接插入

- Codex 忙时，新消息自动**排队**，当前轮结束后依次执行。
- 悬浮窗可以把某条消息**直接插入**（优先于排队消息立即执行）。
- 队列完全可控：查看、取消、改序、编辑。

### 3. 中间过程实时透出

Codex 的执行过程（推理摘要、消息增量、工具调用、状态事件）以近实时方式显示在 dsh 会话里，不只是最终答案。默认仅作日志展示，不进入 dsh 模型上下文。

### 4. 状态显示

绑定后，会话标题栏显示 `CDX-xxxx` 徽标（彩色状态点 + 前四位线程 id），composer 下方显示"Codex 直连 · …"状态条；**未绑定的会话不显示**，保持界面干净。

### 5. 图片/附件透传

可直接粘贴/上传图片，原样交给 Codex 处理（Codex 自身模型有视觉能力时直接看图）。图片理解兜底由 TeamAI skill `ocgw-vision` 处理。

### 6. 委派式与网关式并存

同一个 dsh 对话可以同时挂多个 one-shot 委派的 Codex 子会话（模型触发），并至多一个用户直连的网关会话；按需自由切换。

## 快速开始

### 安装

```sh
dsh plugin --profile <name> add /path/to/dsh-subagent-codex-plus
dsh --profile <name>
```

### 使用

1. 打开任意 dsh 会话（工作目录为你的项目）。
2. 输入 `/codex-lock`：绑定成功后标题栏出现 `CDX-xxxx` 徽标，此后输入直接进入 Codex。
3. Codex 忙时再发消息会自动排队；用悬浮窗可查看队列、插入/取消/改序。
4. `/codex-unlock` 解除直连；之后可随时重新绑定。

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

## 文档

- `IMPLEMENTATION.md` — 功能开发清单（实现细节）
- `REQUIREMENTS.md` — 需求定稿
- `TECH-VERIFICATION.md` — 技术验证报告（实现技术）
