/**
 * Pure PCM helpers for local dictation. The renderer captures raw float
 * samples and ships 16-bit PCM to the local-voice plugin; these helpers are
 * side-effect-free so the conversion pipeline is directly unit-testable.
 */

/** The dictation pipeline's fixed wire sample rate (matches shared contract). */
export const PCM_TARGET_SAMPLE_RATE = 16_000;

/** Convert float samples in [-1, 1] to little-endian 16-bit PCM bytes. */
export function float32ToInt16Bytes(samples: Float32Array): Uint8Array {
  const out = new Uint8Array(samples.length * 2);
  const view = new DataView(out.buffer);
  for (let i = 0; i < samples.length; i += 1) {
    const clamped = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(i * 2, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true);
  }
  return out;
}

/** Root mean square of the samples — the cheap "did anyone speak" gate. */
export function rms(samples: Float32Array): number {
  if (samples.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < samples.length; i += 1) {
    sum += samples[i] * samples[i];
  }
  return Math.sqrt(sum / samples.length);
}

/** Concatenate captured chunks into one buffer. */
export function concatFloat32(chunks: Float32Array[], totalLength?: number): Float32Array {
  const length = totalLength ?? chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const out = new Float32Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    if (offset >= length) break;
    const copy = Math.min(chunk.length, length - offset);
    out.set(copy === chunk.length ? chunk : chunk.subarray(0, copy), offset);
    offset += copy;
  }
  return out;
}

/**
 * Linear-interpolation resample to `targetRate`. Good enough for speech
 * capture (the browser already band-limits mic input at the device rate).
 */
export function resampleLinear(
  samples: Float32Array,
  sourceRate: number,
  targetRate: number,
): Float32Array {
  if (sourceRate === targetRate || samples.length === 0) return samples;
  const ratio = sourceRate / targetRate;
  const outLength = Math.max(1, Math.floor(samples.length / ratio));
  const out = new Float32Array(outLength);
  for (let i = 0; i < outLength; i += 1) {
    const position = i * ratio;
    const index = Math.floor(position);
    const fraction = position - index;
    const a = samples[index];
    const b = index + 1 < samples.length ? samples[index + 1] : a;
    out[i] = a + (b - a) * fraction;
  }
  return out;
}
