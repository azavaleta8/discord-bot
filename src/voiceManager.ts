import {
  EndBehaviorType,
  VoiceConnection,
  VoiceConnectionStatus,
  entersState,
  getVoiceConnection,
  joinVoiceChannel,
} from "@discordjs/voice";
import type { VoiceBasedChannel } from "discord.js";
import prism from "prism-media";
import { FRAME_MS, SAMPLE_RATE, CHANNELS } from "./audio";
import { RingBuffer } from "./RingBuffer";

const MAX_USERS = Number(process.env.MAX_USERS ?? 12);

/** Thrown when the voice (UDP) connection fails to reach the Ready state. */
export class VoiceConnectError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "VoiceConnectError";
  }
}

interface UserEntry {
  ring: RingBuffer;
  /** Timestamp of the last decoded frame, for silence-gap measurement. */
  lastDataTs: number;
  /** Whether we already have an active Opus subscription for this user. */
  subscribed: boolean;
  cleanup?: () => void;
}

interface GuildSession {
  connection: VoiceConnection;
  users: Map<string, UserEntry>;
}

/**
 * Owns all active voice sessions: joining channels, decoding incoming Opus into
 * per-user ring buffers (with silence padding), and freeing memory on leave.
 */
export class VoiceManager {
  private readonly sessions = new Map<string, GuildSession>();

  /** Join the given voice channel and start buffering everyone who speaks. */
  async join(channel: VoiceBasedChannel): Promise<void> {
    const connection = joinVoiceChannel({
      channelId: channel.id,
      guildId: channel.guild.id,
      adapterCreator: channel.guild.voiceAdapterCreator,
      selfDeaf: false, // must NOT be deaf — we need to receive audio
      selfMute: true, // we never speak
    });

    try {
      await entersState(connection, VoiceConnectionStatus.Ready, 20_000);
    } catch (err) {
      // The UDP voice path never came up (commonly blocked or NAT'd, e.g. under
      // WSL2). Tear down the half-open connection so we don't leak it.
      connection.destroy();
      throw new VoiceConnectError(
        "Couldn't establish the voice (UDP) connection — it timed out reaching Ready.",
        { cause: err },
      );
    }

    const session: GuildSession = { connection, users: new Map() };
    this.sessions.set(channel.guild.id, session);

    const receiver = connection.receiver;
    receiver.speaking.on("start", (userId) => {
      this.startReceiving(session, userId);
    });

    connection.on(VoiceConnectionStatus.Disconnected, () => {
      this.leave(channel.guild.id);
    });
  }

  /** Subscribe to one user's Opus stream and pipe decoded PCM into their ring. */
  private startReceiving(session: GuildSession, userId: string): void {
    const existing = session.users.get(userId);
    if (existing?.subscribed) return; // already streaming this user

    if (!existing && session.users.size >= MAX_USERS) {
      // RAM guard: refuse new buffers once we hit the cap (~11.5 MB each).
      console.warn(`[voice] MAX_USERS (${MAX_USERS}) reached, skipping ${userId}`);
      return;
    }

    const ring = existing?.ring ?? new RingBuffer();
    const entry: UserEntry = { ring, lastDataTs: 0, subscribed: true };
    session.users.set(userId, entry);

    // Manual end behaviour: keep the subscription open for the whole session.
    // Discord simply stops sending frames during silence; we detect the gap and
    // pad it, rather than tearing down and re-creating the stream each pause.
    const opusStream = session.connection.receiver.subscribe(userId, {
      end: { behavior: EndBehaviorType.Manual },
    });

    const decoder = new prism.opus.Decoder({
      rate: SAMPLE_RATE,
      channels: CHANNELS,
      frameSize: 960, // 20ms @ 48kHz
    });

    const onData = (chunk: Buffer) => {
      const now = Date.now();
      if (entry.lastDataTs !== 0) {
        // Anything beyond one normal frame interval is real silence to pad.
        const gap = now - entry.lastDataTs - FRAME_MS;
        if (gap > FRAME_MS) ring.padSilence(gap);
      }
      entry.lastDataTs = now;
      ring.write(chunk);
    };

    decoder.on("data", onData);
    // Decode glitches / stream resets shouldn't crash the process.
    decoder.on("error", () => {});
    opusStream.on("error", () => {});

    opusStream.pipe(decoder);

    entry.cleanup = () => {
      decoder.off("data", onData);
      opusStream.unpipe(decoder);
      opusStream.destroy();
      decoder.destroy();
      entry.subscribed = false;
    };
  }

  /**
   * Free a single user's buffer and streams (called when they leave the voice
   * channel) so the ~11.5 MB is reclaimed immediately.
   */
  freeUser(guildId: string, userId: string): void {
    const session = this.sessions.get(guildId);
    const entry = session?.users.get(userId);
    if (!session || !entry) return;
    entry.cleanup?.();
    session.users.delete(userId); // drops the RingBuffer reference -> GC
  }

  /** Snapshot every active user's buffer for mixing. */
  snapshotAll(guildId: string): Buffer[] {
    const session = this.sessions.get(guildId);
    if (!session) return [];
    return [...session.users.values()]
      .map((e) => e.ring.snapshot())
      .filter((pcm) => pcm.length > 0);
  }

  /** Whether the bot currently has a live session in this guild. */
  isActive(guildId: string): boolean {
    return this.sessions.has(guildId);
  }

  /** Disconnect from a guild and free all of its buffers. */
  leave(guildId: string): void {
    const session = this.sessions.get(guildId);
    if (!session) return;

    for (const entry of session.users.values()) entry.cleanup?.();
    session.users.clear();

    try {
      const conn = getVoiceConnection(guildId);
      conn?.destroy();
    } catch {
      /* already destroyed */
    }

    this.sessions.delete(guildId);
  }
}
