export const MAX_RPC_FRAME_BYTES = 1024 * 1024;
export const MAX_RPC_REASSEMBLED_BYTES = 64 * 1024 * 1024;
const RPC_CHUNK_PAYLOAD_BYTES = 256 * 1024;

export interface RpcFrame {
	type: string;
	[key: string]: unknown;
}

export interface RpcReadyFrame extends RpcFrame {
	type: "ready";
	protocolVersion: 1;
	supportedProtocolVersions: number[];
	maxFrameBytes: number;
	maxReassembledFrameBytes: number;
}

export interface RpcResponse<T = unknown> extends RpcFrame {
	type: "response";
	id: string;
	command: string;
	success: boolean;
	data?: T;
	error?: string;
	code?: string;
}

export interface RpcSessionState {
	sessionId: string;
	sessionFile?: string;
	sessionName?: string;
	isStreaming: boolean;
	messageCount: number;
	queuedMessageCount: number;
	model?: { id?: string; name?: string; provider?: string };
	[key: string]: unknown;
}

interface PendingChunks {
	chunkId: string;
	count: number;
	byteLength: number;
	nextIndex: number;
	chunks: Uint8Array[];
	receivedBytes: number;
}

export class RpcProtocolError extends Error {}

export class RpcCommandError extends Error {
	readonly command: string;
	readonly code?: string;

	constructor(command: string, message: string, code?: string) {
		super(message);
		this.name = "RpcCommandError";
		this.command = command;
		this.code = code;
	}
}

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseRpcFrame(value: unknown): RpcFrame {
	if (
		!isRecord(value) ||
		typeof value.type !== "string" ||
		value.type.length === 0
	) {
		throw new RpcProtocolError("RPC frame must be an object with a type");
	}
	return value as RpcFrame;
}

export function parseReadyFrame(frame: RpcFrame): RpcReadyFrame {
	if (
		frame.type !== "ready" ||
		frame.protocolVersion !== 1 ||
		!Array.isArray(frame.supportedProtocolVersions) ||
		!frame.supportedProtocolVersions.every(Number.isSafeInteger) ||
		!frame.supportedProtocolVersions.includes(2) ||
		frame.maxFrameBytes !== MAX_RPC_FRAME_BYTES ||
		frame.maxReassembledFrameBytes !== MAX_RPC_REASSEMBLED_BYTES
	) {
		throw new RpcProtocolError(
			"OMP RPC ready frame is incompatible with protocol v2",
		);
	}
	return frame as RpcReadyFrame;
}

export function parseResponse(frame: RpcFrame): RpcResponse {
	if (
		frame.type !== "response" ||
		typeof frame.id !== "string" ||
		typeof frame.command !== "string" ||
		typeof frame.success !== "boolean"
	) {
		throw new RpcProtocolError("Invalid RPC response frame");
	}
	if (!frame.success && typeof frame.error !== "string") {
		throw new RpcProtocolError("Failed RPC response is missing an error");
	}
	return frame as RpcResponse;
}

export function parseSessionState(value: unknown): RpcSessionState {
	if (
		!isRecord(value) ||
		typeof value.sessionId !== "string" ||
		value.sessionId.length === 0 ||
		(value.sessionFile !== undefined &&
			typeof value.sessionFile !== "string") ||
		typeof value.isStreaming !== "boolean" ||
		!Number.isSafeInteger(value.messageCount) ||
		!Number.isSafeInteger(value.queuedMessageCount)
	) {
		throw new RpcProtocolError("Invalid get_state response");
	}
	return value as RpcSessionState;
}

function decodeBase64(value: unknown): Uint8Array {
	if (
		typeof value !== "string" ||
		value.length === 0 ||
		!RegExp(
			/^(?:[A-Za-z\d+/]{4})*(?:[A-Za-z\d+/]{2}==|[A-Za-z\d+/]{3}=)?$/,
		).test(value)
	) {
		throw new RpcProtocolError("Invalid RPC chunk data");
	}
	const bytes = Buffer.from(value, "base64");
	if (bytes.toString("base64") !== value)
		throw new RpcProtocolError("Invalid RPC chunk data");
	return bytes;
}

