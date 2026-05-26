// Side-effect module: load a local .env BEFORE any other module reads
// process.env. Must be the very first import in the entrypoint so that
// module-load-time constants (BUFFER_SECONDS, MAX_USERS, …) see the values.
//
// In production (Render/Docker) there's no .env file and the platform injects
// env vars, so this just no-ops.
try {
  process.loadEnvFile();
  console.log("[env] loaded .env");
} catch {
  /* no .env file — rely on real environment variables */
}
