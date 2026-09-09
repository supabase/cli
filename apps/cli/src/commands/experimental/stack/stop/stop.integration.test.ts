import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer, Option, Stream } from "effect";
import { CliOutput, Command } from "effect/unstable/cli";
import {
  InvalidStackIdentityError,
  StackCleanupError,
  StackIdSchema,
  StackNotFoundError,
  StackOwnershipConflictError,
  StackStateFormatUnsupportedError,
  StackStateInvalidError,
  StackUpgradeRequiredError,
} from "@supabase/stack/effect";
import type {
  EffectStack,
  OpenStackError,
  StackDiscoveryError,
  StackStatus,
  StackStopError,
} from "@supabase/stack/effect";
import { mockOutput } from "../../../../../tests/helpers/mocks.ts";
import {
  mockCommandSettings,
  mockTelemetryStateTracked,
} from "../../../../../tests/helpers/command-mocks.ts";
import { OutputFlag } from "../../../../command-internal/global-flags.ts";
import {
  actionability,
  ErrorActionabilityId,
} from "../../../../shared/telemetry/error-actionability.ts";
import { ExperimentalStackApi } from "../stack.shared.ts";
import { textCliOutputFormatter } from "../../../../shared/output/text-formatter.ts";
import { experimentalStackStop } from "./stop.handler.ts";
import { ExperimentalStackStopError } from "./stop.errors.ts";
import { experimentalStackStopCommand } from "./stop.command.ts";

const status = (id: string): StackStatus => ({
  id: StackIdSchema.make(id),
  lifecycle: "running",
  desiredLifecycle: "running",
  runtime: { kind: "native" },
  endpoints: {},
  versions: {},
  capabilities: [],
  artifacts: [],
});

const flags = (overrides: Partial<Parameters<typeof experimentalStackStop>[0]> = {}) => ({
  stack: Option.none<string>(),
  stackId: Option.none<string>(),
  ...overrides,
});

function setup(opts: {
  root: string;
  found?: { id: string; name?: string };
  stop?: () => Effect.Effect<void, StackStopError>;
  openFailure?: OpenStackError;
  findFailure?: StackDiscoveryError;
}) {
  const out = mockOutput();
  const telemetry = mockTelemetryStateTracked();
  const state = {
    findInputs: [] as Array<{ projectRoot: string; name?: string }>,
    openedIds: [] as string[],
    stopCalls: 0,
    destroyCalled: false,
  };
  const id = opts.found?.id ?? "a".repeat(64);
  const stack = {
    id: StackIdSchema.make(id),
    status: () => Effect.succeed(status(id)),
    credentials: () => Effect.die("unused"),
    prepare: () => Effect.die("unused"),
    start: () => Effect.die("unused"),
    stop:
      opts.stop ??
      (() =>
        Effect.sync(() => {
          state.stopCalls += 1;
        })),
    destroy: () =>
      Effect.sync(() => {
        state.destroyCalled = true;
      }),
    logs: () => Effect.die("unused"),
    followLogs: () => Stream.empty,
  } satisfies EffectStack;
  const descriptor = opts.found
    ? {
        id: stack.id,
        projectRoot: opts.root,
        name: opts.found.name ?? "feature-a",
        branchContext: "ordinary-workspace",
        runtime: { kind: "native" as const },
        desiredLifecycle: "running" as const,
      }
    : undefined;
  const layer = Layer.mergeAll(
    out.layer,
    telemetry.layer,
    mockCommandSettings({ workdir: opts.root }),
    Layer.succeed(ExperimentalStackApi, {
      createStack: () => Effect.die("must not create"),
      findStack: (input) =>
        Effect.sync(() => {
          state.findInputs.push(input);
          return descriptor === undefined ? Option.none() : Option.some(descriptor);
        }).pipe(
          Effect.flatMap((value) =>
            opts.findFailure === undefined ? Effect.succeed(value) : Effect.fail(opts.findFailure),
          ),
        ),
      openStack: (stackId) => {
        if (opts.openFailure !== undefined) return Effect.fail(opts.openFailure);
        return Effect.sync(() => {
          state.openedIds.push(stackId);
          return stack;
        });
      },
      inspectStack: () => Effect.die("must not inspect"),
    }),
    BunServices.layer,
  );
  return { layer, out, state, telemetry };
}

