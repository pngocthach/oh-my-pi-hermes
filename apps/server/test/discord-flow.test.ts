import { afterEach, describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Client, Events } from "discord.js";
import { DiscordAdapter } from "../src/adapters/discord";
import { SessionStore } from "../src/session/session-store";
import { SessionWorkerPool } from "../src/session/session-worker-pool";

const fakeOmpCommand = [
	process.execPath,
	join(import.meta.dir, "fixtures/fake-omp.ts"),
];

const temporaryDirectories: string[] = [];
const pools: SessionWorkerPool[] = [];
const adapters: DiscordAdapter[] = [];

interface Sent {
	id: string;
	content: string;
	replyMessageReference?: string;
}

interface ChannelRecord {
	channel: unknown;
	sent: Sent[];
	editCalls: number;
	name?: string;
}

let messageCounter = 0;

function makeChannel(dm: boolean, thread = false): ChannelRecord {
	const sent: Sent[] = [];
	const record: ChannelRecord = {
		channel: undefined as never,
		sent,
		editCalls: 0,
	};
	const channel = {
		id: thread ? "thread-1" : "ch-1",
		isDMBased: () => dm,
		isThread: () => thread,
		get parentId() {
			return thread ? "ch-1" : undefined;
		},
		setName: async (name: string) => {
			record.name = name;
		},
		sendTyping: async () => undefined,
		send: async (options: {
			content: string;
			reply?: { messageReference: string; failIfNotExists?: boolean };
		}) => {
			const id = `out-${messageCounter}`;
			sent.push({
				id,
				content: options.content,
				replyMessageReference: options.reply?.messageReference,
			});
			return {
				id,
				content: options.content,
				edit: async (editOptions: { content: string }) => {
					record.editCalls += 1;
					const previous = record.sent.at(-1);
					record.sent[record.sent.length - 1] = {
						id: previous?.id ?? id,
						content: editOptions.content,
						replyMessageReference: previous?.replyMessageReference,
					};
				},
				delete: async () => undefined,
			};
		},
		messages: { fetch: async () => new Map() },
	};
	record.channel = channel;
	return record;
}

class FakeClient extends EventEmitter {
	user: { id: string; tag: string } | null = {
		id: "bot-1",
		tag: "Hermes#0000",
	};
	async login(): Promise<string> {
		this.emit(Events.ClientReady, {});
		return "ok";
	}
	async destroy(): Promise<void> {}
}

function makeUserMessage(content: string, channel: unknown) {
	const reactions: string[] = [];
	return {
		id: `user-msg-${++messageCounter}`,
		author: { id: "user-1", bot: false },
		webhookId: undefined,
		content,
		channel,
		guildId: null,
		mentions: { users: new Map() },
		createdTimestamp: Date.now(),
		reactions,
		react: async (emoji: string) => {
			reactions.push(emoji);
		},
	};
}

async function makePool(directory: string): Promise<SessionWorkerPool> {
	const pool = new SessionWorkerPool({
		sessionRoot: join(directory, "sessions"),
		maxWorkers: 2,
		idleMs: 60_000,
		store: new SessionStore(join(directory, "gateway-sessions.json")),
		transport: {
			command: fakeOmpCommand,
			startTimeoutMs: 5_000,
			commandTimeoutMs: 5_000,
			shutdownTimeoutMs: 500,
		},
	});
	await pool.initialize();
	pools.push(pool);
	return pool;
}

async function makeAdapter(
	directory: string,
	fakeClient: Client,
	guild = false,
) {
	const pool = await makePool(directory);
	const adapter = new DiscordAdapter({
		token: "test-token",
		pool,
		client: fakeClient,
		registerCommands: false,
		policy: {
			allowedGuildIds: guild ? new Set(["guild-1"]) : new Set(),
			allowedUserIds: new Set(["user-1"]),
			allowedChannelIds: new Set(),
			ignoredChannelIds: new Set(),
			freeResponseChannelIds: new Set(),
			enableDms: true,
			requireMention: guild,
			autoThread: guild,
		},
	});
	adapters.push(adapter);
	return adapter;
}
async function waitForMessage(
	record: ChannelRecord,
	timeoutMs = 5_000,
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (record.sent.length === 0 && Date.now() < deadline) {
		await Bun.sleep(20);
	}
	expect(record.sent.length).toBeGreaterThan(0);
}

afterEach(async () => {
	await Promise.allSettled(pools.splice(0).map((pool) => pool.shutdown()));
	await Promise.allSettled(adapters.splice(0).map((adapter) => adapter.stop()));
	await Promise.allSettled(
		temporaryDirectories
			.splice(0)
			.map((directory) => rm(directory, { recursive: true, force: true })),
	);
});

