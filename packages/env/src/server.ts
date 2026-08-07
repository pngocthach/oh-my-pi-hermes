import "dotenv/config";
import { createEnv } from "@t3-oss/env-core";
import { z } from "zod";

export const env = createEnv({
	server: {
		CORS_ORIGIN: z.url().default("http://localhost:3000"),
		NODE_ENV: z
			.enum(["development", "production", "test"])
			.default("development"),
		HOST: z.string().min(1).default("127.0.0.1"),
		PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
		GATEWAY_API_KEY: z.string().min(1),
		GATEWAY_MODEL_ID: z.string().min(1).default("omp"),
		GATEWAY_DATA_DIR: z.string().min(1).default("../../var"),
		OMP_BIN: z.string().min(1).default("omp"),
		OMP_PREFIX_ARGS_JSON: z.string().default("[]"),
		OMP_CWD: z.string().optional(),
		MAX_WORKERS: z.coerce.number().int().min(1).default(8),
		WORKER_IDLE_MS: z.coerce.number().int().min(1_000).default(900_000),
		WORKER_START_TIMEOUT_MS: z.coerce.number().int().min(100).default(10_000),
		WORKER_COMMAND_TIMEOUT_MS: z.coerce.number().int().min(100).default(30_000),
		WORKER_SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().min(100).default(5_000),
		DISCORD_TOKEN: z.string().optional(),
		DISCORD_ALLOWED_GUILD_IDS: z.string().default(""),
		DISCORD_ALLOWED_USER_IDS: z.string().default(""),
		DISCORD_ALLOWED_CHANNEL_IDS: z.string().default(""),
		DISCORD_IGNORED_CHANNEL_IDS: z.string().default(""),
		DISCORD_FREE_RESPONSE_CHANNEL_IDS: z.string().default(""),
		DISCORD_ENABLE_DMS: z.coerce.boolean().default(false),
		DISCORD_REQUIRE_MENTION: z.coerce.boolean().default(true),
		DISCORD_AUTO_THREAD: z.coerce.boolean().default(true),
	},
	runtimeEnv: process.env,
	skipValidation: !!process.env.SKIP_ENV_VALIDATION,
	emptyStringAsUndefined: true,
});
