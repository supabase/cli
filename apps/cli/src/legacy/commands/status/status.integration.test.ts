import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { LegacyGoProxy } from "../../../shared/legacy/go-proxy.service.ts";
import { legacyStatus } from "./status.handler.ts";
import type { LegacyStatusFlags } from "./status.command.ts";

function setupLegacyStatus() {
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

const baseFlags: LegacyStatusFlags = {
  overrideName: [],
  exclude: [],
  ignoreHealthCheck: false,
};

describe("legacy status", () => {
  it.live("forwards no extra flags when defaults are used", () => {
    const { layer, calls } = setupLegacyStatus();
    return Effect.gen(function* () {
      yield* legacyStatus(baseFlags);
      expect(calls).toEqual([["status"]]);
    }).pipe(Effect.provide(layer));
  });

  it.live("forwards --override-name for each provided override", () => {
    const { layer, calls } = setupLegacyStatus();
    return Effect.gen(function* () {
      yield* legacyStatus({
        ...baseFlags,
        overrideName: ["api.url=NEXT_PUBLIC_SUPABASE_URL"],
      });
      expect(calls).toEqual([["status", "--override-name", "api.url=NEXT_PUBLIC_SUPABASE_URL"]]);
    }).pipe(Effect.provide(layer));
  });

  it.live("forwards the hidden --exclude and --ignore-health-check flags", () => {
    const { layer, calls } = setupLegacyStatus();
    return Effect.gen(function* () {
      yield* legacyStatus({
        overrideName: [],
        exclude: ["db", "kong"],
        ignoreHealthCheck: true,
      });
      expect(calls).toEqual([
        ["status", "--exclude", "db", "--exclude", "kong", "--ignore-health-check"],
      ]);
    }).pipe(Effect.provide(layer));
  });
});
