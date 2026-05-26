import express from "express";
import { log } from "./logger";

/**
 * Lightweight HTTP server exposing /ping. Used as the platform health check
 * (Fly) and, on spin-down platforms, to keep the service awake. Binds
 * 0.0.0.0:$PORT — the host assigns the port via the PORT env var.
 */
export function startKeepAliveServer(): void {
  const app = express();
  const port = Number(process.env.PORT ?? 3000);

  app.get("/ping", (_req, res) => res.status(200).send("ok"));
  app.get("/", (_req, res) => res.status(200).send("Audio dashcam bot is running."));

  app.listen(port, "0.0.0.0", () => {
    log.info("server", `keep-alive listening on 0.0.0.0:${port}`);
  });
}
