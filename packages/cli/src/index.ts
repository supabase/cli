import { spawnSync } from "node:child_process";
import path from "node:path";

const ext = process.platform === "win32" ? ".exe" : "";
const sidecar = path.join(path.dirname(process.execPath), `supabase-backend${ext}`);

const result = spawnSync(sidecar, process.argv.slice(2), {
  stdio: "inherit",
});

if (result.error) {
  const err = result.error as NodeJS.ErrnoException;
  if (err.code === "ENOENT") {
    console.error(`supabase-backend not found at: ${sidecar}`);
    console.error("Ensure the Go CLI binary is placed alongside this executable.");
    process.exit(1);
  }
  throw err;
}

if (result.signal) {
  process.kill(process.pid, result.signal);
}

process.exit(result.status ?? 1);
