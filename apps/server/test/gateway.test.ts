import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/app";
import { textDeltaFromFrame } from "../src/rpc/protocol";
import { RpcTransport } from "../src/rpc/transport";
import { SessionStore } from "../src/session/session-store";
import { SessionWorkerPool } from "../src/session/session-worker-pool";

const temporaryDirectories: string[] = [];
const pools: SessionWorkerPool[] = [];
const fakeOmpCommand = [
	process.execPath,
	join(import.meta.dir, "fixtures/fake-omp.ts"),
];

async function makeDirectory(): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "hermes-gateway-test-"));
	temporaryDirectories.push(directory);
	return directory;
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

afterEach(async () => {
	await Promise.allSettled(pools.splice(0).map((pool) => pool.shutdown()));
	await Promise.allSettled(
		temporaryDirectories
			.splice(0)
			.map((directory) => rm(directory, { recursive: true, force: true })),
	);
});

describe("RPC transport and workers", () => {
	test("negotiates v2 and correlates a prompt response with streamed events", async () => {
		const directory = await makeDirectory();
		const transport = new RpcTransport({
			command: fakeOmpCommand,
			sessionDirectory: join(directory, "session"),
			startTimeoutMs: 5_000,
			commandTimeoutMs: 5_000,
			shutdownTimeoutMs: 500,
		});
		const deltas: string[] = [];
		let resolveDelta: (() => void) | undefined;
		const firstDelta = new Promise<void>((resolve) => {
			resolveDelta = resolve;
		});
		transport.onFrame((frame) => {
			const delta = textDeltaFromFrame(frame);
			if (delta) {
				deltas.push(delta);
				resolveDelta?.();
			}
		});
		await transport.start();
		const response = await transport.sendCommand({
			type: "prompt",
			message: "transport",
		});
		expect(response.success).toBe(true);
		await firstDelta;
		expect(deltas).toEqual(["Echo: transport"]);
		await transport.stop();
	});
	test("lists and switches models through the worker RPC", async () => {
		const directory = await makeDirectory();
		const pool = await makePool(directory);
		const worker = await pool.getOrCreate("discord:model-test");

		await expect(worker.getAvailableModels()).resolves.toEqual([
			{ provider: "fake", id: "fast", name: "Fake Fast" },
			{ provider: "fake", id: "smart", name: "Fake Smart" },
		]);

		await worker.setModel({ provider: "fake", id: "smart" });
		expect(worker.state.model).toMatchObject({
			provider: "fake",
			id: "smart",
		});
	});

	test("resumes the same OMP session after the worker pool restarts", async () => {
		const directory = await makeDirectory();
		const firstPool = await makePool(directory);
		const firstWorker = await firstPool.getOrCreate("openwebui:resume-test");
		let output = "";
		for await (const frame of firstWorker.runPrompt("first"))
			output += textDeltaFromFrame(frame) ?? "";
		expect(output).toBe("Echo: first");
		const sessionId = firstWorker.state.sessionId;
		await firstPool.shutdown();
		pools.splice(pools.indexOf(firstPool), 1);

		const secondPool = await makePool(directory);
		const resumed = await secondPool.getOrCreate("openwebui:resume-test");
		expect(resumed.state.sessionId).toBe(sessionId);
	});
});

describe("OpenAI-compatible adapter", () => {
	test("authenticates, completes, and deduplicates an Open WebUI message", async () => {
		const directory = await makeDirectory();
		const pool = await makePool(directory);
		const app = createApp({
			apiKey: "secret",
			corsOrigin: "http://localhost:3000",
			modelId: "omp",
			pool,
		});
		const body = JSON.stringify({
			model: "omp",
			messages: [{ role: "user", content: "hello" }],
		});
		const headers = {
			Authorization: "Bearer secret",
			"Content-Type": "application/json",
			"X-OpenWebUI-Chat-Id": "chat-one",
			"X-OpenWebUI-User-Message-Id": "message-one",
		};
		const first = await app.request("/v1/chat/completions", {
			method: "POST",
			headers,
			body,
		});
		expect(first.status).toBe(200);
		const firstBody = (await first.json()) as {
			choices: Array<{ message: { content: string } }>;
		};
		expect(firstBody.choices[0]?.message.content).toBe("Echo: hello");

		const duplicate = await app.request("/v1/chat/completions", {
			method: "POST",
			headers,
			body,
		});
		const duplicateBody = (await duplicate.json()) as {
			choices: Array<{ message: { content: string } }>;
		};
		expect(duplicateBody.choices[0]?.message.content).toBe("Echo: hello");
		expect(pool.getStored("openwebui:chat-one")?.lastExternalMessageId).toBe(
			"message-one",
		);
	});

	test("streams OpenAI chunks and a terminal DONE marker", async () => {
		const directory = await makeDirectory();
		const pool = await makePool(directory);
		const app = createApp({
			apiKey: "secret",
			corsOrigin: "http://localhost:3000",
			modelId: "omp",
			pool,
		});
		const response = await app.request("/v1/chat/completions", {
			method: "POST",
			headers: {
				Authorization: "Bearer secret",
				"Content-Type": "application/json",
				"X-OpenWebUI-Chat-Id": "chat-stream",
				"X-OpenWebUI-User-Message-Id": "message-stream",
			},
			body: JSON.stringify({
				model: "omp",
				stream: true,
				messages: [{ role: "user", content: "stream" }],
			}),
		});
		expect(response.status).toBe(200);
		expect(response.headers.get("content-type")).toContain("text/event-stream");
		const body = await response.text();
		expect(body).toContain('"content":"Echo: stream"');
		expect(body).toContain("data: [DONE]");
	});

	test("rejects requests without the configured bearer token", async () => {
		const directory = await makeDirectory();
		const pool = await makePool(directory);
		const app = createApp({
			apiKey: "secret",
			corsOrigin: "http://localhost:3000",
			modelId: "omp",
			pool,
		});
		const response = await app.request("/v1/models");
		expect(response.status).toBe(401);
	});
});
