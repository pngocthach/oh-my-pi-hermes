import { describe, expect, test } from "bun:test";
import {
	discordStreamPreview,
	formatDiscordMessage,
	splitDiscordMessage,
} from "../src/message-format";

describe("Discord output formatting", () => {
	test("keeps every final message inside Discord's content limit", () => {
		const chunks = splitDiscordMessage(`start\n${"x".repeat(5_000)}\nend`);
		expect(chunks.length).toBeGreaterThan(1);
		expect(chunks.every((chunk) => chunk.length <= 2_000)).toBe(true);
		expect(chunks[0]).toContain("start");
		expect(chunks.at(-1)).toContain("end");
	});

	test("closes and reopens a code fence split across messages", () => {
		const chunks = splitDiscordMessage(
			`\`\`\`ts\n${"const value = 1;\n".repeat(200)}\`\`\``,
		);
		expect(chunks.length).toBeGreaterThan(1);
		expect(chunks[0]).toContain("\n```");
		expect(chunks[1]?.startsWith("```ts\n")).toBe(true);
	});

	test("caps streaming previews at 2,000 characters", () => {
		expect(discordStreamPreview("x".repeat(3_000))).toHaveLength(2_000);
	});
	test("converts Markdown tables to readable Discord bullets", () => {
		const formatted = formatDiscordMessage(
			"| Service | Status |\n|---|---|\n| api | UP |\n| db | DOWN |",
		);
		expect(formatted).toContain("**api**");
		expect(formatted).toContain("• Status: UP");
		expect(formatted).toContain("**db**");
		expect(formatted).not.toContain("|---|");
	});
});
