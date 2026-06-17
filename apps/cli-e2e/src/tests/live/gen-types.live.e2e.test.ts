import { describe, expect } from "vitest";
import { testLive } from "./live-context.ts";

// gen types introspects the real DB and emits TypeScript types. It spawns the
// postgres-meta container, so this case needs Docker (available in the CI live
// job alongside the --use-docker bundler cell).
describe("gen types (live --db-url)", () => {
  testLive("generates TypeScript types from the remote schema", async ({ run, dbUrl }) => {
    const res = await run(["gen", "types", "--db-url", dbUrl, "--lang", "typescript"]);
    expect(res.exitCode, res.stderr).toBe(0);
    expect(res.stdout).toMatch(/export type (Database|Json)/);
  });
});
