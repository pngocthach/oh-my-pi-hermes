import { z } from "zod";
import {
	isTerminalAgentEnd,
	parseSessionState,
	type RpcFrame,
	type RpcSessionState,
} from "../rpc/protocol";
import { RpcTransport, type RpcTransportOptions } from "../rpc/transport";
import type { SessionStore, StoredSession } from "./session-store";

const promptResponseSchema = z.object({ agentInvoked: z.boolean() }).optional();

type EventListener = (frame: RpcFrame) => void;

class AsyncFrameQueue implements AsyncIterable<RpcFrame> {
	readonly #frames: RpcFrame[] = [];
	readonly #waiters: Array<{
		resolve: (result: IteratorResult<RpcFrame>) => void;
		reject: (error: Error) => void;
	}> = [];
	#closed = false;
	#error?: Error;

	push(frame: RpcFrame): void {
		if (this.#closed) return;
		const waiter = this.#waiters.shift();
		if (waiter) waiter.resolve({ done: false, value: frame });
		else this.#frames.push(frame);
	}

	close(): void {
		if (this.#closed) return;
		this.#closed = true;
		for (const waiter of this.#waiters.splice(0))
			waiter.resolve({ done: true, value: undefined });
	}

	fail(error: Error): void {
		if (this.#closed) return;
		this.#closed = true;
		this.#error = error;
		for (const waiter of this.#waiters.splice(0)) waiter.reject(error);
	}

	[Symbol.asyncIterator](): AsyncIterator<RpcFrame> {
		return {
			next: () => {
				const frame = this.#frames.shift();
				if (frame) return Promise.resolve({ done: false, value: frame });
				if (this.#error) return Promise.reject(this.#error);
				if (this.#closed)
					return Promise.resolve({ done: true, value: undefined });
				return new Promise<IteratorResult<RpcFrame>>((resolve, reject) => {
					this.#waiters.push({ resolve, reject });
				});
			},
		};
	}
}

export interface SessionWorkerOptions {
	externalId: string;
	sessionDirectory: string;
	persistent: boolean;
	store: SessionStore;
	transport: Omit<RpcTransportOptions, "sessionDirectory">;
}

export class SessionBusyError extends Error {
	constructor() {
		super("A turn is already active for this conversation");
		this.name = "SessionBusyError";
	}
}

export class SessionWorker {
	readonly externalId: string;
	readonly sessionDirectory: string;
	readonly persistent: boolean;
	readonly #store: SessionStore;
	readonly #transportOptions: Omit<RpcTransportOptions, "sessionDirectory">;
	readonly #listeners = new Set<EventListener>();
	#transport?: RpcTransport;
	#state?: RpcSessionState;
	#record?: StoredSession;
	#activeTurn = false;
	#alive = false;

	constructor(options: SessionWorkerOptions) {
		this.externalId = options.externalId;
		this.sessionDirectory = options.sessionDirectory;
		this.persistent = options.persistent;
		this.#store = options.store;
		this.#transportOptions = options.transport;
	}

	get isAlive(): boolean {
		return this.#alive && this.#transport?.isRunning === true;
	}

	get isBusy(): boolean {
		return this.#activeTurn;
	}

	get state(): RpcSessionState {
		if (!this.#state) throw new Error("Session worker has not started");
		return this.#state;
	}

	get storedSession(): StoredSession | undefined {
		return this.#record;
	}

	onEvent(listener: EventListener): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	async start(): Promise<void> {
		if (this.isAlive) return;
		let lastError: Error | undefined;
		for (const delayMs of [0, 250, 1_000]) {
			if (delayMs > 0) await Bun.sleep(delayMs);
			const transport = new RpcTransport({
				...this.#transportOptions,
				sessionDirectory: this.sessionDirectory,
			});
			this.#transport = transport;
			transport.onFrame((frame) => this.#dispatch(frame));
			try {
				await transport.start();
				lastError = undefined;
				break;
			} catch (error) {
				lastError = error instanceof Error ? error : new Error(String(error));
				await transport.stop().catch(() => undefined);
			}
		}
		if (lastError || !this.#transport?.isRunning)
			throw lastError ?? new Error("Failed to start OMP worker");

		const stored = this.persistent
			? this.#store.get(this.externalId)
			: undefined;
		this.#record = stored;
		if (stored?.sessionFile) {
			if (await Bun.file(stored.sessionFile).exists()) {
				await this.#transport.sendCommand({
					type: "switch_session",
					sessionPath: stored.sessionFile,
				});
			} else {
				await this.#store.remove(this.externalId);
			}
		}
		await this.#refreshState();
		if (!this.#state?.sessionName && this.#state?.messageCount === 0) {
			await this.#transport.sendCommand({
				type: "set_session_name",
				name: this.externalId.slice(0, 200),
			});
			await this.#refreshState();
		}
		this.#alive = true;
	}

	async *runPrompt(
		message: string,
		signal?: AbortSignal,
	): AsyncGenerator<RpcFrame> {
		if (!this.#transport || !this.isAlive)
			throw new Error("Session worker is not running");
		if (this.#activeTurn) throw new SessionBusyError();
		if (signal?.aborted)
			throw signal.reason ?? new DOMException("Aborted", "AbortError");

		this.#activeTurn = true;
		const frames = new AsyncFrameQueue();
		let terminal = false;
		const unsubscribe = this.onEvent((frame) => {
			frames.push(frame);
			if (frame.type === "transport_closed") {
				frames.fail(new Error("OMP worker closed during the active turn"));
			} else if (
				frame.type === "prompt_result" &&
				frame.agentInvoked === false
			) {
				terminal = true;
				frames.close();
			} else if (isTerminalAgentEnd(frame)) {
				terminal = true;
				frames.close();
			}
		});
		const onAbort = () => {
			void this.abort();
		};
		signal?.addEventListener("abort", onAbort, { once: true });

		try {
			const response = await this.#transport.sendCommand({
				type: "prompt",
				message,
			});
			const result = promptResponseSchema.parse(response.data);
			if (result?.agentInvoked === false) return;
			for await (const frame of frames) yield frame;
		} finally {
			unsubscribe();
			signal?.removeEventListener("abort", onAbort);
			if (!terminal && this.#transport.isRunning)
				await this.abort().catch(() => undefined);
			this.#activeTurn = false;
			if (this.#transport.isRunning)
				await this.#refreshState().catch(() => undefined);
		}
	}

	async followUp(message: string): Promise<void> {
		if (!this.#transport || !this.isAlive)
			throw new Error("Session worker is not running");
		await this.#transport.sendCommand({ type: "follow_up", message });
	}

	async abort(): Promise<void> {
		if (!this.#transport?.isRunning) return;
		await this.#transport.sendCommand({ type: "abort" });
	}

	async commitExternalMessage(
		messageId: string | undefined,
		assistantText: string,
	): Promise<void> {
		if (!this.#record) return;
		this.#record = {
			...this.#record,
			updatedAt: new Date().toISOString(),
			lastExternalMessageId: messageId || undefined,
			lastAssistantText: assistantText,
		};
		if (this.persistent) await this.#store.upsert(this.#record);
	}

	async stop(): Promise<void> {
		if (this.#activeTurn) await this.abort().catch(() => undefined);
		await this.#transport?.stop();
		this.#alive = false;
	}

	#dispatch(frame: RpcFrame): void {
		if (frame.type === "transport_closed") this.#alive = false;
		for (const listener of this.#listeners) listener(frame);
	}

	async #refreshState(): Promise<void> {
		if (!this.#transport) throw new Error("Session worker has no transport");
		const response = await this.#transport.sendCommand({ type: "get_state" });
		this.#state = parseSessionState(response.data);
		this.#record = {
			externalId: this.externalId,
			sessionId: this.#state.sessionId,
			sessionFile: this.#state.sessionFile,
			sessionDirectory: this.sessionDirectory,
			updatedAt: new Date().toISOString(),
			lastExternalMessageId: this.#record?.lastExternalMessageId,
			lastAssistantText: this.#record?.lastAssistantText,
		};
		if (this.persistent) await this.#store.upsert(this.#record);
	}
}
