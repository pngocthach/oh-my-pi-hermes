import { mkdir } from "node:fs/promises";
import { join } from "node:path";

const args = process.argv.slice(2);
const sessionDirIndex = args.indexOf("--session-dir");
const requestedSessionDirectory = args[sessionDirIndex + 1];
if (sessionDirIndex < 0 || !requestedSessionDirectory)
	throw new Error("Missing --session-dir");
const sessionDirectory: string = requestedSessionDirectory;
await mkdir(sessionDirectory, { recursive: true });

const inputDelayMs = process.env.FAKE_OMP_DELAY_MS ?? "0";
let sessionId: string = crypto.randomUUID();
let sessionName: string | undefined;
let currentModel = { provider: "fake", id: "fast", name: "Fake Fast" };
let messageCount = 0;
let sessionFile = join(sessionDirectory, `fake_${sessionId}.jsonl`);

function emit(frame: unknown): void {
	process.stdout.write(`${JSON.stringify(frame)}\n`);
}

async function persist(): Promise<void> {
	await Bun.write(
		sessionFile,
		`${JSON.stringify({ type: "session", version: 3, id: sessionId, title: sessionName, timestamp: new Date().toISOString(), cwd: process.cwd() })}\n`,
	);
}

emit({
	type: "ready",
	protocolVersion: 1,
	supportedProtocolVersions: [1, 2],
	maxFrameBytes: 1024 * 1024,
	maxReassembledFrameBytes: 64 * 1024 * 1024,
});

const reader = Bun.stdin.stream().getReader();
const decoder = new TextDecoder();
let buffered = "";
while (true) {
	const { done, value } = await reader.read();
	if (done) break;
	buffered += decoder.decode(value, { stream: true });
	let newline = buffered.indexOf("\n");
	while (newline >= 0) {
		const line = buffered.slice(0, newline);
		buffered = buffered.slice(newline + 1);
		newline = buffered.indexOf("\n");
		if (!line.trim()) continue;
		const command = JSON.parse(line) as {
			id: string;
			type: string;
			[key: string]: unknown;
		};
		switch (command.type) {
			case "negotiate_protocol":
				emit({
					type: "response",
					command: command.type,
					id: command.id,
					success: true,
					data: { protocolVersion: 2 },
				});
				break;
			case "get_state":
				emit({
					type: "response",
					command: command.type,
					id: command.id,
					success: true,
					data: {
						sessionId,
						sessionFile,
						sessionName,
						isStreaming: false,
						messageCount,
						queuedMessageCount: 0,
						model: currentModel,
					},
				});
				break;
			case "get_available_models":
				emit({
					type: "response",
					command: command.type,
					id: command.id,
					success: true,
					data: {
						models: [
							{ provider: "fake", id: "fast", name: "Fake Fast" },
							{ provider: "fake", id: "smart", name: "Fake Smart" },
						],
					},
				});
				break;
			case "set_model":
				currentModel = {
					provider: String(command.provider),
					id: String(command.modelId),
					name: String(command.modelId),
				};
				emit({
					type: "response",
					command: command.type,
					id: command.id,
					success: true,
					data: currentModel,
				});
				break;
			case "set_session_name":
				sessionName = String(command.name);
				await persist();
				emit({
					type: "response",
					command: command.type,
					id: command.id,
					success: true,
				});
				break;
			case "switch_session": {
				const requestedFile = String(command.sessionPath);
				const file = Bun.file(requestedFile);
				if (!(await file.exists())) {
					emit({
						type: "response",
						command: command.type,
						id: command.id,
						success: false,
						error: "Session not found",
					});
					break;
				}
				const header = JSON.parse(
					(await file.text()).split("\n", 1)[0] ?? "{}",
				) as { id?: string; title?: string };
				sessionId = header.id ?? sessionId;
				sessionName = header.title;
				sessionFile = requestedFile;
				emit({
					type: "response",
					command: command.type,
					id: command.id,
					success: true,
					data: { cancelled: false },
				});
				break;
			}
			case "prompt": {
				const raw = String(command.message);
				const delayMs = Number(inputDelayMs);
				if (delayMs > 0) await Bun.sleep(delayMs);
				const text = raw.startsWith("LONG:")
					? `Line one\n\n${"lorem ipsum dolor sit amet\n".repeat(90)}The end`
					: `Echo: ${raw}`;
				messageCount += 2;
				await persist();
				emit({
					type: "response",
					command: command.type,
					id: command.id,
					success: true,
					data: { agentInvoked: true },
				});
				emit({ type: "agent_start" });
				emit({
					type: "message_update",
					message: { role: "assistant", content: [{ type: "text", text }] },
					assistantMessageEvent: {
						type: "text_delta",
						contentIndex: 0,
						delta: text,
					},
				});
				emit({
					type: "message_end",
					message: { role: "assistant", content: [{ type: "text", text }] },
				});
				emit({
					type: "turn_end",
					message: { role: "assistant", content: [{ type: "text", text }] },
					toolResults: [],
				});
				emit({ type: "agent_end", messages: [], isTerminal: true });
				break;
			}
			case "abort":
			case "follow_up":
				emit({
					type: "response",
					command: command.type,
					id: command.id,
					success: true,
				});
				break;
			default:
				emit({
					type: "response",
					command: command.type,
					id: command.id,
					success: false,
					error: "Unsupported fake command",
				});
		}
	}
}
