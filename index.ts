/**
 * Flipper RPC Extension
 *
 * Connects to a Flipper Zero over USB serial using the protobuf RPC protocol.
 * Provides structured, reliable communication with explicit status codes.
 *
 * Tool: flipper_rpc
 * Commands: /flipper-rpc
 */

import { StringEnum } from "@mariozechner/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve as pathResolve } from "node:path";
import { FlipperRPC } from "./rpc";

// ── Types ──────────────────────────────────────────────────────────────

const FlipperRpcParams = Type.Object({
	action: StringEnum([
		"connect", "disconnect", "status",
		"device_info", "power_info",
		"storage_list", "storage_read", "storage_write",
		"storage_delete", "storage_mkdir", "storage_stat",
		"storage_info", "storage_rename",
		"app_start", "app_exit",
		"gui_input", "gui_screen",
	] as const),
	path: Type.Optional(Type.String({ description: "File/directory path on the Flipper (e.g. /ext/scripts/test.js)" })),
	content: Type.Optional(Type.String({ description: "File content to write (for storage_write)" })),
	port: Type.Optional(Type.String({ description: "Serial device path. Auto-detects if omitted." })),
	name: Type.Optional(Type.String({ description: "App name (for app_start, e.g. 'js')" })),
	args: Type.Optional(Type.String({ description: "App arguments (for app_start, e.g. '/ext/scripts/test.js')" })),
	new_path: Type.Optional(Type.String({ description: "Destination path (for storage_rename)" })),
	key: Type.Optional(Type.String({ description: "Input key: UP, DOWN, LEFT, RIGHT, OK, BACK (for gui_input)" })),
	input_type: Type.Optional(Type.String({ description: "Input type: SHORT, LONG, PRESS, RELEASE (for gui_input)" })),
	recursive: Type.Optional(Type.Boolean({ description: "Recursive delete (for storage_delete)" })),
	timeout: Type.Optional(Type.Number({ description: "Timeout in ms. Default varies by action." })),
});

// ── State ──────────────────────────────────────────────────────────────

const rpc = new FlipperRPC();

// ── Screen rendering ───────────────────────────────────────────────────
// Flipper screen: 128x64 monochrome, SSD1306 page format (LSB first).
// 8 pages of 128 bytes each. Each byte is a vertical column of 8 pixels.

function renderFlipperScreen(data: Buffer): string {
	const lines: string[] = [];
	for (let y = 0; y < 64; y += 2) {
		let line = "";
		for (let x = 0; x < 128; x++) {
			const page1 = Math.floor(y / 8);
			const bit1 = y % 8;
			const px1 = (data[page1 * 128 + x] >> bit1) & 1;

			const page2 = Math.floor((y + 1) / 8);
			const bit2 = (y + 1) % 8;
			const px2 = (data[page2 * 128 + x] >> bit2) & 1;

			if (px1 && px2) line += "\u2588";      // full block
			else if (px1) line += "\u2580";         // upper half
			else if (px2) line += "\u2584";         // lower half
			else line += " ";
		}
		lines.push(line);
	}
	return lines.join("\n");
}

// ── Auto-detect ────────────────────────────────────────────────────────

function autoDetectFlipper(): string | null {
	try {
		const dir = "/dev/serial/by-id";
		const entries = readdirSync(dir);
		const flipper = entries.find((e) => e.startsWith("usb-Flipper"));
		return flipper ? `${dir}/${flipper}` : null;
	} catch {
		return null;
	}
}

// ── mjs linter (shared with CLI extension) ─────────────────────────────

const FZ_SDK_DIR = pathResolve(__dirname, "skills/flipper-rpc/references/fz-sdk");

interface MjsIssue {
	line: number;
	text: string;
	error: string;
}

