export const CONFIG = {
  sampleRate: 48000,
  channels: 2,
  bitDepth: 16,

  chunkDurationMs: 20,

  get samplesPerChunk() {
    return Math.floor((this.sampleRate * this.chunkDurationMs) / 1000)
  },
  get bytesPerChunk() {
    return this.samplesPerChunk * this.channels * (this.bitDepth / 8)
  },

  defaultPort: 8765,

  syncIntervalMs: 1000,
  syncSamples: 5,
  targetBufferMs: 60,
  minBufferMs: 30,
  maxBufferMs: 200,
  maxDriftMs: 5,
  driftCorrectionSamples: 1,
} as const

export type Config = typeof CONFIG
