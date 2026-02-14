#!/usr/bin/env bun
import { Command } from 'commander'
import { findDevice, listAudioDevices } from './audio'
import { startClient } from './client'
import { CONFIG } from './config'
import { startServer } from './server'

const program = new Command()

program.name('playme').description('multi-device audio sync').version('1.0.0')

program
  .command('server')
  .description('start as audio source')
  .option('-p, --port <port>', 'port', String(CONFIG.defaultPort))
  .option('-d, --device <name>', 'audio device', 'BlackHole 2ch')
  .action(async (options) => {
    const port = parseInt(options.port, 10)

    const device = await findDevice(options.device)
    if (!device) {
      console.error(`device not found: ${options.device}`)
      console.log('\navailable devices:')
      const devices = await listAudioDevices()
      for (const d of devices) {
        console.log(`  [${d.index}] ${d.name}`)
      }
      process.exit(1)
    }

    console.log(`using device: ${device.name}`)

    try {
      await startServer({ port, device: device.name })
    } catch (err) {
      console.error('server error:', err)
      process.exit(1)
    }
  })

program
  .command('client')
  .description('connect to server')
  .option('-s, --server <url>', 'server url', `ws://localhost:${CONFIG.defaultPort}`)
  .action(async (options) => {
    let serverUrl = options.server

    if (!serverUrl.startsWith('ws://') && !serverUrl.startsWith('wss://')) {
      serverUrl = `ws://${serverUrl}`
    }

    if (!serverUrl.match(/:\d+$/)) {
      serverUrl = `${serverUrl}:${CONFIG.defaultPort}`
    }

    try {
      await startClient({ serverUrl })
    } catch (err) {
      console.error('client error:', err)
      process.exit(1)
    }
  })

program
  .command('devices')
  .description('list audio devices')
  .action(async () => {
    console.log('audio devices:\n')
    const devices = await listAudioDevices()
    if (devices.length === 0) {
      console.log('no devices found')
      return
    }

    for (const device of devices) {
      console.log(`  [${device.index}] ${device.name}`)
    }
  })

program
  .command('info')
  .description('show config')
  .action(() => {
    console.log('audio:')
    console.log(`  sample rate: ${CONFIG.sampleRate} hz`)
    console.log(`  channels: ${CONFIG.channels}`)
    console.log(`  bit depth: ${CONFIG.bitDepth}`)
    console.log(`  chunk: ${CONFIG.chunkDurationMs}ms (${CONFIG.bytesPerChunk} bytes)`)
    console.log('')
    console.log('sync:')
    console.log(`  interval: ${CONFIG.syncIntervalMs}ms`)
    console.log(`  samples: ${CONFIG.syncSamples}`)
    console.log('')
    console.log('buffer:')
    console.log(`  target: ${CONFIG.targetBufferMs}ms`)
    console.log(`  min: ${CONFIG.minBufferMs}ms`)
    console.log(`  max: ${CONFIG.maxBufferMs}ms`)
    console.log('')
    console.log('drift:')
    console.log(`  max: ${CONFIG.maxDriftMs}ms`)
  })

program.parse()
