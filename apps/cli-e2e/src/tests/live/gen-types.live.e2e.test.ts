import { describe, expect } from "vitest";
import { testLiveRequires } from "./live-context.ts";

// gen types introspects the remote schema over the IPv4 session pooler (needs
// `database`) and emits TypeScript types by running the postgres-meta Docker
// image (needs `docker`).
describe("gen types (live, session pooler)", () => {
  testLiveRequires(["database", "docker"])(
    "generates TypeScript types from the remote schema",
    async ({ run, dbUrl }) => {
      const res = await run(["gen", "types", "--db-url", dbUrl, "--lang", "typescript"]);
      expect(res.exitCode, res.stderr).toBe(0);
      expect(res.stdout).toMatch(/export type (Database|Json)/);
    },
  );
});