export class RpcFrameDecoder {
	#pending?: PendingChunks;

	push(value: unknown): RpcFrame | undefined {
		const frame = parseRpcFrame(value);
		if (frame.type !== "rpc_chunk") {
			if (this.#pending)
				throw new RpcProtocolError("RPC chunk sequence was interrupted");
			return frame;
		}

		const { chunkId, index, count, byteLength, data } = frame;
		if (
			typeof chunkId !== "string" ||
			chunkId.length === 0 ||
			chunkId.length > 128 ||
			!Number.isSafeInteger(index) ||
			!Number.isSafeInteger(count) ||
			!Number.isSafeInteger(byteLength) ||
			(index as number) < 0 ||
			(count as number) < 2 ||
			(count as number) >
				Math.ceil(MAX_RPC_REASSEMBLED_BYTES / RPC_CHUNK_PAYLOAD_BYTES) ||
			(index as number) >= (count as number) ||
			(byteLength as number) < MAX_RPC_FRAME_BYTES ||
			(byteLength as number) > MAX_RPC_REASSEMBLED_BYTES
		) {
			throw new RpcProtocolError("Invalid RPC chunk metadata");
		}

		const bytes = decodeBase64(data);
		if (bytes.byteLength > RPC_CHUNK_PAYLOAD_BYTES) {
			throw new RpcProtocolError(
				"RPC chunk payload exceeds the transport limit",
			);
		}
		if (!this.#pending) {
			if (index !== 0)
				throw new RpcProtocolError("RPC chunk sequence must start at zero");
			this.#pending = {
				chunkId,
				count: count as number,
				byteLength: byteLength as number,
				nextIndex: 0,
				chunks: [],
				receivedBytes: 0,
			};
		}

		const pending = this.#pending;
		if (
			pending.chunkId !== chunkId ||
			pending.count !== count ||
			pending.byteLength !== byteLength ||
			pending.nextIndex !== index
		) {
			throw new RpcProtocolError("RPC chunk sequence mismatch");
		}
		pending.chunks.push(bytes);
		pending.receivedBytes += bytes.byteLength;
		pending.nextIndex += 1;
		if (pending.receivedBytes > pending.byteLength) {
			throw new RpcProtocolError(
				"RPC chunk sequence exceeds its declared length",
			);
		}
		if (pending.nextIndex < pending.count) return undefined;
		if (pending.receivedBytes !== pending.byteLength) {
			throw new RpcProtocolError("RPC chunk sequence length mismatch");
		}

		this.#pending = undefined;
		const joined = Buffer.concat(pending.chunks);
		const json = new TextDecoder("utf-8", { fatal: true }).decode(joined);
		return parseRpcFrame(JSON.parse(json));
	}
}

export function encodeRpcCommand(command: Record<string, unknown>): string {
	const line = `${JSON.stringify(command)}\n`;
	if (Buffer.byteLength(line, "utf8") > MAX_RPC_FRAME_BYTES) {
		throw new RpcProtocolError(
			"RPC command exceeded the transport frame limit",
		);
	}
	return line;
}

export function isTerminalAgentEnd(frame: RpcFrame): boolean {
	return (
		frame.type === "agent_end" &&
		frame.isTerminal !== false &&
		frame.willContinue !== true
	);
}

export function textDeltaFromFrame(frame: RpcFrame): string | undefined {
	if (frame.type !== "message_update" || !isRecord(frame.assistantMessageEvent))
		return undefined;
	const event = frame.assistantMessageEvent;
	return event.type === "text_delta" && typeof event.delta === "string"
		? event.delta
		: undefined;
}

export function thinkingDeltaFromFrame(frame: RpcFrame): string | undefined {
	if (frame.type !== "message_update" || !isRecord(frame.assistantMessageEvent))
		return undefined;
	const event = frame.assistantMessageEvent;
	return event.type === "thinking_delta" && typeof event.delta === "string"
		? event.delta
		: undefined;
}
