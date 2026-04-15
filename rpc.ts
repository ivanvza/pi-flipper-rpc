/**
 * Flipper Zero RPC Protocol Layer
 *
 * Handles varint-framed protobuf communication over serial.
 * Provides typed high-level operations (storage, system, app, gui).
 */

import { SerialPort } from "serialport";
import { PB, PB_Storage, PB_System, PB_App, PB_Gui } from "./generated.js";

// ── Types ──────────────────────────────────────────────────────────────

export interface FlipperFile {
	name: string;
	type: "file" | "dir";
	size: number;
}

export interface FlipperStorageInfo {
	totalSpace: number;
	freeSpace: number;
}

export type InputKey = "UP" | "DOWN" | "LEFT" | "RIGHT" | "OK" | "BACK";
export type InputType = "PRESS" | "RELEASE" | "SHORT" | "LONG";

const INPUT_KEY_MAP: Record<InputKey, number> = {
	UP: 0, DOWN: 1, RIGHT: 2, LEFT: 3, OK: 4, BACK: 5,
};
const INPUT_TYPE_MAP: Record<InputType, number> = {
	PRESS: 0, RELEASE: 1, SHORT: 2, LONG: 3,
};

// ── Varint helpers ─────────────────────────────────────────────────────

function encodeVarint(value: number): Buffer {
	const bytes: number[] = [];
	while (value > 0x7f) {
		bytes.push((value & 0x7f) | 0x80);
		value = value >>> 7;
	}
	bytes.push(value & 0x7f);
	return Buffer.from(bytes);
}

function decodeVarint(buf: Buffer, offset: number): { value: number; nextOffset: number } | null {
	let result = 0;
	let shift = 0;
	let pos = offset;
	while (pos < buf.length && shift < 35) {
		const b = buf[pos];
		result |= (b & 0x7f) << shift;
		pos++;
		if ((b & 0x80) === 0) {
			return { value: result, nextOffset: pos };
		}
		shift += 7;
	}
	return null; // incomplete varint
}

// ── Error mapping ──────────────────────────────────────────────────────

const STATUS_NAMES: Record<number, string> = {
	0: "OK",
	1: "ERROR",
	2: "ERROR_DECODE",
	3: "ERROR_NOT_IMPLEMENTED",
	4: "ERROR_BUSY",
	5: "ERROR_STORAGE_NOT_READY",
	6: "ERROR_STORAGE_EXIST",
	7: "ERROR_STORAGE_NOT_EXIST",
	8: "ERROR_STORAGE_INVALID_PARAMETER",
	9: "ERROR_STORAGE_DENIED",
	10: "ERROR_STORAGE_INVALID_NAME",
	11: "ERROR_STORAGE_INTERNAL",
	12: "ERROR_STORAGE_NOT_IMPLEMENTED",
	13: "ERROR_STORAGE_ALREADY_OPEN",
	14: "ERROR_CONTINUOUS_COMMAND_INTERRUPTED",
	15: "ERROR_INVALID_PARAMETERS",
	16: "ERROR_APP_CANT_START",
	17: "ERROR_APP_SYSTEM_LOCKED",
	18: "ERROR_STORAGE_DIR_NOT_EMPTY",
	19: "ERROR_VIRTUAL_DISPLAY_ALREADY_STARTED",
	20: "ERROR_VIRTUAL_DISPLAY_NOT_STARTED",
	21: "ERROR_APP_NOT_RUNNING",
	22: "ERROR_APP_CMD_ERROR",
};

function statusName(code: number): string {
	return STATUS_NAMES[code] || `UNKNOWN_${code}`;
}

// ── Pending request tracking ───────────────────────────────────────────

interface PendingRequest {
	resolve: (msgs: PB.Main[]) => void;
	reject: (err: Error) => void;
	responses: PB.Main[];
	timer: ReturnType<typeof setTimeout>;
}

// ── Write chunk size for file uploads ──────────────────────────────────

const WRITE_CHUNK_SIZE = 512;

// ── FlipperRPC class ───────────────────────────────────────────────────

export class FlipperRPC {
	private port: SerialPort | null = null;
	private nextCommandId = 1;
	private pending = new Map<number, PendingRequest>();
	private recvBuf = Buffer.alloc(0);
	private connected = false;
	private connectedPath: string | null = null;

	get isConnected(): boolean {
		return this.connected && this.port?.isOpen === true;
	}

