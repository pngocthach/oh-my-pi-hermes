import {
	Client,
	Events,
	GatewayIntentBits,
	type Message,
	type MessageCreateOptions,
	Partials,
	ThreadAutoArchiveDuration,
} from "discord.js";
import { discordStreamPreview, splitDiscordMessage } from "../message-format";
import { type RpcFrame, textDeltaFromFrame } from "../rpc/protocol";
import type { SessionWorkerPool } from "../session/session-worker-pool";

const STREAM_EDIT_INTERVAL_MS = 800;
const STREAM_BUFFER_THRESHOLD = 24;
const TYPING_REFRESH_MS = 2_000;
const MAX_DEDUP_IDS = 4_096;
const SAFE_MENTIONS = { parse: [] as const, repliedUser: false };

interface DiscordPolicy {
	allowedGuildIds: ReadonlySet<string>;
	allowedUserIds: ReadonlySet<string>;
	allowedChannelIds: ReadonlySet<string>;
	ignoredChannelIds: ReadonlySet<string>;
	freeResponseChannelIds: ReadonlySet<string>;
	enableDms: boolean;
	requireMention: boolean;
	autoThread: boolean;
}

export interface DiscordAdapterOptions {
	token: string;
	pool: SessionWorkerPool;
	policy: DiscordPolicy;
	/** Inject a pre-configured client (tests, custom intents). */
	client?: Client;
}
interface DiscordOutputChannel {
	id: string;
	sendTyping(): Promise<void>;
	send(options: MessageCreateOptions): Promise<Message>;
}

interface PendingDiscordPrompt {
	content: string;
	message: Message;
	channel: DiscordOutputChannel;
	sessionKey: string;
}

interface ConversationQueue {
	running: boolean;
	pending: PendingDiscordPrompt[];
}

export class DiscordAdapter {
	readonly #options: DiscordAdapterOptions;
	readonly #client: Client;
	readonly #seenMessageIds = new Set<string>();
	readonly #queues = new Map<string, ConversationQueue>();

