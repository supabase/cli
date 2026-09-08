import { describe, expect, it } from "@effect/vitest";
import { BunServices } from "@effect/platform-bun";
import { Effect, Layer, Option, Stream } from "effect";
import { Command } from "effect/unstable/cli";
import { StackDestructionError, StackIdSchema } from "@supabase/stack/effect";
import type { EffectStack } from "@supabase/stack/effect";
import { CliArgs } from "../../../../shared/cli/cli-args.service.ts";
import { LegacyYesFlag } from "../../../../shared/legacy/global-flags.ts";
import { mockLegacyCliSettings } from "../../../../../tests/helpers/legacy-mocks.ts";
import { mockOutput, mockStdin, mockTty } from "../../../../../tests/helpers/mocks.ts";
import {
  actionability,
  ErrorActionabilityId,
} from "../../../../shared/telemetry/error-actionability.ts";
import { LegacyExperimentalStackApi } from "../stack.shared.ts";
import {
  legacyExperimentalStackDestroy,
  legacyValidateExperimentalStackDestroyTarget,
} from "./destroy.handler.ts";
import { LegacyExperimentalStackDestroyError } from "./destroy.errors.ts";
import { legacyExperimentalStackDestroyCommand } from "./destroy.command.ts";

const id = "a".repeat(64);
const flags = (overrides: Partial<Parameters<typeof legacyExperimentalStackDestroy>[0]> = {}) => ({
  stack: Option.none<string>(),
  stackId: Option.none<string>(),
  ...overrides,
});

function setup(opts: {
  yes: boolean;
  stdinIsTty: boolean;
  outputFormat?: "text" | "json";
  promptConfirmResponses?: ReadonlyArray<boolean>;
  found?: boolean;
  destroyFailure?: boolean;
}) {
  const output = mockOutput({
    format: opts.outputFormat,
    promptConfirmResponses: opts.promptConfirmResponses,
  });
  const state = { destroyed: 0, openedIds: [] as string[] };
  const descriptor = {
    id: StackIdSchema.make(id),
    projectRoot: "/project",
    name: "feature-a",
    branchContext: "ordinary-workspace" as const,
    runtime: { kind: "native" as const },
    desiredLifecycle: "stopped" as const,
  };
  const stack = {
    id: descriptor.id,
    status: () => Effect.die("unused"),
    credentials: () => Effect.die("unused"),
    prepare: () => Effect.die("unused"),
    start: () => Effect.die("unused"),
    stop: () => Effect.die("unused"),
    destroy: () =>
      opts.destroyFailure
        ? Effect.fail(new StackDestructionError({ message: "destroy failed" }))
        : Effect.sync(() => void state.destroyed++),
    logs: () => Effect.die("unused"),
    followLogs: () => Stream.empty,
  } satisfies EffectStack;
  const layer = Layer.mergeAll(
    output.layer,
    mockStdin(opts.stdinIsTty),
    mockLegacyCliSettings({ workdir: "/project" }),
    mockTty({ stdinIsTty: opts.stdinIsTty, stdoutIsTty: opts.stdinIsTty }),
    Layer.succeed(LegacyYesFlag, opts.yes),
    Layer.succeed(CliArgs, { args: [] }),
    Layer.succeed(LegacyExperimentalStackApi, {
      createStack: () => Effect.die("unused"),
      listStacks: () => Effect.succeed([]),
      discoverStacks: () => Effect.succeed({ stacks: [], errors: [] }),
      findStack: () =>
        Effect.succeed(opts.found === false ? Option.none() : Option.some(descriptor)),
      inspectStack: () => Effect.succeed({ descriptor, owner: "absent" as const }),
      openStack: (stackId) =>
        Effect.sync(() => {
          state.openedIds.push(stackId);
          return { ...stack, id: StackIdSchema.make(stackId) };
        }),
    }),
  );
  return { layer, output, state };
}

