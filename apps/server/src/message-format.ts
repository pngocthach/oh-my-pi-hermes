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
