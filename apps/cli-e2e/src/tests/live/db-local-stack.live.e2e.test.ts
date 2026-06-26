import { describe, expect } from "vitest";
import { TARGET } from "../env.ts";
import { testLive } from "./live-context.ts";

// Real-stack live coverage for the native `db start` / `db reset --local` ports.
// These are local-Docker commands (they boot/recreate the local Postgres
// container), so they exercise the hidden `db __db-bootstrap` Go seam end-to-end
// against the real Docker socket the live harness wires up — the one boundary the
// in-process integration suites mock.
//
// `db start` / `db reset` live only in the `go` reference and the `ts-legacy`
// port (the `next` shell has no `db` group), so skip the `ts-next` target.
//
// The whole start → already-running → reset cycle runs in one test so it shares a
// single booted stack, and `finally` stops it (legacy proxies `stop` to Go) so the
// run never leaves containers behind. Each test gets a fresh init-generated
// workspace, so the project id (and container names) never collide across targets.
describe.skipIf(TARGET === "ts-next")("db local stack (live, real Docker)", () => {
  testLive(
    "db start boots, is idempotent, and db reset --local recreates",
    { timeout: 600_000 },
    async ({ run }) => {
      try {
        const start = await run(["db", "start"]);
        expect(start.exitCode, start.stderr).toBe(0);
        // Go tees bootstrap progress to stderr (mode-independent).
        expect(`${start.stdout}${start.stderr}`).toMatch(/Starting database|Initialising schema/i);

        // Second start is a no-op: the db is already running, exit 0.
        const again = await run(["db", "start"]);
        expect(again.exitCode, again.stderr).toBe(0);
        expect(`${again.stdout}${again.stderr}`).toMatch(/already[\s-]running/i);

        // Local reset recreates the container and prints the git-branch line.
        const reset = await run(["db", "reset", "--local"]);
        expect(reset.exitCode, reset.stderr).toBe(0);
        expect(reset.stderr).toContain("on branch ");
      } finally {
        await run(["stop", "--no-backup"]).catch(() => undefined);
      }
    },
  );
});
