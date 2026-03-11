import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { status } from "./status.handler.ts";
import { mockOutput, withEnv } from "../../../tests/helpers/mocks.ts";
import { BunServices } from "@effect/platform-bun";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function setup() {
  const out = mockOutput();
  const home = mkdtempSync(join(tmpdir(), "supa-status-test-"));
  const layer = Layer.mergeAll(out.layer, BunServices.layer);
  return { layer, out, home };
}

describe("status handler", () => {
  it.live("shows no stacks message when none exist", () => {
    const { layer, out, home } = setup();
    return Effect.gen(function* () {
      yield* status({});
      expect(out.messages).toContainEqual(
        expect.objectContaining({ type: "info", message: "No local Supabase stacks found." }),
      );
    }).pipe(Effect.provide(layer), Effect.provide(withEnv({ SUPABASE_HOME: home })));
  });
});
