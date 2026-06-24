import { describe, expect } from "vitest";
import { testLive } from "./live-context.ts";

// gen types introspects the remote schema over the IPv4 session pooler and emits
// TypeScript types. It pulls the postgres-meta Docker image, so it needs Docker
// (present in the CI live job alongside the --use-docker bundler cell).
describe("gen types (live, session pooler)", () => {
  testLive("generates TypeScript types from the remote schema", async ({ run, dbUrl }) => {
    const res = await run(["gen", "types", "--db-url", dbUrl, "--lang", "typescript"]);
    expect(res.exitCode, res.stderr).toBe(0);
    expect(res.stdout).toMatch(/export type (Database|Json)/);
  });
});