describe("Discord adapter message pipeline", () => {
	test("one multi-line user message produces exactly one bot message", async () => {
		const directory = await mkdtemp(join(tmpdir(), "hermes-discord-"));
		temporaryDirectories.push(directory);
		const fakeClient = new FakeClient();
		const adapter = await makeAdapter(
			directory,
			fakeClient as unknown as Client,
		);
		await adapter.start();
		const record = makeChannel(true);
		const userMessage = makeUserMessage(
			"dòng một\ndòng hai",
			record.channel,
		);
		fakeClient.emit(Events.MessageCreate, userMessage);
		await waitForMessage(record);
		// Drain debounce has passed; allow the turn to finish editing.
		await Bun.sleep(150);
		expect(record.sent).toHaveLength(1);
		expect(userMessage.reactions).toEqual(["👀", "✅"]);
	});

	test("two rapid user messages are merged into a single turn", async () => {
		const directory = await mkdtemp(join(tmpdir(), "hermes-discord-"));
		temporaryDirectories.push(directory);
		const fakeClient = new FakeClient();
		const adapter = await makeAdapter(
			directory,
			fakeClient as unknown as Client,
		);
		await adapter.start();
		const record = makeChannel(true);
		fakeClient.emit(
			Events.MessageCreate,
			makeUserMessage("first", record.channel),
		);
		fakeClient.emit(
			Events.MessageCreate,
			makeUserMessage("second", record.channel),
		);
		await waitForMessage(record);
		await Bun.sleep(150);
		expect(record.sent).toHaveLength(1);
		expect(record.sent[0]?.content).toBe("Echo: first\n\nsecond");
	});

	test("a reply longer than 2000 chars splits into multiple messages", async () => {
		const directory = await mkdtemp(join(tmpdir(), "hermes-discord-"));
		temporaryDirectories.push(directory);
		const fakeClient = new FakeClient();
		const adapter = await makeAdapter(
			directory,
			fakeClient as unknown as Client,
		);
		await adapter.start();
		const record = makeChannel(true);
		// "LONG:" makes fake-omp emit a multi-line reply just over 2000 chars,
		// forcing Discord's message-limit splitter into 2 chunks.
		fakeClient.emit(
			Events.MessageCreate,
			makeUserMessage("LONG: explain", record.channel),
		);
		await waitForMessage(record);
		await Bun.sleep(200);
		expect(record.sent.length).toBe(2);
		const combined = record.sent.map((m) => m.content).join("\n");
		expect(combined).toContain("Line one");
		expect(combined).toContain("The end");
	});

	test("a follow-up sent while a turn is running yields a second reply", async () => {
		const previous = process.env.FAKE_OMP_DELAY_MS;
		process.env.FAKE_OMP_DELAY_MS = "800";
		try {
			const directory = await mkdtemp(join(tmpdir(), "hermes-discord-"));
			temporaryDirectories.push(directory);
			const fakeClient = new FakeClient();
			const adapter = await makeAdapter(
				directory,
				fakeClient as unknown as Client,
			);
			await adapter.start();
			const record = makeChannel(true);
			fakeClient.emit(
				Events.MessageCreate,
				makeUserMessage("first", record.channel),
			);
			// First turn is in flight (drain 250ms + fake delay 800ms); the
			// follow-up arrives after the debounce window, so it gets its own turn.
			await Bun.sleep(450);
			fakeClient.emit(
				Events.MessageCreate,
				makeUserMessage("second", record.channel),
			);
			await waitForMessage(record, 8_000);
			// Allow both turns to complete.
			await Bun.sleep(1_800);
			expect(record.sent.length).toBe(2);
			expect(record.sent[0]?.content).toBe("Echo: first");
			expect(record.sent[1]?.content).toBe("Echo: second");
		} finally {
			process.env.FAKE_OMP_DELAY_MS = previous;
		}
	});
	test("sends overflow continuations as consecutive messages", async () => {
		const directory = await mkdtemp(join(tmpdir(), "hermes-discord-"));
		temporaryDirectories.push(directory);
		const fakeClient = new FakeClient();
		const adapter = await makeAdapter(
			directory,
			fakeClient as unknown as Client,
		);
		await adapter.start();
		const record = makeChannel(true);
		fakeClient.emit(
			Events.MessageCreate,
			makeUserMessage("LONG: report", record.channel),
		);
		await Bun.sleep(600);
		expect(record.sent.length).toBe(2);
		expect(record.sent[1]?.replyMessageReference).toBeUndefined();
		expect(record.sent[1]?.content).toContain("(2/2)");
	});
	test("renames an auto-created thread with a generated title", async () => {
		const directory = await mkdtemp(join(tmpdir(), "hermes-discord-"));
		temporaryDirectories.push(directory);
		const fakeClient = new FakeClient();
		const adapter = await makeAdapter(
			directory,
			fakeClient as unknown as Client,
			true,
		);
		await adapter.start();
		const parent = makeChannel(false);
		const thread = makeChannel(false, true);
		const message = Object.assign(
			makeUserMessage("<@bot-1> Check the current system", parent.channel),
			{
				guildId: "guild-1",
				mentions: { users: new Map([["bot-1", {}]]) },
				startThread: async () => thread.channel,
			},
		);
		fakeClient.emit(Events.MessageCreate, message);
		await waitForMessage(thread);
		const deadline = Date.now() + 5_000;
		while (!thread.name && Date.now() < deadline) await Bun.sleep(20);
		expect(thread.name).toContain("Echo:");
	});
});
