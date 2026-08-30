---
description: "Forked from the official @deepseek-ai/dsh-subagent-codex: keeps the official one-shot Codex delegation and adds a true-gateway direct connection, queued/steered continuous conversation, live intermediate output, and image passthrough (vision fallback owned by the OCGW gateway system)."
kind: "package-bundle"
---

# dsh-subagent-codex-plus

English | [中文](README.zh.md)

**This plugin is forked from the official `@deepseek-ai/dsh-subagent-codex` plugin**. It keeps the official one-shot Codex delegation exactly as upstream ships it, and layers a set of extensions on top so that **Codex becomes a first-class citizen inside DeepSeek Harness (dsh)**: continuous conversation, live intermediate output, and a true-gateway mode where dsh only relays bytes between you and a Codex session — no model runs in between.

## Features

### 1. True-gateway direct connection (core)

One local command binds your **current dsh conversation 1:1 to a durable Codex thread**; from then on everything you type in the dsh composer goes straight to Codex — **dsh runs no model in between, it only relays**.

- `/codex-lock` binds the session to a persistent Codex thread.
- `/codex-unlock` unbinds and restores the normal dsh agent loop; the Codex thread is kept and can be rebound anytime.
- **Durable binding**: after shutting down / restarting dsh, reopening the session auto-reconnects the same Codex thread (connection contention handled automatically), no manual step needed.
- One Codex thread can be bound to only one dsh session.

### 2. Continuous conversation: queue + direct insert

- While Codex is busy, new messages are **queued** automatically and run in order when the current turn ends.
- The floating panel can **insert** a message directly (it runs ahead of queued messages on the next turn).
- The queue is fully manageable: view, cancel, reorder, edit.

### 3. Live intermediate output

Codex's execution progress (reasoning summaries, message deltas, tool calls, status events) shows up in the dsh session in near real time — not just the final answer. By default it is display-only and never enters the dsh model context.

### 4. Status display

Once bound, the session header shows a `CDX-xxxx` badge (colored status dot + first 4 thread id chars) and the composer dock shows a "Codex 直连 · …" status line. **Unbound sessions show nothing**, keeping the UI clean.

### 5. Image / attachment passthrough

Paste or upload images and hand them to Codex as-is (Codex's own model can see them when it has vision). Vision fallback is handled by the TeamAI skill `ocgw-vision`.

### 6. Delegation and gateway coexist

One dsh conversation can hold multiple one-shot delegated Codex runs (model-triggered) **and** at most one user-attached gateway session, switching freely between them.

## Quick start

### Install

```sh
dsh plugin --profile <name> add /path/to/dsh-subagent-codex-plus
dsh --profile <name>
```

### Usage

1. Open any dsh session (cwd is your project).
2. Type `/codex-lock`: after binding succeeds the header shows a `CDX-xxxx` badge, and input goes straight to Codex.
3. While Codex is busy, further messages queue automatically; use the floating panel to view/insert/cancel/reorder.
4. `/codex-unlock` disconnects; the Codex thread is kept and can be rebound anytime.

### Delegation (official baseline, unchanged)

```yaml
# dsh profile settings
- id: tool-subagent-codex
  name: '@deepseek-ai/dsh-tool-subagent'
  config:
    provider: codex-plus
    toolName: subagent_codex
    backgroundMode: one-shot
```

## Docs

- `IMPLEMENTATION.md` — feature checklist (implementation details)
- `REQUIREMENTS.md` — requirements spec
- `TECH-VERIFICATION.md` — technical verification report (implementation technology)
