/**
 * Host-side staging for RACP prompt attachments (spec §6.4).
 *
 * Clients upload bytes through `attachment/create` → `attachment/put` →
 * `attachment/complete`; completed uploads land as content-addressed blobs
 * (`<sha256>`) under the Host's attachments dir — the same blob store the
 * desktop uses for pastes and uploads — so a later `turn/start` can hand the
 * runtime ordinary file references. The wire never sees host paths: clients
 * only ever hold attachment ids and the `attachments/<sha256>` ref.
 *
 * Security invariants:
 * - uploads are size-capped (`maxAttachmentBytes`) and chunk-sequential;
 * - names are metadata only: they are sanitized and never used as paths;
 * - executable binary extensions are refused at create time;
 * - `resolve` only returns paths for completed uploads of the SAME session;
 * - partial uploads expire without a completion (lazy reclamation).
 */
import { createHash, randomBytes } from "node:crypto";
import { open, mkdir, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";

import {
  RacpAttachmentCompleteParamsSchema,
  RacpAttachmentCreateParamsSchema,
  RacpAttachmentPutParamsSchema,
  type RacpAttachmentCreated,
  type RacpAttachmentPutResult,
  type RacpAttachmentRecord,
} from "@pi-desktop/shared";
import * as Value from "typebox/value";

import { RacpError } from "@pi-desktop/agent-host";

const DEFAULT_MAX_CHUNK_BYTES = 512 * 1024;
const PENDING_UPLOAD_TTL_MS = 10 * 60 * 1000;
const MAX_UPLOADS_IN_FLIGHT = 256;
const MAX_NAME_LENGTH = 200;

/** Binary formats that must not enter the agent's attachment surface. */
const BLOCKED_EXTENSIONS: readonly string[] = [
  ".exe", ".dll", ".msi", ".bat", ".cmd", ".com", ".scr", ".sys",
  ".dylib", ".so", ".drv", ".cpl", ".app", ".dmg", ".msix", ".apk",
];

function invalid(message: string): never {
  throw new RacpError("INVALID_ARGUMENT", message);
}

function sanitizeName(rawName: string): string {
  const name = rawName.replace(/[\\/]+/g, "_").replace(/[\u0000-\u001f\u007f]/g, "").trim();
  if (!name) invalid("attachment name is empty");
  if (name.length > MAX_NAME_LENGTH) invalid(`attachment name exceeds ${MAX_NAME_LENGTH} characters`);
  if (BLOCKED_EXTENSIONS.some((extension) => name.toLowerCase().endsWith(extension))) {
    invalid(`attachment type is not allowed: ${name}`);
  }
  return name;
}

function validMimeType(mimeType: string | undefined): string | undefined {
  if (mimeType === undefined) return undefined;
  if (!/^[a-zA-Z0-9][a-zA-Z0-9!#$&^_.+-]*\/[a-zA-Z0-9][a-zA-Z0-9!#$&^_.+-]*$/.test(mimeType)) {
    invalid(`attachment mimeType is not a valid media type: ${mimeType.slice(0, 60)}`);
  }
  return mimeType.toLowerCase();
}

type PendingUpload = {
  sessionId: string;
  name: string;
  kind: "image" | "file";
  mimeType?: string;
  sizeBytes: number;
  received: number;
  handle: Awaited<ReturnType<typeof open>>;
  hash: ReturnType<typeof createHash>;
  createdAt: number;
};

type CompletedUpload = {
  sessionId: string;
  record: RacpAttachmentRecord;
  /** Absolute host path of the content-addressed blob. */
  path: string;
  completedAt: number;
};

export type ResolvedAttachment = {
  path: string;
  ref: string;
  name: string;
  kind: "image" | "file";
  mimeType?: string;
  size: number;
};

export type AttachmentStagingOptions = {
  /** Host attachments dir; completed blobs land here as `<sha256>`. */
  root: string;
  maxAttachmentBytes: number;
  maxChunkBytes?: number;
  now?: () => number;
};

export type RacpAttachmentStaging = {
  create(input: unknown): Promise<RacpAttachmentCreated>;
  put(input: unknown): Promise<RacpAttachmentPutResult>;
  complete(input: unknown): Promise<{ attachment: RacpAttachmentRecord }>;
  /** Resolve a completed upload for `turn/start`; the session must match. */
  resolve(attachmentId: string, sessionId: string): Promise<ResolvedAttachment>;
};

export function createAttachmentStaging(options: AttachmentStagingOptions): RacpAttachmentStaging {
  const root = options.root;
  const maxChunkBytes = options.maxChunkBytes ?? DEFAULT_MAX_CHUNK_BYTES;
  const now = options.now ?? (() => Date.now());

  const pending = new Map<string, PendingUpload>();
  const completed = new Map<string, CompletedUpload>();

  function reclaim(nowMs: number): void {
    for (const [id, upload] of pending) {
      if (nowMs - upload.createdAt > PENDING_UPLOAD_TTL_MS) {
        void upload.handle.close().catch(() => undefined);
        void rm(join(root, `.upload-${id}.part`), { force: true }).catch(() => undefined);
        pending.delete(id);
      }
    }
    for (const [id, upload] of completed) {
      if (nowMs - upload.completedAt > PENDING_UPLOAD_TTL_MS) completed.delete(id);
    }
  }

  return {
    async create(rawInput: unknown): Promise<RacpAttachmentCreated> {
      if (!Value.Check(RacpAttachmentCreateParamsSchema, rawInput)) invalid("invalid attachment/create params");
      const input = rawInput as {
        sessionId: string;
        name: string;
        kind: "image" | "file";
        mimeType?: string;
        sizeBytes: number;
      };
      reclaim(now());
      if (pending.size + completed.size >= MAX_UPLOADS_IN_FLIGHT) {
        throw new RacpError("RATE_LIMITED", "too many attachment uploads in flight");
      }
      if (input.sizeBytes > options.maxAttachmentBytes) {
        invalid(`attachment exceeds maxAttachmentBytes (${options.maxAttachmentBytes})`);
      }
      const name = sanitizeName(input.name);
      const mimeType = validMimeType(input.mimeType);
      await mkdir(root, { recursive: true, mode: 0o700 });
      const attachmentId = `att_${randomBytes(12).toString("base64url")}`;
      const handle = await open(join(root, `.upload-${attachmentId}.part`), "w", 0o600);
      pending.set(attachmentId, {
        sessionId: input.sessionId,
        name,
        kind: input.kind,
        mimeType,
        sizeBytes: input.sizeBytes,
        received: 0,
        handle,
        hash: createHash("sha256"),
        createdAt: now(),
      });
      return { attachmentId, chunkSize: maxChunkBytes };
    },

    async put(rawInput: unknown): Promise<RacpAttachmentPutResult> {
      if (!Value.Check(RacpAttachmentPutParamsSchema, rawInput)) invalid("invalid attachment/put params");
      reclaim(now());
      const input = rawInput as { attachmentId: string; offset: number; dataBase64: string };
      const upload = pending.get(input.attachmentId);
      if (!upload) throw new RacpError("NOT_FOUND", `attachment upload ${input.attachmentId} is not open`);
      if (input.offset !== upload.received) {
        invalid(`attachment offset ${input.offset} does not match received ${upload.received}`);
      }
      let chunk: Buffer;
      try {
        chunk = Buffer.from(input.dataBase64, "base64");
      } catch {
        invalid("attachment chunk is not valid base64");
      }
      if (chunk.length === 0) invalid("attachment chunk is empty");
      // Strict base64: re-encoding must round-trip to the declared length.
      if (chunk.toString("base64").replace(/=+$/, "") !== input.dataBase64.replace(/=+$/, "")) {
        invalid("attachment chunk is not canonical base64");
      }
      if (upload.received + chunk.length > upload.sizeBytes) {
        invalid("attachment chunk exceeds the declared sizeBytes");
      }
      await upload.handle.write(chunk);
      upload.hash.update(chunk);
      upload.received += chunk.length;
      return { received: upload.received };
    },

    async complete(rawInput: unknown): Promise<{ attachment: RacpAttachmentRecord }> {
      if (!Value.Check(RacpAttachmentCompleteParamsSchema, rawInput)) invalid("invalid attachment/complete params");
      reclaim(now());
      const input = rawInput as { attachmentId: string };
      const upload = pending.get(input.attachmentId);
      if (!upload) throw new RacpError("NOT_FOUND", `attachment upload ${input.attachmentId} is not open`);
      if (upload.received !== upload.sizeBytes) {
        invalid(`attachment upload incomplete: ${upload.received}/${upload.sizeBytes} bytes`);
      }
      const sha256 = upload.hash.digest("hex");
      await upload.handle.close();
      pending.delete(input.attachmentId);
      const blobPath = join(root, sha256);
      const partPath = join(root, `.upload-${input.attachmentId}.part`);
      let exists = false;
      try {
        exists = (await stat(blobPath)).isFile();
      } catch {
        exists = false;
      }
      if (exists) {
        await rm(partPath, { force: true });
      } else {
        try {
          await rename(partPath, blobPath);
        } catch (error) {
          void rm(partPath, { force: true }).catch(() => undefined);
          throw error;
        }
      }
      const record: RacpAttachmentRecord = {
        attachmentId: input.attachmentId,
        name: upload.name,
        kind: upload.kind,
        ...(upload.mimeType ? { mimeType: upload.mimeType } : {}),
        sizeBytes: upload.received,
        sha256,
        ref: `attachments/${sha256}`,
      };
      completed.set(input.attachmentId, {
        sessionId: upload.sessionId,
        record,
        path: blobPath,
        completedAt: now(),
      });
      return { attachment: record };
    },

    async resolve(attachmentId: string, sessionId: string): Promise<ResolvedAttachment> {
      const upload = completed.get(attachmentId);
      if (!upload) throw new RacpError("NOT_FOUND", `attachment ${attachmentId} is not staged`);
      if (upload.sessionId !== sessionId) {
        throw new RacpError("FORBIDDEN", `attachment ${attachmentId} belongs to another session`);
      }
      return {
        path: upload.path,
        ref: upload.record.ref,
        name: upload.record.name,
        kind: upload.record.kind,
        ...(upload.record.mimeType ? { mimeType: upload.record.mimeType } : {}),
        size: upload.record.sizeBytes,
      };
    },
  };
}
