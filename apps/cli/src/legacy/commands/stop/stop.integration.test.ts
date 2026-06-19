import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer, Option } from "effect";
import { LegacyGoProxy } from "../../../shared/legacy/go-proxy.service.ts";
import { legacyStop } from "./stop.handler.ts";
import type { LegacyStopFlags } from "./stop.command.ts";

function setupLegacyStop() {
  const calls: Array<ReadonlyArray<string>> = [];
  const layer = Layer.succeed(LegacyGoProxy, {
    exec: (args) =>
      Effect.sync(() => {
        calls.push(args);
      }),
    execCapture: () => Effect.succeed(""),
  });
  return { layer, calls };
}

const baseFlags: LegacyStopFlags = {
  projectId: Option.none(),
  backup: true,
  noBackup: false,
  all: false,
};

describe("legacy stop", () => {
  it.live("forwards no extra flags when defaults are used", () => {
    const { layer, calls } = setupLegacyStop();
    return Effect.gen(function* () {
      yield* legacyStop(baseFlags);
      expect(calls).toEqual([["stop"]]);
    }).pipe(Effect.provide(layer));
  });

  it.live("forwards --backup=false when the hidden --backup flag is disabled", () => {
    const { layer, calls } = setupLegacyStop();
    return Effect.gen(function* () {
      yield* legacyStop({ ...baseFlags, backup: false });
      expect(calls).toEqual([["stop", "--backup=false"]]);
    }).pipe(Effect.provide(layer));
  });

  it.live("forwards --no-backup, --project-id and --all", () => {
    const { layer, calls } = setupLegacyStop();
    return Effect.gen(function* () {
      yield* legacyStop({
        projectId: Option.some("abc"),
        backup: true,
        noBackup: true,
        all: true,
      });
      expect(calls).toEqual([["stop", "--project-id", "abc", "--no-backup", "--all"]]);
    }).pipe(Effect.provide(layer));
  });
});
