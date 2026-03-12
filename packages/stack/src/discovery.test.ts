import { BunServices } from "@effect/platform-bun";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { deleteManagedStackPersistence } from "./discovery.ts";

async function withTempCacheRoot(run: (cacheRoot: string) => Promise<void>) {
  const cacheRoot = mkdtempSync(join(tmpdir(), "supabase-discovery-test-"));
  try {
    await run(cacheRoot);
  } finally {
    rmSync(cacheRoot, { recursive: true, force: true });
  }
}

describe("deleteManagedStackPersistence", () => {
  it("deletes a persisted stack directory when it exists", async () =>
    withTempCacheRoot(async (cacheRoot) => {
      await Effect.runPromise(
        Effect.gen(function* () {
          const stackDir = join(cacheRoot, "stacks", "my-project");
          mkdirSync(join(stackDir, "data"), { recursive: true });
          writeFileSync(join(stackDir, "ports.json"), "{}");
          writeFileSync(join(stackDir, "state.json"), "{}");

          yield* deleteManagedStackPersistence({
            cacheRoot,
            name: "my-project",
            cwd: "/Users/test/Code/my-project",
          });

          expect(existsSync(stackDir)).toBe(false);
        }).pipe(Effect.provide(BunServices.layer)),
      );
    }));

  it("fails with NoRunningStackError when no persisted stack directory exists", async () =>
    withTempCacheRoot(async (cacheRoot) => {
      const exit = await Effect.runPromise(
        deleteManagedStackPersistence({
          cacheRoot,
          name: "missing-project",
          cwd: "/Users/test/Code/missing-project",
        }).pipe(Effect.provide(BunServices.layer), Effect.exit),
      );

      expect(exit._tag).toBe("Failure");
      if (exit._tag === "Failure") {
        expect(JSON.stringify(exit.cause)).toContain("NoRunningStackError");
      }
    }));
});
