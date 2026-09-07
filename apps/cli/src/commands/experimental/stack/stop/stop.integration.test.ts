import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer, Option, Stream } from "effect";
import { StackIdSchema, StackStateInvalidError } from "@supabase/stack/effect";
import type { EffectStack, StackStatus, StackStopError } from "@supabase/stack/effect";
import { mockOutput } from "../../../../../tests/helpers/mocks.ts";
import { mockLegacyCliSettings } from "../../../../../tests/helpers/legacy-mocks.ts";
import { LegacyOutputFlag } from "../../../../shared/legacy/global-flags.ts";
import {
  actionability,
  ErrorActionabilityId,
} from "../../../../shared/telemetry/error-actionability.ts";
import { LegacyExperimentalStackApi } from "../stack.shared.ts";
import {
  legacyExperimentalStackStop,
  legacyValidateExperimentalStackStopTarget,
} from "./stop.handler.ts";
import { LegacyExperimentalStackStopError } from "./stop.errors.ts";

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

const flags = (overrides: Partial<Parameters<typeof legacyExperimentalStackStop>[0]> = {}) => ({
  stack: Option.none<string>(),
  stackId: Option.none<string>(),
  ...overrides,
});

function setup(opts: {
  root: string;
  found?: { id: string; name?: string };
  stop?: () => Effect.Effect<void, StackStopError>;
}) {
  const out = mockOutput();
  const state = {
    findInputs: [] as Array<{ projectRoot: string; name?: string }>,
    openedIds: [] as string[],
    stopCalls: 0,
    retainedRows: ["retained-row"],
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
    destroy: () => Effect.die("must not destroy"),
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
    mockLegacyCliSettings({ workdir: opts.root }),
    Layer.succeed(LegacyExperimentalStackApi, {
      createStack: () => Effect.die("must not create"),
      findStack: (input) =>
        Effect.sync(() => {
          state.findInputs.push(input);
          return descriptor === undefined ? Option.none() : Option.some(descriptor);
        }),
      openStack: (stackId) =>
        Effect.sync(() => {
          state.openedIds.push(stackId);
          return stack;
        }),
      inspectStack: () => Effect.die("must not inspect"),
    }),
    BunServices.layer,
  );
  return { layer, out, state };
}

