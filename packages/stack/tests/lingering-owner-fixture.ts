import { runHostProcess } from "../src/internal/host-process.ts";

// oxlint-disable-next-line effecttsgo/global-timers -- a raw open handle stands in for a leaked timer or socket.
setInterval(() => undefined, 60_000);

if (import.meta.main) await runHostProcess(process.argv.slice(2));
