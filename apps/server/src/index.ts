import { DiscordAdapter } from "./adapters/discord";
import { createApp } from "./app";
import { config } from "./config";
import { SessionStore } from "./session/session-store";
import { SessionWorkerPool } from "./session/session-worker-pool";

const store = new SessionStore(config.stateFile);
const pool = new SessionWorkerPool({
	sessionRoot: config.sessionRoot,
	maxWorkers: config.maxWorkers,
	idleMs: config.workerIdleMs,
	store,
	transport: {
		command: config.ompCommand,
		cwd: config.ompCwd,
		startTimeoutMs: config.workerStartTimeoutMs,
		commandTimeoutMs: config.workerCommandTimeoutMs,
		shutdownTimeoutMs: config.workerShutdownTimeoutMs,
	},
});
await pool.initialize();

const app = createApp({
	apiKey: config.apiKey,
	corsOrigin: config.corsOrigin,
	modelId: config.modelId,
	pool,
});

let discord: DiscordAdapter | undefined;
if (config.discord.token) {
	discord = new DiscordAdapter({
		token: config.discord.token,
		pool,
		policy: config.discord,
	});
	await discord.start();
}

const server = Bun.serve({
	hostname: config.host,
	port: config.port,
	fetch: app.fetch,
});
console.info(
	`Hermes gateway listening on http://${server.hostname}:${server.port}`,
);

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
	if (shuttingDown) return;
	shuttingDown = true;
	console.info(`Received ${signal}; shutting down`);
	await server.stop(false);
	await discord?.stop();
	await pool.shutdown();
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
	process.once(signal, () => {
		void shutdown(signal).catch((error) => {
			console.error("Gateway shutdown failed", error);
			process.exitCode = 1;
		});
	});
}

export { app, pool };
