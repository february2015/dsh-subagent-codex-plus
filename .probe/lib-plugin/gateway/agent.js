/**
 * dsh `Agent` contract implemented as a thin forwarder to a durable
 * `CodexGateway`. The dsh host constructs the gateway (attach flow) and
 * supplies the live session/inbox/context association at registration.
 *
 * Semantics follow the verified app-server behavior:
 * - followup -> `turn/start` when idle, `thread/queue/add` when busy;
 * - steer -> `turn/steer` (or a fresh turn when idle);
 * - inject -> buffered and merged as leading text into the next submission;
 * - cancel -> best-effort `turn/interrupt` (thread/process stay alive).
 *
 * Intermediate Codex output is projected into the dsh session log as
 * log-only events (R1-A1, A2) via {@link GatewayEventForwarder}.
 *
 * @module dsh-subagent-codex-plus/gateway/agent
 */
import { CodexGateway } from "./gateway.js";
import { DEFAULT_EVENT_FORWARDER_OPTIONS, GatewayEventForwarder, } from "./events.js";
/**
 * Project one dsh user message onto gateway input blocks. Text blocks pass
 * through; image/attachment blocks are deferred to the image-passthrough
 * step (Q3/R4) and fail loudly until then.
 */
export function gatewayInputs(message) {
    const inputs = [];
    for (const block of message.content) {
        if (block.type === 'text') {
            inputs.push({ type: 'text', text: block.text, text_elements: [] });
            continue;
        }
        throw new Error('gateway: image/attachment passthrough not wired yet (Q3/R4 step)');
    }
    if (inputs.length === 0) {
        throw new Error('gateway: user message carried no text content');
    }
    return inputs;
}
/** Forwarder agent driving one Codex thread for one dsh session. */
export class GatewayAgent {
    host;
    gateway;
    agentOptions;
    id;
    options;
    session;
    inbox;
    ctx;
    pendingInject = [];
    idleResolvers = new Set();
    maintenanceSignal;
    constructor(host, gateway, agentOptions = {}) {
        this.host = host;
        this.gateway = gateway;
        this.agentOptions = agentOptions;
        this.id = host.id;
        this.options = host.options;
        this.session = host.session;
        this.inbox = host.inbox;
        this.ctx = host.ctx ?? undefined;
        void this.inbox;
        this.gateway.on('turn', () => this.reconcileIdle());
        const forwarder = new GatewayEventForwarder(this.session, {
            ...(this.agentOptions.eventForwarder ?? DEFAULT_EVENT_FORWARDER_OPTIONS),
            onError: (message) => this.report(new Error(message)),
        });
        this.gateway.on('notification', (notification) => forwarder.forward(notification));
    }
    get status() {
        return this.gateway.turnState === 'running' ? 'running' : 'idle';
    }
    send(message, target, wakeup) {
        if (wakeup) {
            this.followup(message);
        }
        else {
            this.inject(message);
        }
    }
    followup(message) {
        this.dispatch('followup', message);
    }
    steer(message) {
        this.dispatch('steer', message);
    }
    inject(message) {
        for (const block of message.content) {
            if (block.type === 'text')
                this.pendingInject.push(block.text);
        }
    }
    /** Bind the agent-scoped context after construction (attach wiring). */
    bindCtx(ctx) {
        this.ctx = ctx;
    }
    cancel(cause, options) {
        this.gateway.cancel();
        this.maintenanceSignal?.dispatchEvent(new Event('abort'));
        if (options?.keepInbox !== true) {
            this.pendingInject = [];
        }
    }
    whenIdle() {
        if (this.status === 'idle')
            return Promise.resolve();
        return new Promise((resolve) => {
            this.idleResolvers.add(resolve);
        });
    }
    runMaintenance(task) {
        if (this.maintenanceSignal !== undefined) {
            return Promise.reject(new Error('gateway: maintenance task already running'));
        }
        const controller = new AbortController();
        this.maintenanceSignal = controller.signal;
        const done = task(controller.signal);
        done.finally(() => {
            this.maintenanceSignal = undefined;
        });
        return done;
    }
    dispatch(kind, message) {
        let inputs;
        try {
            const injected = this.pendingInject;
            this.pendingInject = [];
            const blocks = gatewayInputs(message);
            inputs = injected.length === 0
                ? blocks
                : [
                    ...injected.map((text) => ({ type: 'text', text, text_elements: [] })),
                    ...blocks,
                ];
        }
        catch (error) {
            this.report(error);
            return;
        }
        // Mirror the loop agent's durable inbox recording so the dsh UI and log
        // show the user's prompt even though no dsh model processes it.
        try {
            this.inbox.append(kind === 'steer' ? 'next-step' : 'next-turn', message);
        }
        catch (error) {
            this.report(error);
            return;
        }
        void this.route(kind, inputs).catch((error) => this.report(error));
    }
    async route(kind, inputs) {
        if (this.gateway.phase !== 'ready') {
            throw new Error(`gateway: agent not attached (phase ${this.gateway.phase})`);
        }
        if (kind === 'steer') {
            await this.gateway.steer(inputs);
        }
        else {
            await this.gateway.submit(inputs);
        }
    }
    report(error) {
        const message = error instanceof Error ? error.message : String(error);
        this.ctx?.logger?.warn?.(`[gateway] ${message}`);
    }
    reconcileIdle() {
        if (this.status !== 'idle')
            return;
        for (const resolve of this.idleResolvers)
            resolve();
        this.idleResolvers.clear();
    }
}
