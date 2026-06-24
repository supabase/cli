import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer, Option } from "effect";

import { mockOutput } from "../../../../tests/helpers/mocks.ts";
import { LegacyOutputFlag } from "../../../shared/legacy/global-flags.ts";
import { LegacyGoProxy } from "../../../shared/legacy/go-proxy.service.ts";
import type { LegacyStartFlags } from "./start.command.ts";
import { legacyStart } from "./start.handler.ts";

interface ProxyCall {
  readonly args: ReadonlyArray<string>;
  readonly stdin?: "inherit" | "ignore";
}

function setup(opts: { readonly goOutput?: "json"; readonly captureStdout?: string } = {}) {
  const out = mockOutput();
  const execCalls: ProxyCall[] = [];
  const execCaptureCalls: ProxyCall[] = [];
  const proxy = Layer.succeed(LegacyGoProxy, {
    exec: (args) =>
      Effect.sync(() => {
        execCalls.push({ args });
      }),
    execCapture: (args, execOpts) =>
      Effect.sync(() => {
        execCaptureCalls.push({ args, stdin: execOpts?.stdin });
        return opts.captureStdout ?? "";
      }),
  });

  const layer = Layer.mergeAll(
    out.layer,
    proxy,
    Layer.succeed(
      LegacyOutputFlag,
      opts.goOutput === undefined ? Option.none() : Option.some(opts.goOutput),
    ),
  );

  return { layer, out, execCalls, execCaptureCalls };
}

const flags = (overrides: Partial<LegacyStartFlags> = {}): LegacyStartFlags => ({
  exclude: overrides.exclude ?? [],
  ignoreHealthCheck: overrides.ignoreHealthCheck ?? false,
  preview: overrides.preview ?? false,
});

describe("legacy start", () => {
  it.live("delegates text mode directly to Go start", () => {
    const s = setup();

    return Effect.gen(function* () {
      yield* legacyStart(flags({ exclude: ["db"] }));

      expect(s.execCalls).toEqual([{ args: ["start", "--exclude", "db"] }]);
      expect(s.execCaptureCalls).toEqual([]);
    }).pipe(Effect.provide(s.layer));
  });

  it.live("captures Go start then emits Go status for --output json", () => {
    const s = setup({ goOutput: "json" });

    return Effect.gen(function* () {
      yield* legacyStart(flags());

      expect(s.execCaptureCalls).toEqual([{ args: ["start"], stdin: "inherit" }]);
      expect(s.execCalls).toEqual([{ args: ["status"] }]);
    }).pipe(Effect.provide(s.layer));
  });

  it.live("preserves start flags when --output json captures Go start", () => {
    const s = setup({ goOutput: "json" });

    return Effect.gen(function* () {
      yield* legacyStart(
        flags({
          exclude: ["analytics", "studio"],
          ignoreHealthCheck: true,
          preview: true,
        }),
      );

      expect(s.execCaptureCalls).toEqual([
        {
          args: [
            "start",
            "--exclude",
            "analytics",
            "--exclude",
            "studio",
            "--ignore-health-check",
            "--preview",
          ],
          stdin: "inherit",
        },
      ]);
      expect(s.execCalls).toEqual([{ args: ["status"] }]);
    }).pipe(Effect.provide(s.layer));
  });

  it.live("does not write captured Go start stdout to output", () => {
    const s = setup({ goOutput: "json", captureStdout: "pretty status table\n" });

    return Effect.gen(function* () {
      yield* legacyStart(flags());

      expect(s.out.stdoutText).toBe("");
      expect(s.out.rawChunks).toEqual([]);
    }).pipe(Effect.provide(s.layer));
  });
});
