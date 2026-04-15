# pi-flipper-rpc

A [Pi](https://github.com/badlogic/pi-mono) extension for controlling a **Flipper Zero** via the protobuf RPC protocol over USB serial.

## Features

- **Structured communication** — protobuf messages with explicit status codes (no text parsing)
- **Storage operations** — list, read, write, delete, mkdir, rename, stat, info
- **App control** — start/stop apps, run JavaScript scripts
- **Screen capture** — grab the Flipper's 128x64 display as ASCII art
- **Remote control** — send button inputs (UP/DOWN/LEFT/RIGHT/OK/BACK)
- **Device info** — hardware info, firmware version, battery status
- **File chunking** — large files automatically split into 512-byte chunks
- **mjs linter** — type-checks `.js` files against fz-sdk TypeScript declarations before upload
- **25 specific error codes** — know exactly what went wrong

## Install

Quick start — run Pi with the extension directly:

```bash
pi -e https://github.com/ivanvza/pi-flipper-rpc
```

Or add to your Pi `settings.json` for permanent installation:

```json
{
  "packages": [
    "git:github.com/ivanvza/pi-flipper-rpc@main"
  ]
}
```

Or copy the extension manually:

```bash
git clone https://github.com/ivanvza/pi-flipper-rpc.git ~/.pi/agent/extensions/flipper-rpc
cd ~/.pi/agent/extensions/flipper-rpc && npm install
```

## Prerequisites

- Flipper Zero connected via USB
- User in the `dialout` group: `sudo usermod -aG dialout $USER` (log out/in after)
- Flipper must be unlocked

## Usage

The extension registers a `flipper_rpc` tool with these actions:

| Action | Description |
|--------|-------------|
| `connect` | Open connection and enter RPC mode |
| `disconnect` | Clean disconnect (StopSession) |
| `status` | Check connection status |
| `device_info` | Get device hardware/firmware info |
| `power_info` | Get battery/power status |
| `storage_list` | List directory contents |
| `storage_read` | Read file content |
| `storage_write` | Write file (mjs linter for .js) |
| `storage_delete` | Delete file/directory |
| `storage_mkdir` | Create directory |
| `storage_stat` | Get file/directory info |
| `storage_info` | Get filesystem space info |
| `storage_rename` | Rename/move file |
| `app_start` | Launch an app |
| `app_exit` | Stop running app |
| `gui_input` | Send button press |
| `gui_screen` | Capture screen as ASCII art |

### Examples

```
flipper_rpc action:"connect"
flipper_rpc action:"device_info"
flipper_rpc action:"storage_list" path:"/ext"
flipper_rpc action:"storage_write" path:"/ext/test.txt" content:"Hello Flipper!"
flipper_rpc action:"storage_read" path:"/ext/test.txt"
flipper_rpc action:"gui_screen"
flipper_rpc action:"gui_input" key:"OK"
flipper_rpc action:"app_start" name:"js" args:"/ext/scripts/scanner.js"
flipper_rpc action:"disconnect"
```

## How It Works

1. Opens USB serial at 230400 baud
2. Sends `start_rpc_session` to switch from CLI to protobuf mode
3. Communicates via varint-framed `PB.Main` protobuf messages
4. Each request gets a unique `command_id` — responses are matched by ID
5. Large transfers use `has_next` continuation for chunking

The `.proto` definitions are from [flipperdevices/flipperzero-protobuf](https://github.com/flipperdevices/flipperzero-protobuf).

## Why RPC over CLI?

| | CLI | RPC |
|--|-----|-----|
| Response detection | Prompt regex + idle timeout | Command ID matching |
| Error handling | Parse text | 25 explicit status codes |
| File writes | Interactive stdin + Ctrl+C | Structured WriteRequest |
| Screen capture | Not possible | Native support |
| Remote control | Not possible | Native button input |
| Reliability | Fragile (ANSI codes, timing) | Robust (binary protocol) |

## Skills

The `skills/` directory contains Flipper Zero documentation including command references, JavaScript engine docs, and fz-sdk TypeScript declarations.

## License

MIT
