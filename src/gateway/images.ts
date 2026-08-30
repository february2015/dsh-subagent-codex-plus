/**
 * Resolve dsh image blocks to Codex `localImage` inputs (Q3), optionally with
 * a vision description injected as text alongside the image (R4).
 *
 * dsh stores images as opaque content-addressed attachment refs; the resolver
 * reads the bytes through `ctx.attachments`, materializes them under a
 * per-gateway temp directory, and hands the local path to the app-server
 * (`localImage`, protocol-verified). When a vision describer is available
 * (the OCGW `ocgw-vision` service), the bytes are also described and the
 * description text is appended after the image input so Codex's model sees
 * both.
 *
 * @module dsh-subagent-codex-plus/gateway/images
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { GatewayLocalImageInput } from './wire.ts'

/**
 * Image description capability (R4). Provided by the OCGW gateway system:
 * `dsh-ocgw` registers it as the `ocgw-vision` service; this package only
 * consumes it. Absent the service, images pass through undescribed.
 */
export interface VisionDescriber {
  /** Model name used for descriptions (R4 status display). */
  readonly model: string
  /** Describe one raster image; resolves to the assistant's text reply. */
  describe(bytes: Uint8Array, mediaType: string): Promise<string>
}

const MEDIA_EXT: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
  'image/gif': '.gif',
}

/** Map a dsh media type to a file extension (falls back to `.img`). */
export function mediaTypeExt(mediaType: string): string {
  return MEDIA_EXT[mediaType] ?? '.img'
}

/** One resolved image: the Codex input block plus an optional vision text. */
export interface ResolvedImage {
  readonly input: GatewayLocalImageInput
  /** Vision description injected as a text block after the image (R4). */
  readonly description?: string
}

/** Materializes dsh attachment bytes into Codex-local image files. */
export class GatewayImageResolver {
  private dir: string | undefined
  private index = 0

  constructor(private readonly ctx: Context) {}

  /**
   * Read one attachment and stage it for the app-server.
   * @param attachment - durable ref from the dsh message block.
   * @param vision - optional vision describer; when present, describe the image.
   */
  async resolve(
    attachment: ImageAttachmentRef,
    vision?: VisionDescriber,
  ): Promise<ResolvedImage> {
    const attachments = this.ctx.get('attachments')
    if (attachments === undefined) {
      throw new Error('gateway: attachments service is not available; image passthrough disabled')
    }
    const stored = await attachments.readImage(attachment)
    const dir = await this.ensureDir()
    this.index += 1
    const id = String(attachment.attachmentId).slice(0, 12)
    const path = join(dir, `img-${this.index}-${id}${mediaTypeExt(attachment.mediaType)}`)
    await writeFile(path, stored.data)
    let description: string | undefined
    if (vision !== undefined) {
      try {
        description = await vision.describe(stored.data, attachment.mediaType)
      } catch (error) {
        // Vision belongs to the OCGW system; when it is unavailable the image
        // still passes through, just undescribed.
        this.ctx.logger?.warn?.(
          `[codex-plus] vision describe skipped (image passes through undescribed): ${String(error)}`,
        )
      }
    }
    return {
      input: { type: 'localImage', path },
      ...description === undefined ? {} : { description },
    }
  }

  /** Remove the staged image directory (idempotent). */
  async dispose(): Promise<void> {
    if (this.dir === undefined) return
    await rm(this.dir, { recursive: true, force: true })
    this.dir = undefined
  }

  private async ensureDir(): Promise<string> {
    if (this.dir !== undefined) return this.dir
    this.dir = await mkdtemp(join(tmpdir(), 'dsh-codex-plus-img-'))
    return this.dir
  }
}
