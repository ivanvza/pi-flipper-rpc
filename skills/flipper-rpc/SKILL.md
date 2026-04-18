---
name: flipper-rpc
description: Control a Flipper Zero via protobuf RPC over USB serial. Manage storage, run apps/scripts, capture screen, send button inputs, get device info. More reliable than CLI with structured responses and explicit error codes. Use when the user wants to interact with a Flipper Zero.
---

# Flipper Zero RPC

Control a Flipper Zero via the `flipper_rpc` tool. Uses the protobuf RPC protocol for structured, reliable communication.

## Connection

```
flipper_rpc action:"connect"
flipper_rpc action:"disconnect"
flipper_rpc action:"status"
```

Auto-detects the Flipper at `/dev/serial/by-id/usb-Flipper*` on Linux and `/dev/cu.usbmodemflip_*` on macOS. The Flipper must be **unlocked** and connected via USB. On Linux the user must be in the `dialout` group; macOS needs no extra setup.

## Device Info

```
flipper_rpc action:"device_info"
flipper_rpc action:"power_info"
```

## Storage Operations

```
flipper_rpc action:"storage_list" path:"/ext"
flipper_rpc action:"storage_read" path:"/ext/myfile.txt"
flipper_rpc action:"storage_write" path:"/ext/myfile.txt" content:"Hello!"
flipper_rpc action:"storage_delete" path:"/ext/myfile.txt"
flipper_rpc action:"storage_delete" path:"/ext/mydir" recursive:true
flipper_rpc action:"storage_mkdir" path:"/ext/scripts"
flipper_rpc action:"storage_stat" path:"/ext/myfile.txt"
flipper_rpc action:"storage_info" path:"/ext"
flipper_rpc action:"storage_rename" path:"/ext/old.txt" new_path:"/ext/new.txt"
```

**Important:**
- `.js` files are automatically type-checked against the Flipper's fz-sdk declarations before uploading. If the linter finds issues, the upload is rejected with line numbers.
- `storage_write` overwrites existing files (deletes first, then writes).
- Parent directories must exist — create them with `storage_mkdir` first.
- Paths start with `/int` (internal) or `/ext` (SD card).

For detailed storage command reference, see [references/storage.md](references/storage.md).

## Running JavaScript Scripts

1. Write the script (linter checks it automatically):
```
flipper_rpc action:"storage_mkdir" path:"/ext/scripts"
flipper_rpc action:"storage_write" path:"/ext/scripts/scanner.js" content:"<script content>"
```

2. Run it:
```
flipper_rpc action:"app_start" name:"js" args:"/ext/scripts/scanner.js"
```

3. Monitor progress visually:
```
flipper_rpc action:"gui_screen"
```

4. Read results (scripts must write output to a file):
```
flipper_rpc action:"storage_read" path:"/ext/apps_data/results.txt"
```

**Important:** In RPC mode, `print()` output goes to the Flipper's screen, NOT back over serial. Scripts must write results to a file for retrieval.

For the mjs engine reference, API declarations, and limitations, see [references/js.md](references/js.md). **Always read the fz-sdk `.d.ts` files** before writing scripts — they define exactly what functions exist.

## Screen Capture

```
flipper_rpc action:"gui_screen"
```

Captures the Flipper's 128x64 display and returns it as ASCII art. Use this to:
- See what the Flipper is currently showing
- Monitor script progress
- Verify menu navigation

## Button Input (Remote Control)

```
flipper_rpc action:"gui_input" key:"OK"
flipper_rpc action:"gui_input" key:"UP"
flipper_rpc action:"gui_input" key:"DOWN"
flipper_rpc action:"gui_input" key:"LEFT"
flipper_rpc action:"gui_input" key:"RIGHT"
flipper_rpc action:"gui_input" key:"BACK"
flipper_rpc action:"gui_input" key:"OK" input_type:"LONG"
```

Keys: `UP`, `DOWN`, `LEFT`, `RIGHT`, `OK`, `BACK`
Types: `SHORT` (default), `LONG`, `PRESS`, `RELEASE`

Use `gui_screen` after each input to see the result.

## App Control

```
flipper_rpc action:"app_start" name:"<app_name>" args:"<required_args>"
flipper_rpc action:"app_exit"
```

**The `args` parameter is required for most apps.** For example, `js` needs the script path:

```
flipper_rpc action:"app_start" name:"js" args:"/ext/scripts/scanner.js"
```

Without `args`, the Flipper returns `ERROR_INVALID_PARAMETERS`.

## Detailed References

| Topic | Reference |
|-------|-----------|
| Storage operations | [references/storage.md](references/storage.md) |
| JavaScript engine & mjs API | [references/js.md](references/js.md) |
| Sub-GHz radio | [references/subghz.md](references/subghz.md) |
| NFC | [references/nfc.md](references/nfc.md) |
| RFID | [references/rfid.md](references/rfid.md) |
| Infrared | [references/ir.md](references/ir.md) |
| GPIO | [references/gpio.md](references/gpio.md) |
| LED & backlight | [references/led.md](references/led.md) |
| Vibration | [references/vibro.md](references/vibro.md) |
| Buzzer | [references/buzzer.md](references/buzzer.md) |
| iButton | [references/ikey.md](references/ikey.md) |
| Bluetooth | [references/bt.md](references/bt.md) |
| Device & power info | [references/info.md](references/info.md) |
| Power management | [references/power.md](references/power.md) |
| App launcher | [references/loader.md](references/loader.md) |

## Tips

- Use `gui_screen` + `gui_input` to navigate the Flipper remotely — capture screen, press buttons, capture again.
- JS scripts: always write output to a file. `print()` doesn't come back over RPC.
- Read [references/js.md](references/js.md) and the `.d.ts` files in `fz-sdk/` before writing scripts. The mjs engine is very limited.
- For CLI-only commands (raw text commands, streaming output like `log`), use the `flipper` CLI tool instead.
