/**
 * Vision bridge smoke (R4): describes a known 1×1 red PNG via the real
 * glm-5.3-flash channel and asserts the description mentions red/maroon.
 * Skips (exit 0) when no ocgo route is configured in ~/.codex/config.toml.
 *
 * Run: node --experimental-transform-types docs/verification/vision-smoke.ts
 */
import { readFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { VisionBridge, readOcgoVisionConfig } from '../../src/gateway/vision.ts'

const RED_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

const config = readOcgoVisionConfig(join(homedir(), '.codex', 'config.toml'))
if (config === undefined) {
  console.log('[SKIP] no ocgo vision route in ~/.codex/config.toml')
  process.exit(0)
}
const bridge = new VisionBridge(config)
const data = Buffer.from(RED_PNG_BASE64, 'base64')
const description = await bridge.describe(data, 'image/png')
const red = /红|红|red|maroon|栗|褐|棕/i.test(description)
console.log(`[${red ? 'PASS' : 'FAIL'}] glm-5.3-flash described the red PNG (${description.slice(0, 60)}…)`)
process.exit(red ? 0 : 1)
