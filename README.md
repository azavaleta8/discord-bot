# Discord Audio Dashcam Bot

A Discord bot that joins a voice channel, continuously buffers the **last N seconds**
of audio per speaker in memory (default **15s**, set via `BUFFER_SECONDS`), and exports
a single mixed **OGG/Opus** clip to the text channel on `/clip`. Designed to run within
Render's free 512 MB Web Service tier.

## How it works

```
Discord (Opus/UDP)
  → @discordjs/voice receiver (per user)
  → prism-media Opus decoder → PCM s16le 48kHz stereo
  → RingBuffer (fixed-size ring, ~2.9 MB at 15s, silence-gap padded)
/clip → snapshot all buffers → right-aligned mix → FFmpeg → OGG/Opus → upload
```

Key design points:

- **Opus, not PCM, on the wire.** Discord sends compressed Opus; we decode to PCM
  *before* buffering. The 192 KB/s figure applies to decoded audio.
- **Pre-allocated ring buffer per user** (`Buffer.alloc(BYTES_PER_SECOND * BUFFER_SECONDS)`,
  ~2.9 MB at the 15s default), wrapped with bulk `copy()` calls — no per-byte loops,
  no GC churn. Freed the instant a user leaves the channel.
- **Silence padding.** Discord stops sending frames during silence, so gaps are
  measured by wall-clock and padded with frame-aligned (20ms) zeroed bytes to keep
  every speaker on a shared timeline.
- **Right-aligned mixing.** All snapshots end at "now"; shorter buffers get leading
  silence. Samples are summed in Int32 and clamped to int16 to avoid clipping wrap.
- **Bounded RAM under load.** `MAX_USERS` caps concurrent buffers; `EncodeQueue`
  serializes FFmpeg processes so simultaneous `/clip` requests don't spike memory.

## Commands

| Command  | Action                                                        |
| -------- | ------------------------------------------------------------- |
| `/join`  | Joins your current voice channel and starts buffering.        |
| `/clip`  | Exports the buffered window as a mixed `.ogg` to the text channel. |
| `/leave` | Leaves the channel and frees all buffers.                     |

> ⚠️ **Consent:** `/join` posts a "🔴 Now recording" notice. Recording voice may
> require participant consent depending on your jurisdiction — keep the notice on.

## Local development

```bash
cp .env.example .env   # fill in DISCORD_TOKEN, CLIENT_ID, GUILD_ID
npm install
npm run dev
```

Requires **FFmpeg** on your PATH locally (the Docker image installs it for you).

### Bot setup (Discord Developer Portal)

1. Create an application → **Bot**, copy the token into `DISCORD_TOKEN`.
2. Copy the application ID into `CLIENT_ID`.
3. Invite the bot with the `bot` + `applications.commands` scopes and the
   **Connect** + **Speak** voice permissions.
4. Set `GUILD_ID` to your test server for instant slash-command registration.

## Deploy to Render (free tier)

1. Push this repo to GitHub.
2. Render → **New → Web Service** → connect the repo.
3. Environment: **Docker** (uses the included `Dockerfile`).
4. Add env vars: `DISCORD_TOKEN`, `CLIENT_ID`, `GUILD_ID`. (`PORT` is automatic.)
5. Deploy.

### Keep it awake

Render free Web Services sleep after 15 min of HTTP inactivity, which would drop the
voice connection. Point an external pinger at the `/ping` endpoint:

- [UptimeRobot](https://uptimerobot.com) → HTTP(s) monitor →
  `https://<your-service>.onrender.com/ping` → **every 14 minutes**.

## Memory budget

At the **15s default** (~2.9 MB per speaker):

| Item                       | Approx. RAM        |
| -------------------------- | ------------------ |
| Ring buffer per speaker    | ~2.9 MB            |
| 12 speakers (`MAX_USERS`)  | ~35 MB             |
| Clip snapshot + mix (peak) | ~3–6 MB (brief)    |
| Node + discord.js runtime  | ~70–90 MB          |

Each second is ~192 KB/speaker, so the buffer scales linearly with `BUFFER_SECONDS`
(60s ≈ 11.5 MB/speaker). Lower `MAX_USERS` or `BUFFER_SECONDS` for bigger channels.
