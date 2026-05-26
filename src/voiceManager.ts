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
import { log } from "./logger";
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
    const voiceDebug = process.env.LOG_LEVEL?.toLowerCase() === "debug";
    const connection = joinVoiceChannel({
      channelId: channel.id,
      guildId: channel.guild.id,
      adapterCreator: channel.guild.voiceAdapterCreator,
      selfDeaf: false, // must NOT be deaf — we need to receive audio
      selfMute: true, // we never speak
      debug: voiceDebug, // low-level voice ws/udp events (LOG_LEVEL=debug to enable)
    });

    // Log every state transition. Healthy path: signalling -> connecting -> ready.
    connection.on("stateChange", (oldState, newState) => {
      log.info("voice", `state ${oldState.status} -> ${newState.status}`);
    });
    connection.on("error", (err) => log.error("voice", "connection error", { error: String(err) }));
    if (voiceDebug) {
      // Surfaces voice WebSocket close codes / encryption negotiation — the trail
      // that pinned down the 0.18 handshake bug. Only when LOG_LEVEL=debug.
      connection.on("debug", (msg) => log.debug("voice-dbg", msg));
    }

    const connectStart = Date.now();
    try {
      await entersState(connection, VoiceConnectionStatus.Ready, 20_000);
      log.info("voice", "reached Ready", { ms: Date.now() - connectStart });
    } catch (err) {
      // Never reached Ready. The voice WS/handshake failed — see the "voice-dbg"
      // lines just above for the close code / reason.
      log.error("voice", "failed to reach Ready", {
        ms: Date.now() - connectStart,
        lastState: connection.state.status,
        error: String(err),
      });
      // Guard: the connection may already be destroyed (the bounce path destroys
      // it), so destroying again throws "already been destroyed".
      if (connection.state.status !== VoiceConnectionStatus.Destroyed) {
        connection.destroy();
      }
      throw new VoiceConnectError(
        "Couldn't establish the voice connection — handshake failed before Ready.",
        { cause: err },
      );
    }

    const session: GuildSession = { connection, users: new Map() };
    this.sessions.set(channel.guild.id, session);

    const receiver = connection.receiver;
    receiver.speaking.on("start", (userId) => {
      log.debug("voice", "speaking start", { userId });
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
      // RAM guard: refuse new buffers once we hit the cap.
      log.warn("voice", `MAX_USERS (${MAX_USERS}) reached, skipping`, { userId });
      return;
    }

    const ring = existing?.ring ?? new RingBuffer();
    const entry: UserEntry = { ring, lastDataTs: 0, subscribed: true };
    session.users.set(userId, entry);
    log.info("voice", "subscribed to user audio", { userId, activeUsers: session.users.size });

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

    let firstChunkLogged = false;
    const onData = (chunk: Buffer) => {
      if (!firstChunkLogged) {
        firstChunkLogged = true;
        log.info("voice", "receiving decoded audio ✅", { userId, frameBytes: chunk.length });
      }
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
