import { describe, expect, it } from "@effect/vitest";
import { Effect, Exit, Layer } from "effect";
import { stop } from "./stop.handler.ts";
import { mockOutput, withEnv } from "../../../tests/helpers/mocks.ts";
import { BunServices } from "@effect/platform-bun";
import { existsSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function setup() {
  const out = mockOutput();
  const home = mkdtempSync(join(tmpdir(), "supabase-stop-test-"));
  const layer = Layer.mergeAll(out.layer, BunServices.layer);
  return { layer, out, home };
}

describe("stop handler", () => {
  it.live("displays intro message before stopping", () => {
    const { layer, out, home } = setup();
    return Effect.gen(function* () {
      // Will fail with NoRunningStackError since no stacks exist, but intro should be emitted
      yield* stop({ noBackup: false }).pipe(Effect.exit);
      expect(out.messages).toContainEqual(
        expect.objectContaining({ type: "intro", message: "Stop local Supabase stack" }),
      );
    }).pipe(Effect.provide(layer), Effect.provide(withEnv({ SUPABASE_HOME: home })));
  });

  it.live("fails with NoRunningStackError when no stack exists", () => {
    const { layer, home } = setup();
    return Effect.gen(function* () {
      const exit = yield* stop({ noBackup: false }).pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
    }).pipe(Effect.provide(layer), Effect.provide(withEnv({ SUPABASE_HOME: home })));
  });

  it.live(
    "deletes persisted stack data with --no-backup even when the daemon is already stopped",
    () => {
      const { layer, out, home } = setup();
      const stackDir = join(home, "stacks", "project");
      mkdirSync(join(stackDir, "data"), { recursive: true });
      return Effect.gen(function* () {
        yield* stop({ noBackup: true });
        expect(existsSync(stackDir)).toBe(false);
        expect(out.messages).toContainEqual(
          expect.objectContaining({
            type: "success",
            message: "Local Supabase stopped and persisted data deleted",
          }),
        );
      }).pipe(
        Effect.provide(layer),
        Effect.provide(withEnv({ SUPABASE_HOME: home, PWD: "/test/project" })),
      );
    },
  );
});