function lintMjs(source: string): MjsIssue[] {
	const issues: MjsIssue[] = [];
	const lines = source.split("\n");

	// Phase 1: mjs syntax restrictions
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		const trimmed = line.trim();
		const num = i + 1;
		if (trimmed.startsWith("//")) continue;

		if (/\bconst\s+/.test(trimmed))
			issues.push({ line: num, text: trimmed, error: "mjs does not support 'const'. Use 'let'." });
		if (/^\s*try\s*\{/.test(line) || /\}\s*catch\s*[\({]/.test(line) || /\}\s*finally\s*\{/.test(line))
			issues.push({ line: num, text: trimmed, error: "mjs does not support try/catch/finally." });
		if (/\bclass\s+\w+/.test(trimmed))
			issues.push({ line: num, text: trimmed, error: "mjs does not support classes." });
		if (/\(?[^)]*\)?\s*=>/.test(trimmed) && !trimmed.startsWith("//") && !/\/.*=>.*\//.test(trimmed))
			issues.push({ line: num, text: trimmed, error: "mjs does not support arrow functions." });
		if (/`[^`]*`/.test(trimmed))
			issues.push({ line: num, text: trimmed, error: "mjs does not support template literals." });
		if (/(?:let|var)\s*[\[{]/.test(trimmed))
			issues.push({ line: num, text: trimmed, error: "mjs does not support destructuring." });
		if (/\.\.\.[\w\[]/.test(trimmed) && !trimmed.startsWith("//"))
			issues.push({ line: num, text: trimmed, error: "mjs does not support spread operator." });
		if (/\basync\s+function\b/.test(trimmed) || /\bawait\s+/.test(trimmed))
			issues.push({ line: num, text: trimmed, error: "mjs does not support async/await." });
		if (/\bfor\s*\(\s*(?:let|var)\s+\w+\s+of\s+/.test(trimmed))
			issues.push({ line: num, text: trimmed, error: "mjs does not support for...of." });
	}
	if (issues.length > 0) return issues;

	// Phase 2: TypeScript type-check against fz-sdk
	try {
		const ts = require("typescript");
		const dtsFiles: Record<string, string> = {};
		let sdkFiles: string[];
		try {
			sdkFiles = readdirSync(FZ_SDK_DIR).filter((f) => f.endsWith(".d.ts"));
		} catch { return issues; }

		for (const f of sdkFiles) {
			dtsFiles[join(FZ_SDK_DIR, f)] = readFileSync(join(FZ_SDK_DIR, f), "utf-8");
		}

		let preamble = "";
		let rewrittenSource = source;
		const requireRe = /let\s+(\w+)\s*=\s*require\s*\(\s*["'](\w+)["']\s*\)/g;
		let match: RegExpExecArray | null;
		while ((match = requireRe.exec(source)) !== null) {
			const dtsPath = join(FZ_SDK_DIR, `${match[2]}.d.ts`);
			if (dtsFiles[dtsPath]) {
				preamble += `declare const ${match[1]}: typeof import("${dtsPath}");\n`;
				rewrittenSource = rewrittenSource.replace(match[0], `// ${match[0]}`);
			}
		}

		const virtualFileName = "/virtual/script.ts";
		const fullSource = preamble + rewrittenSource;
		const fileMap = new Map<string, string>();
		fileMap.set(virtualFileName, fullSource);
		for (const [path, content] of Object.entries(dtsFiles)) fileMap.set(path, content);

		const compilerOptions: any = {
			target: ts.ScriptTarget.ES5,
			module: ts.ModuleKind.CommonJS,
			strict: false, noEmit: true, allowJs: true, checkJs: true,
			noLib: true, types: [],
		};

		const host = ts.createCompilerHost(compilerOptions);
		const origGet = host.getSourceFile.bind(host);
		host.getSourceFile = (name: string, ver: any) => {
			const c = fileMap.get(name);
			return c !== undefined ? ts.createSourceFile(name, c, ver) : origGet(name, ver);
		};
		host.fileExists = (n: string) => fileMap.has(n) || ts.sys.fileExists(n);
		host.readFile = (n: string) => fileMap.get(n) ?? ts.sys.readFile(n);
		host.getDefaultLibFileName = () => join(FZ_SDK_DIR, "global.d.ts");

		const program = ts.createProgram([virtualFileName, ...Object.keys(dtsFiles)], compilerOptions, host);
		const preambleLines = preamble.split("\n").length - 1;

		for (const d of ts.getPreEmitDiagnostics(program).filter((d: any) => d.file?.fileName === virtualFileName)) {
			if (d.file && d.start !== undefined) {
				const pos = d.file.getLineAndCharacterOfPosition(d.start);
				const lineNum = pos.line + 1 - preambleLines;
				if (lineNum < 1) continue;
				const msg = ts.flattenDiagnosticMessageText(d.messageText, "\n");
				issues.push({ line: lineNum, text: lines[lineNum - 1]?.trim() ?? "", error: msg });
			}
		}
	} catch {
		// TS check failed — syntax checks already ran
	}

	return issues;
}

