import type { AudioCapture } from './audio'
import { chunkStream, startCapture } from './audio'
import { CONFIG } from './config'
import type { AudioChunk, Message, ServerInfo, SyncRequest } from './protocol'
import { decodeMessage, encodeMessage, MessageType, now } from './protocol'
import { processSyncRequest } from './sync'

interface Client {
  id: string
  ws: ServerWebSocket<ClientData>
  isReady: boolean
}

interface ClientData {
  id: string
}

interface ServerState {
  clients: Map<string, Client>
  capture: AudioCapture | null
  sequence: number
  serverStartTime: number
  isRunning: boolean
}

export interface ServerOptions {
  port: number
  device: string
}

type ServerWebSocket<T> = {
  send(data: string | ArrayBuffer | Uint8Array): void
  close(): void
  data: T
}

export async function startServer(options: ServerOptions): Promise<void> {
  const state: ServerState = {
    clients: new Map(),
    capture: null,
    sequence: 0,
    serverStartTime: now(),
    isRunning: true,
  }

  console.log(`starting server on port ${options.port}`)
  console.log(`capturing from device: ${options.device}`)

  const server = Bun.serve<ClientData>({
    hostname: "0.0.0.0",
    port: options.port,

    fetch(req, server) {
      const clientId = crypto.randomUUID().slice(0, 8)
      if (server.upgrade(req, { data: { id: clientId } })) return
      return new Response('websocket upgrade required', { status: 426 })
    },

    websocket: {
      open(ws) {
        const clientId = ws.data.id
        console.log(`client connected: ${clientId}`)

        const client: Client = {
          id: clientId,
          ws: ws as unknown as ServerWebSocket<ClientData>,
          isReady: false,
        }

        state.clients.set(clientId, client)

        const serverInfo: ServerInfo = {
          type: MessageType.SERVER_INFO,
          sampleRate: CONFIG.sampleRate,
          channels: CONFIG.channels,
          bitDepth: CONFIG.bitDepth,
          chunkDurationMs: CONFIG.chunkDurationMs,
          serverStartTime: state.serverStartTime,
        }

        ws.send(encodeMessage(serverInfo))
      },

      message(ws, data) {
        try {
          const buffer =
            data instanceof ArrayBuffer
              ? data
              : typeof data === 'string'
                ? new TextEncoder().encode(data)
                : data
          const message = decodeMessage(buffer as Uint8Array)
          handleMessage(ws as unknown as ServerWebSocket<ClientData>, message, state)
        } catch (err) {
          console.error('failed to handle message:', err)
        }
      },

      close(ws) {
        console.log(`client disconnected: ${ws.data.id}`)
        state.clients.delete(ws.data.id)
      },
    },
  })

  console.log(`listening on ws://0.0.0.0:${server.port}`)

  try {
    state.capture = startCapture(options.device)
    console.log('audio capture started')
    await processAudioStream(state)
  } catch (err) {
    console.error('failed to start audio capture:', err)
    throw err
  }
}

function handleMessage(
  ws: ServerWebSocket<ClientData>,
  message: Message,
  state: ServerState,
): void {
  switch (message.type) {
    case MessageType.SYNC_REQUEST:
      ws.send(processSyncRequest(message as SyncRequest))
      break

    case MessageType.CLIENT_READY: {
      const client = state.clients.get(ws.data.id)
      if (client) {
        client.isReady = true
        console.log(`client ${ws.data.id} ready`)
      }
      break
    }

    default:
      console.log(`unknown message type: ${(message as any).type}`)
  }
}

async function processAudioStream(state: ServerState): Promise<void> {
  if (!state.capture) return

  const chunkSize = CONFIG.bytesPerChunk
  console.log(
    `streaming: ${CONFIG.sampleRate}hz ${CONFIG.channels}ch ${CONFIG.chunkDurationMs}ms chunks (${chunkSize} bytes)`,
  )

  try {
    for await (const pcmData of chunkStream(state.capture.stream, chunkSize)) {
      if (!state.isRunning) break

      const chunk: AudioChunk = {
        type: MessageType.AUDIO_CHUNK,
        timestamp: now(),
        sequence: state.sequence++,
        data: pcmData,
      }

      const encoded = encodeMessage(chunk)

      for (const client of state.clients.values()) {
        if (client.isReady) {
          try {
            client.ws.send(encoded)
          } catch (err) {
            console.error(`failed to send to client ${client.id}:`, err)
          }
        }
      }

      if (state.sequence % 500 === 0) {
        console.log(`streamed ${state.sequence} chunks to ${state.clients.size} clients`)
      }
    }
  } catch (err) {
    console.error('audio stream error:', err)
  } finally {
    state.capture?.stop()
    console.log('audio stream ended')
  }
}

export function stopServer(state: ServerState): void {
  state.isRunning = false
  state.capture?.stop()
  for (const client of state.clients.values()) {
    client.ws.close()
  }
  state.clients.clear()
}
