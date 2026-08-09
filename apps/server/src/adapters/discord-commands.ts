import { SlashCommandBuilder } from "discord.js";

export const OMP_COMMAND_NAME = "omp";

export interface DiscordModelChoice {
	provider: string;
	id: string;
	name?: string;
}

export function buildOmpCommand() {
	return new SlashCommandBuilder()
		.setName(OMP_COMMAND_NAME)
		.setDescription("Interact with Oh My Pi")
		.addSubcommand((subcommand) =>
			subcommand
				.setName("model")
				.setDescription("Show or switch the model for this conversation")
				.addStringOption((option) =>
					option
						.setName("model")
						.setDescription("Choose an available provider/model")
						.setAutocomplete(true),
				),
		);
}

export function modelChoiceValue(model: Pick<DiscordModelChoice, "provider" | "id">): string {
	return `${model.provider}/${model.id}`;
}

export function parseModelChoice(value: string): DiscordModelChoice | undefined {
	const separator = value.indexOf("/");
	if (separator <= 0 || separator === value.length - 1) return undefined;
	return {
		provider: value.slice(0, separator),
		id: value.slice(separator + 1),
	};
}
