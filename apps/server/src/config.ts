import { resolve } from "node:path";
import { env } from "@oh-my-pi-hermes/env/server";

function parseStringArray(value: string, name: string): string[] {
	let parsed: unknown;
	try {
		parsed = JSON.parse(value);
	} catch {
		throw new Error(`${name} must be a JSON string array`);
	}
	if (
		!Array.isArray(parsed) ||
		parsed.some((item) => typeof item !== "string")
	) {
		throw new Error(`${name} must be a JSON string array`);
	}
	return parsed;
}

function parseIdSet(value: string): ReadonlySet<string> {
	return new Set(
		value
			.split(",")
			.map((item) => item.trim())
			.filter(Boolean),
	);
}

const dataDirectory = resolve(env.GATEWAY_DATA_DIR);

export const config = {
	host: env.HOST,
	port: env.PORT,
	corsOrigin: env.CORS_ORIGIN,
	apiKey: env.GATEWAY_API_KEY,
	modelId: env.GATEWAY_MODEL_ID,
	dataDirectory,
	stateFile: resolve(dataDirectory, "gateway-sessions.json"),
	sessionRoot: resolve(dataDirectory, "omp-sessions"),
	ompCommand: [
		env.OMP_BIN,
		...parseStringArray(env.OMP_PREFIX_ARGS_JSON, "OMP_PREFIX_ARGS_JSON"),
	],
	ompCwd: env.OMP_CWD ? resolve(env.OMP_CWD) : undefined,
	maxWorkers: env.MAX_WORKERS,
	workerIdleMs: env.WORKER_IDLE_MS,
	workerStartTimeoutMs: env.WORKER_START_TIMEOUT_MS,
	workerCommandTimeoutMs: env.WORKER_COMMAND_TIMEOUT_MS,
	workerShutdownTimeoutMs: env.WORKER_SHUTDOWN_TIMEOUT_MS,
	discord: {
		token: env.DISCORD_TOKEN,
		allowedGuildIds: parseIdSet(env.DISCORD_ALLOWED_GUILD_IDS),
		allowedUserIds: parseIdSet(env.DISCORD_ALLOWED_USER_IDS),
		allowedChannelIds: parseIdSet(env.DISCORD_ALLOWED_CHANNEL_IDS),
		ignoredChannelIds: parseIdSet(env.DISCORD_IGNORED_CHANNEL_IDS),
		freeResponseChannelIds: parseIdSet(env.DISCORD_FREE_RESPONSE_CHANNEL_IDS),
		enableDms: env.DISCORD_ENABLE_DMS,
		requireMention: env.DISCORD_REQUIRE_MENTION,
		autoThread: env.DISCORD_AUTO_THREAD,
	},
} as const;

export type GatewayConfig = typeof config;
