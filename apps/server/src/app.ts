import { timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import { bearerAuth } from "hono/bearer-auth";
import { cors } from "hono/cors";
import { HTTPException } from "hono/http-exception";
import { logger } from "hono/logger";
import { registerOpenAiRoutes } from "./adapters/openai";
import type { SessionWorkerPool } from "./session/session-worker-pool";

export interface GatewayAppOptions {
	apiKey: string;
	corsOrigin: string;
	modelId: string;
	pool: SessionWorkerPool;
}

export function createApp(options: GatewayAppOptions): Hono {
	const app = new Hono();
	app.use(logger());
	app.use(
		"/*",
		cors({
			origin: options.corsOrigin,
			allowMethods: ["GET", "POST", "OPTIONS"],
			allowHeaders: [
				"Authorization",
				"Content-Type",
				"X-OpenWebUI-Chat-Id",
				"X-OpenWebUI-User-Message-Id",
				"X-OpenWebUI-Assistant-Message-Id",
				"X-OpenWebUI-Task",
			],
			exposeHeaders: ["X-OMP-Session-Id"],
		}),
	);
	app.get("/health", (context) =>
		context.json({ status: "ok", workers: options.pool.size }),
	);
	app.use(
		"/v1/*",
		bearerAuth({
			verifyToken: (token) => {
				const actual = Buffer.from(token);
				const expected = Buffer.from(options.apiKey);
				return (
					actual.byteLength === expected.byteLength &&
					timingSafeEqual(actual, expected)
				);
			},
		}),
	);
	registerOpenAiRoutes(app, { modelId: options.modelId, pool: options.pool });
	app.notFound(() =>
		Response.json(
			{ error: { message: "Not found", type: "not_found" } },
			{ status: 404 },
		),
	);
	app.onError((error) => {
		if (error instanceof HTTPException) return error.getResponse();
		console.error("Unhandled gateway request error", error);
		return Response.json(
			{ error: { message: "Internal gateway error", type: "gateway_error" } },
			{ status: 500 },
		);
	});
	return app;
}