// ── Extension ──────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	// Cleanup
	const closePort = () => { if (rpc.isConnected) rpc.disconnect(); };
	process.on("exit", closePort);
	process.on("SIGTERM", closePort);
	process.on("SIGINT", closePort);

	pi.on("session_shutdown", async (_event, ctx) => {
		if (rpc.isConnected) rpc.disconnect();
		ctx.ui.setStatus("flipper-rpc", undefined);
	});

	pi.registerTool({
		name: "flipper_rpc",
		label: "Flipper RPC",
		description:
			"Connect to a Flipper Zero over USB serial using the protobuf RPC protocol. " +
			"Provides reliable, structured communication with explicit error codes. " +
			"Actions: connect, disconnect, status, device_info, power_info, " +
			"storage_list, storage_read, storage_write, storage_delete, storage_mkdir, " +
			"storage_stat, storage_info, storage_rename, app_start, app_exit, gui_input, " +
			"gui_screen (capture the Flipper's screen as ASCII art).",
		promptSnippet: "Control a Flipper Zero via RPC (protobuf) over USB serial",
		promptGuidelines: [
			"Always connect before using other actions.",
			"Use storage_write to upload files. For .js files, the mjs linter runs automatically.",
			"To run JS scripts: storage_write the script, then app_start with name 'js' and args '/ext/scripts/yourscript.js'. Script output goes to the Flipper screen — write results to a file and read them back with storage_read.",
			"gui_input sends button presses: key (UP/DOWN/LEFT/RIGHT/OK/BACK), input_type (SHORT/LONG/PRESS/RELEASE).",
		],
		parameters: FlipperRpcParams,

		async execute(toolCallId, params, signal, onUpdate, ctx) {
			const { action } = params;

			switch (action) {
				case "connect": {
					if (rpc.isConnected) {
						return {
							content: [{ type: "text", text: `Already connected to ${rpc.devicePath}` }],
							details: { connected: true, path: rpc.devicePath },
						};
					}

					const devicePath = params.port ?? autoDetectFlipper();
					if (!devicePath) {
						throw new Error("No Flipper found. Is it plugged in and unlocked?");
					}

					onUpdate?.({ content: [{ type: "text", text: `Connecting to ${devicePath} via RPC...` }] });
					await rpc.connect(devicePath);
					ctx.ui.setStatus("flipper-rpc", "Flipper RPC connected");

					return {
						content: [{ type: "text", text: `Connected to Flipper at ${devicePath} (RPC mode, ping OK)` }],
						details: { connected: true, path: devicePath },
					};
				}

				case "disconnect": {
					if (!rpc.isConnected) {
						return { content: [{ type: "text", text: "Not connected." }], details: { connected: false } };
					}
					const path = rpc.devicePath;
					rpc.disconnect();
					ctx.ui.setStatus("flipper-rpc", undefined);
					return { content: [{ type: "text", text: `Disconnected from ${path}` }], details: { connected: false } };
				}

				case "status": {
					const connected = rpc.isConnected;
					const detected = autoDetectFlipper();
					let text = connected ? `Connected to ${rpc.devicePath}` : "Not connected";
					if (detected && !connected) text += `\nFlipper detected at: ${detected}`;
					return { content: [{ type: "text", text }], details: { connected, path: rpc.devicePath, detected } };
				}

				case "device_info": {
					if (!rpc.isConnected) throw new Error("Not connected.");
					const info = await rpc.deviceInfo();
					const text = Object.entries(info).map(([k, v]) => `${k}: ${v}`).join("\n");
					return { content: [{ type: "text", text: text || "(no info)" }], details: { info } };
				}

				case "power_info": {
					if (!rpc.isConnected) throw new Error("Not connected.");
					const info = await rpc.powerInfo();
					const text = Object.entries(info).map(([k, v]) => `${k}: ${v}`).join("\n");
					return { content: [{ type: "text", text: text || "(no info)" }], details: { info } };
				}

				case "storage_list": {
					if (!rpc.isConnected) throw new Error("Not connected.");
					if (!params.path) throw new Error("Missing 'path' parameter.");
					const files = await rpc.storageList(params.path);
					const text = files.map((f) => `${f.type === "dir" ? "[DIR]" : `[${f.size}B]`} ${f.name}`).join("\n");
					return { content: [{ type: "text", text: text || "(empty directory)" }], details: { files, path: params.path } };
				}

				case "storage_read": {
					if (!rpc.isConnected) throw new Error("Not connected.");
					if (!params.path) throw new Error("Missing 'path' parameter.");
					const data = await rpc.storageRead(params.path);
					const text = data.toString("utf-8");
					return { content: [{ type: "text", text }], details: { path: params.path, size: data.length } };
				}

				case "storage_write": {
					if (!rpc.isConnected) throw new Error("Not connected.");
					if (!params.path) throw new Error("Missing 'path' parameter.");
					if (params.content === undefined) throw new Error("Missing 'content' parameter.");

					// mjs linter for .js files
					if (params.path.endsWith(".js")) {
						ctx.ui.notify("Linting against fz-sdk...", "info");
						const issues = lintMjs(params.content);
						if (issues.length > 0) {
							ctx.ui.notify(`mjs lint FAILED: ${issues.length} issue(s)`, "error");
							const report = issues.map((i) => `  Line ${i.line}: ${i.error}\n    ${i.text}`).join("\n");
							throw new Error(`mjs compatibility issues (${issues.length}):\n${report}\n\nFix before uploading.`);
						}
						ctx.ui.notify("mjs lint OK!", "success");
					}

					onUpdate?.({ content: [{ type: "text", text: `Writing ${params.content.length} bytes to ${params.path}...` }] });

					// Delete first (storage_write overwrites only if we delete)
					try { await rpc.storageDelete(params.path); } catch {}

					await rpc.storageWrite(params.path, Buffer.from(params.content, "utf-8"));

					return {
						content: [{ type: "text", text: `Wrote ${params.content.length} bytes to ${params.path}` }],
						details: { path: params.path, size: params.content.length },
					};
				}

				case "storage_delete": {
					if (!rpc.isConnected) throw new Error("Not connected.");
					if (!params.path) throw new Error("Missing 'path' parameter.");
					await rpc.storageDelete(params.path, params.recursive ?? false);
					return { content: [{ type: "text", text: `Deleted ${params.path}` }], details: { path: params.path } };
				}

				case "storage_mkdir": {
					if (!rpc.isConnected) throw new Error("Not connected.");
					if (!params.path) throw new Error("Missing 'path' parameter.");
					await rpc.storageMkdir(params.path);
					return { content: [{ type: "text", text: `Created directory ${params.path}` }], details: { path: params.path } };
				}

				case "storage_stat": {
					if (!rpc.isConnected) throw new Error("Not connected.");
					if (!params.path) throw new Error("Missing 'path' parameter.");
					const stat = await rpc.storageStat(params.path);
					const text = stat ? `${stat.type} "${stat.name}" (${stat.size} bytes)` : "Not found";
					return { content: [{ type: "text", text }], details: { stat, path: params.path } };
				}

				case "storage_info": {
					if (!rpc.isConnected) throw new Error("Not connected.");
					const p = params.path || "/ext";
					const info = await rpc.storageInfo(p);
					const text = `Total: ${info.totalSpace} bytes, Free: ${info.freeSpace} bytes`;
					return { content: [{ type: "text", text }], details: { ...info, path: p } };
				}

				case "storage_rename": {
					if (!rpc.isConnected) throw new Error("Not connected.");
					if (!params.path) throw new Error("Missing 'path' parameter.");
					if (!params.new_path) throw new Error("Missing 'new_path' parameter.");
					await rpc.storageRename(params.path, params.new_path);
					return { content: [{ type: "text", text: `Renamed ${params.path} -> ${params.new_path}` }], details: {} };
				}

				case "app_start": {
					if (!rpc.isConnected) throw new Error("Not connected.");
					if (!params.name) throw new Error("Missing 'name' parameter.");
					await rpc.appStart(params.name, params.args);
					return {
						content: [{ type: "text", text: `Started app: ${params.name} ${params.args || ""}` }],
						details: { name: params.name, args: params.args },
					};
				}

				case "app_exit": {
					if (!rpc.isConnected) throw new Error("Not connected.");
					await rpc.appExit();
					return { content: [{ type: "text", text: "App exited" }], details: {} };
				}

				case "gui_input": {
					if (!rpc.isConnected) throw new Error("Not connected.");
					const key = (params.key || "OK").toUpperCase() as any;
					const inputType = (params.input_type || "SHORT").toUpperCase() as any;
					await rpc.guiSendInput(key, inputType);
					return { content: [{ type: "text", text: `Sent input: ${key} ${inputType}` }], details: { key, inputType } };
				}

				case "gui_screen": {
					if (!rpc.isConnected) throw new Error("Not connected.");
					onUpdate?.({ content: [{ type: "text", text: "Capturing screen..." }] });
					const frame = await rpc.guiSnapshotScreen();
					if (!frame) {
						return { content: [{ type: "text", text: "No screen frame received" }], details: {} };
					}
					const ascii = renderFlipperScreen(frame);
					return {
						content: [{ type: "text", text: ascii }],
						details: { width: 128, height: 64, bytes: frame.length },
					};
				}

				default:
					throw new Error(`Unknown action: ${action}`);
			}
		},

		renderCall(args, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			let content = theme.fg("toolTitle", theme.bold("flipper_rpc "));
			content += theme.fg("muted", args.action ?? "");
			if (args.path) content += " " + theme.fg("dim", args.path);
			if (args.name) content += " " + theme.fg("dim", args.name);
			if (args.key) content += " " + theme.fg("dim", args.key);
			text.setText(content);
			return text;
		},

		renderResult(result, { expanded, isPartial }, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			if (isPartial) { text.setText(theme.fg("warning", "Working...")); return text; }

			const details = result.details as Record<string, unknown> | undefined;
			const action = context.args?.action;

			if (action === "connect" || action === "disconnect" || action === "status") {
				const connected = details?.connected as boolean;
				const icon = connected ? "●" : "○";
				const color = connected ? "success" : "muted";
				text.setText(theme.fg(color, `${icon} ${result.content?.[0]?.type === "text" ? result.content[0].text : ""}`));
				return text;
			}

			const output = result.content?.[0]?.type === "text" ? result.content[0].text : "";
			const lines = output.split("\n");
			const preview = lines.length <= 8 || expanded
				? output
				: lines.slice(0, 8).join("\n") + `\n... (${lines.length - 8} more lines)`;
			text.setText(theme.fg("success", "✓ ") + preview);
			return text;
		},
	});

	// Quick status command
	pi.registerCommand("flipper-rpc", {
		description: "Show Flipper RPC connection status",
		handler: async (_args, ctx) => {
			if (rpc.isConnected) {
				ctx.ui.notify(`Flipper RPC connected at ${rpc.devicePath}`, "info");
			} else {
				const detected = autoDetectFlipper();
				ctx.ui.notify(detected ? `Flipper at ${detected} (not connected)` : "No Flipper detected", detected ? "info" : "warning");
			}
		},
	});
}
