import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer, Option, Stream } from "effect";
import { StackDestructionError, StackIdSchema } from "@supabase/stack/effect";
import type { EffectStack } from "@supabase/stack/effect";
import { CliArgs } from "../../../../shared/cli/cli-args.service.ts";
import { YesFlag } from "../../../../command-internal/global-flags.ts";
import {
  mockCommandSettings,
  mockTelemetryStateTracked,
} from "../../../../../tests/helpers/command-mocks.ts";
import {
  mockOutput,
  mockStdin,
  mockTty,
  processEnvLayer,
} from "../../../../../tests/helpers/mocks.ts";
import { StackApi } from "../stack.shared.ts";
import { stackDestroy } from "./destroy.handler.ts";
import { StackCommandDestroyError } from "./destroy.errors.ts";

const id = StackIdSchema.make("a".repeat(64));
const descriptor = {
  id,
  projectRoot: "/project",
  name: "feature-a",
  branchContext: "ordinary-workspace" as const,
  runtime: { kind: "native" as const },
  desiredLifecycle: "stopped" as const,
};

const flags = (stackId = Option.none<string>(), stack = Option.none<string>()) => ({
  stack,
  stackId,
});

function setup(options: {
  yes: boolean;
  destroyFailure?: boolean;
  interactive?: boolean;
  promptConfirmResponses?: ReadonlyArray<boolean>;
  outputFormat?: "text" | "json";
  found?: boolean;
}) {
  const output = mockOutput({
    format: options.outputFormat,
    promptConfirmResponses: options.promptConfirmResponses,
  });
  const telemetry = mockTelemetryStateTracked();
  const state = { destroyed: 0 };
  const stack: EffectStack = {
    id,
    status: () => Effect.die("unused"),
    credentials: () => Effect.die("unused"),
    prepare: () => Effect.die("unused"),
    start: () => Effect.die("unused"),
    stop: () => Effect.die("unused"),
    destroy: () =>
      options.destroyFailure
        ? Effect.fail(new StackDestructionError({ message: "destroy failed" }))
        : Effect.sync(() => void state.destroyed++),
    logs: () => Effect.die("unused"),
    followLogs: () => Stream.empty,
  };
  return {
    output,
    state,
    telemetry,
    layer: Layer.mergeAll(
      output.layer,
      telemetry.layer,
      mockCommandSettings({ workdir: descriptor.projectRoot }),
      mockTty({
        stdinIsTty: options.interactive ?? false,
        stdoutIsTty: options.interactive ?? false,
      }),
      mockStdin(options.interactive ?? false),
      processEnvLayer({}),
      Layer.succeed(YesFlag, options.yes),
      Layer.succeed(CliArgs, { args: options.yes ? ["--yes"] : [] }),
      Layer.succeed(StackApi, {
        findStack: () =>
          Effect.succeed(options.found === false ? Option.none() : Option.some(descriptor)),
        createStack: () => Effect.die("unused"),
        inspectStack: () => Effect.succeed({ descriptor, owner: "absent" as const }),
        openStack: () => Effect.succeed(stack),
        discoverStacks: () => Effect.succeed({ stacks: [], errors: [] }),
      }),
      BunServices.layer,
    ),
  };
}

describe("stack destroy", () => {
  it.live("requires confirmation before mutating a noninteractive invocation", () => {
    const fixture = setup({ yes: false });
    return Effect.gen(function* () {
      const failure = yield* stackDestroy(flags()).pipe(Effect.flip);
      expect(failure).toBeInstanceOf(StackCommandDestroyError);
      expect(failure.message).toContain("requires confirmation");
      expect(fixture.state.destroyed).toBe(0);
    }).pipe(Effect.provide(fixture.layer));
  });

  it.live("destroys the selected stack after --yes", () => {
    const fixture = setup({ yes: true });
    return Effect.gen(function* () {
      yield* stackDestroy(flags(Option.some(id)));
      expect(fixture.state.destroyed).toBe(1);
      expect(fixture.output.stdoutText).toContain("destroyed");
      expect(fixture.telemetry.flushed).toBe(true);
    }).pipe(Effect.provide(fixture.layer));
  });

  it.live("emits a machine-readable result after --yes", () => {
    const fixture = setup({ yes: true, outputFormat: "json" });
    return Effect.gen(function* () {
      yield* stackDestroy(flags(Option.some(id)));
      expect(fixture.output.messages).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: "success", data: { destroyed: true, id } }),
        ]),
      );
    }).pipe(Effect.provide(fixture.layer));
  });

  it.live("does not destroy a stack when interactive confirmation is declined", () => {
    const fixture = setup({ yes: false, interactive: true, promptConfirmResponses: [false] });
    return Effect.gen(function* () {
      const failure = yield* stackDestroy(flags()).pipe(Effect.flip);
      expect(failure.message).toContain("not confirmed");
      expect(fixture.state.destroyed).toBe(0);
    }).pipe(Effect.provide(fixture.layer));
  });

  it.live("flushes telemetry when destruction fails", () => {
    const fixture = setup({ yes: true, destroyFailure: true });
    return Effect.gen(function* () {
      const failure = yield* stackDestroy(flags(Option.some(id))).pipe(Effect.flip);
      expect(failure.message).toContain("destroy failed");
      expect(fixture.telemetry.flushed).toBe(true);
    }).pipe(Effect.provide(fixture.layer));
  });

  it.live("rejects malformed and conflicting targets without opening a stack", () => {
    const fixture = setup({ yes: true });
    return Effect.gen(function* () {
      const malformed = yield* stackDestroy(flags(Option.some("invalid"))).pipe(Effect.flip);
      expect(malformed.message).toContain("lowercase SHA-256");
      const conflicting = yield* stackDestroy(
        flags(Option.some(id), Option.some("feature-a")),
      ).pipe(Effect.flip);
      expect(conflicting.message).toContain("cannot be used together");
    }).pipe(Effect.provide(fixture.layer));
  });

  it.live("reports an absent named target", () => {
    const fixture = setup({ yes: true, found: false });
    return Effect.gen(function* () {
      const failure = yield* stackDestroy(flags()).pipe(Effect.flip);
      expect(failure.message).toContain("No managed stack");
    }).pipe(Effect.provide(fixture.layer));
  });
});
