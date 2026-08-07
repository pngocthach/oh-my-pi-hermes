import { mkdir } from "node:fs/promises";
import {
	encodeRpcCommand,
	isRecord,
	parseReadyFrame,
	parseResponse,
	RpcCommandError,
	type RpcFrame,
	RpcFrameDecoder,
	type RpcResponse,
} from "./protocol";

export interface RpcTransportOptions {
	command: readonly string[];
	sessionDirectory: string;
	cwd?: string;
	startTimeoutMs: number;
	commandTimeoutMs: number;
	shutdownTimeoutMs: number;
}

interface PendingRequest {
	command: string;
	resolve: (response: RpcResponse) => void;
	reject: (error: Error) => void;
	timer: ReturnType<typeof setTimeout>;
}

type FrameListener = (frame: RpcFrame) => void;
type RpcProcess = Bun.Subprocess<"pipe", "pipe", "pipe">;

export class RpcTransportClosedError extends Error {
	constructor(message = "OMP RPC transport closed") {
		super(message);
		this.name = "RpcTransportClosedError";
	}
}

async function settleWithin<T>(
	promise: Promise<T>,
	timeoutMs: number,
	message: string,
): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			promise,
			new Promise<never>((_, reject) => {
				timer = setTimeout(() => reject(new Error(message)), timeoutMs);
			}),
		]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

export class RpcTransport {
	readonly #options: RpcTransportOptions;
	readonly #listeners = new Set<FrameListener>();
	readonly #pending = new Map<string, PendingRequest>();
	readonly #frameDecoder = new RpcFrameDecoder();
	#process?: RpcProcess;
	#nextRequestId = 0;
	#running = false;
	#stopping = false;
	#readyResolve?: (frame: RpcFrame) => void;
	#readyReject?: (error: Error) => void;
	#readyPromise?: Promise<RpcFrame>;

	constructor(options: RpcTransportOptions) {
		if (options.command.length === 0)
			throw new Error("OMP command cannot be empty");
		this.#options = options;
	}

	get isRunning(): boolean {
		return (
			this.#running &&
			this.#process !== undefined &&
			this.#process.exitCode === null
		);
	}

	onFrame(listener: FrameListener): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	async start(): Promise<void> {
		if (this.#running) return;
		await mkdir(this.#options.sessionDirectory, { recursive: true });
		this.#stopping = false;
		this.#readyPromise = new Promise<RpcFrame>((resolve, reject) => {
			this.#readyResolve = resolve;
			this.#readyReject = reject;
		});

		const process = Bun.spawn(
			[
				...this.#options.command,
				"--mode",
				"rpc",
				"--session-dir",
				this.#options.sessionDirectory,
			],
			{
				cwd: this.#options.cwd,
				env: processEnv(),
				stdin: "pipe",
				stdout: "pipe",
				stderr: "pipe",
			},
		);
		this.#process = process;
		this.#running = true;
		void this.#consumeStdout(process.stdout);
		void this.#consumeStderr(process.stderr);
		void process.exited.then((exitCode) =>
			this.#handleExit(exitCode, process.signalCode),
		);

		const ready = await settleWithin(
			this.#readyPromise,
			this.#options.startTimeoutMs,
			"Timed out waiting for OMP RPC ready frame",
		);
		parseReadyFrame(ready);
		const negotiation = await this.sendCommand<{ protocolVersion: number }>({
			type: "negotiate_protocol",
			protocolVersion: 2,
		});
		if (!isRecord(negotiation.data) || negotiation.data.protocolVersion !== 2) {
			throw new Error("OMP rejected RPC protocol v2 negotiation");
		}
	}

