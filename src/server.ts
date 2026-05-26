import express from "express";

/**
 * Lightweight keep-alive web server for Render's free Web Service tier.
 *
 * Render spins the service down after 15 min of HTTP inactivity, which would
 * kill the bot's gateway/voice connections. An external pinger (e.g. UptimeRobot
 * every 14 min) hits /ping to keep it awake. Must bind to 0.0.0.0:$PORT — Render
 * assigns the port via the PORT env var.
 */
export function startKeepAliveServer(): void {
  const app = express();
  const port = Number(process.env.PORT ?? 3000);

  app.get("/ping", (_req, res) => res.status(200).send("ok"));
  app.get("/", (_req, res) => res.status(200).send("Audio dashcam bot is running."));

  app.listen(port, "0.0.0.0", () => {
    console.log(`[server] keep-alive listening on 0.0.0.0:${port}`);
  });
}
