import assert from "node:assert/strict";
import test from "node:test";
import { register } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
register(pathToFileURL(join(here, "helpers/ts-import-hooks.mjs")));

const { float32ToInt16Bytes, rms, concatFloat32, resampleLinear } = await import(
  "../src/features/voice/pcm.ts"
);

test("float32ToInt16Bytes round-trips clamped samples little-endian", () => {
  const bytes = float32ToInt16Bytes(new Float32Array([0, 0.5, -0.5, 1.5, -1.5]));
  assert.equal(bytes.byteLength, 10);
  const view = new DataView(bytes.buffer);
  assert.equal(view.getInt16(0, true), 0);
  assert.ok(Math.abs(view.getInt16(2, true) - 16384) <= 1);
  assert.ok(Math.abs(view.getInt16(4, true) + 16384) <= 1);
  assert.equal(view.getInt16(6, true), 32767);
  assert.equal(view.getInt16(8, true), -32768);
});

test("rms measures loudness and is zero on silence", () => {
  assert.equal(rms(new Float32Array(100)), 0);
  const sine = new Float32Array(160);
  for (let i = 0; i < sine.length; i += 1) sine[i] = Math.sin((2 * Math.PI * i) / 160);
  assert.ok(rms(sine) > 0.5 && rms(sine) <= 0.75);
});

test("concatFloat32 joins chunks up to the optional total length", () => {
  const joined = concatFloat32([new Float32Array([1, 2]), new Float32Array([3, 4, 5])]);
  assert.deepEqual([...joined], [1, 2, 3, 4, 5]);
  const clipped = concatFloat32([new Float32Array([1, 2]), new Float32Array([3, 4, 5])], 3);
  assert.deepEqual([...clipped], [1, 2, 3]);
});

test("resampleLinear keeps the rate and downsamples by the ratio", () => {
  const identity = new Float32Array([0, 0.25, -0.5]);
  assert.equal(resampleLinear(identity, 16000, 16000), identity);
  const source = new Float32Array(48000);
  for (let i = 0; i < source.length; i += 1) source[i] = Math.sin((2 * Math.PI * 220 * i) / 48000);
  const down = resampleLinear(source, 48000, 16000);
  assert.equal(down.length, 16000);
  assert.ok(rms(down) > 0.5);
});
