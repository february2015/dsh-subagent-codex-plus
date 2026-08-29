/**
 * Vision bridge (R4): raster images are described by a small vision model
 * (`glm-5.3-flash` via the ocgo gateway by default) and the structured
 * description is injected as text alongside the image, so Codex's own model
 * — which may lack vision — still understands what the image shows.
 *
 * The endpoint/apiKey default to the ocgo provider already configured in
 * `~/.codex/config.toml` (`[model_providers.ocgw]`), so no extra secrets need
 * to live in the dsh plugin config.
 *
 * @module dsh-subagent-codex-plus/gateway/vision
 */
import { readFileSync } from 'node:fs';
const DEFAULT_TIMEOUT_MS = 30_000;
/** Prompt asking for a terse, structured, transferable description. */
const DESCRIBE_PROMPT = '请用中文描述这张图片：先一句话概括，再分条列出画面内容、可见文字、' +
    '布局结构、以及任何对理解任务重要的细节。不要猜测图片之外的信息。';
const MEDIA_EXT = {
    'image/png': '.png',
    'image/jpeg': '.jpg',
    'image/webp': '.webp',
    'image/gif': '.gif',
};
/** Map a dsh media type to a file extension (falls back to `.img`). */
export function mediaTypeExt(mediaType) {
    return MEDIA_EXT[mediaType] ?? '.img';
}
/**
 * Thin OpenAI-compatible vision client. Uses only built-in `fetch`, so the
 * gateway core stays dependency-free.
 */
export class VisionBridge {
    config;
    constructor(config) {
        this.config = config;
    }
    /** Model name used for descriptions (R4 status display). */
    get model() {
        return this.config.model;
    }
    /** Describe one raster image; resolves to the assistant's text reply. */
    async describe(data, mediaType) {
        const base64 = Buffer.from(data).toString('base64');
        const body = {
            model: this.config.model,
            messages: [
                {
                    role: 'user',
                    content: [
                        { type: 'text', text: DESCRIBE_PROMPT },
                        { type: 'image_url', image_url: { url: `data:${mediaType};base64,${base64}` } },
                    ],
                },
            ],
            max_tokens: 900,
            temperature: 0.2,
        };
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), this.config.timeoutMs ?? DEFAULT_TIMEOUT_MS);
        let response;
        try {
            response = await fetch(`${this.config.endpoint.replace(/\/$/, '')}/chat/completions`, {
                method: 'POST',
                headers: {
                    'content-type': 'application/json',
                    authorization: `Bearer ${this.config.apiKey}`,
                },
                body: JSON.stringify(body),
                signal: controller.signal,
            });
        }
        finally {
            clearTimeout(timer);
        }
        if (!response.ok) {
            const detail = await response.text().catch(() => '');
            throw new Error(`vision: ${this.config.model} returned ${response.status}: ${detail.slice(0, 300)}`);
        }
        const payload = await response.json();
        const text = payload.choices?.[0]?.message?.content;
        if (typeof text !== 'string' || text.length === 0) {
            throw new Error(`vision: ${this.config.model} returned an empty description`);
        }
        return text.trim();
    }
}
/**
 * Parse the ocgo vision route out of a Codex `config.toml` (TOML-lite: the
 * section is keyed plainly, values are double-quoted strings).
 * @param tomlPath - path to `~/.codex/config.toml`.
 * @returns the ocgo route, or undefined when the provider is missing.
 */
export function readOcgoVisionConfig(tomlPath) {
    let source;
    try {
        source = readFileSync(tomlPath, 'utf8');
    }
    catch {
        return undefined;
    }
    const section = /\[model_providers\.ocgw\]\s*\n([^[]*)/.exec(source);
    if (section === null)
        return undefined;
    const read = (key) => {
        const match = new RegExp(`^\\s*${key}\\s*=\\s*"([^"]*)"`, 'm').exec(section[1]);
        return match?.[1];
    };
    const endpoint = read('base_url');
    const apiKey = read('experimental_bearer_token');
    if (endpoint === undefined || apiKey === undefined)
        return undefined;
    return {
        endpoint,
        apiKey,
        model: 'glm-5.3-flash',
    };
}