describe("experimental stack stop", () => {
  it.effect("stops a named stack without destroying its data", () => {
    const root = mkdtempSync(join(tmpdir(), "supabase-stack-stop-"));
    const setupResult = setup({
      root,
      found: { id: "a".repeat(64), name: "feature-a" },
    });
    return Effect.gen(function* () {
      yield* legacyExperimentalStackStop(flags({ stack: Option.some("feature-a") }));
      expect(setupResult.state.findInputs).toEqual([{ projectRoot: root, name: "feature-a" }]);
      expect(setupResult.state.openedIds).toEqual(["a".repeat(64)]);
      expect(setupResult.state.stopCalls).toBe(1);
      expect(setupResult.out.stdoutText).toContain("stopped");
      expect(setupResult.out.messages.some((message) => message.type === "success")).toBe(true);
    }).pipe(
      Effect.provide(setupResult.layer),
      Effect.ensuring(Effect.sync(() => rmSync(root, { recursive: true, force: true }))),
    );
  });

  it.effect("opens an explicit id without finding or reading the current project", () => {
    const root = join(tmpdir(), `supabase-stack-stop-id-${Date.now()}`);
    const id = "c".repeat(64);
    const setupResult = setup({ root, found: { id } });
    return Effect.gen(function* () {
      yield* legacyExperimentalStackStop(flags({ stackId: Option.some(id) }));
      expect(setupResult.state.findInputs).toEqual([]);
      expect(setupResult.state.openedIds).toEqual([id]);
      expect(setupResult.state.stopCalls).toBe(1);
    }).pipe(Effect.provide(setupResult.layer));
  });

  it.effect("stops an already stopped stack repeatedly while retaining its data", () => {
    const root = mkdtempSync(join(tmpdir(), "supabase-stack-stop-repeat-"));
    const setupResult = setup({ root, found: { id: "d".repeat(64) } });
    return Effect.gen(function* () {
      yield* legacyExperimentalStackStop(flags());
      yield* legacyExperimentalStackStop(flags());
      expect(setupResult.state.stopCalls).toBe(2);
      expect(setupResult.state.retainedRows).toEqual(["retained-row"]);
    }).pipe(
      Effect.provide(setupResult.layer),
      Effect.ensuring(Effect.sync(() => rmSync(root, { recursive: true, force: true }))),
    );
  });

  it.effect("reports a missing named stack without opening or stopping anything", () => {
    const root = mkdtempSync(join(tmpdir(), "supabase-stack-stop-named-missing-"));
    const setupResult = setup({ root });
    return Effect.gen(function* () {
      const failure = yield* legacyExperimentalStackStop(
        flags({ stack: Option.some("missing") }),
      ).pipe(Effect.flip);
      expect(failure[ErrorActionabilityId]).toEqual(actionability.provideFlags);
      expect(setupResult.state.findInputs).toEqual([{ projectRoot: root, name: "missing" }]);
      expect(setupResult.state.openedIds).toEqual([]);
      expect(setupResult.state.stopCalls).toBe(0);
    }).pipe(
      Effect.provide(setupResult.layer),
      Effect.ensuring(Effect.sync(() => rmSync(root, { recursive: true, force: true }))),
    );
  });

  it.effect("rejects malformed ids before opening or stopping anything", () => {
    const root = mkdtempSync(join(tmpdir(), "supabase-stack-stop-malformed-"));
    const setupResult = setup({ root });
    return Effect.gen(function* () {
      const failure = yield* legacyExperimentalStackStop(
        flags({ stackId: Option.some("invalid") }),
      ).pipe(Effect.flip);
      expect(failure[ErrorActionabilityId]).toEqual(actionability.provideFlags);
      expect(setupResult.state.findInputs).toEqual([]);
      expect(setupResult.state.openedIds).toEqual([]);
      expect(setupResult.state.stopCalls).toBe(0);
    }).pipe(
      Effect.provide(setupResult.layer),
      Effect.ensuring(Effect.sync(() => rmSync(root, { recursive: true, force: true }))),
    );
  });

  it.effect("is idempotent when no current stack exists and does not read config", () => {
    const root = join(tmpdir(), `supabase-stack-stop-missing-${Date.now()}`);
    const setupResult = setup({ root });
    return Effect.gen(function* () {
      yield* legacyExperimentalStackStop(flags());
      expect(
        setupResult.out.messages.some((message) =>
          message.message.includes("No managed stack found"),
        ),
      ).toBe(true);
    }).pipe(Effect.provide(setupResult.layer));
  });

  it.effect("rejects explicit legacy output and mutually exclusive targets", () =>
    Effect.gen(function* () {
      const targetFailure = yield* legacyValidateExperimentalStackStopTarget({
        stack: Option.some("feature-a"),
        stackId: Option.some("a".repeat(64)),
      }).pipe(Effect.flip);
      expect(targetFailure[ErrorActionabilityId]).toEqual(actionability.provideFlags);
      expect(targetFailure.message).toContain("cannot be used together");
    }),
  );

  it.effect("does not report success when package stop fails", () => {
    const root = mkdtempSync(join(tmpdir(), "supabase-stack-stop-failure-"));
    const setupResult = setup({
      root,
      found: { id: "b".repeat(64) },
      stop: () => Effect.fail(new StackStateInvalidError({ message: "stop failed" })),
    });
    return Effect.gen(function* () {
      const failure = yield* legacyExperimentalStackStop(flags()).pipe(Effect.flip);
      expect(failure).toBeInstanceOf(LegacyExperimentalStackStopError);
      expect(setupResult.out.messages.some((message) => message.type === "success")).toBe(false);
    }).pipe(
      Effect.provide(setupResult.layer),
      Effect.ensuring(Effect.sync(() => rmSync(root, { recursive: true, force: true }))),
    );
  });

  it.effect("rejects the legacy output flag with actionable guidance", () => {
    const root = mkdtempSync(join(tmpdir(), "supabase-stack-stop-output-"));
    const setupResult = setup({ root });
    return Effect.gen(function* () {
      const failure = yield* legacyExperimentalStackStop(flags()).pipe(Effect.flip);
      expect(failure).toBeInstanceOf(LegacyExperimentalStackStopError);
      expect(failure[ErrorActionabilityId]).toEqual(actionability.provideFlags);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(setupResult.layer, Layer.succeed(LegacyOutputFlag, Option.some("json"))),
      ),
      Effect.ensuring(Effect.sync(() => rmSync(root, { recursive: true, force: true }))),
    );
  });
});
