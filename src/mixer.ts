import { spawn } from "node:child_process";
import { BYTES_PER_SAMPLE } from "./audio";

const INT16_MAX = 32_767;
const INT16_MIN = -32_768;

/**
 * Sum multiple PCM tracks into one stereo s16le track.
 *
 * Tracks are right-aligned: every snapshot ends at "now" but may start at a
 * different point (a user who just joined has a short buffer). Aligning to the
 * end keeps everyone temporally synced. Shorter tracks are implicitly padded
 * with leading silence via the per-track offset.
 *
 * Samples are summed in an Int32 accumulator and clamped to the int16 range so
 * overlapping speakers don't overflow into wrap-around distortion.
 */
export function mixTracks(tracks: Buffer[]): Buffer {
  if (tracks.length === 0) return Buffer.alloc(0);

  const maxLen = tracks.reduce((m, t) => Math.max(m, t.length), 0);
  const len = maxLen - (maxLen % BYTES_PER_SAMPLE); // keep sample alignment
  const numSamples = len / BYTES_PER_SAMPLE;
  if (numSamples === 0) return Buffer.alloc(0);

  const acc = new Int32Array(numSamples);

  for (const t of tracks) {
    const tSamples = Math.floor(t.length / BYTES_PER_SAMPLE);
    const offset = numSamples - tSamples; // right-align to the shared end time
    for (let s = 0; s < tSamples; s++) {
      acc[offset + s] += t.readInt16LE(s * BYTES_PER_SAMPLE);
    }
  }

  const out = Buffer.alloc(len);
  for (let s = 0; s < numSamples; s++) {
    let v = acc[s];
    if (v > INT16_MAX) v = INT16_MAX;
    else if (v < INT16_MIN) v = INT16_MIN;
    out.writeInt16LE(v, s * BYTES_PER_SAMPLE);
  }

  return out;
}

/**
 * Encode raw PCM (s16le, 48kHz, stereo) into an OGG/Opus file via FFmpeg.
 * PCM is piped to stdin; the encoded file is collected from stdout.
 */
export function encodeToOgg(pcm: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const ff = spawn("ffmpeg", [
      "-hide_banner",
      "-loglevel", "error",
      "-f", "s16le",
      "-ar", "48000",
      "-ac", "2",
      "-i", "pipe:0",
      "-c:a", "libopus",
      "-b:a", "64k",
      "-f", "ogg",
      "pipe:1",
    ]);

    const chunks: Buffer[] = [];
    let stderr = "";

    ff.stdout.on("data", (d: Buffer) => chunks.push(d));
    ff.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    ff.on("error", reject); // e.g. ffmpeg not installed
    ff.on("close", (code) => {
      if (code === 0) resolve(Buffer.concat(chunks));
      else reject(new Error(stderr.trim() || `ffmpeg exited with code ${code}`));
    });

    ff.stdin.on("error", () => {/* ignore EPIPE if ffmpeg dies early */});
    ff.stdin.end(pcm);
  });
}
