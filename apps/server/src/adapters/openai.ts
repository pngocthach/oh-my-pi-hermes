import type { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import {
	type RpcFrame,
	textDeltaFromFrame,
	thinkingDeltaFromFrame,
} from "../rpc/protocol";
import {
	SessionBusyError,
	type SessionWorker,
} from "../session/session-worker";
import {
	type SessionWorkerPool,
	WorkerCapacityError,
} from "../session/session-worker-pool";

const contentPartSchema = z
	.object({
		type: z.string(),
		text: z.string().optional(),
	})
	.passthrough();

const messageSchema = z
	.object({
		role: z.enum(["system", "developer", "user", "assistant", "tool"]),
		content: z.union([z.string(), z.array(contentPartSchema), z.null()]),
	})
	.passthrough();

const completionSchema = z
	.object({
		model: z.string().min(1),
		messages: z.array(messageSchema).min(1),
		stream: z.boolean().optional().default(false),
		stream_options: z
			.object({ include_usage: z.boolean().optional() })
			.passthrough()
			.optional(),
	})
	.passthrough();

type CompletionRequest = z.infer<typeof completionSchema>;

export interface OpenAiAdapterOptions {
	modelId: string;
	pool: SessionWorkerPool;
}

interface ConversationTarget {
	externalId: string;
	persistent: boolean;
	messageId?: string;
}

function messageText(
	content: CompletionRequest["messages"][number]["content"],
): string {
	if (typeof content === "string") return content;
	if (!content) return "";
	return content.map((part) => part.text ?? "").join("");
}

function openAiError(message: string, type: string, status: number): Response {
	return Response.json({ error: { message, type } }, { status });
}

function completionTarget(headers: Headers): ConversationTarget {
	const chatId = headers.get("X-OpenWebUI-Chat-Id")?.trim();
	const userMessageId =
		headers.get("X-OpenWebUI-User-Message-Id")?.trim() || undefined;
	const task = headers.get("X-OpenWebUI-Task")?.trim();
	if (task) {
		return {
			externalId: `openwebui-task:${chatId || "anonymous"}:${task}:${crypto.randomUUID()}`,
			persistent: false,
			messageId: userMessageId,
		};
	}
	if (!chatId) {
		return {
			externalId: `openai-ephemeral:${crypto.randomUUID()}`,
			persistent: false,
			messageId: userMessageId,
		};
	}
	if (chatId.length > 512) throw new Error("X-OpenWebUI-Chat-Id is too long");
	return {
		externalId: `openwebui:${chatId}`,
		persistent:
			!chatId.startsWith("temporary:") && !chatId.startsWith("local:"),
		messageId: userMessageId,
	};
}

function promptFromRequest(
	body: CompletionRequest,
	worker: SessionWorker,
): string {
	const userMessage = [...body.messages]
		.reverse()
		.find((message) => message.role === "user");
	if (!userMessage) throw new Error("A user message is required");
	const userText = messageText(userMessage.content).trim();
	if (!userText) throw new Error("The last user message is empty");
	if (worker.state.messageCount > 0) return userText;
	const instructions = body.messages
		.filter(
			(message) => message.role === "system" || message.role === "developer",
		)
		.map((message) => messageText(message.content).trim())
		.filter(Boolean)
		.join("\n\n");
	return instructions
		? `[Client instructions]\n${instructions}\n\n[User]\n${userText}`
		: userText;
}

function chunkEnvelope(
	id: string,
	created: number,
	model: string,
	delta: Record<string, unknown>,
	finish: string | null,
) {
	return {
		id,
		object: "chat.completion.chunk",
		created,
		model,
		system_fingerprint: null,
		choices: [{ index: 0, delta, finish_reason: finish, logprobs: null }],
	};
}

function progressDelta(frame: RpcFrame): string | undefined {
	if (
		frame.type === "tool_execution_start" &&
		typeof frame.toolName === "string"
	) {
		return `\n> Running tool: ${frame.toolName}\n`;
	}
	if (
		frame.type === "tool_execution_end" &&
		typeof frame.toolName === "string"
	) {
		return `\n> Tool finished: ${frame.toolName}\n`;
	}
	return undefined;
}

export function registerOpenAiRoutes(
	app: Hono,
	options: OpenAiAdapterOptions,
): void {
	app.get("/v1/models", (context) =>
		context.json({
			object: "list",
			data: [
				{
					id: options.modelId,
					object: "model",
					created: 0,
					owned_by: "oh-my-pi-hermes",
				},
			],
		}),
	);

	app.post("/v1/chat/completions", async (context) => {
		const parsed = completionSchema.safeParse(
			await context.req.json().catch(() => undefined),
		);
		if (!parsed.success)
			return openAiError(
				"Invalid chat completion request",
				"invalid_request_error",
				400,
			);
		if (parsed.data.model !== options.modelId) {
			return openAiError(
				`Model not found: ${parsed.data.model}`,
				"model_not_found",
				404,
			);
		}

		let target: ConversationTarget;
		let worker: SessionWorker;
		try {
			target = completionTarget(context.req.raw.headers);
			worker = await options.pool.getOrCreate(
				target.externalId,
				target.persistent,
			);
		} catch (error) {
			if (error instanceof WorkerCapacityError) {
				return openAiError(error.message, "worker_capacity_exceeded", 503);
			}
			return openAiError(
				error instanceof Error ? error.message : String(error),
				"gateway_error",
				500,
			);
		}

		const prior = worker.storedSession;
		const duplicate =
			target.messageId &&
			prior?.lastExternalMessageId === target.messageId &&
			prior.lastAssistantText !== undefined
				? prior.lastAssistantText
				: undefined;
		let prompt: string;
		try {
			prompt = promptFromRequest(parsed.data, worker);
		} catch (error) {
			return openAiError(
				error instanceof Error ? error.message : String(error),
				"invalid_request_error",
				400,
			);
		}

		context.header("X-OMP-Session-Id", worker.state.sessionId);
		if (parsed.data.stream) {
			const completionId = `chatcmpl-${crypto.randomUUID()}`;
			const created = Math.floor(Date.now() / 1_000);
			return streamSSE(context, async (stream) => {
				const abort = new AbortController();
				stream.onAbort(() =>
					abort.abort(
						new DOMException("HTTP client disconnected", "AbortError"),
					),
				);
				let assistantText = "";
				try {
					await stream.writeSSE({
						data: JSON.stringify(
							chunkEnvelope(
								completionId,
								created,
								options.modelId,
								{ role: "assistant" },
								null,
							),
						),
					});
					if (duplicate !== undefined) {
						assistantText = duplicate;
						await stream.writeSSE({
							data: JSON.stringify(
								chunkEnvelope(
									completionId,
									created,
									options.modelId,
									{ content: duplicate },
									null,
								),
							),
						});
					} else {
						for await (const frame of worker.runPrompt(prompt, abort.signal)) {
							const text = textDeltaFromFrame(frame);
							if (text) {
								assistantText += text;
								await stream.writeSSE({
									data: JSON.stringify(
										chunkEnvelope(
											completionId,
											created,
											options.modelId,
											{ content: text },
											null,
										),
									),
								});
							}
							const thinking =
								thinkingDeltaFromFrame(frame) ?? progressDelta(frame);
							if (thinking) {
								await stream.writeSSE({
									data: JSON.stringify(
										chunkEnvelope(
											completionId,
											created,
											options.modelId,
											{ reasoning_content: thinking },
											null,
										),
									),
								});
							}
						}
						await worker.commitExternalMessage(target.messageId, assistantText);
					}
					await stream.writeSSE({
						data: JSON.stringify(
							chunkEnvelope(completionId, created, options.modelId, {}, "stop"),
						),
					});
					if (parsed.data.stream_options?.include_usage) {
						await stream.writeSSE({
							data: JSON.stringify({
								id: completionId,
								object: "chat.completion.chunk",
								created,
								model: options.modelId,
								choices: [],
								usage: {
									prompt_tokens: 0,
									completion_tokens: 0,
									total_tokens: 0,
								},
							}),
						});
					}
					await stream.writeSSE({ data: "[DONE]" });
				} catch (error) {
					if (!abort.signal.aborted) {
						await stream.writeSSE({
							data: JSON.stringify({
								error: {
									message:
										error instanceof Error ? error.message : String(error),
									type:
										error instanceof SessionBusyError
											? "session_busy"
											: "upstream_error",
								},
							}),
						});
					}
				} finally {
					stream.close();
				}
			});
		}

		if (worker.isBusy)
			return openAiError(
				"Conversation already has an active turn",
				"session_busy",
				409,
			);
		let assistantText = duplicate ?? "";
		if (duplicate === undefined) {
			try {
				for await (const frame of worker.runPrompt(
					prompt,
					context.req.raw.signal,
				)) {
					assistantText += textDeltaFromFrame(frame) ?? "";
				}
				await worker.commitExternalMessage(target.messageId, assistantText);
			} catch (error) {
				const status = error instanceof SessionBusyError ? 409 : 502;
				return openAiError(
					error instanceof Error ? error.message : String(error),
					error instanceof SessionBusyError ? "session_busy" : "upstream_error",
					status,
				);
			}
		}
		return context.json({
			id: `chatcmpl-${crypto.randomUUID()}`,
			object: "chat.completion",
			created: Math.floor(Date.now() / 1_000),
			model: options.modelId,
			choices: [
				{
					index: 0,
					message: { role: "assistant", content: assistantText },
					finish_reason: "stop",
					logprobs: null,
				},
			],
			usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
		});
	});
}
