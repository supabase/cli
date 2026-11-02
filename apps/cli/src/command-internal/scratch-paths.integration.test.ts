import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";

import { mockCommandSettings } from "../../tests/helpers/command-mocks.ts";
import { pgdeltaScratchDir, scratchDir } from "./scratch-paths.ts";
import { stackBackendLayer } from "./stack-backend.ts";

const resolve = (kind: "legacy" | "stack", workdir: string) =>
  Effect.all({
    scratch: scratchDir(workdir),
    pgdelta: pgdeltaScratchDir(workdir),
  }).pipe(
    Effect.provide([
      BunServices.layer,
      mockCommandSettings({ workdir, supabaseHome: "/home/.supabase" }),
      stackBackendLayer(kind),
    ]),
  );

describe("pg-delta scratch directory", () => {
  it.effect("gives each project its own root in stack state", () =>
    Effect.gen(function* () {
      const first = yield* resolve("stack", "/work/first");
      const second = yield* resolve("stack", "/work/second");

      expect(first.pgdelta).not.toBe(second.pgdelta);
      for (const { scratch, pgdelta } of [first, second]) {
        expect(pgdelta.startsWith(`${scratch}/pgdelta/`)).toBe(true);
      }
      expect(yield* resolve("stack", "/work/first")).toEqual(first);
    }),
  );

  it.effect("stays under the project's supabase/.temp in legacy state", () =>
    Effect.gen(function* () {
      const { pgdelta } = yield* resolve("legacy", "/work/first");

      expect(pgdelta).toBe("/work/first/supabase/.temp/pgdelta");
    }),
  );
});
