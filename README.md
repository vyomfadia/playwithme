# playme

multi-device audio synchronization app mate

## prereqs

Install the required tools:

```bash
brew install ffmpeg sox

# (only for source, virtual audio device)
brew install blackhole-2ch
```

## setuo

```bash
bun install
```

## usage

```bash
# list devices
bun run start devices

# start server
bun run server

# connect to server
bun run client --server 192.168.1.100:8765
```
