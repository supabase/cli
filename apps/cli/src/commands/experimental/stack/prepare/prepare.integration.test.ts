import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Deferred, Effect, Fiber, Layer, Option, Stream } from "effect";
import { CliOutput, Command } from "effect/unstable/cli";
import { StackIdSchema, StackPreparationError, type EffectStack } from "@supabase/stack/effect";
import { mockOutput } from "../../../../../tests/helpers/mocks.ts";
import { mockLegacyCliSettings } from "../../../../../tests/helpers/legacy-mocks.ts";
import {
  LegacyExperimentalStackApi,
  LegacyExperimentalStackTargetResolver,
} from "../stack.shared.ts";
import {
  legacyExperimentalStackPrepare,
  legacyValidateExperimentalStackPrepareTarget,
} from "./prepare.handler.ts";
import { legacyExperimentalStackPrepareCommand } from "./prepare.command.ts";
import { LegacyExperimentalStackPrepareError } from "./prepare.errors.ts";
import { textCliOutputFormatter } from "../../../../shared/output/text-formatter.ts";
import { LegacyOutputFlag } from "../../../../shared/legacy/global-flags.ts";
import {
  actionability,
  ErrorActionabilityId,
} from "../../../../shared/telemetry/error-actionability.ts";

const project = (): string => {
  const root = mkdtempSync(join(tmpdir(), "supabase-experimental-stack-prepare-"));
  mkdirSync(join(root, "supabase"), { recursive: true });
  writeFileSync(join(root, "supabase", "config.toml"), 'project_id = "prepare-test"\n');
  return root;
};

const flags = (overrides: Partial<Parameters<typeof legacyExperimentalStackPrepare>[0]> = {}) => ({
  stack: Option.none<string>(),
  stackId: Option.none<string>(),
  runtime: "auto" as const,
  capability: [],
  ...overrides,
});

function fakeStack(
  id: string,
  prepare: (options: unknown) => Effect.Effect<
    {
      capabilities: ReadonlyArray<{
        capability: "database" | "rest";
        version: string;
        outcome: "cached" | "downloaded" | "pulled";
      }>;
    },
    StackPreparationError
  >,
) {
  return {
    id: StackIdSchema.make(id),
    status: () => Effect.die("status not used in prepare test"),
    credentials: () => Effect.die("credentials not used in prepare test"),
    prepare,
    start: () => Effect.die("start not used in prepare test"),
    stop: () => Effect.die("stop not used in prepare test"),
    destroy: () => Effect.die("destroy not used in prepare test"),
    logs: () => Effect.die("logs not used in prepare test"),
    followLogs: () => Stream.empty,
  } satisfies EffectStack;
}

function setup(opts: {
  root: string;
  target: { projectRoot: string; name?: string; id?: string; runtime?: { kind: "native" } };
  stack: EffectStack;
  onCreate?: (options: unknown) => void;
  onOpen?: () => void;
}) {
  const out = mockOutput();
  const { id, ...targetWithoutId } = opts.target;
  const targetLayer = Layer.succeed(LegacyExperimentalStackTargetResolver, {
    resolve: () =>
      Effect.succeed({
        ...targetWithoutId,
        ...(id === undefined ? {} : { id: StackIdSchema.make(id) }),
      }),
  });
  const apiLayer = Layer.succeed(LegacyExperimentalStackApi, {
    createStack: (options) => {
      opts.onCreate?.(options);
      return Effect.succeed(opts.stack);
    },
    openStack: () => {
      opts.onOpen?.();
      return Effect.succeed(opts.stack);
    },
    inspectStack: () => Effect.die("inspect not used in prepare test"),
  });
  return {
    out,
    layer: Layer.mergeAll(
      out.layer,
      mockLegacyCliSettings({ workdir: opts.root }),
      targetLayer,
      apiLayer,
      BunServices.layer,
    ),
  };
}

