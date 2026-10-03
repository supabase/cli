import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer, Ref } from "effect";
import { runtimeInfoLayer } from "../shared/runtime/runtime-info.layer.ts";
import {
  CommandTelemetryAttributes,
  type CommandTelemetryAttributeValues,
} from "../telemetry/command-telemetry-attributes.ts";
import { selectStackRuntime } from "./stack-runtime.ts";

describe("selectStackRuntime", () => {
  it.effect("records the selected runtime on the command event", () =>
    Effect.gen(function* () {
      const recorded = yield* Ref.make<CommandTelemetryAttributeValues>({});

      const runtime = yield* selectStackRuntime("docker").pipe(
        Effect.provideService(CommandTelemetryAttributes, {
          record: (values) => Ref.update(recorded, (current) => ({ ...current, ...values })),
        }),
      );

      expect(runtime).toBe("docker");
      expect((yield* Ref.get(recorded)).stack_runtime).toBe("docker");
    }).pipe(Effect.provide(Layer.mergeAll(BunServices.layer, runtimeInfoLayer))),
  );
});
