# Discord Audio Dashcam Bot

A Discord bot that joins a voice channel, continuously buffers the **last N seconds**
of audio per speaker in memory (default **15s**, set via `BUFFER_SECONDS`), and exports
a single mixed **OGG/Opus** clip to the text channel on `/clip`. Runs in ~512 MB RAM on
a host with UDP egress (Fly.io, a VPS, etc. — **not** Render/Heroku, which block voice UDP).

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

## Deploy to Fly.io

> **Why not Render/Heroku?** Discord voice runs over **UDP**, and HTTP-only
> platforms like Render and Heroku don't route outbound UDP — the gateway and
> slash commands work, but the voice connection times out. Fly.io (and any real
> VM/VPS) gives the container normal UDP egress, so voice works.

1. Install the CLI: `curl -L https://fly.io/install.sh | sh` (then add it to PATH
   as the installer prints).
2. `fly auth signup` (or `fly auth login`).
3. Edit `fly.toml`: set a unique `app` name and a `primary_region` near you
   (`fly platform regions` lists them).
4. Create the app without deploying yet: `fly launch --no-deploy --copy-config`.
5. Set your secrets (never commit these):
   ```bash
   fly secrets set DISCORD_TOKEN=... CLIENT_ID=... GUILD_ID=...
   ```
6. Deploy: `fly deploy`.
7. Tail logs: `fly logs` — look for `logged in as ...` and `registered 3 commands`.

The bot stays running 24/7 (`auto_stop_machines = false`), so no external pinger
is needed. The `/ping` endpoint is used as Fly's health check.

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