	get devicePath(): string | null {
		return this.connectedPath;
	}

	// ── Connect ────────────────────────────────────────────────────────

	async connect(path: string): Promise<void> {
		if (this.isConnected) {
			throw new Error("Already connected");
		}

		// Open serial port
		await new Promise<void>((resolve, reject) => {
			this.port = new SerialPort({ path, baudRate: 230400 }, (err) => {
				if (err) {
					this.port = null;
					reject(new Error(`Failed to open ${path}: ${err.message}`));
				} else {
					resolve();
				}
			});
		});

		// Install permanent data listener
		this.port!.on("data", (chunk: Buffer) => this.onData(chunk));
		this.port!.on("close", () => this.onClose());
		this.port!.on("error", () => this.onClose());

		this.connectedPath = path;

		// Wake CLI and enter RPC mode
		await this.enterRpcMode();

		// Verify with ping
		await this.ping();
		this.connected = true;
	}

	// ── Disconnect ─────────────────────────────────────────────────────

	disconnect(): void {
		// Send StopSession if possible
		if (this.port?.isOpen) {
			try {
				const msg = PB.Main.create({ commandId: this.nextCommandId++, stopSession: {} });
				const encoded = PB.Main.encode(msg).finish();
				const frame = Buffer.concat([encodeVarint(encoded.length), Buffer.from(encoded)]);
				this.port.write(frame);
			} catch {}
			try { this.port.close(); } catch {}
		}
		this.cleanup();
	}

	// ── System operations ──────────────────────────────────────────────

	async ping(): Promise<void> {
		const data = Buffer.from([0xde, 0xad, 0xbe, 0xef]);
		const responses = await this.sendRequest({
			systemPingRequest: { data },
		}, 3000);
		this.checkStatus(responses[0]);
	}

	async deviceInfo(): Promise<Record<string, string>> {
		const responses = await this.sendRequest({
			systemDeviceInfoRequest: {},
		}, 5000);
		const info: Record<string, string> = {};
		for (const r of responses) {
			if (r.systemDeviceInfoResponse) {
				info[r.systemDeviceInfoResponse.key || ""] = r.systemDeviceInfoResponse.value || "";
			}
		}
		return info;
	}

	async powerInfo(): Promise<Record<string, string>> {
		const responses = await this.sendRequest({
			systemPowerInfoRequest: {},
		}, 5000);
		const info: Record<string, string> = {};
		for (const r of responses) {
			if (r.systemPowerInfoResponse) {
				info[r.systemPowerInfoResponse.key || ""] = r.systemPowerInfoResponse.value || "";
			}
		}
		return info;
	}

	// ── Storage operations ─────────────────────────────────────────────

	async storageList(path: string): Promise<FlipperFile[]> {
		const responses = await this.sendRequest({
			storageListRequest: { path },
		}, 5000);
		const files: FlipperFile[] = [];
		for (const r of responses) {
			this.checkStatus(r);
			if (r.storageListResponse?.file) {
				for (const f of r.storageListResponse.file) {
					files.push({
						name: f.name || "",
						type: f.type === PB_Storage.File.FileType.DIR ? "dir" : "file",
						size: f.size || 0,
					});
				}
			}
		}
		return files;
	}

	async storageRead(path: string): Promise<Buffer> {
		const responses = await this.sendRequest({
			storageReadRequest: { path },
		}, 10000);
		const chunks: Buffer[] = [];
		for (const r of responses) {
			this.checkStatus(r);
			if (r.storageReadResponse?.file?.data) {
				chunks.push(Buffer.from(r.storageReadResponse.file.data));
			}
		}
		return Buffer.concat(chunks);
	}

	async storageWrite(path: string, data: Buffer): Promise<void> {
		const totalChunks = Math.ceil(data.length / WRITE_CHUNK_SIZE) || 1;

		for (let i = 0; i < totalChunks; i++) {
			const offset = i * WRITE_CHUNK_SIZE;
			const chunk = data.slice(offset, offset + WRITE_CHUNK_SIZE);
			const isLast = i === totalChunks - 1;

			const commandId = this.nextCommandId++;
			const msg = PB.Main.create({
				commandId,
				hasNext: !isLast,
				storageWriteRequest: {
					path,
					file: { data: chunk },
				},
			});

			if (isLast) {
				// Only wait for response on the last chunk
				const responses = await this.sendRequestRaw(commandId, msg, 15000);
				this.checkStatus(responses[0]);
			} else {
				// Fire and forget for intermediate chunks
				this.sendFrame(msg);
				// Small delay between chunks
				await new Promise((r) => setTimeout(r, 16));
			}
		}
	}

