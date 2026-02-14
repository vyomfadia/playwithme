import { CONFIG } from './config'
import type { SyncRequest, SyncResponse } from './protocol'
import { encodeMessage, MessageType, now } from './protocol'

export interface SyncState {
  offset: number
  roundTripTime: number
  drift: number
  samples: SyncSample[]
  lastSyncTime: number
  isSynced: boolean
}

interface SyncSample {
  offset: number
  rtt: number
  timestamp: number
}

export function createSyncState(): SyncState {
  return {
    offset: 0,
    roundTripTime: 0,
    drift: 0,
    samples: [],
    lastSyncTime: 0,
    isSynced: false,
  }
}

export function createSyncRequest(): { message: Uint8Array; t1: number } {
  const t1 = now()
  const request: SyncRequest = { type: MessageType.SYNC_REQUEST, t1 }
  return { message: encodeMessage(request), t1 }
}

export function processSyncRequest(request: SyncRequest): Uint8Array {
  const t2 = now()
  const response: SyncResponse = {
    type: MessageType.SYNC_RESPONSE,
    t1: request.t1,
    t2,
    t3: now(),
  }
  return encodeMessage(response)
}

export function processSyncResponse(response: SyncResponse, state: SyncState): SyncState {
  const t4 = now()
  const { t1, t2, t3 } = response

  const rtt = t4 - t1 - (t3 - t2)
  const offset = (t2 - t1 + (t3 - t4)) / 2

  const sample: SyncSample = { offset, rtt, timestamp: now() }
  const samples = [...state.samples, sample].slice(-CONFIG.syncSamples)

  return {
    offset: calculateWeightedOffset(samples),
    roundTripTime: rtt,
    drift: calculateDrift(samples),
    samples,
    lastSyncTime: now(),
    isSynced: true,
  }
}

function calculateWeightedOffset(samples: SyncSample[]): number {
  if (samples.length === 0) return 0
  const firstSample = samples[0]
  if (samples.length === 1 && firstSample) return firstSample.offset
  if (samples.length === 1) return 0

  let totalWeight = 0
  let weightedSum = 0

  for (const sample of samples) {
    const weight = 1 / Math.max(sample.rtt, 0.1)
    totalWeight += weight
    weightedSum += sample.offset * weight
  }

  return weightedSum / totalWeight
}

function calculateDrift(samples: SyncSample[]): number {
  if (samples.length < 2) return 0

  const n = samples.length
  let sumX = 0,
    sumY = 0,
    sumXY = 0,
    sumX2 = 0

  for (const sample of samples) {
    const x = sample.timestamp
    const y = sample.offset
    sumX += x
    sumY += y
    sumXY += x * y
    sumX2 += x * x
  }

  const slope = (n * sumXY - sumX * sumY) / (n * sumX2 - sumX * sumX)
  return slope * 1000
}

export function toServerTime(localTime: number, state: SyncState): number {
  return localTime + state.offset
}

export function toLocalTime(serverTime: number, state: SyncState): number {
  return serverTime - state.offset
}

export function getPlayTime(
  chunkServerTimestamp: number,
  state: SyncState,
  bufferMs: number = CONFIG.targetBufferMs,
): number {
  return toLocalTime(chunkServerTimestamp, state) + bufferMs
}

export function needsResync(state: SyncState): boolean {
  if (!state.isSynced) return true
  return now() - state.lastSyncTime > CONFIG.syncIntervalMs
}

export function formatSyncState(state: SyncState): string {
  if (!state.isSynced) return 'not synced'
  return `offset=${state.offset.toFixed(2)}ms rtt=${state.roundTripTime.toFixed(2)}ms drift=${state.drift.toFixed(4)}ms/s`
}
