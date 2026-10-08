import { runHostProcess } from "../src/internal/host-process.ts";

/** An owner whose registration-loss poll runs every 200ms, so ownership-loss tests need not wait the production interval. */
if (import.meta.main)
  await runHostProcess(process.argv.slice(2), { registrationCheckInterval: "200 millis" });