	async storageDelete(path: string, recursive = false): Promise<void> {
		const responses = await this.sendRequest({
			storageDeleteRequest: { path, recursive },
		}, 5000);
		this.checkStatus(responses[0]);
	}

	async storageMkdir(path: string): Promise<void> {
		const responses = await this.sendRequest({
			storageMkdirRequest: { path },
		}, 5000);
		this.checkStatus(responses[0]);
	}

	async storageStat(path: string): Promise<FlipperFile | null> {
		const responses = await this.sendRequest({
			storageStatRequest: { path },
		}, 5000);
		this.checkStatus(responses[0]);
		const file = responses[0]?.storageStatResponse?.file;
		if (!file) return null;
		return {
			name: file.name || "",
			type: file.type === PB_Storage.File.FileType.DIR ? "dir" : "file",
			size: file.size || 0,
		};
	}

	async storageInfo(path: string): Promise<FlipperStorageInfo> {
		const responses = await this.sendRequest({
			storageInfoRequest: { path },
		}, 5000);
		this.checkStatus(responses[0]);
		return {
			totalSpace: Number(responses[0]?.storageInfoResponse?.totalSpace || 0),
			freeSpace: Number(responses[0]?.storageInfoResponse?.freeSpace || 0),
		};
	}

	async storageRename(oldPath: string, newPath: string): Promise<void> {
		const responses = await this.sendRequest({
			storageRenameRequest: { oldPath, newPath },
		}, 5000);
		this.checkStatus(responses[0]);
	}

	async storageMd5(path: string): Promise<string> {
		const responses = await this.sendRequest({
			storageMd5sumRequest: { path },
		}, 5000);
		this.checkStatus(responses[0]);
		return responses[0]?.storageMd5sumResponse?.md5sum || "";
	}

	// ── App operations ─────────────────────────────────────────────────

	async appStart(name: string, args?: string): Promise<void> {
		const responses = await this.sendRequest({
			appStartRequest: { name, args: args || "" },
		}, 5000);
		this.checkStatus(responses[0]);
	}

	async appExit(): Promise<void> {
		const responses = await this.sendRequest({
			appExitRequest: {},
		}, 3000);
		this.checkStatus(responses[0]);
	}

	// ── GUI operations ─────────────────────────────────────────────────

	async guiSendInput(key: InputKey, type: InputType = "SHORT"): Promise<void> {
		const keyVal = INPUT_KEY_MAP[key];

		if (type === "SHORT" || type === "LONG") {
			// A short/long press requires three events in sequence:
			// PRESS → SHORT/LONG → RELEASE
			// Sending only one event gets discarded by the Flipper.
			await this.sendRequest({
				guiSendInputEventRequest: { key: keyVal, type: INPUT_TYPE_MAP["PRESS"] },
			}, 3000);
			await this.sendRequest({
				guiSendInputEventRequest: { key: keyVal, type: INPUT_TYPE_MAP[type] },
			}, 3000);
			await this.sendRequest({
				guiSendInputEventRequest: { key: keyVal, type: INPUT_TYPE_MAP["RELEASE"] },
			}, 3000);
		} else {
			// Raw PRESS or RELEASE — send as-is
			const responses = await this.sendRequest({
				guiSendInputEventRequest: { key: keyVal, type: INPUT_TYPE_MAP[type] },
			}, 3000);
			this.checkStatus(responses[0]);
		}
	}

	async guiSnapshotScreen(): Promise<Buffer | null> {
		// Start screen stream — Flipper sends frames as unsolicited messages
		this.screenFrameBuffer = null;
		await this.sendRequest({ guiStartScreenStreamRequest: {} }, 3000);

		// Wait for a frame to arrive
		await new Promise((r) => setTimeout(r, 1000));

		// Stop stream
		await this.sendRequest({ guiStopScreenStreamRequest: {} }, 3000);

		return this.screenFrameBuffer;
	}

	private screenFrameBuffer: Buffer | null = null;

	// ── Low-level protocol ─────────────────────────────────────────────

