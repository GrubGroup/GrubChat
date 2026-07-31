// AudioWorklet mic capture for the voice session.
//
// PLAIN .js ON PURPOSE — do NOT rename to .ts. `AudioWorkletProcessor` /
// `registerProcessor` / `sampleRate` are AudioWorklet-global names that are NOT in
// TypeScript's DOM lib (they live in @types/audioworklet). Because public/ is
// outside tsconfig.app.json's `include: ["src"]`, a .js file here is never
// type-checked and never breaks `tsc -b`; authoring it as .ts would.
//
// It runs in the AudioWorkletGlobalScope on the audio render thread. The capture
// AudioContext is created at { sampleRate: 16000 } so the BROWSER does the
// resampling to Flux's rate — this processor only reframes and quantizes:
//   * accumulate the 128-sample render quanta into 1280-sample (80 ms @ 16 kHz)
//     frames — Deepgram's recommended chunk size;
//   * convert float32 [-1,1] → int16 linear16 (what Flux expects);
//   * transfer the ArrayBuffer to the main thread (zero-copy) as `audio`;
//   * post a coarse RMS level as `rms` so the UI can draw a REAL waveform instead
//     of a hardcoded bar array.
//
// linear16 @ 16 kHz mono is the exact upstream encoding stt.py declares
// (DEFAULT_ENCODING="linear16", DEFAULT_SAMPLE_RATE=16000).

const FRAME_SAMPLES = 1280; // 80 ms at 16 kHz

class PCMRecorder extends AudioWorkletProcessor {
  constructor() {
    super();
    // Rolling accumulator: fill to FRAME_SAMPLES, flush, repeat. A render quantum
    // is 128 samples and 1280 % 128 === 0, so frames never straddle awkwardly, but
    // we handle the general case anyway.
    this._buf = new Float32Array(FRAME_SAMPLES);
    this._n = 0;
  }

  process(inputs) {
    // inputs[0] = first input; [0] = first (mono) channel. Absent when the graph
    // hasn't delivered audio yet — keep the processor alive.
    const channel = inputs[0] && inputs[0][0];
    if (!channel) return true;

    for (let i = 0; i < channel.length; i++) {
      this._buf[this._n++] = channel[i];
      if (this._n === FRAME_SAMPLES) {
        this._flush();
        this._n = 0;
      }
    }
    return true; // keep processing (never auto-terminate the node)
  }

  _flush() {
    // float32 [-1,1] -> int16 little-endian. Clamp before scaling so a hot mic
    // can't wrap around into noise.
    const pcm = new Int16Array(FRAME_SAMPLES);
    let sumSq = 0;
    for (let i = 0; i < FRAME_SAMPLES; i++) {
      let s = this._buf[i];
      if (s > 1) s = 1;
      else if (s < -1) s = -1;
      pcm[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
      sumSq += s * s;
    }
    const rms = Math.sqrt(sumSq / FRAME_SAMPLES);
    // Transfer the underlying buffer (zero-copy) — after this the worklet no longer
    // owns `pcm.buffer`, which is fine since we allocate a fresh one each frame.
    this.port.postMessage({ audio: pcm.buffer, rms }, [pcm.buffer]);
  }
}

registerProcessor('pcm-recorder', PCMRecorder);
