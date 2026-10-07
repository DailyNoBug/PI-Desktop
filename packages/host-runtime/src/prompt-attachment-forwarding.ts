/**
 * Headless prompt-attachment forwarding.
 *
 * The desktop main process prepares renderer attachments through
 * `prompt-attachments.ts`; a headless Host receives already-staged uploads
 * from the RACP bridge instead. This module mirrors the desktop contract:
 * validated host-side blob paths become durable `MessageAttachment` rows,
 * vision-capable images are inlined as base64 for the model, and everything
 * else is appended to the prompt text as a readable path the agent may open.
 */
import { readFile, stat } from "node:fs/promises";
import { basename, join, resolve } from "node:path";

import { formatFileInsert, MAX_INLINE_IMAGE_BYTES, type MessageAttachment } from "@pi-desktop/shared";
import type { AgentPromptAttachment } from "@pi-desktop/shared";
import type { RuntimePromptAttachment } from "@pi-desktop/agent-runtime";

import { ErrorCodes } from "@pi-desktop/shared";

export type PreparedHeadlessAttachment = {
  /** Durable rows for the persisted user message. */
  messages: MessageAttachment[];
  /** Inline image payloads for the sidecar prompt (vision-capable only). */
  sidecar: RuntimePromptAttachment[];
  /** Fallback text appended to the prompt for everything not inlined. */
  contentSuffix: string;
};

function typedError(message: string, errorCode: string): Error {
  return Object.assign(new Error(message), { errorCode });
}

/**
 * Resolve staged RACP uploads for a headless turn. Every path must be an
 * absolute file under the Host attachments dir (`<dataDir>/attachments`),
 * which is where the RACP staging writes content-addressed blobs — remote
 * callers never supply readable paths themselves.
 */
export async function prepareHeadlessAttachments(
  attachments: readonly AgentPromptAttachment[],
  attachmentsDir: string | undefined,
  supportsVision: boolean,
): Promise<PreparedHeadlessAttachment> {
  const messages: MessageAttachment[] = [];
  const sidecar: RuntimePromptAttachment[] = [];
  const fallbacks: string[] = [];
  if (!attachments.length) return { messages, sidecar, contentSuffix: "" };
  if (!attachmentsDir) {
    throw typedError("Prompt attachments are not supported by this Host", ErrorCodes.INVALID_ARGUMENT);
  }
  const root = resolve(attachmentsDir);
  for (const attachment of attachments) {
    const rawPath = String(attachment.path ?? "").trim();
    if (!rawPath) throw typedError("Attachment path is required", ErrorCodes.INVALID_ARGUMENT);
    const absolute = resolve(rawPath);
    if (absolute !== root && !absolute.startsWith(root.endsWith("/") ? root : `${root}/`)) {
      throw typedError("Attachment path is outside the Host attachments area", ErrorCodes.PATH_OUTSIDE_WORKSPACE);
    }
    let size: number | undefined;
    try {
      size = (await stat(absolute)).size;
    } catch {
      throw typedError(`Attachment is not available on the Host: ${basename(absolute)}`, ErrorCodes.NOT_FOUND);
    }
    const blobName = basename(absolute);
    const isContentAddressed = /^[0-9a-f]{64}$/i.test(blobName);
    const ref = isContentAddressed ? `attachments/${blobName}` : absolute;
    const message: MessageAttachment = {
      kind: attachment.kind,
      name: attachment.name,
      ref,
      ...(attachment.mimeType ? { mimeType: attachment.mimeType } : {}),
      ...(attachment.size !== undefined || size !== undefined ? { size: attachment.size ?? size } : {}),
    };
    messages.push(message);
    const inline =
      attachment.kind === "image" &&
      supportsVision &&
      size <= MAX_INLINE_IMAGE_BYTES;
    if (inline) {
      const bytes = await readFile(absolute);
      sidecar.push({
        path: ref,
        name: attachment.name,
        kind: "image",
        ...(attachment.mimeType ? { mimeType: attachment.mimeType } : {}),
        size,
        data: bytes.toString("base64"),
      });
    } else {
      // The model reaches the file through its tools, so give it the absolute
      // host path; `ref` alone is only meaningful to the transcript.
      fallbacks.push(formatFileInsert(absolute, "file"));
    }
  }
  return { messages, sidecar, contentSuffix: fallbacks.join("").trim() };
}
