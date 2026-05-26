/**
 * Minimal concurrency limiter.
 *
 * Each FFmpeg encode spawns a process and briefly holds the mixed PCM in memory.
 * If many users hit /clip at once, running them all in parallel would spike RAM
 * past Render's 512 MB ceiling. This queues tasks so at most `concurrency` run
 * simultaneously; the rest wait their turn.
 */
export class EncodeQueue {
  private active = 0;
  private readonly waiting: Array<() => void> = [];

  constructor(private readonly concurrency = 1) {}

  run<T>(task: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const exec = () => {
        this.active++;
        task()
          .then(resolve, reject)
          .finally(() => {
            this.active--;
            const next = this.waiting.shift();
            if (next) next();
          });
      };

      if (this.active < this.concurrency) exec();
      else this.waiting.push(exec);
    });
  }
}
