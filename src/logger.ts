/**
 * Tiny structured logger. Writes timestamped, tagged lines to stdout so they
 * show up in `fly logs` / the Fly dashboard.
 *
 * Note: in containers stdout is a pipe, which Node buffers. We force a sync
 * flush per line so logs aren't lost or delayed when the process is busy or
 * crashes — that was the "I don't see the logs" problem.
 */
type Level = "INFO" | "WARN" | "ERROR" | "DEBUG";

function emit(level: Level, tag: string, msg: string, extra?: Record<string, unknown>): void {
  const time = new Date().toISOString();
  let line = `${time} ${level} [${tag}] ${msg}`;
  if (extra && Object.keys(extra).length > 0) {
    line += " " + JSON.stringify(extra);
  }
  // Write directly + synchronously to fd 1 so nothing is lost to buffering.
  try {
    process.stdout.write(line + "\n");
  } catch {
    console.log(line);
  }
}

export const log = {
  info: (tag: string, msg: string, extra?: Record<string, unknown>) => emit("INFO", tag, msg, extra),
  warn: (tag: string, msg: string, extra?: Record<string, unknown>) => emit("WARN", tag, msg, extra),
  error: (tag: string, msg: string, extra?: Record<string, unknown>) => emit("ERROR", tag, msg, extra),
  debug: (tag: string, msg: string, extra?: Record<string, unknown>) => emit("DEBUG", tag, msg, extra),
};

/** Time an async operation and log how long it took. */
export async function timed<T>(tag: string, label: string, fn: () => Promise<T>): Promise<T> {
  const start = Date.now();
  try {
    const result = await fn();
    log.info(tag, `${label} ok`, { ms: Date.now() - start });
    return result;
  } catch (err) {
    log.error(tag, `${label} failed`, { ms: Date.now() - start, error: String(err) });
    throw err;
  }
}