describe("experimental stack destroy", () => {
  it.live("requires --yes in a noninteractive session and does not mutate", () => {
    const setupResult = setup({ yes: false, stdinIsTty: false });
    return Effect.gen(function* () {
      const failure = yield* legacyExperimentalStackDestroy(flags()).pipe(Effect.flip);
      expect(failure).toBeInstanceOf(LegacyExperimentalStackDestroyError);
      expect(failure.message).toContain("requires confirmation");
      expect(setupResult.state.destroyed).toBe(0);
    }).pipe(Effect.provide(setupResult.layer));
  });

  it.live("destroys the exact selected stack after --yes", () => {
    const setupResult = setup({ yes: true, stdinIsTty: false });
    return Effect.gen(function* () {
      yield* legacyExperimentalStackDestroy(flags({ stackId: Option.some(id) }));
      expect(setupResult.state.destroyed).toBe(1);
      expect(setupResult.state.openedIds).toEqual([id]);
      expect(setupResult.output.stdoutText).toContain("destroyed");
    }).pipe(Effect.provide(setupResult.layer));
  });

  it.live("does not destroy when an interactive confirmation is declined", () => {
    const setupResult = setup({ yes: false, stdinIsTty: true, promptConfirmResponses: [false] });
    return Effect.gen(function* () {
      const failure = yield* legacyExperimentalStackDestroy(flags()).pipe(Effect.flip);
      expect(failure.message).toContain("not confirmed");
      expect(setupResult.state.openedIds).toEqual([]);
      expect(setupResult.state.destroyed).toBe(0);
    }).pipe(Effect.provide(setupResult.layer));
  });

  it.live("reports a destroy failure without reporting success", () => {
    const setupResult = setup({ yes: true, stdinIsTty: false, destroyFailure: true });
    return Effect.gen(function* () {
      const failure = yield* legacyExperimentalStackDestroy(flags()).pipe(Effect.flip);
      expect(failure.message).toContain("destroy failed");
      expect(failure.reason).toBe("lifecycle");
      expect(failure[ErrorActionabilityId]).toEqual(actionability.invalidConfig);
      expect(setupResult.state.openedIds).toEqual([id]);
      expect(setupResult.output.messages.some((message) => message.type === "success")).toBe(false);
    }).pipe(Effect.provide(setupResult.layer));
  });

  it.live("emits JSON success after confirmed destruction", () => {
    const setupResult = setup({ yes: true, stdinIsTty: false, outputFormat: "json" });
    return Effect.gen(function* () {
      yield* legacyExperimentalStackDestroy(flags());
      expect(setupResult.output.messages).toContainEqual(
        expect.objectContaining({
          type: "success",
          data: { destroyed: true, id },
        }),
      );
    }).pipe(Effect.provide(setupResult.layer));
  });

  it.live("rejects a missing named stack and malformed id before opening", () => {
    const missing = setup({ yes: true, stdinIsTty: false, found: false });
    const malformed = setup({ yes: true, stdinIsTty: false });
    return Effect.gen(function* () {
      const missingFailure = yield* legacyExperimentalStackDestroy(
        flags({ stack: Option.some("missing") }),
      ).pipe(Effect.flip, Effect.provide(missing.layer));
      const malformedFailure = yield* legacyExperimentalStackDestroy(
        flags({ stackId: Option.some("invalid") }),
      ).pipe(Effect.flip, Effect.provide(malformed.layer));
      expect(missingFailure.message).toContain("No managed stack named");
      expect(malformedFailure.message).toContain("lowercase SHA-256");
      expect(missing.state.openedIds).toEqual([]);
      expect(malformed.state.openedIds).toEqual([]);
    });
  });

  it.effect("rejects a stack name and id together before side effects", () =>
    Effect.gen(function* () {
      const failure = yield* legacyValidateExperimentalStackDestroyTarget({
        stack: Option.some("feature-a"),
        stackId: Option.some(id),
      }).pipe(Effect.flip);
      expect(failure.message).toContain("cannot be used together");
    }),
  );
});

describe("experimental stack destroy parser", () => {
  it.live("parses an explicit stack id", () => {
    let parsed: Option.Option<string> | undefined;
    const command = legacyExperimentalStackDestroyCommand.pipe(
      Command.withHandler((parsedFlags) => Effect.sync(() => (parsed = parsedFlags.stackId))),
    );
    return Command.runWith(command, { version: "0.0.0-test" })(["--stack-id", id]).pipe(
      Effect.andThen(Effect.sync(() => expect(parsed).toEqual(Option.some(id)))),
      Effect.provide(BunServices.layer),
    );
  });
});
