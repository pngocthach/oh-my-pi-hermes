import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { RpcTransportOptions } from "../rpc/transport";
import type { SessionStore } from "./session-store";
import { SessionWorker } from "./session-worker";

interface PoolEntry {
	worker: SessionWorker;
	lastUsedAt: number;
}

export interface SessionWorkerPoolOptions {
	sessionRoot: string;
	maxWorkers: number;
	idleMs: number;
	store: SessionStore;
	transport: Omit<RpcTransportOptions, "sessionDirectory">;
}

export class WorkerCapacityError extends Error {
	constructor() {
		super("All OMP workers are active");
		this.name = "WorkerCapacityError";
	}
}

export class SessionWorkerPool {
	readonly #options: SessionWorkerPoolOptions;
	readonly #entries = new Map<string, PoolEntry>();
	readonly #creating = new Map<string, Promise<SessionWorker>>();
	#idleTimer?: ReturnType<typeof setInterval>;
	#initialized = false;

	constructor(options: SessionWorkerPoolOptions) {
		this.#options = options;
	}

	get size(): number {
		return this.#entries.size;
	}

	async initialize(): Promise<void> {
		if (this.#initialized) return;
		await mkdir(this.#options.sessionRoot, { recursive: true });
		await this.#options.store.initialize();
		this.#idleTimer = setInterval(
			() => void this.evictIdle(),
			Math.min(this.#options.idleMs, 60_000),
		);
		this.#idleTimer.unref?.();
		this.#initialized = true;
	}

	hasPersisted(externalId: string): boolean {
		return this.#options.store.has(externalId);
	}

	getStored(externalId: string) {
		return this.#options.store.get(externalId);
	}

	async getOrCreate(
		externalId: string,
		persistent = true,
	): Promise<SessionWorker> {
		if (!this.#initialized)
			throw new Error("SessionWorkerPool must be initialized before use");
		const existing = this.#entries.get(externalId);
		if (existing?.worker.isAlive) {
			existing.lastUsedAt = Date.now();
			return existing.worker;
		}
		if (existing) {
			this.#entries.delete(externalId);
			await existing.worker.stop().catch(() => undefined);
		}

		const creating = this.#creating.get(externalId);
		if (creating) return creating;
		const promise = this.#createWorker(externalId, persistent);
		this.#creating.set(externalId, promise);
		try {
			return await promise;
		} finally {
			this.#creating.delete(externalId);
		}
	}

	touch(externalId: string): void {
		const entry = this.#entries.get(externalId);
		if (entry) entry.lastUsedAt = Date.now();
	}

	async evictIdle(now = Date.now()): Promise<void> {
		const stops: Promise<void>[] = [];
		for (const [key, entry] of this.#entries) {
			if (entry.worker.isBusy || now - entry.lastUsedAt < this.#options.idleMs)
				continue;
			this.#entries.delete(key);
			stops.push(entry.worker.stop());
		}
		await Promise.allSettled(stops);
	}

	async shutdown(): Promise<void> {
		clearInterval(this.#idleTimer);
		this.#idleTimer = undefined;
		const workers = [...this.#entries.values()].map((entry) => entry.worker);
		this.#entries.clear();
		await Promise.allSettled(workers.map((worker) => worker.stop()));
		await this.#options.store.flush();
	}

	async #createWorker(
		externalId: string,
		persistent: boolean,
	): Promise<SessionWorker> {
		await this.#ensureCapacity();
		const digest = createHash("sha256").update(externalId).digest("hex");
		const worker = new SessionWorker({
			externalId,
			sessionDirectory: join(this.#options.sessionRoot, digest),
			persistent,
			store: this.#options.store,
			transport: this.#options.transport,
		});
		await worker.start();
		this.#entries.set(externalId, { worker, lastUsedAt: Date.now() });
		return worker;
	}

	async #ensureCapacity(): Promise<void> {
		if (this.#entries.size < this.#options.maxWorkers) return;
		let oldest: [string, PoolEntry] | undefined;
		for (const candidate of this.#entries) {
			if (candidate[1].worker.isBusy) continue;
			if (!oldest || candidate[1].lastUsedAt < oldest[1].lastUsedAt)
				oldest = candidate;
		}
		if (!oldest) throw new WorkerCapacityError();
		this.#entries.delete(oldest[0]);
		await oldest[1].worker.stop();
	}
}
