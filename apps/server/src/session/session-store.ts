import { mkdir, rename } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";

const storedSessionSchema = z.object({
	externalId: z.string().min(1),
	sessionId: z.string().min(1),
	sessionFile: z.string().min(1).optional(),
	sessionDirectory: z.string().min(1),
	updatedAt: z.string().datetime(),
	lastExternalMessageId: z.string().min(1).optional(),
	lastAssistantText: z.string().optional(),
});

const storeFileSchema = z.object({
	version: z.literal(1),
	sessions: z.record(z.string(), storedSessionSchema),
});

export type StoredSession = z.infer<typeof storedSessionSchema>;

export class SessionStore {
	readonly #file: string;
	readonly #sessions = new Map<string, StoredSession>();
	#writeChain = Promise.resolve();
	#initialized = false;

	constructor(file: string) {
		this.#file = file;
	}

	async initialize(): Promise<void> {
		if (this.#initialized) return;
		await mkdir(dirname(this.#file), { recursive: true });
		const file = Bun.file(this.#file);
		if (await file.exists()) {
			const parsed = storeFileSchema.parse(await file.json());
			for (const [key, value] of Object.entries(parsed.sessions))
				this.#sessions.set(key, value);
		}
		this.#initialized = true;
	}

	get(externalId: string): StoredSession | undefined {
		return this.#sessions.get(externalId);
	}

	has(externalId: string): boolean {
		return this.#sessions.has(externalId);
	}

	async upsert(session: StoredSession): Promise<void> {
		this.#assertInitialized();
		this.#sessions.set(session.externalId, storedSessionSchema.parse(session));
		await this.#persist();
	}

	async remove(externalId: string): Promise<void> {
		this.#assertInitialized();
		if (!this.#sessions.delete(externalId)) return;
		await this.#persist();
	}

	async flush(): Promise<void> {
		await this.#writeChain;
	}

	#assertInitialized(): void {
		if (!this.#initialized)
			throw new Error("SessionStore must be initialized before use");
	}

	async #persist(): Promise<void> {
		const snapshot: Record<string, StoredSession> = {};
		for (const [key, value] of this.#sessions) snapshot[key] = value;
		const body = `${JSON.stringify({ version: 1, sessions: snapshot }, null, 2)}\n`;
		const temporaryFile = `${this.#file}.${crypto.randomUUID()}.tmp`;
		const write = this.#writeChain.then(async () => {
			await Bun.write(temporaryFile, body);
			await rename(temporaryFile, this.#file);
		});
		this.#writeChain = write.catch(() => undefined);
		await write;
	}
}
