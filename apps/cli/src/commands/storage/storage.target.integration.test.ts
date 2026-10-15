import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { ConfigProvider, Effect, FileSystem, Layer, Option } from "effect";

import { mockCommandSettings, useTempWorkdir } from "../../../tests/helpers/command-mocks.ts";
import { mockOutput } from "../../../tests/helpers/mocks.ts";
import { resolveStorageTarget } from "./storage.flags.ts";

const FLIP_WARNING =
  'Warning: supabase storage ls will target the local stack by default in the next major version. Pass --linked, or set target = "remote" in supabase/config.toml (or SUPABASE_TARGET=remote), to keep targeting the linked project.';

describe("storage target resolution", () => {
  const workdir = useTempWorkdir("supabase-storage-target-");

  const setup = (env: Record<string, string> = {}) => {
    const out = mockOutput();
    const layer = Layer.mergeAll(
      out.layer,
      BunServices.layer,
      mockCommandSettings({ workdir: workdir.current, explicitWorkdir: true }),
      ConfigProvider.layer(ConfigProvider.fromEnvRecord(env)),
    );
    return { out, layer };
  };

  const writeTarget = (target: string) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      yield* fs.makeDirectory(`${workdir.current}/supabase`, { recursive: true });
      yield* fs.writeFileString(
        `${workdir.current}/supabase/config.toml`,
        `project_id = "demo"\ntarget = "${target}"\n`,
      );
    });

  const resolve = (args: ReadonlyArray<string>, local = false) =>
    resolveStorageTarget({
      command: "storage ls",
      args,
      local,
      projectRef: Option.none(),
    });

  it.effect(
    "warns and keeps the linked default when neither a selector nor a target is set",
    () => {
      const { out, layer } = setup();
      return Effect.gen(function* () {
        expect(yield* resolve(["storage", "ls"])).toBe(false);
        expect(out.stderrText).toContain(FLIP_WARNING);
        expect(out.stdoutText).toBe("");
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect("targets the linked project without warning when target = remote", () => {
    const { out, layer } = setup();
    return Effect.gen(function* () {
      yield* writeTarget("remote");
      expect(yield* resolve(["storage", "ls"])).toBe(false);
      expect(out.stderrText).toBe("");
    }).pipe(Effect.provide(layer));
  });

  it.effect("targets the local stack without warning when target = local", () => {
    const { out, layer } = setup();
    return Effect.gen(function* () {
      yield* writeTarget("local");
      expect(yield* resolve(["storage", "ls"])).toBe(true);
      expect(out.stderrText).toBe("");
    }).pipe(Effect.provide(layer));
  });

  it.effect("lets SUPABASE_TARGET override the config target", () => {
    const { layer } = setup({ SUPABASE_TARGET: "local" });
    return Effect.gen(function* () {
      yield* writeTarget("remote");
      expect(yield* resolve(["storage", "ls"])).toBe(true);
    }).pipe(Effect.provide(layer));
  });

  it.effect(
    "keeps an explicit --linked or --local selector ahead of the target, with no warning",
    () => {
      const { out, layer } = setup();
      return Effect.gen(function* () {
        yield* writeTarget("remote");
        expect(yield* resolve(["storage", "ls", "--local"], true)).toBe(true);
        expect(yield* resolve(["storage", "ls", "--linked"], false)).toBe(false);
        expect(out.stderrText).toBe("");
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect("does not warn when --project-ref pins the linked project", () => {
    const { out, layer } = setup();
    return Effect.gen(function* () {
      const local = yield* resolveStorageTarget({
        command: "storage ls",
        args: ["storage", "ls", "--project-ref", "abcdefghijklmnopqrst"],
        local: false,
        projectRef: Option.some("abcdefghijklmnopqrst"),
      });
      expect(local).toBe(false);
      expect(out.stderrText).toBe("");
    }).pipe(Effect.provide(layer));
  });
});
