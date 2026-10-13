import { BunCrypto } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer, Option, Stdio } from "effect";

import {
  mockContextualAnalytics,
  mockOutput,
  mockProcessControl,
} from "../../../tests/helpers/mocks.ts";
import { commandRuntimeLayer } from "../../shared/runtime/command-runtime.layer.ts";
import { withCommandTelemetry } from "../../telemetry/command-telemetry.ts";

const capturedFlags = (
  command: ReadonlyArray<string>,
  args: ReadonlyArray<string>,
  flags: Record<string, unknown>,
) => {
  const analytics = mockContextualAnalytics();
  const stdio = Stdio.layerTest({ args: Effect.succeed([...command, ...args]) });
  return Effect.void.pipe(
    withCommandTelemetry({ flags }),
    Effect.provide(
      Layer.mergeAll(
        analytics.layer,
        mockProcessControl().layer,
        mockOutput({ format: "text" }).layer,
        stdio,
        commandRuntimeLayer(command).pipe(Layer.provide(BunCrypto.layer)),
      ),
    ),
    Effect.map(() => analytics.captured[0]?.properties.flags),
  );
};

describe("seed and pg-delta flag telemetry", () => {
  it.live("records --include-seed as a boolean", () =>
    capturedFlags(["db", "push"], ["--include-seed"], {
      "include-seed": Option.some(true),
    }).pipe(
      Effect.tap((flags) => Effect.sync(() => expect(flags).toEqual({ "include-seed": true }))),
    ),
  );

  it.live("records --no-seed as a boolean and redacts --sql-paths values", () =>
    capturedFlags(["db", "reset"], ["--no-seed", "--sql-paths", "a.sql"], {
      "no-seed": Option.some(true),
      "sql-paths": Option.some(["a.sql"]),
    }).pipe(
      Effect.tap((flags) =>
        Effect.sync(() => expect(flags).toEqual({ "no-seed": true, "sql-paths": "<redacted>" })),
      ),
    ),
  );

  it.live("records --use-pg-delta=false as a boolean", () =>
    capturedFlags(["db", "pull"], ["--use-pg-delta=false"], {
      "use-pg-delta": Option.some(false),
    }).pipe(
      Effect.tap((flags) => Effect.sync(() => expect(flags).toEqual({ "use-pg-delta": false }))),
    ),
  );

  it.live("omits flags that were not passed", () =>
    capturedFlags(["db", "push"], [], {
      "include-seed": Option.none(),
    }).pipe(Effect.tap((flags) => Effect.sync(() => expect(flags).toBeUndefined()))),
  );
});
