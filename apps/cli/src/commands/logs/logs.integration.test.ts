import { describe, expect, it } from "@effect/vitest";
import { Effect, Exit, Layer } from "effect";
import { logs } from "./logs.handler.ts";
import { mockOutput, withEnv } from "../../../tests/helpers/mocks.ts";
import { BunServices } from "@effect/platform-bun";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function setup() {
  const out = mockOutput();
  const home = mkdtempSync(join(tmpdir(), "supa-logs-test-"));
  const layer = Layer.mergeAll(out.layer, BunServices.layer);
  return { layer, out, home };
}

describe("logs handler", () => {
  it.live("fails with NoRunningStackError when no stack exists", () => {
    const { layer, home } = setup();
    return Effect.gen(function* () {
      const exit = yield* logs({}).pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
    }).pipe(Effect.provide(layer), Effect.provide(withEnv({ SUPABASE_HOME: home })));
  });
});
