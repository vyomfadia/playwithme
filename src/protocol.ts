import { decode, encode } from '@msgpack/msgpack'

export enum MessageType {
  SYNC_REQUEST = 'sync_request',
  SYNC_RESPONSE = 'sync_response',
  AUDIO_CHUNK = 'audio_chunk',
  CLIENT_READY = 'client_ready',
  SERVER_INFO = 'server_info',
  ERROR = 'error',
}

export interface SyncRequest {
  type: MessageType.SYNC_REQUEST
  t1: number
}

export interface SyncResponse {
  type: MessageType.SYNC_RESPONSE
  t1: number
  t2: number
  t3: number
}

export interface AudioChunk {
  type: MessageType.AUDIO_CHUNK
  timestamp: number
  sequence: number
  data: Uint8Array
}

export interface ClientReady {
  type: MessageType.CLIENT_READY
  clientId: string
}

export interface ServerInfo {
  type: MessageType.SERVER_INFO
  sampleRate: number
  channels: number
  bitDepth: number
  chunkDurationMs: number
  serverStartTime: number
}

export interface ErrorMessage {
  type: MessageType.ERROR
  message: string
}

export type Message =
  | SyncRequest
  | SyncResponse
  | AudioChunk
  | ClientReady
  | ServerInfo
  | ErrorMessage

export function encodeMessage(message: Message): Uint8Array {
  return encode(message)
}

export function decodeMessage(data: Uint8Array | ArrayBuffer): Message {
  const buffer = data instanceof ArrayBuffer ? new Uint8Array(data) : data
  return decode(buffer) as Message
}

export function now(): number {
  return performance.now()
}

export function absoluteTime(): number {
  return Date.now()
}
