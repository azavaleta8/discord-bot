/**
 * Shared audio format constants.
 *
 * Discord delivers Opus packets over the wire. After decoding (see voiceManager),
 * every packet becomes raw PCM in this canonical format. All buffering, padding,
 * mixing and encoding below assumes exactly this layout.
 */
export const SAMPLE_RATE = 48_000; // Hz
export const CHANNELS = 2; // stereo
export const BYTES_PER_SAMPLE = 2; // 16-bit signed little-endian

/** Bytes of PCM produced per second of audio: 48000 * 2 * 2 = 192000. */
export const BYTES_PER_SECOND = SAMPLE_RATE * CHANNELS * BYTES_PER_SAMPLE;

/** Opus/Discord frame duration. One decoded frame == 20ms of audio. */
export const FRAME_MS = 20;

/** Bytes in one 20ms frame: 192000 * 0.02 = 3840. Silence is padded in these units. */
export const FRAME_BYTES = (BYTES_PER_SECOND * FRAME_MS) / 1000;

/**
 * How many seconds of history we retain per speaker. Configurable via
 * BUFFER_SECONDS (default 15). Each second costs ~192 KB of RAM per speaker,
 * so raising this scales the per-user buffer linearly — mind the 512 MB cap.
 */
export const BUFFER_SECONDS = (() => {
  const n = Number(process.env.BUFFER_SECONDS ?? 15);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 15;
})();

/** Total ring-buffer capacity per user: BYTES_PER_SECOND * BUFFER_SECONDS (~2.9 MB at 15s). */
export const RING_CAPACITY = BYTES_PER_SECOND * BUFFER_SECONDS;