describe("experimental stack prepare", () => {
  it.live("parses repeated capability choices through the command", () => {
    let parsed: ReadonlyArray<string> | undefined;
    const configured = legacyExperimentalStackPrepareCommand.pipe(
      Command.withHandler((flags) =>
        Effect.sync(() => {
          parsed = flags.capability;
        }),
      ),
    );
    return Effect.gen(function* () {
      yield* Command.runWith(configured, { version: "0.0.0-test" })([
        "--capability",
        "rest",
        "--capability",
        "auth",
      ]);
      expect(parsed).toEqual(["rest", "auth"]);
    }).pipe(
      Effect.provide(Layer.mergeAll(BunServices.layer, CliOutput.layer(textCliOutputFormatter()))),
    );
  });

  it.effect("rejects mutually exclusive stack targets", () =>
    legacyValidateExperimentalStackPrepareTarget({
      stack: Option.some("feature-a"),
      stackId: Option.some("a".repeat(64)),
    }).pipe(
      Effect.flip,
      Effect.tap((failure) =>
        Effect.sync(() => expect(failure.message).toContain("cannot be used together")),
      ),
    ),
  );

  it.effect("rejects a disabled capability before package preparation", () => {
    const root = project();
    writeFileSync(
      join(root, "supabase", "config.toml"),
      'project_id = "prepare-test"\n[studio]\nenabled = false\n',
    );
    const stack = fakeStack("f".repeat(64), () => Effect.die("prepare must not run"));
    const setupResult = setup({ root, target: { projectRoot: root }, stack });
    return Effect.gen(function* () {
      const failure = yield* legacyExperimentalStackPrepare(flags({ capability: ["studio"] })).pipe(
        Effect.flip,
      );
      expect(failure[ErrorActionabilityId]).toEqual(actionability.invalidConfig);
      if (failure instanceof LegacyExperimentalStackPrepareError)
        expect(failure.suggestion).toContain("Enable studio");
    }).pipe(
      Effect.provide(setupResult.layer),
      Effect.ensuring(Effect.sync(() => rmSync(root, { recursive: true, force: true }))),
    );
  });

  it.effect("rejects the legacy output flag before resolving the target", () => {
    const root = project();
    let resolved = false;
    const setupResult = setup({
      root,
      target: { projectRoot: root },
      stack: fakeStack("1".repeat(64), () => Effect.die("prepare must not run")),
    });
    const target = Layer.succeed(LegacyExperimentalStackTargetResolver, {
      resolve: () =>
        Effect.sync(() => {
          resolved = true;
          return { projectRoot: root };
        }),
    });
    return Effect.gen(function* () {
      const failure = yield* legacyExperimentalStackPrepare(flags()).pipe(Effect.flip);
      expect(failure[ErrorActionabilityId]).toEqual(actionability.provideFlags);
      expect(resolved).toBe(false);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          setupResult.layer,
          target,
          Layer.succeed(LegacyOutputFlag, Option.some("json")),
        ),
      ),
      Effect.ensuring(Effect.sync(() => rmSync(root, { recursive: true, force: true }))),
    );
  });

  it.effect(
    "creates a stack handle and prepares selected capabilities from the project config",
    () => {
      const root = project();
      let createOptions: unknown;
      let prepareOptions: unknown;
      let stopped = false;
      let destroyed = false;
      const stack = fakeStack("a".repeat(64), (options) => {
        prepareOptions = options;
        return Effect.succeed({
          capabilities: [{ capability: "database", version: "16", outcome: "downloaded" }],
        });
      });
      const setupResult = setup({
        root,
        target: { projectRoot: root, name: "feature-a", runtime: { kind: "native" } },
        stack: {
          ...stack,
          stop: () =>
            Effect.sync(() => {
              stopped = true;
            }),
          destroy: () =>
            Effect.sync(() => {
              destroyed = true;
            }),
        },
        onCreate: (options) => {
          createOptions = options;
        },
      });
      return Effect.gen(function* () {
        yield* legacyExperimentalStackPrepare(
          flags({
            stack: Option.some("feature-a"),
            runtime: "native",
            capability: ["database"],
          }),
        );
        expect(createOptions).toEqual({
          projectRoot: root,
          name: "feature-a",
          runtime: { kind: "native" },
        });
        expect(prepareOptions).toMatchObject({ capabilities: ["database"] });
        expect(stopped).toBe(false);
        expect(destroyed).toBe(false);
        expect(setupResult.out.stdoutText).toContain("prepared");
      }).pipe(
        Effect.provide(setupResult.layer),
        Effect.ensuring(Effect.sync(() => rmSync(root, { recursive: true, force: true }))),
      );
    },
  );

  it.effect("emits the selected stack and capabilities in JSON mode", () => {
    const root = project();
    const stack = fakeStack("e".repeat(64), () =>
      Effect.succeed({
        capabilities: [{ capability: "database", version: "16", outcome: "cached" }],
      }),
    );
    const setupResult = setup({ root, target: { projectRoot: root }, stack });
    const output = mockOutput({ format: "json" });
    return Effect.gen(function* () {
      yield* legacyExperimentalStackPrepare(flags());
      expect(output.messages.find((message) => message.type === "success")?.data).toEqual({
        id: "e".repeat(64),
        capabilities: [{ capability: "database", version: "16", outcome: "cached" }],
      });
    }).pipe(
      Effect.provide(Layer.mergeAll(setupResult.layer, output.layer)),
      Effect.ensuring(Effect.sync(() => rmSync(root, { recursive: true, force: true }))),
    );
  });

  it.effect(
    "opens an explicit stack id and omits capabilities for the package default selection",
    () => {
      const settingsRoot = project();
      const targetRoot = project();
      let opened = false;
      let prepareOptions: unknown;
      const stack = fakeStack("b".repeat(64), (options) => {
        prepareOptions = options;
        return Effect.succeed({ capabilities: [] });
      });
      const setupResult = setup({
        root: settingsRoot,
        target: { projectRoot: targetRoot, id: "b".repeat(64) },
        stack,
        onOpen: () => {
          opened = true;
        },
      });
      return Effect.gen(function* () {
        yield* legacyExperimentalStackPrepare(flags({ stackId: Option.some("b".repeat(64)) }));
        expect(opened).toBe(true);
        expect(prepareOptions).toMatchObject({ config: expect.anything() });
        expect(prepareOptions).not.toHaveProperty("capabilities");
      }).pipe(
        Effect.provide(setupResult.layer),
        Effect.ensuring(
          Effect.sync(() => {
            rmSync(settingsRoot, { recursive: true, force: true });
            rmSync(targetRoot, { recursive: true, force: true });
          }),
        ),
      );
    },
  );

  it.effect("maps preparation failures without lifecycle cleanup", () => {
    const root = project();
    const stack = fakeStack("c".repeat(64), () =>
      Effect.fail(new StackPreparationError({ message: "artifact failed" })),
    );
    const setupResult = setup({ root, target: { projectRoot: root }, stack });
    return Effect.gen(function* () {
      const failure = yield* legacyExperimentalStackPrepare(flags()).pipe(Effect.flip);
      expect(failure).toBeInstanceOf(LegacyExperimentalStackPrepareError);
      if (failure instanceof LegacyExperimentalStackPrepareError) {
        expect(failure.reason).toBe("artifact");
        expect(failure.message).toBe("artifact failed");
        expect(failure[ErrorActionabilityId]).toEqual(actionability.externalNetwork);
      }
      expect(setupResult.out.messages.filter((message) => message.type === "success")).toHaveLength(
        0,
      );
    }).pipe(
      Effect.provide(setupResult.layer),
      Effect.ensuring(Effect.sync(() => rmSync(root, { recursive: true, force: true }))),
    );
  });

  it.effect("interrupts caller-owned preparation without lifecycle cleanup", () =>
    Effect.gen(function* () {
      const root = project();
      const started = yield* Deferred.make<void>();
      let stopped = false;
      let destroyed = false;
      const stack = fakeStack("2".repeat(64), () =>
        Effect.gen(function* () {
          yield* Deferred.succeed(started, undefined);
          yield* Effect.never;
          return { capabilities: [] };
        }),
      );
      const setupResult = setup({
        root,
        target: { projectRoot: root },
        stack: {
          ...stack,
          stop: () => Effect.sync(() => (stopped = true)),
          destroy: () => Effect.sync(() => (destroyed = true)),
        },
      });
      const fiber = yield* Effect.forkChild(
        legacyExperimentalStackPrepare(flags()).pipe(Effect.provide(setupResult.layer)),
      );
      yield* Deferred.await(started);
      yield* Fiber.interrupt(fiber);
      expect(stopped).toBe(false);
      expect(destroyed).toBe(false);
      rmSync(root, { recursive: true, force: true });
    }),
  );
});
