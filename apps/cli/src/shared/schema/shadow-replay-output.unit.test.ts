import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { mockOutput } from "../../../tests/helpers/mocks.ts";
import { Output } from "../output/output.service.ts";
import { wrapShadowReplayOutput } from "./shadow-replay-output.ts";

describe("wrapShadowReplayOutput", () => {
  it.effect("emits one replay line and swallows per-file apply lines", () => {
    const out = mockOutput();
    return Effect.gen(function* () {
      const wrapped = wrapShadowReplayOutput(yield* Output, { debug: false });
      yield* wrapped.raw("Applying migration a.sql...\n", "stderr");
      yield* wrapped.raw("Applying migration b.sql...\n", "stderr");
      yield* wrapped.raw("Seeding globals from roles.sql...\n", "stderr");
      expect(out.rawChunks.map((chunk) => chunk.text)).toEqual([
        "Replaying migrations on a shadow (not the local database)...\n",
        "Seeding globals from roles.sql...\n",
      ]);
    }).pipe(Effect.provide(out.layer));
  });

  it.effect("prefixes each apply line when debug is on", () => {
    const out = mockOutput();
    return Effect.gen(function* () {
      const wrapped = wrapShadowReplayOutput(yield* Output, { debug: true });
      yield* wrapped.raw("Applying migration a.sql...\n", "stderr");
      yield* wrapped.raw("Applying migration b.sql...\n", "stderr");
      expect(out.rawChunks.map((chunk) => chunk.text)).toEqual([
        "Shadow: Applying migration a.sql...\n",
        "Shadow: Applying migration b.sql...\n",
      ]);
    }).pipe(Effect.provide(out.layer));
  });

  it.effect("swallows apply lines in json without a replay banner", () => {
    const out = mockOutput({ format: "json" });
    return Effect.gen(function* () {
      const wrapped = wrapShadowReplayOutput(yield* Output, { debug: false });
      yield* wrapped.raw("Applying migration a.sql...\n", "stderr");
      yield* wrapped.raw("Seeding globals from roles.sql...\n", "stderr");
      expect(out.rawChunks.map((chunk) => chunk.text)).toEqual([
        "Seeding globals from roles.sql...\n",
      ]);
    }).pipe(Effect.provide(out.layer));
  });
});