	async sendCommand<T = unknown>(
		command: Record<string, unknown>,
	): Promise<RpcResponse<T>> {
		if (!this.isRunning || !this.#process) throw new RpcTransportClosedError();
		if (typeof command.type !== "string" || command.type.length === 0) {
			throw new Error("RPC command requires a type");
		}
		const id = `gateway-${++this.#nextRequestId}`;
		const line = encodeRpcCommand({ ...command, id });
		const response = new Promise<RpcResponse>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.#pending.delete(id);
				reject(new Error(`RPC command timed out: ${command.type}`));
			}, this.#options.commandTimeoutMs);
			this.#pending.set(id, {
				command: command.type as string,
				resolve,
				reject,
				timer,
			});
		});

		try {
			this.#process.stdin.write(line);
			await this.#process.stdin.flush();
		} catch (error) {
			const pending = this.#pending.get(id);
			if (pending) {
				clearTimeout(pending.timer);
				this.#pending.delete(id);
				pending.reject(
					error instanceof Error ? error : new Error(String(error)),
				);
			}
		}
		return (await response) as RpcResponse<T>;
	}

	async stop(): Promise<void> {
		const process = this.#process;
		if (!process || process.exitCode !== null) return;
		this.#stopping = true;
		try {
			process.stdin.end();
		} catch {
			// The process may already have closed stdin.
		}
		try {
			await settleWithin(
				process.exited,
				this.#options.shutdownTimeoutMs,
				"OMP did not exit after stdin closed",
			);
			return;
		} catch {
			process.kill("SIGTERM");
		}
		try {
			await settleWithin(
				process.exited,
				this.#options.shutdownTimeoutMs,
				"OMP ignored SIGTERM",
			);
		} catch {
			process.kill("SIGKILL");
			await process.exited;
		}
	}

	async #consumeStdout(stream: ReadableStream<Uint8Array>): Promise<void> {
		const reader = stream.getReader();
		const decoder = new TextDecoder();
		let buffered = "";
		try {
			while (true) {
				const { done, value } = await reader.read();
				if (done) break;
				buffered += decoder.decode(value, { stream: true });
				let newline = buffered.indexOf("\n");
				while (newline >= 0) {
					const line = buffered.slice(0, newline);
					buffered = buffered.slice(newline + 1);
					if (Buffer.byteLength(line, "utf8") + 1 > 1024 * 1024) {
						throw new Error("OMP emitted an oversized physical RPC frame");
					}
					if (line.trim().length > 0)
						this.#handlePhysicalFrame(JSON.parse(line));
					newline = buffered.indexOf("\n");
				}
				if (Buffer.byteLength(buffered, "utf8") + 1 > 1024 * 1024) {
					throw new Error("OMP emitted an unterminated oversized RPC frame");
				}
			}
			buffered += decoder.decode();
			if (buffered.trim().length > 0)
				throw new Error("OMP stdout ended with an incomplete RPC frame");
		} catch (error) {
			this.#fail(error instanceof Error ? error : new Error(String(error)));
			if (this.#process?.exitCode === null) this.#process.kill("SIGTERM");
		} finally {
			reader.releaseLock();
		}
	}

	async #consumeStderr(stream: ReadableStream<Uint8Array>): Promise<void> {
		const reader = stream.getReader();
		const decoder = new TextDecoder();
		let buffered = "";
		try {
			while (true) {
				const { done, value } = await reader.read();
				if (done) break;
				buffered += decoder.decode(value, { stream: true });
				const lines = buffered.split("\n");
				buffered = lines.pop() ?? "";
				for (const line of lines) {
					if (line.trim()) console.error(`[omp] ${line}`);
				}
			}
			buffered += decoder.decode();
			if (buffered.trim()) console.error(`[omp] ${buffered}`);
		} finally {
			reader.releaseLock();
		}
	}

	#handlePhysicalFrame(value: unknown): void {
		const frame = this.#frameDecoder.push(value);
		if (!frame) return;
		if (frame.type === "ready") {
			if (!this.#readyResolve)
				throw new Error("Received duplicate RPC ready frame");
			this.#readyResolve(frame);
			this.#readyResolve = undefined;
			this.#readyReject = undefined;
			return;
		}
		if (frame.type === "response") {
			const response = parseResponse(frame);
			const pending = this.#pending.get(response.id);
			if (!pending) return;
			clearTimeout(pending.timer);
			this.#pending.delete(response.id);
			if (response.command !== pending.command) {
				pending.reject(
					new Error(
						`RPC response command mismatch: expected ${pending.command}, got ${response.command}`,
					),
				);
			} else if (!response.success) {
				pending.reject(
					new RpcCommandError(
						response.command,
						response.error ?? "RPC command failed",
						response.code,
					),
				);
			} else {
				pending.resolve(response);
			}
			return;
		}
		for (const listener of this.#listeners) {
			try {
				listener(frame);
			} catch (error) {
				console.error("RPC frame listener failed", error);
			}
		}
	}

	#handleExit(exitCode: number, signalCode: NodeJS.Signals | null): void {
		const expected = this.#stopping;
		this.#running = false;
		this.#process = undefined;
		const detail = signalCode
			? `signal ${signalCode}`
			: `exit code ${exitCode}`;
		this.#fail(
			new RpcTransportClosedError(`OMP RPC process closed with ${detail}`),
		);
		if (!expected) {
			for (const listener of this.#listeners)
				listener({ type: "transport_closed", exitCode, signalCode });
		}
	}

	#fail(error: Error): void {
		this.#readyReject?.(error);
		this.#readyResolve = undefined;
		this.#readyReject = undefined;
		for (const pending of this.#pending.values()) {
			clearTimeout(pending.timer);
			pending.reject(error);
		}
		this.#pending.clear();
	}
}

function processEnv(): Record<string, string> {
	const result: Record<string, string> = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (value !== undefined) result[key] = value;
	}
	return result;
}
