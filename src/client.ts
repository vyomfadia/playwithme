import type { AudioPlayback } from './audio'
import { startPlayback } from './audio'
import { CONFIG } from './config'
import type { AudioChunk, ClientReady, Message, ServerInfo } from './protocol'
import { decodeMessage, encodeMessage, MessageType, now } from './protocol'
import type { SyncState } from './sync'
import {
  createSyncRequest,
  createSyncState,
  formatSyncState,
  needsResync,
  processSyncResponse,
  toLocalTime,
} from './sync'

interface BufferedChunk {
  chunk: AudioChunk
  playTime: number
}

interface ClientState {
  ws: WebSocket | null
  sync: SyncState
  buffer: BufferedChunk[]
  playback: AudioPlayback | null
  serverInfo: ServerInfo | null
  isConnected: boolean
  isPlaying: boolean
  lastSequence: number
  droppedChunks: number
  lateChunks: number
  pendingSyncT1: number | null
  outputDevice?: string
}

export interface ClientOptions {
  serverUrl: string
  outputDevice?: string
}

export async function startClient(options: ClientOptions): Promise<void> {
  const state: ClientState = {
    ws: null,
    sync: createSyncState(),
    buffer: [],
    playback: null,
    serverInfo: null,
    isConnected: false,
    isPlaying: false,
    lastSequence: -1,
    droppedChunks: 0,
    lateChunks: 0,
    pendingSyncT1: null,
    outputDevice: options.outputDevice,
  }

  console.log(`connecting to ${options.serverUrl}`)

  const ws = new WebSocket(options.serverUrl)
  ws.binaryType = 'arraybuffer'
  state.ws = ws

  ws.onopen = () => {
    console.log('connected')
    state.isConnected = true
    performSync(state)
    setInterval(() => {
      if (needsResync(state.sync)) performSync(state)
    }, CONFIG.syncIntervalMs)
  }

  ws.onmessage = (event) => {
    try {
      const data = event.data as ArrayBuffer
      handleMessage(decodeMessage(new Uint8Array(data)), state)
    } catch (err) {
      console.error('failed to handle message:', err)
    }
  }

  ws.onclose = () => {
    console.log('disconnected')
    state.isConnected = false
    cleanup(state)
  }

  ws.onerror = (error) => {
    console.error('websocket error:', error)
  }

  playbackLoop(state)
  await new Promise(() => {})
}

function handleMessage(message: Message, state: ClientState): void {
  switch (message.type) {
    case MessageType.SERVER_INFO:
      state.serverInfo = message as ServerInfo
      console.log(
        `server: ${message.sampleRate}hz ${message.channels}ch ${message.chunkDurationMs}ms chunks`,
      )
      break

    case MessageType.SYNC_RESPONSE:
      if (state.pendingSyncT1 !== null) {
        state.sync = processSyncResponse(message, state.sync)
        state.pendingSyncT1 = null
        console.log(`sync: ${formatSyncState(state.sync)}`)
        if (state.sync.isSynced && !state.isPlaying) {
          sendReady(state)
        }
      }
      break

    case MessageType.AUDIO_CHUNK:
      handleAudioChunk(message as AudioChunk, state)
      break

    default:
      console.log(`unknown message type: ${(message as any).type}`)
  }
}

function handleAudioChunk(chunk: AudioChunk, state: ClientState): void {
  if (!state.sync.isSynced) return

  if (state.lastSequence >= 0 && chunk.sequence !== state.lastSequence + 1) {
    const gap = chunk.sequence - state.lastSequence - 1
    if (gap > 0) {
      console.warn(`dropped ${gap} chunks (seq ${state.lastSequence + 1}-${chunk.sequence - 1})`)
      state.droppedChunks += gap
    }
  }
  state.lastSequence = chunk.sequence

  const playTime = toLocalTime(chunk.timestamp, state.sync) + CONFIG.targetBufferMs
  const currentTime = now()

  if (playTime < currentTime) {
    state.lateChunks++
    if (state.lateChunks % 100 === 1) {
      console.warn(
        `late chunk (${(currentTime - playTime).toFixed(1)}ms), total: ${state.lateChunks}`,
      )
    }
    return
  }

  insertSorted(state.buffer, { chunk, playTime })

  while (state.buffer.length > 0) {
    const lastChunk = state.buffer[state.buffer.length - 1]
    const firstChunk = state.buffer[0]
    if (!lastChunk || !firstChunk) break
    if (lastChunk.playTime - firstChunk.playTime <= CONFIG.maxBufferMs) break
    state.buffer.shift()
    state.droppedChunks++
  }
}

function insertSorted(buffer: BufferedChunk[], item: BufferedChunk): void {
  let low = 0
  let high = buffer.length

  while (low < high) {
    const mid = (low + high) >>> 1
    const midItem = buffer[mid]
    if (midItem && midItem.playTime < item.playTime) {
      low = mid + 1
    } else {
      high = mid
    }
  }

  buffer.splice(low, 0, item)
}

function performSync(state: ClientState): void {
  if (!state.ws || state.ws.readyState !== WebSocket.OPEN) return
  const { message, t1 } = createSyncRequest()
  state.pendingSyncT1 = t1
  state.ws.send(message)
}

function sendReady(state: ClientState): void {
  if (!state.ws || state.ws.readyState !== WebSocket.OPEN) return
  const ready: ClientReady = { type: MessageType.CLIENT_READY, clientId: 'client' }
  state.ws.send(encodeMessage(ready))
  console.log('ready to receive audio')
}

async function playbackLoop(state: ClientState): Promise<void> {
  while (!state.sync.isSynced || state.buffer.length < 2) {
    await sleep(5)
  }

  console.log('starting playback' + (state.outputDevice ? ` on ${state.outputDevice}` : ''))
  state.playback = startPlayback(state.outputDevice)
  state.isPlaying = true

  let lastStatsTime = now()
  let chunksPlayed = 0

  const pollIntervalMs = Math.max(1, Math.floor(CONFIG.chunkDurationMs / 4))
  while (state.isConnected) {
    const currentTime = now()
    let chunksWritten = 0

    while (state.buffer.length > 0) {
      const firstChunk = state.buffer[0]
      if (!firstChunk || firstChunk.playTime > currentTime) break

      const shifted = state.buffer.shift()
      if (!shifted) break

      try {
        if (state.playback) {
          await state.playback.write(shifted.chunk.data)
          chunksPlayed++
          chunksWritten++
        }
      } catch (err) {
        console.error('failed to write audio:', err)
        break
      }
    }

    if (currentTime - lastStatsTime > 5000) {
      let bufferMs = 0
      if (state.buffer.length > 0) {
        const lastChunk = state.buffer[state.buffer.length - 1]
        const firstChunk = state.buffer[0]
        if (lastChunk && firstChunk) {
          bufferMs = lastChunk.playTime - firstChunk.playTime
        }
      }
      console.log(
        `stats: buffer=${state.buffer.length} (${bufferMs.toFixed(0)}ms) played=${chunksPlayed} dropped=${state.droppedChunks} late=${state.lateChunks}`,
      )
      console.log(`sync: ${formatSyncState(state.sync)}`)
      lastStatsTime = currentTime
    }

    await sleep(chunksWritten > 0 ? 1 : pollIntervalMs)
  }
}

function cleanup(state: ClientState): void {
  state.playback?.stop()
  state.ws?.close()
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
