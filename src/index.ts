import "./loadEnv"; // must be first: loads .env before any module reads process.env
import { BUFFER_SECONDS } from "./audio";
import { createBot } from "./bot";
import { log } from "./logger";
import { startKeepAliveServer } from "./server";

function main(): void {
  const token = process.env.DISCORD_TOKEN;
  if (!token) {
    log.error("startup", "DISCORD_TOKEN is not set — exiting");
    process.exit(1);
  }

  log.info("startup", "booting", {
    node: process.version,
    bufferSeconds: BUFFER_SECONDS,
    maxUsers: Number(process.env.MAX_USERS ?? 12),
    encodeConcurrency: Number(process.env.ENCODE_CONCURRENCY ?? 1),
    port: Number(process.env.PORT ?? 3000),
    hasGuildId: Boolean(process.env.GUILD_ID),
  });

  // Don't let a stray stream/decoder error take the whole process down.
  process.on("unhandledRejection", (err) => log.error("process", "unhandledRejection", { error: String(err) }));
  process.on("uncaughtException", (err) => log.error("process", "uncaughtException", { error: String(err) }));

  startKeepAliveServer();

  const client = createBot();
  client.login(token).catch((err) => {
    log.error("startup", "login failed — exiting", { error: String(err) });
    process.exit(1);
  });
}

main();
