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
import { log, timed } from "./logger";
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
    log.info("bot", `logged in as ${client.user?.tag}`, { wsPing: client.ws.ping });

    // Guild-scoped registration updates instantly; global takes up to an hour.
    const guildId = process.env.GUILD_ID;
    try {
      if (guildId) {
        const guild = await client.guilds.fetch(guildId);
        await guild.commands.set(commands);
        log.info("bot", `registered ${commands.length} commands`, { guildId });
      } else {
        await client.application?.commands.set(commands);
        log.info("bot", `registered ${commands.length} global commands`);
      }
    } catch (err) {
      // Most common cause: the bot isn't in GUILD_ID (e.g. it was kicked). The
      // bot still runs; existing commands may persist. Re-invite + restart to fix.
      log.error("bot", "command registration failed — is the bot in GUILD_ID?", {
        guildId,
        error: String(err),
      });
    }
  });

  // Surface gateway connectivity — high ping here directly explains 10062s.
  client.on("shardReady", (id) => log.info("gateway", `shard ${id} ready`, { wsPing: client.ws.ping }));
  client.on("shardDisconnect", (e, id) => log.warn("gateway", `shard ${id} disconnected`, { code: e.code }));
  client.on("shardReconnecting", (id) => log.warn("gateway", `shard ${id} reconnecting`));
  client.on("shardResume", (id) => log.info("gateway", `shard ${id} resumed`, { wsPing: client.ws.ping }));
  client.on("error", (err) => log.error("client", "client error", { error: String(err) }));
  client.on("warn", (msg) => log.warn("client", msg));

  client.on("interactionCreate", async (interaction) => {
    if (!interaction.isChatInputCommand()) return;

    // staleMs = how old the interaction already is when we receive it. If this
    // is anywhere near 3000ms, the gateway delivered it slowly and a 10062 on
    // deferReply is expected — points at gateway latency, not our code.
    const staleMs = Date.now() - interaction.createdTimestamp;
    log.info("interaction", `${interaction.commandName} from ${interaction.user.tag}`, {
      staleMs,
      wsPing: client.ws.ping,
      guildId: interaction.guildId,
    });

    try {
      await handleCommand(interaction);
    } catch (err) {
      log.error("interaction", `${interaction.commandName} failed`, { error: String(err), staleMs });
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
      await timed("join", "deferReply", () => interaction.deferReply());
      const member = await timed("join", "fetchMember", () =>
        interaction.guild!.members.fetch(interaction.user.id),
      );
      const channel = member.voice.channel;
      if (!channel) {
        log.info("join", "user not in a voice channel");
        await interaction.editReply("Join a voice channel first, then run /join.");
        return;
      }
      log.info("join", `joining voice channel`, { channel: channel.name, channelId: channel.id });
      try {
        await voice.join(channel);
        log.info("join", "voice connection ready ✅", { channel: channel.name });
      } catch (err) {
        if (err instanceof VoiceConnectError) {
          log.warn("join", "voice connection failed ⚠️", { error: String(err.cause ?? err) });
          await interaction.editReply(
            "⚠️ Joined the channel but the **voice connection** didn't complete (handshake failed before Ready). " +
              "Check the `voice-dbg` logs for the close code.",
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
      const totalBytes = snapshots.reduce((n, s) => n + s.length, 0);
      log.info("clip", "snapshot taken", { speakers: snapshots.length, totalBytes });
      if (snapshots.length === 0) {
        await interaction.reply({ content: "No audio buffered yet — say something first!", flags: MessageFlags.Ephemeral });
        return;
      }

      await timed("clip", "deferReply", () => interaction.deferReply());

      // Mix synchronously, then queue the FFmpeg encode to bound RAM/CPU.
      const mixStart = Date.now();
      const mixed = mixTracks(snapshots);
      log.info("clip", "mixed", { bytes: mixed.length, ms: Date.now() - mixStart });

      const ogg = await timed("clip", "ffmpeg encode", () => encodeQueue.run(() => encodeToOgg(mixed)));
      log.info("clip", "encoded", { oggBytes: ogg.length });

      const file = new AttachmentBuilder(ogg, { name: `clip-${Date.now()}.ogg` });
      await timed("clip", "upload", () =>
        interaction.editReply({
          content: `🎬 Last ${BUFFER_SECONDS}s — ${snapshots.length} speaker(s).`,
          files: [file],
        }),
      );
      return;
    }
  }
}
