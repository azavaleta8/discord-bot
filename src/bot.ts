import {
  AttachmentBuilder,
  ChatInputCommandInteraction,
  Client,
  GatewayIntentBits,
  MessageFlags,
  SlashCommandBuilder,
} from "discord.js";
import { BUFFER_SECONDS } from "./audio";
import { EncodeQueue } from "./encodeQueue";
import { encodeToOgg, mixTracks } from "./mixer";
import { VoiceConnectError, VoiceManager } from "./voiceManager";

const voice = new VoiceManager();
// Concurrency 1: encode clips one at a time to stay under the 512 MB ceiling.
const encodeQueue = new EncodeQueue(Number(process.env.ENCODE_CONCURRENCY ?? 1));

const commands = [
  new SlashCommandBuilder()
    .setName("join")
    .setDescription("Join your current voice channel and start buffering audio."),
  new SlashCommandBuilder()
    .setName("leave")
    .setDescription("Leave the voice channel and clear all buffers."),
  new SlashCommandBuilder()
    .setName("clip")
    .setDescription(`Export the last ${BUFFER_SECONDS} seconds of voice as a mixed audio clip.`),
].map((c) => c.toJSON());

export function createBot(): Client {
  const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
  });

  client.once("ready", async () => {
    console.log(`[bot] logged in as ${client.user?.tag}`);

    // Guild-scoped registration updates instantly; global takes up to an hour.
    const guildId = process.env.GUILD_ID;
    if (guildId) {
      const guild = await client.guilds.fetch(guildId);
      await guild.commands.set(commands);
      console.log(`[bot] registered ${commands.length} commands in guild ${guildId}`);
    } else {
      await client.application?.commands.set(commands);
      console.log(`[bot] registered ${commands.length} global commands`);
    }
  });

  client.on("interactionCreate", async (interaction) => {
    if (!interaction.isChatInputCommand()) return;
    try {
      await handleCommand(interaction);
    } catch (err) {
      console.error("[bot] command error:", err);
      const msg = "Something went wrong handling that command.";
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply(msg).catch(() => {});
      } else {
        await interaction.reply({ content: msg, flags: MessageFlags.Ephemeral }).catch(() => {});
      }
    }
  });

  // Free a user's buffer the moment they leave the voice channel.
  client.on("voiceStateUpdate", (oldState, newState) => {
    if (!oldState.channelId || !oldState.guild) return;
    const userId = oldState.id;
    // They left or moved out of the bot's channel.
    if (oldState.channelId !== newState.channelId) {
      voice.freeUser(oldState.guild.id, userId);
    }
  });

  return client;
}

async function handleCommand(interaction: ChatInputCommandInteraction): Promise<void> {
  if (!interaction.inGuild() || !interaction.guild) {
    await interaction.reply({ content: "This command only works in a server.", flags: MessageFlags.Ephemeral });
    return;
  }

  const guildId = interaction.guild.id;

  switch (interaction.commandName) {
    case "join": {
      // Defer FIRST — Discord kills the interaction token after ~3s, and the
      // member fetch + voice connection below can take longer than that.
      await interaction.deferReply();
      const member = await interaction.guild.members.fetch(interaction.user.id);
      const channel = member.voice.channel;
      if (!channel) {
        await interaction.editReply("Join a voice channel first, then run /join.");
        return;
      }
      try {
        await voice.join(channel);
      } catch (err) {
        if (err instanceof VoiceConnectError) {
          await interaction.editReply(
            "⚠️ Joined the channel but couldn't open the **voice (UDP) connection** — it timed out. " +
              "This usually means UDP to Discord's voice servers is blocked or NAT'd (common on WSL2). " +
              "It should work when deployed to a real host (e.g. Render).",
          );
          return;
        }
        throw err;
      }
      await interaction.editReply(
        `🔴 **Now recording** in **${channel.name}** — the last ${BUFFER_SECONDS}s of voice is continuously buffered. Run \`/clip\` to export, \`/leave\` to stop.`,
      );
      return;
    }

    case "leave": {
      if (!voice.isActive(guildId)) {
        await interaction.reply({ content: "I'm not in a voice channel here.", flags: MessageFlags.Ephemeral });
        return;
      }
      voice.leave(guildId);
      await interaction.reply("👋 Left the voice channel and cleared all buffers.");
      return;
    }

    case "clip": {
      if (!voice.isActive(guildId)) {
        await interaction.reply({ content: "I'm not recording. Run /join first.", flags: MessageFlags.Ephemeral });
        return;
      }

      const snapshots = voice.snapshotAll(guildId);
      if (snapshots.length === 0) {
        await interaction.reply({ content: "No audio buffered yet — say something first!", flags: MessageFlags.Ephemeral });
        return;
      }

      await interaction.deferReply();

      // Mix synchronously, then queue the FFmpeg encode to bound RAM/CPU.
      const mixed = mixTracks(snapshots);
      const ogg = await encodeQueue.run(() => encodeToOgg(mixed));

      const file = new AttachmentBuilder(ogg, { name: `clip-${Date.now()}.ogg` });
      await interaction.editReply({
        content: `🎬 Last ${BUFFER_SECONDS}s — ${snapshots.length} speaker(s).`,
        files: [file],
      });
      return;
    }
  }
}
