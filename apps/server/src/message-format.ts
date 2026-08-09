const TABLE_SEPARATOR = /^\s*\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*){1,}\|?\s*$/;

function splitTableRow(line: string): string[] {
	let row = line.trim();
	if (row.startsWith("|")) row = row.slice(1);
	if (row.endsWith("|")) row = row.slice(0, -1);
	return row.split("|").map((cell) => cell.trim());
}


function renderTable(lines: string[]): string {
	if (lines.length < 3) return lines.join("\n");
	const headers = splitTableRow(lines[0] ?? "");
	if (headers.length < 2) return lines.join("\n");
	const firstData = splitTableRow(lines[2] ?? "");
	const hasRowLabel = firstData.length === headers.length + 1;
	const groups: string[] = [];
	for (let index = 2; index < lines.length; index += 1) {
		const cells = splitTableRow(lines[index] ?? "");
		const heading = hasRowLabel
			? cells[0] || `Row ${index - 1}`
			: cells.find(Boolean) || `Row ${index - 1}`;
		const values = hasRowLabel ? cells.slice(1) : cells;
		const normalized = [...values];
		while (normalized.length < headers.length) normalized.push("");
		const bullets = headers
			.map((header, headerIndex) => [header, normalized[headerIndex] ?? ""] as const)
			.filter(([, value]) => hasRowLabel || value !== heading)
			.map(([header, value]) => `• ${header}: ${value}`);
		groups.push([`**${heading}**`, ...bullets].join("\n"));
	}
	return groups.join("\n\n");
}

export function formatDiscordMessage(text: string): string {
	if (!text.includes("|") || !text.includes("-")) return text;
	const lines = text.split("\n");
	const output: string[] = [];
	let inFence = false;
	let index = 0;
	while (index < lines.length) {
		const line = lines[index] ?? "";
		if (line.trimStart().startsWith("```")) {
			inFence = !inFence;
			output.push(line);
			index += 1;
			continue;
		}
		if (
			!inFence &&
			line.includes("|") &&
			index + 1 < lines.length &&
			TABLE_SEPARATOR.test(lines[index + 1] ?? "")
		) {
			const table = [line, lines[index + 1] ?? ""];
			let next = index + 2;
			while (
				next < lines.length &&
				(lines[next]?.trim().length ?? 0) > 0 &&
				(lines[next]?.includes("|") ?? false)
			) {
				table.push(lines[next] ?? "");
				next += 1;
			}
			output.push(renderTable(table));
			index = next;
			continue;
		}
		output.push(line);
		index += 1;
	}
	return output.join("\n");
}

const DISCORD_MESSAGE_LIMIT = 2_000;
const DISCORD_CHUNK_BODY_LIMIT = 1_880;

function rawChunks(text: string): string[] {
	const chunks: string[] = [];
	let remaining = text.trim();
	while (remaining.length > DISCORD_CHUNK_BODY_LIMIT) {
		const window = remaining.slice(0, DISCORD_CHUNK_BODY_LIMIT + 1);
		let splitAt = window.lastIndexOf("\n");
		if (splitAt < DISCORD_CHUNK_BODY_LIMIT / 2)
			splitAt = window.lastIndexOf(" ");
		if (splitAt < DISCORD_CHUNK_BODY_LIMIT / 2)
			splitAt = DISCORD_CHUNK_BODY_LIMIT;
		chunks.push(remaining.slice(0, splitAt).trimEnd());
		remaining = remaining.slice(splitAt).trimStart();
	}
	if (remaining) chunks.push(remaining);
	return chunks;
}

export function splitDiscordMessage(text: string): string[] {
	if (text.length <= DISCORD_MESSAGE_LIMIT) return [text];
	const sourceChunks = rawChunks(text);
	const output: string[] = [];
	let openFenceLanguage: string | undefined;
	for (let index = 0; index < sourceChunks.length; index += 1) {
		const source = sourceChunks[index] ?? "";
		const prefix =
			openFenceLanguage !== undefined ? `\`\`\`${openFenceLanguage}\n` : "";
		const matches = [...source.matchAll(/```([^\n]*)/g)];
		for (const match of matches) {
			if (openFenceLanguage === undefined)
				openFenceLanguage = match[1]?.trim() ?? "";
			else openFenceLanguage = undefined;
		}
		const suffix = openFenceLanguage !== undefined ? "\n```" : "";
		const indicator = `\n(${index + 1}/${sourceChunks.length})`;
		output.push(`${prefix}${source}${suffix}${indicator}`);
	}
	return output;
}

export function discordStreamPreview(text: string): string {
	if (text.length <= DISCORD_MESSAGE_LIMIT) return text;
	return `${text.slice(0, DISCORD_MESSAGE_LIMIT - 1)}…`;
}