	constructor(options: DiscordAdapterOptions) {
		this.#options = options;
		this.#client =
			options.client ??
			new Client({
				intents: [
					GatewayIntentBits.Guilds,
					GatewayIntentBits.GuildMessages,
					GatewayIntentBits.DirectMessages,
					GatewayIntentBits.MessageContent,
				],
				partials: [Partials.Channel],
				allowedMentions: SAFE_MENTIONS,
			});
		this.#client.on(
			Events.MessageCreate,
			(message) => void this.#onMessage(message),
		);
		this.#client.on(Events.Error, (error) =>
			console.error("Discord client error", error),
		);
		this.#client.on(Events.Warn, (warning) =>
			console.warn("Discord client warning", warning),
		);
	}

	async start(): Promise<void> {
		if (
			this.#options.policy.allowedGuildIds.size === 0 &&
			this.#options.policy.allowedUserIds.size === 0
		) {
			console.warn(
				"Discord adapter is fail-closed: configure an allowed guild or user ID",
			);
		}
		const ready = new Promise<void>((resolve) =>
			this.#client.once(Events.ClientReady, () => resolve()),
		);
		await this.#client.login(this.#options.token);
		await Promise.race([
			ready,
			Bun.sleep(30_000).then(() => {
				throw new Error(
					"Discord client did not become ready within 30 seconds",
				);
			}),
		]);
		console.info(`Discord connected as ${this.#client.user?.tag ?? "unknown"}`);
	}

	async stop(): Promise<void> {
		this.#client.destroy();
		const drains = [...this.#queues.values()]
			.filter((queue) => queue.running)
			.map(async (queue) => {
				while (queue.running) await Bun.sleep(25);
			});
		await Promise.allSettled(drains);
	}

	async #onMessage(message: Message): Promise<void> {
		if (!this.#admitMessage(message)) return;
		const botId = this.#client.user?.id;
		if (!botId) return;
		if (!("send" in message.channel) || !("sendTyping" in message.channel))
			return;
		const isDm = message.channel.isDMBased();
		const parentId = message.channel.isThread()
			? message.channel.parentId
			: null;
		const channelKeys = new Set([
			message.channel.id,
			...(parentId ? [parentId] : []),
		]);
		if (
			[...channelKeys].some((id) =>
				this.#options.policy.ignoredChannelIds.has(id),
			)
		)
			return;
		if (
			this.#options.policy.allowedChannelIds.size > 0 &&
			![...channelKeys].some((id) =>
				this.#options.policy.allowedChannelIds.has(id),
			)
		) {
			return;
		}

		const mentioned =
			message.mentions.users.has(botId) ||
			message.content.includes(`<@${botId}>`) ||
			message.content.includes(`<@!${botId}>`);
		const freeResponse = [...channelKeys].some((id) =>
			this.#options.policy.freeResponseChannelIds.has(id),
		);
		let sessionKey = this.#sessionKey(message);
		const activeThread =
			message.channel.isThread() &&
			(this.#queues.has(sessionKey) ||
				this.#options.pool.hasPersisted(sessionKey));
		if (
			!isDm &&
			this.#options.policy.requireMention &&
			!freeResponse &&
			!activeThread &&
			!mentioned
		)
			return;

		let content = message.content
			.replaceAll(`<@${botId}>`, "")
			.replaceAll(`<@!${botId}>`, "")
			.trim();
		if (!content) return;
		let outputChannel: DiscordOutputChannel = message.channel;

		if (
			!isDm &&
			!message.channel.isThread() &&
			mentioned &&
			this.#options.policy.autoThread &&
			!freeResponse
		) {
			try {
				const firstLine =
					content.split("\n", 1)[0]?.trim() || "Hermes conversation";
				const thread = await message.startThread({
					name: firstLine.slice(0, 100),
					autoArchiveDuration: ThreadAutoArchiveDuration.OneHour,
					reason: "Isolate an agent conversation",
				});
				outputChannel = thread;
				sessionKey = `discord:${message.guildId}:thread:${thread.id}`;
			} catch (error) {
				await message.channel.send({
					content:
						"Hermes could not create a Discord thread, so the request was not processed. Please retry.",
					allowedMentions: SAFE_MENTIONS,
				});
				console.error("Discord auto-thread failed", error);
				return;
			}
		}

		if (!isDm) {
			const context = await this.#fetchHistoryContext(message);
			if (context)
				content = `[Recent Discord context]\n${context}\n\n[Current message]\n${content}`;
		}
		this.#enqueue({ content, message, channel: outputChannel, sessionKey });
	}

	#admitMessage(message: Message): boolean {
		if (this.#seenMessageIds.has(message.id)) return false;
		this.#seenMessageIds.add(message.id);
		if (this.#seenMessageIds.size > MAX_DEDUP_IDS) {
			const oldest = this.#seenMessageIds.values().next().value;
			if (oldest) this.#seenMessageIds.delete(oldest);
		}
		if (
			message.author.id === this.#client.user?.id ||
			message.author.bot ||
			message.webhookId
		)
			return false;
		if (message.channel.isDMBased()) {
			return (
				this.#options.policy.enableDms &&
				this.#options.policy.allowedUserIds.has(message.author.id)
			);
		}
		if (!message.guildId) return false;
		const guildAllowed =
			this.#options.policy.allowedGuildIds.size > 0 &&
			this.#options.policy.allowedGuildIds.has(message.guildId);
		const userAllowed =
			this.#options.policy.allowedUserIds.size > 0 &&
			this.#options.policy.allowedUserIds.has(message.author.id);
		return guildAllowed || userAllowed;
	}

	#sessionKey(message: Message): string {
		if (message.channel.isDMBased()) return `discord:dm:${message.channel.id}`;
		if (message.channel.isThread())
			return `discord:${message.guildId}:thread:${message.channel.id}`;
		return `discord:${message.guildId}:channel:${message.channel.id}:user:${message.author.id}`;
	}

	#enqueue(prompt: PendingDiscordPrompt): void {
		let queue = this.#queues.get(prompt.sessionKey);
		if (!queue) {
			queue = { running: false, pending: [] };
			this.#queues.set(prompt.sessionKey, queue);
		}
		queue.pending.push(prompt);
		if (!queue.running) void this.#drain(prompt.sessionKey, queue);
	}

	async #drain(sessionKey: string, queue: ConversationQueue): Promise<void> {
		queue.running = true;
		try {
			while (queue.pending.length > 0) {
				await Bun.sleep(250);
				const pending = queue.pending.splice(0);
				const latest = pending.at(-1);
				if (!latest) continue;
				await this.#runTurn({
					...latest,
					content: pending.map((item) => item.content).join("\n\n"),
				});
			}
		} finally {
			queue.running = false;
			if (queue.pending.length === 0) this.#queues.delete(sessionKey);
		}
	}

	async #runTurn(prompt: PendingDiscordPrompt): Promise<void> {
		let typingTimer: ReturnType<typeof setInterval> | undefined;
		let responseMessage: Message | undefined;
		let visibleText = "";
		let statusText = "";
		let lastPreview = "";
		let lastEditAt = 0;
		try {
			await prompt.channel.sendTyping();
			typingTimer = setInterval(
				() => void prompt.channel.sendTyping().catch(() => undefined),
				TYPING_REFRESH_MS,
			);
			const worker = await this.#options.pool.getOrCreate(
				prompt.sessionKey,
				true,
			);
			for await (const frame of worker.runPrompt(prompt.content)) {
				const text = textDeltaFromFrame(frame);
				if (text) visibleText += text;
				statusText = this.#statusForFrame(frame, statusText);
				const display = visibleText || statusText;
				if (!display) continue;
				const preview = discordStreamPreview(display);
				const elapsed = Date.now() - lastEditAt;
				if (
					preview === lastPreview ||
					(preview.length - lastPreview.length < STREAM_BUFFER_THRESHOLD &&
						elapsed < STREAM_EDIT_INTERVAL_MS)
				) {
					continue;
				}
				if (!responseMessage)
					responseMessage = await this.#sendInitial(prompt, preview);
				else
					await responseMessage.edit({
						content: preview,
						allowedMentions: SAFE_MENTIONS,
					});
				lastPreview = preview;
				lastEditAt = Date.now();
			}

			if (!visibleText) {
				if (responseMessage)
					await responseMessage.delete().catch(() => undefined);
				return;
			}
			const chunks = splitDiscordMessage(visibleText);
			if (!responseMessage)
				responseMessage = await this.#sendInitial(
					prompt,
					chunks[0] ?? visibleText,
				);
			else
				await responseMessage.edit({
					content: chunks[0] ?? visibleText,
					allowedMentions: SAFE_MENTIONS,
				});
			let previous = responseMessage;
			for (const chunk of chunks.slice(1)) {
				previous = await prompt.channel.send({
					content: chunk,
					reply: { messageReference: previous.id, failIfNotExists: false },
					allowedMentions: SAFE_MENTIONS,
				});
			}
		} catch (error) {
			console.error(`Discord turn failed for ${prompt.sessionKey}`, error);
			const content = `Gateway error: ${error instanceof Error ? error.message : String(error)}`;
			if (responseMessage)
				await responseMessage
					.edit({ content, allowedMentions: SAFE_MENTIONS })
					.catch(() => undefined);
			else await this.#sendInitial(prompt, content).catch(() => undefined);
		} finally {
			clearInterval(typingTimer);
		}
	}

	async #sendInitial(
		prompt: PendingDiscordPrompt,
		content: string,
	): Promise<Message> {
		const options: MessageCreateOptions = {
			content,
			allowedMentions: SAFE_MENTIONS,
		};
		if (prompt.channel.id === prompt.message.channel.id) {
			options.reply = {
				messageReference: prompt.message.id,
				failIfNotExists: false,
			};
		}
		return prompt.channel.send(options);
	}

	#statusForFrame(frame: RpcFrame, current: string): string {
		if (
			frame.type === "tool_execution_start" &&
			typeof frame.toolName === "string"
		) {
			return `Running tool: ${frame.toolName}…`;
		}
		if (
			frame.type === "tool_execution_end" &&
			typeof frame.toolName === "string"
		) {
			return `Finished tool: ${frame.toolName}`;
		}
		return current;
	}

	async #fetchHistoryContext(message: Message): Promise<string | undefined> {
		try {
			const history = await message.channel.messages.fetch({
				limit: 30,
				before: message.id,
			});
			const ordered = [...history.values()].sort(
				(left, right) => left.createdTimestamp - right.createdTimestamp,
			);
			let start = 0;
			for (let index = ordered.length - 1; index >= 0; index -= 1) {
				if (ordered[index]?.author.id === this.#client.user?.id) {
					start = index + 1;
					break;
				}
			}
			const lines = ordered
				.slice(start)
				.filter((item) => !item.author.bot && item.content.trim())
				.map((item) => `${item.author.displayName}: ${item.content.trim()}`);
			return lines.length > 0 ? lines.join("\n") : undefined;
		} catch (error) {
			console.warn("Discord history backfill failed", error);
			return undefined;
		}
	}
}
