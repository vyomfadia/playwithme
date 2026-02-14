#!/usr/bin/env bun
/**
 * Web-based audio client
 * Serves an HTML page that connects via WebSocket and plays audio using Web Audio API
 */

import { CONFIG } from './config'

const HTML_PAGE = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>PlayMe Audio Client</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%);
      color: #fff;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .container {
      text-align: center;
      padding: 2rem;
      max-width: 500px;
    }
    h1 { margin-bottom: 1rem; font-size: 2rem; }
    .status {
      padding: 1rem;
      border-radius: 8px;
      margin: 1rem 0;
      font-size: 1.1rem;
    }
    .status.connecting { background: #2d3748; }
    .status.connected { background: #22543d; }
    .status.playing { background: #2b6cb0; }
    .status.error { background: #742a2a; }
    .meter-container {
      background: #2d3748;
      border-radius: 8px;
      padding: 1rem;
      margin: 1rem 0;
    }
    .meter {
      height: 20px;
      background: #1a202c;
      border-radius: 4px;
      overflow: hidden;
    }
    .meter-fill {
      height: 100%;
      background: linear-gradient(90deg, #48bb78, #38a169);
      width: 0%;
      transition: width 50ms;
    }
    .stats {
      font-family: monospace;
      font-size: 0.85rem;
      color: #a0aec0;
      text-align: left;
      background: #1a202c;
      padding: 1rem;
      border-radius: 8px;
      margin-top: 1rem;
    }
    button {
      background: #4299e1;
      color: white;
      border: none;
      padding: 1rem 2rem;
      font-size: 1.1rem;
      border-radius: 8px;
      cursor: pointer;
      margin: 1rem 0;
    }
    button:hover { background: #3182ce; }
    button:disabled { background: #4a5568; cursor: not-allowed; }
    .hidden { display: none; }
  </style>
</head>
<body>
  <div class="container">
    <h1>🎵 PlayMe</h1>
    
    <button id="startBtn" onclick="startAudio()">Start Listening</button>
    
    <div id="statusContainer" class="hidden">
      <div id="status" class="status connecting">Connecting...</div>
      
      <div class="meter-container">
        <div>Audio Level</div>
        <div class="meter">
          <div id="meterFill" class="meter-fill"></div>
        </div>
      </div>
      
      <div id="stats" class="stats">
        Buffer: 0 chunks<br>
        Played: 0<br>
        Dropped: 0<br>
        Late: 0
      </div>
    </div>
  </div>

  <script>
    const CONFIG = {
      sampleRate: ${CONFIG.sampleRate},
      channels: ${CONFIG.channels},
      bitDepth: ${CONFIG.bitDepth},
      chunkDurationMs: ${CONFIG.chunkDurationMs},
      targetBufferMs: ${CONFIG.targetBufferMs},
    };
    
    let audioContext = null;
    let ws = null;
    let isPlaying = false;
    let nextPlayTime = 0;
    let stats = { buffer: 0, played: 0, dropped: 0, late: 0 };
    let audioQueue = [];
    let syncState = { offset: 0, isSynced: false };
    
    function updateStatus(text, className) {
      const el = document.getElementById('status');
      el.textContent = text;
      el.className = 'status ' + className;
    }
    
    function updateStats() {
      document.getElementById('stats').innerHTML = 
        'Buffer: ' + audioQueue.length + ' chunks<br>' +
        'Played: ' + stats.played + '<br>' +
        'Dropped: ' + stats.dropped + '<br>' +
        'Late: ' + stats.late;
    }
    
    function updateMeter(level) {
      const percent = Math.max(0, Math.min(100, (level + 60) / 60 * 100));
      document.getElementById('meterFill').style.width = percent + '%';
    }
    
    // Convert Int16 PCM to Float32 for Web Audio
    function pcmToFloat32(pcmData) {
      const int16 = new Int16Array(pcmData.buffer, pcmData.byteOffset, pcmData.length / 2);
      const float32 = new Float32Array(int16.length);
      for (let i = 0; i < int16.length; i++) {
        float32[i] = int16[i] / 32768;
      }
      return float32;
    }
    
    // Deinterleave stereo to separate channels
    function deinterleave(float32, channels) {
      const samplesPerChannel = float32.length / channels;
      const result = [];
      for (let ch = 0; ch < channels; ch++) {
        result[ch] = new Float32Array(samplesPerChannel);
        for (let i = 0; i < samplesPerChannel; i++) {
          result[ch][i] = float32[i * channels + ch];
        }
      }
      return result;
    }
    
    // Calculate audio level in dB
    function calculateLevel(float32) {
      let sum = 0;
      for (let i = 0; i < float32.length; i++) {
        sum += float32[i] * float32[i];
      }
      const rms = Math.sqrt(sum / float32.length);
      return rms > 0 ? 20 * Math.log10(rms) : -60;
    }
    
    // MessagePack decoder (minimal implementation for our protocol)
    function decodeMsgPack(data) {
      const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
      let offset = 0;
      
      function read() {
        const byte = view.getUint8(offset++);
        
        // fixmap (0x80 - 0x8f)
        if ((byte & 0xf0) === 0x80) {
          const len = byte & 0x0f;
          const obj = {};
          for (let i = 0; i < len; i++) {
            const key = read();
            obj[key] = read();
          }
          return obj;
        }
        
        // map 16
        if (byte === 0xde) {
          const len = view.getUint16(offset); offset += 2;
          const obj = {};
          for (let i = 0; i < len; i++) {
            const key = read();
            obj[key] = read();
          }
          return obj;
        }
        
        // fixstr (0xa0 - 0xbf)
        if ((byte & 0xe0) === 0xa0) {
          const len = byte & 0x1f;
          const str = new TextDecoder().decode(data.subarray(offset, offset + len));
          offset += len;
          return str;
        }
        
        // str 8
        if (byte === 0xd9) {
          const len = view.getUint8(offset++);
          const str = new TextDecoder().decode(data.subarray(offset, offset + len));
          offset += len;
          return str;
        }
        
        // positive fixint (0x00 - 0x7f)
        if ((byte & 0x80) === 0) {
          return byte;
        }
        
        // uint 8
        if (byte === 0xcc) {
          return view.getUint8(offset++);
        }
        
        // uint 16
        if (byte === 0xcd) {
          const val = view.getUint16(offset); offset += 2;
          return val;
        }
        
        // uint 32
        if (byte === 0xce) {
          const val = view.getUint32(offset); offset += 4;
          return val;
        }
        
        // float 64
        if (byte === 0xcb) {
          const val = view.getFloat64(offset); offset += 8;
          return val;
        }
        
        // bin 8
        if (byte === 0xc4) {
          const len = view.getUint8(offset++);
          const bin = data.slice(offset, offset + len);
          offset += len;
          return bin;
        }
        
        // bin 16
        if (byte === 0xc5) {
          const len = view.getUint16(offset); offset += 2;
          const bin = data.slice(offset, offset + len);
          offset += len;
          return bin;
        }
        
        // bin 32
        if (byte === 0xc6) {
          const len = view.getUint32(offset); offset += 4;
          const bin = data.slice(offset, offset + len);
          offset += len;
          return bin;
        }
        
        // negative fixint (0xe0 - 0xff)
        if ((byte & 0xe0) === 0xe0) {
          return byte - 256;
        }
        
        console.warn('Unknown msgpack byte:', byte.toString(16));
        return null;
      }
      
      return read();
    }
    
    // MessagePack encoder (minimal)
    function encodeMsgPack(obj) {
      const parts = [];
      
      function encode(val) {
        if (typeof val === 'object' && val !== null) {
          const keys = Object.keys(val);
          if (keys.length < 16) {
            parts.push(0x80 | keys.length);
          } else {
            parts.push(0xde);
            parts.push((keys.length >> 8) & 0xff);
            parts.push(keys.length & 0xff);
          }
          for (const key of keys) {
            encode(key);
            encode(val[key]);
          }
        } else if (typeof val === 'string') {
          const bytes = new TextEncoder().encode(val);
          if (bytes.length < 32) {
            parts.push(0xa0 | bytes.length);
          } else {
            parts.push(0xd9);
            parts.push(bytes.length);
          }
          parts.push(...bytes);
        } else if (typeof val === 'number') {
          if (Number.isInteger(val) && val >= 0 && val < 128) {
            parts.push(val);
          } else {
            // float64
            parts.push(0xcb);
            const buf = new ArrayBuffer(8);
            new DataView(buf).setFloat64(0, val);
            parts.push(...new Uint8Array(buf));
          }
        }
      }
      
      encode(obj);
      return new Uint8Array(parts);
    }
    
    function now() {
      return performance.now();
    }
    
    function performSync() {
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      const msg = encodeMsgPack({ type: 1, t1: now() }); // SYNC_REQUEST = 1
      ws.send(msg);
    }
    
    function handleSyncResponse(msg) {
      const t4 = now();
      const { t1, t2, t3 } = msg;
      const rtt = t4 - t1 - (t3 - t2);
      const offset = (t2 - t1 + (t3 - t4)) / 2;
      syncState = { offset, rtt, isSynced: true };
      console.log('Synced: offset=' + offset.toFixed(2) + 'ms, rtt=' + rtt.toFixed(2) + 'ms');
      
      if (!isPlaying) {
        sendReady();
      }
    }
    
    function sendReady() {
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      const msg = encodeMsgPack({ type: 4, clientId: 'web-client' }); // CLIENT_READY = 4
      ws.send(msg);
      updateStatus('Receiving audio...', 'playing');
    }
    
    function toLocalTime(serverTime) {
      return serverTime - syncState.offset;
    }
    
    function scheduleAudio() {
      if (!audioContext || audioQueue.length === 0) return;
      
      const currentTime = audioContext.currentTime;
      const nowMs = now();
      
      // Initialize nextPlayTime if needed
      if (nextPlayTime < currentTime) {
        nextPlayTime = currentTime + 0.05; // 50ms initial buffer
      }
      
      // Schedule chunks that are ready
      while (audioQueue.length > 0) {
        const item = audioQueue[0];
        const localPlayTime = toLocalTime(item.timestamp) + CONFIG.targetBufferMs;
        
        // If chunk is too late, skip it
        if (localPlayTime < nowMs - 50) {
          audioQueue.shift();
          stats.late++;
          continue;
        }
        
        // If chunk isn't ready yet, stop scheduling
        if (localPlayTime > nowMs + 200) {
          break;
        }
        
        audioQueue.shift();
        
        // Convert PCM to audio buffer
        const float32 = pcmToFloat32(item.data);
        const channels = deinterleave(float32, CONFIG.channels);
        const samplesPerChannel = channels[0].length;
        
        const audioBuffer = audioContext.createBuffer(
          CONFIG.channels,
          samplesPerChannel,
          CONFIG.sampleRate
        );
        
        for (let ch = 0; ch < CONFIG.channels; ch++) {
          audioBuffer.copyToChannel(channels[ch], ch);
        }
        
        // Schedule playback
        const source = audioContext.createBufferSource();
        source.buffer = audioBuffer;
        source.connect(audioContext.destination);
        source.start(nextPlayTime);
        
        nextPlayTime += audioBuffer.duration;
        stats.played++;
        
        // Update level meter
        updateMeter(calculateLevel(float32));
      }
      
      updateStats();
    }
    
    function handleAudioChunk(msg) {
      if (!syncState.isSynced) return;
      
      audioQueue.push({
        timestamp: msg.timestamp,
        sequence: msg.sequence,
        data: msg.data
      });
      
      // Keep queue from growing too large
      while (audioQueue.length > 50) {
        audioQueue.shift();
        stats.dropped++;
      }
      
      scheduleAudio();
    }
    
    function handleMessage(data) {
      try {
        const msg = decodeMsgPack(new Uint8Array(data));
        if (!msg) return;
        
        switch (msg.type) {
          case 0: // SERVER_INFO
            console.log('Server info:', msg);
            break;
          case 2: // SYNC_RESPONSE
            handleSyncResponse(msg);
            break;
          case 3: // AUDIO_CHUNK
            handleAudioChunk(msg);
            break;
        }
      } catch (err) {
        console.error('Message error:', err);
      }
    }
    
    async function startAudio() {
      document.getElementById('startBtn').classList.add('hidden');
      document.getElementById('statusContainer').classList.remove('hidden');
      
      // Create audio context (requires user interaction)
      audioContext = new AudioContext({ sampleRate: CONFIG.sampleRate });
      
      // Get server URL from current page URL
      const wsProtocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
      const serverUrl = wsProtocol + '//' + location.hostname + ':${CONFIG.defaultPort}';
      
      updateStatus('Connecting to ' + serverUrl + '...', 'connecting');
      
      ws = new WebSocket(serverUrl);
      ws.binaryType = 'arraybuffer';
      
      ws.onopen = () => {
        updateStatus('Connected, syncing...', 'connected');
        performSync();
        setInterval(performSync, 5000);
      };
      
      ws.onmessage = (event) => {
        handleMessage(event.data);
      };
      
      ws.onclose = () => {
        updateStatus('Disconnected', 'error');
        isPlaying = false;
      };
      
      ws.onerror = (err) => {
        updateStatus('Connection error', 'error');
        console.error('WebSocket error:', err);
      };
      
      // Periodically schedule audio
      setInterval(scheduleAudio, 20);
    }
  </script>
</body>
</html>
`;

export interface WebClientOptions {
  port: number
  serverUrl: string
}

export async function startWebClient(options: WebClientOptions): Promise<void> {
  const { port } = options
  
  console.log(`Starting web client on http://localhost:${port}`)
  console.log(`Open this URL in your browser to listen`)
  console.log(`Server: ${options.serverUrl}`)
  
  Bun.serve({
    port,
    fetch(req) {
      const url = new URL(req.url)
      
      if (url.pathname === '/' || url.pathname === '/index.html') {
        return new Response(HTML_PAGE, {
          headers: { 'Content-Type': 'text/html' },
        })
      }
      
      return new Response('Not found', { status: 404 })
    },
  })
  
  console.log(`\n  → http://localhost:${port}\n`)
  
  // Keep running
  await new Promise(() => {})
}
