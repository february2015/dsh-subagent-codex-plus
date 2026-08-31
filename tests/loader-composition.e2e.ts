import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  LOADER_SMOKE_TEST_TIMEOUT_MS,
  runLoaderSmoke,
} from '@deepseek-ai/dsh-loader-smoke'

const fixtureDir = fileURLToPath(new URL(
  './fixtures/loader/',
  import.meta.url,
))
const driver = join(fixtureDir, 'driver.mjs')
const configPath = join(fixtureDir, 'cordis.yml')
const packageDir = fileURLToPath(new URL('..', import.meta.url))
const manifest = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8')) as {
  dsh?: { bundle?: { patch?: string } }
}
const bundlePatch = manifest.dsh?.bundle?.patch
if (bundlePatch === undefined) throw new Error('Codex package must declare a Bundle patch')
const bundlePatchPath = join(packageDir, bundlePatch)

describe('dsh-subagent-codex-plus public Loader composition', () => {
  it('loads the Bundle default, two named instances, their tools, and job controls without starting Codex', async () => {
    const { stdout, stderr } = await runLoaderSmoke({
      label: 'dsh-subagent-codex-plus Loader composition',
      tempDirPrefix: 'dsh-subagent-codex-plus-loader-',
      // 'lib' mode: plain Node running real package `exports` (as an installed
      // consumer does). 'src' mode would spawn `node --import tsx`, and tsx's
      // bundled register file ships a corrupted inline source map that trips
      // vitest-4's error-stack mapping.
      mode: 'lib',
      binScript: driver,
      libBinScript: driver,
      configPath,
      binArgs: [configPath, bundlePatchPath],
      env: {
        // Loading the optional package must not probe or start a Codex binary.
        PATH: '',
      },
    })

    expect(stderr).toBe('')
    expect(JSON.parse(stdout)).toEqual({
      providers: ['codex-plus', 'codex-primary', 'codex-secondary'],
      providerDetails: [
        {
          name: 'codex-plus',
          capabilities: {
            outputSchema: false,
            depthLimit: false,
            toolFilter: false,
            persona: false,
          },
          inheritsParentContext: false,
        },
        {
          name: 'codex-primary',
          capabilities: {
            outputSchema: false,
            depthLimit: false,
            toolFilter: false,
            persona: false,
          },
          inheritsParentContext: false,
        },
        {
          name: 'codex-secondary',
          capabilities: {
            outputSchema: false,
            depthLimit: false,
            toolFilter: false,
            persona: false,
          },
          inheritsParentContext: false,
        },
      ],
      tools: [
        {
          name: 'subagent_codex',
          parameterNames: ['description', 'prompt', 'run_in_background'],
          required: ['description', 'prompt'],
        },
        {
          name: 'subagent_codex_primary',
          parameterNames: ['description', 'prompt', 'run_in_background'],
          required: ['description', 'prompt'],
        },
        {
          name: 'subagent_codex_secondary',
          parameterNames: ['description', 'prompt', 'run_in_background'],
          required: ['description', 'prompt'],
        },
      ],
      jobTools: ['job_kill', 'job_list', 'job_output'],
      starts: 0,
    })
  }, LOADER_SMOKE_TEST_TIMEOUT_MS)
})