	private async enterRpcMode(): Promise<void> {
		if (!this.port?.isOpen) throw new Error("Port not open");

		// Drain any existing data
		this.recvBuf = Buffer.alloc(0);

		// Wake CLI with \r\n and wait briefly
		this.port.write("\r\n");
		await new Promise((r) => setTimeout(r, 2000));

		// Drain whatever the CLI sent (welcome banner, prompt)
		this.recvBuf = Buffer.alloc(0);

		// Enter RPC mode (use \r, not \r\n, matching Python reference)
		this.port.write("start_rpc_session\r");

		// Wait for echo to be consumed
		await new Promise((r) => setTimeout(r, 500));

		// Clear receive buffer — everything before this is CLI text
		this.recvBuf = Buffer.alloc(0);
	}

	private sendRequest(
		content: Partial<PB.IMain>,
		timeoutMs: number,
	): Promise<PB.Main[]> {
		const commandId = this.nextCommandId++;
		const msg = PB.Main.create({ commandId, ...content });
		return this.sendRequestRaw(commandId, msg, timeoutMs);
	}

	private sendRequestRaw(
		commandId: number,
		msg: PB.Main,
		timeoutMs: number,
	): Promise<PB.Main[]> {
		return new Promise((resolve, reject) => {
			if (!this.port?.isOpen) {
				return reject(new Error("Not connected"));
			}

			const timer = setTimeout(() => {
				const req = this.pending.get(commandId);
				this.pending.delete(commandId);
				if (req && req.responses.length > 0) {
					resolve(req.responses);
				} else {
					reject(new Error(`RPC timeout (${timeoutMs}ms) for command ${commandId}`));
				}
			}, timeoutMs);

			this.pending.set(commandId, { resolve, reject, responses: [], timer });
			this.sendFrame(msg);
		});
	}

	private sendFrame(msg: PB.Main): void {
		if (!this.port?.isOpen) return;
		const encoded = PB.Main.encode(msg).finish();
		const frame = Buffer.concat([encodeVarint(encoded.length), Buffer.from(encoded)]);
		this.port.write(frame);
	}

	// ── Data reception ─────────────────────────────────────────────────

	private onData(chunk: Buffer): void {
		this.recvBuf = Buffer.concat([this.recvBuf, chunk]);
		this.processBuffer();
	}

	private processBuffer(): void {
		while (this.recvBuf.length > 0) {
			// Try to read varint length
			const vr = decodeVarint(this.recvBuf, 0);
			if (!vr) break; // incomplete varint

			const msgLen = vr.value;
			const msgStart = vr.nextOffset;
			const msgEnd = msgStart + msgLen;

			if (msgLen <= 0 || msgLen > 256 * 1024) {
				// Invalid length — skip this byte and try again
				this.recvBuf = this.recvBuf.slice(1);
				continue;
			}

			if (this.recvBuf.length < msgEnd) {
				break; // incomplete message, wait for more data
			}

			// Extract and decode message
			const msgBytes = this.recvBuf.slice(msgStart, msgEnd);
			this.recvBuf = this.recvBuf.slice(msgEnd);

			try {
				const msg = PB.Main.decode(msgBytes);
				this.handleMessage(msg);
			} catch {
				// Decode error — skip
			}
		}
	}

	private handleMessage(msg: PB.Main): void {
		// Capture unsolicited screen frames (commandId=0)
		if (msg.guiScreenFrame?.data) {
			this.screenFrameBuffer = Buffer.from(msg.guiScreenFrame.data);
		}

		const id = msg.commandId || 0;
		const req = this.pending.get(id);
		if (!req) return; // unsolicited message

		req.responses.push(msg);

		// If this is the last message (no has_next), resolve
		if (!msg.hasNext) {
			clearTimeout(req.timer);
			this.pending.delete(id);
			req.resolve(req.responses);
		}
	}

	// ── Cleanup ────────────────────────────────────────────────────────

	private onClose(): void {
		this.cleanup();
	}

	private cleanup(): void {
		this.connected = false;
		this.connectedPath = null;
		this.recvBuf = Buffer.alloc(0);

		// Reject all pending requests
		for (const [id, req] of this.pending) {
			clearTimeout(req.timer);
			req.reject(new Error("Connection closed"));
		}
		this.pending.clear();

		if (this.port?.isOpen) {
			try { this.port.close(); } catch {}
		}
		this.port = null;
	}

	private checkStatus(msg: PB.Main): void {
		const status = msg?.commandStatus;
		if (status && status !== PB.CommandStatus.OK) {
			throw new Error(`Flipper RPC error: ${statusName(status)} (${status})`);
		}
	}
}
