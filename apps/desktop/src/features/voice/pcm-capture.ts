/**
 * Microphone capture for local dictation: raw float frames from an
 * AudioWorklet (ScriptProcessor fallback), concatenated and resampled to the
 * 16 kHz mono PCM contract on stop. Audio lives only in memory.
 */
import { PCM_TARGET_SAMPLE_RATE, concatFloat32, resampleLinear } from "./pcm";

export type PcmCapture = {
  /** Device/context rate the frames were captured at. */
  readonly sourceSampleRate: number;
  /** Stop capturing and resolve with speech-rate mono PCM. */
  stop(): Promise<{ samples: Float32Array; sampleRate: number }>;
  /** Drop the graph without producing audio. */
  abort(): void;
};

export type PcmCaptureFactory = (stream: MediaStream) => Promise<PcmCapture>;

const WORKLET_SOURCE = `
class PcmTapProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (channel) this.port.postMessage(channel.slice(0));
    return true;
  }
}
registerProcessor("pcm-tap", PcmTapProcessor);
`;

async function createWorkletCapture(
  context: AudioContext,
  stream: MediaStream,
): Promise<{ node: AudioWorkletNode; chunks: Float32Array[] }> {
  const blob = new Blob([WORKLET_SOURCE], { type: "application/javascript" });
  const url = URL.createObjectURL(blob);
  try {
    await context.audioWorklet.addModule(url);
  } finally {
    URL.revokeObjectURL(url);
  }
  const node = new AudioWorkletNode(context, "pcm-tap");
  const chunks: Float32Array[] = [];
  node.port.onmessage = (event: MessageEvent<Float32Array>) => {
    chunks.push(event.data);
  };
  const source = context.createMediaStreamSource(stream);
  source.connect(node);
  // The worklet is a sink; do not connect it to destination (no monitoring
  // loopback — that would echo into the user's speakers).
  return { node, chunks };
}

function createScriptProcessorCapture(
  context: AudioContext,
  stream: MediaStream,
): { node: ScriptProcessorNode; chunks: Float32Array[] } {
  const node = context.createScriptProcessor(4096, 1, 1);
  const chunks: Float32Array[] = [];
  node.onaudioprocess = (event: AudioProcessingEvent) => {
    chunks.push(event.inputBuffer.getChannelData(0).slice(0));
  };
  const source = context.createMediaStreamSource(stream);
  source.connect(node);
  node.connect(context.destination);
  return { node, chunks };
}

export const createPcmCapture: PcmCaptureFactory = async (stream: MediaStream) => {
  const AudioContextCtor =
    globalThis.AudioContext ??
    (globalThis as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AudioContextCtor) {
    throw Object.assign(new Error("Web Audio is unavailable"), { name: "NotSupportedError" });
  }
  const context = new AudioContextCtor();
  await context.resume().catch(() => undefined);
  let graph: { node: AudioWorkletNode | ScriptProcessorNode; chunks: Float32Array[] };
  try {
    graph = await createWorkletCapture(context, stream);
  } catch {
    graph = createScriptProcessorCapture(context, stream);
  }
  const teardown = () => {
    try {
      graph.node.disconnect();
    } catch {
      // graph already torn down
    }
    stream.getTracks().forEach((track) => track.stop());
    void context.close().catch(() => undefined);
  };
  return {
    sourceSampleRate: context.sampleRate,
    async stop() {
      teardown();
      const samples = resampleLinear(
        concatFloat32(graph.chunks),
        context.sampleRate,
        PCM_TARGET_SAMPLE_RATE,
      );
      return { samples, sampleRate: PCM_TARGET_SAMPLE_RATE };
    },
    abort() {
      teardown();
      graph.chunks.length = 0;
    },
  };
};
