import { type FileSink, type Subprocess, spawn } from 'bun'
import { CONFIG } from './config'

export interface AudioDevice {
  index: number
  name: string
  isInput: boolean
  isOutput: boolean
}

export async function listAudioDevices(): Promise<AudioDevice[]> {
  const proc = spawn({
    cmd: ['ffmpeg', '-f', 'avfoundation', '-list_devices', 'true', '-i', ''],
    stderr: 'pipe',
    stdout: 'pipe',
  })

  const stderr = await new Response(proc.stderr).text()
  await proc.exited

  const devices: AudioDevice[] = []
  const lines = stderr.split('\n')
  let isAudioSection = false

  for (const line of lines) {
    if (line.includes('AVFoundation audio devices:')) {
      isAudioSection = true
      continue
    }

    if (isAudioSection) {
      const match = line.match(/\[(\d+)\]\s+(.+)$/)
      if (match?.[1] && match[2]) {
        devices.push({
          index: parseInt(match[1], 10),
          name: match[2].trim(),
          isInput: true,
          isOutput: false,
        })
      }

      if (
        line.includes('AVFoundation video devices:') ||
        (line.trim() === '' && devices.length > 0)
      ) {
        break
      }
    }
  }

  return devices
}

export async function listOutputDevices(): Promise<AudioDevice[]> {
  const proc = spawn({
    cmd: ['system_profiler', 'SPAudioDataType', '-json'],
    stdout: 'pipe',
    stderr: 'pipe',
  })

  const stdout = await new Response(proc.stdout).text()
  await proc.exited

  const devices: AudioDevice[] = []

  try {
    const data = JSON.parse(stdout)
    const audioData = data.SPAudioDataType || []

    let index = 0
    for (const section of audioData) {
      const items = section._items || []
      for (const item of items) {
        // Check if device has output channels
        const outputChannels = item.coreaudio_output_source
        if (outputChannels || item._name) {
          devices.push({
            index: index++,
            name: item._name || 'Unknown Device',
            isInput: false,
            isOutput: true,
          })
        }
      }
    }
  } catch {
    // Fallback: try sox --info or just return empty
    console.error('failed to parse audio devices')
  }

  return devices
}

export async function findDevice(name: string): Promise<AudioDevice | null> {
  const devices = await listAudioDevices()
  const lowerName = name.toLowerCase()
  return devices.find((d) => d.name.toLowerCase().includes(lowerName)) || null
}

export interface AudioCapture {
  process: Subprocess
  stream: ReadableStream<Uint8Array>
  stop: () => void
}

export function startCapture(deviceName: string): AudioCapture {
  const args = [
    '-hide_banner',
    '-loglevel',
    'error',
    '-f',
    'avfoundation',
    '-i',
    `:${deviceName}`,
    '-f',
    's16le',
    '-ar',
    CONFIG.sampleRate.toString(),
    '-ac',
    CONFIG.channels.toString(),
    'pipe:1',
  ]

  const proc = spawn({
    cmd: ['ffmpeg', ...args],
    stdout: 'pipe',
    stderr: 'pipe',
  })

  ;(async () => {
    const stderr = await new Response(proc.stderr).text()
    if (stderr.trim()) {
      console.error('ffmpeg:', stderr)
    }
  })()

  return {
    process: proc,
    stream: proc.stdout as ReadableStream<Uint8Array>,
    stop: () => proc.kill(),
  }
}

export interface AudioPlayback {
  process: Subprocess
  stdin: FileSink
  write: (data: Uint8Array) => Promise<void>
  stop: () => void
}

export function startPlayback(outputDevice?: string): AudioPlayback {
  const bufferSamples = Math.floor(CONFIG.sampleRate * 0.1)
  const args = [
    '-q', // quiet mode - suppress progress
    '-t',
    'raw',
    '-r',
    CONFIG.sampleRate.toString(),
    '-c',
    CONFIG.channels.toString(),
    '-b',
    CONFIG.bitDepth.toString(),
    '-e',
    'signed-integer',
    '--buffer',
    bufferSamples.toString(),
    '-',
    '-d',
  ]

  const env = outputDevice ? { ...process.env, AUDIODEV: outputDevice } : undefined
  const proc = spawn({
    cmd: ['play', ...args],
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
    env,
  })

  ;(async () => {
    const stderr = await new Response(proc.stderr).text()
    if (stderr.trim() && !stderr.includes('sox WARN')) {
      console.error('sox:', stderr)
    }
  })()

  const stdin = proc.stdin as FileSink
  let bytesWritten = 0
  const flushThreshold = Math.floor(CONFIG.sampleRate * CONFIG.channels * (CONFIG.bitDepth / 8) * 0.1)

  return {
    process: proc,
    stdin,
    write: async (data: Uint8Array) => {
      stdin.write(data)
      bytesWritten += data.length
      if (bytesWritten >= flushThreshold) {
        await stdin.flush()
        bytesWritten = 0
      }
    },
    stop: () => {
      stdin.flush()
      stdin.end()
      proc.kill()
    },
  }
}

export function startPlaybackFFplay(): AudioPlayback {
  const args = [
    '-hide_banner',
    '-loglevel',
    'error',
    '-fflags',
    'nobuffer',
    '-flags',
    'low_delay',
    '-probesize',
    '32',
    '-analyzeduration',
    '0',
    '-f',
    's16le',
    '-ar',
    CONFIG.sampleRate.toString(),
    '-ac',
    CONFIG.channels.toString(),
    '-i',
    'pipe:0',
    '-nodisp',
    '-autoexit',
  ]

  const proc = spawn({
    cmd: ['ffplay', ...args],
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  })

  const stdin = proc.stdin as FileSink

  return {
    process: proc,
    stdin,
    write: async (data: Uint8Array) => {
      stdin.write(data)
      await stdin.flush()
    },
    stop: () => {
      stdin.end()
      proc.kill()
    },
  }
}

export async function* chunkStream(
  stream: ReadableStream<Uint8Array>,
  chunkSize: number,
): AsyncGenerator<Uint8Array> {
  const reader = stream.getReader()
  let buffer = new Uint8Array(0)

  try {
    while (true) {
      const { done, value } = await reader.read()

      if (done) {
        if (buffer.length > 0) yield buffer
        break
      }

      const newBuffer = new Uint8Array(buffer.length + value.length)
      newBuffer.set(buffer)
      newBuffer.set(value, buffer.length)
      buffer = newBuffer

      while (buffer.length >= chunkSize) {
        yield buffer.slice(0, chunkSize)
        buffer = buffer.slice(chunkSize)
      }
    }
  } finally {
    reader.releaseLock()
  }
}
