import "./loadEnv"; // must be first: loads .env before any module reads process.env
import { createBot } from "./bot";
import { startKeepAliveServer } from "./server";

function main(): void {
  const token = process.env.DISCORD_TOKEN;
  if (!token) {
    console.error("[fatal] DISCORD_TOKEN is not set.");
    process.exit(1);
  }

  // Don't let a stray stream/decoder error take the whole process down.
  process.on("unhandledRejection", (err) => console.error("[unhandledRejection]", err));
  process.on("uncaughtException", (err) => console.error("[uncaughtException]", err));

  startKeepAliveServer();

  const client = createBot();
  client.login(token).catch((err) => {
    console.error("[fatal] login failed:", err);
    process.exit(1);
  });
}

main();
