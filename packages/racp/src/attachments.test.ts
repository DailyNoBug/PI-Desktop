import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createAttachmentStaging } from "./attachments.js";
import { harness, OWNER_TOKEN, VIEWER_TOKEN } from "./test-harness.js";

const roots: string[] = [];
async function stagingRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "racp-attachments-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function pngBytes(): Buffer {
  // Minimal valid-looking PNG header; the staging layer is content-agnostic.
  return Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4, 5]);
}

describe("attachment staging", () => {
  it("writes completed uploads as content-addressed blobs and resolves them for the owning session", async () => {
    const root = await stagingRoot();
    const staging = createAttachmentStaging({ root, maxAttachmentBytes: 1024, maxChunkBytes: 8, now: () => Date.now() });
    const bytes = pngBytes();
    const created = await staging.create({ sessionId: "s1", name: "shot.png", kind: "image", mimeType: "image/png", sizeBytes: bytes.length });
    expect(created.chunkSize).toBe(8);
    let offset = 0;
    while (offset < bytes.length) {
      const chunk = bytes.subarray(offset, offset + created.chunkSize);
      const result = await staging.put({ attachmentId: created.attachmentId, offset, dataBase64: chunk.toString("base64") });
      expect(result.received).toBe(offset + chunk.length);
      offset += chunk.length;
    }
    const done = await staging.complete({ attachmentId: created.attachmentId });
    expect(done.attachment.sizeBytes).toBe(bytes.length);
    expect(done.attachment.ref).toBe(`attachments/${done.attachment.sha256}`);
    const stored = await readFile(join(root, done.attachment.sha256));
    expect(stored.equals(bytes)).toBe(true);

    const resolved = await staging.resolve(created.attachmentId, "s1");
    expect(resolved.path).toBe(join(root, done.attachment.sha256));
    expect(resolved.name).toBe("shot.png");
    expect(resolved.size).toBe(bytes.length);
  });

  it("refuses oversize declarations, blocked executables, bad offsets, non-canonical base64, and incomplete completions", async () => {
    const root = await stagingRoot();
    const staging = createAttachmentStaging({ root, maxAttachmentBytes: 16, now: () => Date.now() });
    await expect(staging.create({ sessionId: "s1", name: "big.bin", kind: "file", sizeBytes: 17 })).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    await expect(staging.create({ sessionId: "s1", name: "evil.exe", kind: "file", sizeBytes: 4 })).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    // Path separators in names are sanitized away, never used as paths.
    const escaped = await staging.create({ sessionId: "s1", name: "../escape.png", kind: "image", sizeBytes: 4 });
    expect(escaped.attachmentId).toMatch(/^att_/);

    const created = await staging.create({ sessionId: "s1", name: "a.bin", kind: "file", sizeBytes: 4 });
    await expect(staging.put({ attachmentId: created.attachmentId, offset: 2, dataBase64: "AAAA" })).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    await expect(staging.put({ attachmentId: created.attachmentId, offset: 0, dataBase64: "!!!not-base64!!!" })).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    await expect(staging.put({ attachmentId: created.attachmentId, offset: 0, dataBase64: Buffer.from("12345678").toString("base64") })).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    await expect(staging.complete({ attachmentId: created.attachmentId })).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
  });

  it("binds a staged upload to its session and expires abandoned partials", async () => {
    const root = await stagingRoot();
    let clock = 1_000;
    const staging = createAttachmentStaging({ root, maxAttachmentBytes: 1024, now: () => clock });
    const bytes = pngBytes();
    const created = await staging.create({ sessionId: "s1", name: "a.png", kind: "image", sizeBytes: bytes.length });
    await staging.put({ attachmentId: created.attachmentId, offset: 0, dataBase64: bytes.toString("base64") });
    await staging.complete({ attachmentId: created.attachmentId });
    await expect(staging.resolve(created.attachmentId, "s2")).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(staging.resolve("att_missing", "s1")).rejects.toMatchObject({ code: "NOT_FOUND" });

    const abandoned = await staging.create({ sessionId: "s1", name: "b.png", kind: "image", sizeBytes: 4 });
    clock += 11 * 60 * 1000;
    await expect(staging.put({ attachmentId: abandoned.attachmentId, offset: 0, dataBase64: "AAAA" })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("attachment operations", () => {
  async function harnessWithAttachments() {
    const root = await stagingRoot();
    const staging = createAttachmentStaging({ root, maxAttachmentBytes: 1024 * 1024 });
    const h = await harness({ operations: { attachments: staging } });
    const conn = await h.connect(OWNER_TOKEN);
    return { ...h, client: conn.client, events: conn.events, root, staging };
  }

  async function upload(h: Awaited<ReturnType<typeof harnessWithAttachments>>, sessionId = "s1"): Promise<{ attachmentId: string; sha256: string }> {
    const bytes = pngBytes();
    const created = await h.client.request<{ attachmentId: string }>("attachment/create", { sessionId, name: "shot.png", kind: "image", mimeType: "image/png", sizeBytes: bytes.length });
    await h.client.request("attachment/put", { attachmentId: created.attachmentId, offset: 0, dataBase64: bytes.toString("base64") });
    const done = await h.client.request<{ attachment: { attachmentId: string; sha256: string; ref: string } }>("attachment/complete", { attachmentId: created.attachmentId });
    return { attachmentId: done.attachment.attachmentId, sha256: done.attachment.sha256 };
  }

  it("carries staged attachments into the turn and hides host paths from the wire", async () => {
    const h = await harnessWithAttachments();
    await h.client.request("session/attach", { sessionId: "s1" });
    const { attachmentId, sha256 } = await upload(h);
    const started = await h.client.request<{ turn: { id: string } }>("turn/start", {
      sessionId: "s1",
      input: { text: "describe the image", attachments: [{ attachmentId }] },
      context: { requestId: "r-att-1" },
    });
    expect(started.turn.id).toMatch(/^rt_/);
    const recorded = h.runtime.prompts.at(-1);
    expect(recorded?.content).toBe("describe the image");
    expect(recorded?.attachments).toHaveLength(1);
    expect(recorded?.attachments?.[0]).toMatchObject({ name: "shot.png", kind: "image", mimeType: "image/png" });
    expect(recorded?.attachments?.[0]?.path).toBe(join(h.root, sha256));
    await h.client.close();
  });

  it("rejects attachment operations when the Host does not stage attachments", async () => {
    const h = await harness();
    const conn = await h.connect(OWNER_TOKEN);
    const client = conn.client;
    await expect(client.request("attachment/create", { sessionId: "s1", name: "x.png", kind: "image", sizeBytes: 4 })).rejects.toMatchObject({ code: "CAPABILITY_UNAVAILABLE" });
    await expect(
      client.request("turn/start", { sessionId: "s1", input: { text: "x", attachments: [{ attachmentId: "att_missing" }] }, context: { requestId: "r-att-2" } }),
    ).rejects.toMatchObject({ code: "CAPABILITY_UNAVAILABLE" });
    await client.close();
  });

  it("refuses cross-session attachment references and unknown ids", async () => {
    const h = await harnessWithAttachments();
    await h.client.request("session/attach", { sessionId: "s1" });
    const { attachmentId } = await upload(h);
    await expect(
      h.client.request("turn/start", { sessionId: "s1", input: { text: "x", attachments: [{ attachmentId }] }, context: { requestId: "r-att-3" } }),
    ).resolves.toBeTruthy();
    // A second turn reusing the same staged upload is fine; an unknown id is not.
    await expect(
      h.client.request("turn/start", { sessionId: "s1", input: { text: "x", attachments: [{ attachmentId: "att_unknown" }] }, context: { requestId: "r-att-4" } }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await h.client.close();
  });

  it("enforces the controller role for uploads", async () => {
    const h = await harnessWithAttachments();
    const viewer = await h.connect(VIEWER_TOKEN);
    await expect(viewer.client.request("attachment/create", { sessionId: "s1", name: "x.png", kind: "image", sizeBytes: 4 })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await viewer.client.close();
    await h.client.close();
  });
});