describe("experimental stack stop", () => {
  it.effect("stops a named stack without calling destroy", () => {
    const root = "/tmp/supabase-stack-stop";
    const setupResult = setup({
      root,
      found: { id: "a".repeat(64), name: "feature-a" },
    });
    return Effect.gen(function* () {
      yield* experimentalStackStop(flags({ stack: Option.some("feature-a") }));
      expect(setupResult.state.findInputs).toEqual([{ projectRoot: root, name: "feature-a" }]);
      expect(setupResult.state.openedIds).toEqual(["a".repeat(64)]);
      expect(setupResult.state.stopCalls).toBe(1);
      expect(setupResult.state.destroyCalled).toBe(false);
      expect(setupResult.out.stdoutText).toContain("stopped");
      expect(setupResult.telemetry.flushed).toBe(true);
    }).pipe(Effect.provide(setupResult.layer));
  });

  it.effect("opens an explicit id without discovering a stack", () => {
    const root = "/tmp/supabase-stack-stop-id";
    const id = "c".repeat(64);
    const setupResult = setup({ root, found: { id } });
    return Effect.gen(function* () {
      yield* experimentalStackStop(flags({ stackId: Option.some(id) }));
      expect(setupResult.state.findInputs).toEqual([]);
      expect(setupResult.state.openedIds).toEqual([id]);
      expect(setupResult.state.stopCalls).toBe(1);
    }).pipe(Effect.provide(setupResult.layer));
  });

  it.effect("invokes stop twice without calling destroy", () => {
    const root = "/tmp/supabase-stack-stop-repeat";
    const setupResult = setup({ root, found: { id: "d".repeat(64) } });
    return Effect.gen(function* () {
      yield* experimentalStackStop(flags());
      yield* experimentalStackStop(flags());
      expect(setupResult.state.stopCalls).toBe(2);
      expect(setupResult.state.destroyCalled).toBe(false);
    }).pipe(Effect.provide(setupResult.layer));
  });

  it.effect("classifies an addressed missing stack as actionable flags", () => {
    const root = "/tmp/supabase-stack-stop-open-missing";
    const setupResult = setup({
      root,
      found: { id: "e".repeat(64) },
      openFailure: new StackNotFoundError({ message: "Stack state was not found" }),
    });
    return Effect.gen(function* () {
      const failure = yield* experimentalStackStop(
        flags({ stackId: Option.some("e".repeat(64)) }),
      ).pipe(Effect.flip);
      expect(failure[ErrorActionabilityId]).toEqual(actionability.provideFlags);
      expect(setupResult.state.stopCalls).toBe(0);
    }).pipe(Effect.provide(setupResult.layer));
  });

  it.effect("emits a self-describing JSON stopped result", () => {
    const root = "/tmp/supabase-stack-stop-json";
    const setupResult = setup({ root, found: { id: "f".repeat(64) } });
    const output = mockOutput({ format: "json" });
    return Effect.gen(function* () {
      yield* experimentalStackStop(flags());
      expect(output.messages.find((message) => message.type === "success")?.data).toEqual({
        found: true,
        id: "f".repeat(64),
        lifecycle: "stopped",
      });
    }).pipe(Effect.provide(Layer.mergeAll(setupResult.layer, output.layer)));
  });

  it.effect("reports a missing named stack without opening or stopping anything", () => {
    const root = "/tmp/supabase-stack-stop-named-missing";
    const setupResult = setup({ root });
    return Effect.gen(function* () {
      const failure = yield* experimentalStackStop(flags({ stack: Option.some("missing") })).pipe(
        Effect.flip,
      );
      expect(failure[ErrorActionabilityId]).toEqual(actionability.provideFlags);
      expect(setupResult.state.findInputs).toEqual([{ projectRoot: root, name: "missing" }]);
      expect(setupResult.state.openedIds).toEqual([]);
      expect(setupResult.state.stopCalls).toBe(0);
    }).pipe(Effect.provide(setupResult.layer));
  });

  it.effect("classifies invalid stack names as actionable flags", () => {
    const root = "/tmp/supabase-stack-stop-invalid-name";
    const setupResult = setup({
      root,
      findFailure: new InvalidStackIdentityError({ message: "The stack name must not be blank" }),
    });
    return Effect.gen(function* () {
      const failure = yield* experimentalStackStop(flags({ stack: Option.some("") })).pipe(
        Effect.flip,
      );
      expect(failure[ErrorActionabilityId]).toEqual(actionability.provideFlags);
      expect(setupResult.state.openedIds).toEqual([]);
      expect(setupResult.state.stopCalls).toBe(0);
    }).pipe(Effect.provide(setupResult.layer));
  });

  it.effect("rejects malformed ids before opening or stopping anything", () => {
    const root = "/tmp/supabase-stack-stop-malformed";
    const setupResult = setup({ root });
    return Effect.gen(function* () {
      const failure = yield* experimentalStackStop(flags({ stackId: Option.some("invalid") })).pipe(
        Effect.flip,
      );
      expect(failure[ErrorActionabilityId]).toEqual(actionability.provideFlags);
      expect(setupResult.state.findInputs).toEqual([]);
      expect(setupResult.state.openedIds).toEqual([]);
      expect(setupResult.state.stopCalls).toBe(0);
    }).pipe(Effect.provide(setupResult.layer));
  });

  it.effect("reports when no current stack exists", () => {
    const root = "/tmp/supabase-stack-stop-missing";
    const setupResult = setup({ root });
    return Effect.gen(function* () {
      yield* experimentalStackStop(flags());
      expect(
        setupResult.out.messages.some((message) =>
          message.message.includes("No managed stack found"),
        ),
      ).toBe(true);
      expect(setupResult.state.openedIds).toEqual([]);
      expect(setupResult.state.stopCalls).toBe(0);
    }).pipe(Effect.provide(setupResult.layer));
  });

  it.effect("rejects mutually exclusive targets before discovering a stack", () => {
    const setupResult = setup({ root: "/tmp/supabase-stack-stop-mutex" });
    return Effect.gen(function* () {
      const targetFailure = yield* experimentalStackStop(
        flags({ stack: Option.some("feature-a"), stackId: Option.some("a".repeat(64)) }),
      ).pipe(Effect.flip);
      expect(targetFailure[ErrorActionabilityId]).toEqual(actionability.provideFlags);
      expect(targetFailure.message).toContain("cannot be used together");
      expect(setupResult.state.findInputs).toEqual([]);
      expect(setupResult.state.openedIds).toEqual([]);
      expect(setupResult.state.stopCalls).toBe(0);
    }).pipe(Effect.provide(setupResult.layer));
  });

  it.effect("does not report success when package stop fails", () => {
    const root = "/tmp/supabase-stack-stop-failure";
    const setupResult = setup({
      root,
      found: { id: "b".repeat(64) },
      stop: () => Effect.fail(new StackStateInvalidError({ message: "stop failed" })),
    });
    return Effect.gen(function* () {
      const failure = yield* experimentalStackStop(flags()).pipe(Effect.flip);
      expect(failure).toBeInstanceOf(ExperimentalStackStopError);
      expect(setupResult.out.messages.some((message) => message.type === "success")).toBe(false);
      expect(setupResult.telemetry.flushed).toBe(true);
    }).pipe(Effect.provide(setupResult.layer));
  });

  it.effect("classifies an ownership conflict as unknown with retry guidance", () => {
    const root = "/tmp/supabase-stack-stop-conflict";
    const ownershipConflict = new StackOwnershipConflictError({ message: "stack is owned" });
    const setupResult = setup({
      root,
      found: { id: "7".repeat(64) },
      stop: () => Effect.fail(ownershipConflict),
    });
    return Effect.gen(function* () {
      const failure = yield* experimentalStackStop(flags()).pipe(Effect.flip);
      expect(failure.reason).toBe("unknown");
      expect(failure[ErrorActionabilityId]).toEqual(actionability.unknown);
      expect(failure.suggestion).toBe(
        "Retry the stack stop; if it remains owned, rerun with --debug and inspect cleanup diagnostics.",
      );
      expect(failure.message).toBe(ownershipConflict.message);
      expect(failure.cause).toBe(ownershipConflict);
      expect(setupResult.state.destroyCalled).toBe(false);
      expect(setupResult.out.messages.some((message) => message.type === "success")).toBe(false);
    }).pipe(Effect.provide(setupResult.layer));
  });

  it.effect("classifies persisted state format failures as invalid config", () => {
    const root = "/tmp/supabase-stack-stop-format";
    const setupResult = setup({
      root,
      found: { id: "8".repeat(64) },
      openFailure: new StackStateFormatUnsupportedError({
        format: "future",
        message: "Unsupported stack state format",
      }),
    });
    return Effect.gen(function* () {
      const failure = yield* experimentalStackStop(flags()).pipe(Effect.flip);
      expect(failure.reason).toBe("invalid-config");
      expect(failure[ErrorActionabilityId]).toEqual(actionability.invalidConfig);
      expect(setupResult.state.stopCalls).toBe(0);
      expect(setupResult.out.messages.some((message) => message.type === "success")).toBe(false);
    }).pipe(Effect.provide(setupResult.layer));
  });

  it.effect("classifies stack upgrade requirements as lifecycle failures", () => {
    const root = "/tmp/supabase-stack-stop-upgrade";
    const setupResult = setup({
      root,
      found: { id: "9".repeat(64) },
      openFailure: new StackUpgradeRequiredError({
        expectedRelease: "next",
        actualRelease: "current",
        message: "Stack upgrade required",
      }),
    });
    return Effect.gen(function* () {
      const failure = yield* experimentalStackStop(flags()).pipe(Effect.flip);
      expect(failure.reason).toBe("lifecycle");
      expect(failure[ErrorActionabilityId]).toEqual(actionability.invalidConfig);
      expect(setupResult.state.stopCalls).toBe(0);
      expect(setupResult.out.messages.some((message) => message.type === "success")).toBe(false);
    }).pipe(Effect.provide(setupResult.layer));
  });

  it.effect("classifies cleanup failures as unknown actionability with debug guidance", () => {
    const root = "/tmp/supabase-stack-stop-cleanup";
    const setupResult = setup({
      root,
      found: { id: "a".repeat(64) },
      stop: () => Effect.fail(new StackCleanupError({ message: "cleanup failed" })),
    });
    return Effect.gen(function* () {
      const failure = yield* experimentalStackStop(flags()).pipe(Effect.flip);
      expect(failure.reason).toBe("unknown");
      expect(failure[ErrorActionabilityId]).toEqual(actionability.unknown);
      expect(failure.suggestion).toContain("--debug");
      expect(setupResult.state.openedIds).toEqual(["a".repeat(64)]);
      expect(setupResult.state.destroyCalled).toBe(false);
      expect(setupResult.out.messages.some((message) => message.type === "success")).toBe(false);
    }).pipe(Effect.provide(setupResult.layer));
  });

  it.effect("rejects the output flag with actionable guidance", () => {
    const root = "/tmp/supabase-stack-stop-output";
    const setupResult = setup({ root });
    return Effect.gen(function* () {
      const failure = yield* experimentalStackStop(flags()).pipe(Effect.flip);
      expect(failure).toBeInstanceOf(ExperimentalStackStopError);
      expect(failure[ErrorActionabilityId]).toEqual(actionability.provideFlags);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(setupResult.layer, Layer.succeed(OutputFlag, Option.some("json"))),
      ),
    );
  });
});

describe("experimental stack stop parser", () => {
  it.live("passes a stack name to the handler", () => {
    let parsed: Option.Option<string> | undefined;
    const command = experimentalStackStopCommand.pipe(
      Command.withHandler((flags) => Effect.sync(() => (parsed = flags.stack))),
    );
    return Effect.gen(function* () {
      yield* Command.runWith(command, { version: "0.0.0-test" })(["--stack", "feature-a"]);
      expect(parsed).toEqual(Option.some("feature-a"));
    }).pipe(
      Effect.provide(Layer.mergeAll(BunServices.layer, CliOutput.layer(textCliOutputFormatter()))),
    );
  });
});
