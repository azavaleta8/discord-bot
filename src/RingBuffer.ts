import { FRAME_BYTES, RING_CAPACITY } from "./audio";

/**
 * A fixed-size circular buffer holding the most recent ~60s of one user's PCM.
 *
 * Memory strategy: a single `Buffer.alloc(RING_CAPACITY)` is allocated up front
 * and never reallocated. Node Buffers live off the V8 heap, so this keeps the
 * GC away from the hot audio path — no per-packet array growth, no churn. Once
 * the buffer fills, `writePos` wraps to 0 and the oldest bytes are overwritten.
 */
export class RingBuffer {
  /** Backing store, pre-allocated and zero-filled. */
  private readonly buf: Buffer = Buffer.alloc(RING_CAPACITY);

  /** Index of the next byte to write. Always in [0, RING_CAPACITY). */
  private writePos = 0;

  /** Total bytes ever written, capped at RING_CAPACITY once we've wrapped. */
  private filled = 0;

  /** Reusable zero-filled chunk so silence padding allocates nothing. */
  private static readonly SILENCE = Buffer.alloc(FRAME_BYTES * 10);

  /** Write a PCM chunk, wrapping at the capacity boundary with bulk copies. */
  write(chunk: Buffer): void {
    let offset = 0;
    let remaining = chunk.length;

    while (remaining > 0) {
      const space = RING_CAPACITY - this.writePos;
      const n = Math.min(space, remaining);
      chunk.copy(this.buf, this.writePos, offset, offset + n);

      this.writePos = (this.writePos + n) % RING_CAPACITY;
      offset += n;
      remaining -= n;
    }

    this.filled = Math.min(this.filled + chunk.length, RING_CAPACITY);
  }

  /**
   * Pad the buffer with zeroed bytes for a silent gap.
   *
   * Discord stops sending packets while a user is quiet, so consecutive voice
   * packets are NOT temporally adjacent. We frame-align the gap to 20ms units
   * and write that many zero bytes before the next real packet, preserving
   * each speaker's position on the shared timeline.
   *
   * @param gapMs measured wall-clock silence in milliseconds
   */
  padSilence(gapMs: number): void {
    if (gapMs <= 0) return;

    const frames = Math.round(gapMs / 20); // 20ms per frame
    // A gap longer than the whole buffer just clears it — no point looping more.
    let bytes = Math.min(frames * FRAME_BYTES, RING_CAPACITY);

    while (bytes > 0) {
      const n = Math.min(bytes, RingBuffer.SILENCE.length);
      this.write(RingBuffer.SILENCE.subarray(0, n));
      bytes -= n;
    }
  }

  /**
   * Return a linear, oldest→newest copy of the valid audio (the "freeze/clone"
   * step for /clip). Handles the wrap so callers get a clean contiguous PCM
   * stream ending at "now".
   */
  snapshot(): Buffer {
    const len = this.filled;
    if (len === 0) return Buffer.alloc(0);

    const out = Buffer.alloc(len);

    if (len < RING_CAPACITY) {
      // Not yet wrapped: data is linear from 0..writePos.
      this.buf.copy(out, 0, 0, len);
    } else {
      // Wrapped: oldest byte is at writePos. Copy tail then head.
      const tail = RING_CAPACITY - this.writePos;
      this.buf.copy(out, 0, this.writePos, RING_CAPACITY);
      this.buf.copy(out, tail, 0, this.writePos);
    }

    return out;
  }

  /** Bytes of valid audio currently held. */
  get size(): number {
    return this.filled;
  }
}
