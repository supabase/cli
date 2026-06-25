import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer, Option } from "effect";

import { mockOutput } from "../../../../tests/helpers/mocks.ts";
import { LegacyOutputFlag } from "../../../shared/legacy/global-flags.ts";
import { LegacyGoProxy } from "../../../shared/legacy/go-proxy.service.ts";
import type { OutputFormat } from "../../../shared/output/types.ts";
import type { LegacyStartFlags } from "./start.command.ts";
import { legacyStart } from "./start.handler.ts";

type LegacyGoOutput = "env" | "pretty" | "json" | "toml" | "yaml" | "table" | "csv";

interface ProxyCall {
  readonly args: ReadonlyArray<string>;
  readonly stdin?: "inherit" | "ignore";
  readonly env?: Record<string, string>;
}

const helperStatusEnv = { SUPABASE_TELEMETRY_DISABLED: "1" };

function setup(
  opts: {
    readonly format?: OutputFormat;
    readonly goOutput?: LegacyGoOutput;
    readonly captureStdout?: string;
    readonly statusStdout?: string;
  } = {},
) {
  const out = mockOutput({ format: opts.format ?? "text" });
  const execCalls: ProxyCall[] = [];
  const execCaptureCalls: ProxyCall[] = [];
  const proxy = Layer.succeed(LegacyGoProxy, {
    exec: (args, execOpts) =>
      Effect.sync(() => {
        execCalls.push(execOpts?.env === undefined ? { args } : { args, env: execOpts.env });
      }),
    execCapture: (args, execOpts) =>
      Effect.sync(() => {
        execCaptureCalls.push({
          args,
          ...(execOpts?.stdin === undefined ? {} : { stdin: execOpts.stdin }),
          ...(execOpts?.env === undefined ? {} : { env: execOpts.env }),
        });
        return args[0] === "status" ? (opts.statusStdout ?? "{}\n") : (opts.captureStdout ?? "");
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
      expect(s.execCalls).toEqual([{ args: ["status", "--output", "json"], env: helperStatusEnv }]);
    }).pipe(Effect.provide(s.layer));
  });

  it.live("captures Go start then emits Go status for --output-format json", () => {
    const s = setup({ format: "json" });

    return Effect.gen(function* () {
      yield* legacyStart(flags());

      expect(s.execCaptureCalls).toEqual([{ args: ["start"], stdin: "inherit" }]);
      expect(s.execCalls).toEqual([{ args: ["status", "--output", "json"], env: helperStatusEnv }]);
    }).pipe(Effect.provide(s.layer));
  });

  it.live("emits captured Go status as a result event for --output-format stream-json", () => {
    const s = setup({
      format: "stream-json",
      statusStdout: '{\n  "API_URL": "http://127.0.0.1:54321"\n}\n',
    });

    return Effect.gen(function* () {
      yield* legacyStart(flags());

      expect(s.execCaptureCalls).toEqual([
        { args: ["start"], stdin: "inherit" },
        { args: ["status", "--output", "json"], env: helperStatusEnv },
      ]);
      expect(s.execCalls).toEqual([]);
      expect(s.out.events).toEqual([
        expect.objectContaining({
          type: "result",
          data: { API_URL: "http://127.0.0.1:54321" },
        }),
      ]);
    }).pipe(Effect.provide(s.layer));
  });

  it.live("lets --output pretty win over --output-format json", () => {
    const s = setup({ format: "json", goOutput: "pretty" });

    return Effect.gen(function* () {
      yield* legacyStart(flags());

      expect(s.execCaptureCalls).toEqual([]);
      expect(s.execCalls).toEqual([{ args: ["start"] }]);
    }).pipe(Effect.provide(s.layer));
  });

  it.live("delegates --output yaml through Go status after start succeeds", () => {
    const s = setup({ goOutput: "yaml" });

    return Effect.gen(function* () {
      yield* legacyStart(flags());

      expect(s.execCaptureCalls).toEqual([{ args: ["start"], stdin: "inherit" }]);
      expect(s.execCalls).toEqual([{ args: ["status", "--output", "yaml"], env: helperStatusEnv }]);
    }).pipe(Effect.provide(s.layer));
  });

  it.live("preserves start flags and forwards ignore-health-check to helper status", () => {
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
      expect(s.execCalls).toEqual([
        {
          args: [
            "status",
            "--output",
            "json",
            "--exclude",
            "analytics",
            "--exclude",
            "studio",
            "--ignore-health-check",
          ],
          env: helperStatusEnv,
        },
      ]);
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
