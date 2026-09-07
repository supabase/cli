import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Exit, Layer, Option, Stream } from "effect";
import { CliOutput, Command } from "effect/unstable/cli";
import {
  PortUnavailableError,
  StackIdSchema,
  StackLifecycleConflictError,
  StackPreparationError,
  StackRuntimeError,
  type EffectStack,
  type StackStatus,
} from "@supabase/stack/effect";
import { mockOutput } from "../../../../../tests/helpers/mocks.ts";
import { mockLegacyCliSettings } from "../../../../../tests/helpers/legacy-mocks.ts";
import { LegacyOutputFlag } from "../../../../shared/legacy/global-flags.ts";
import {
  actionability,
  ErrorActionabilityId,
} from "../../../../shared/telemetry/error-actionability.ts";
import { LegacyExperimentalStackApi } from "../stack.shared.ts";
import { legacyExperimentalStackCommand } from "../stack.command.ts";
import { legacyExperimentalStackRestart } from "./restart.handler.ts";
import { legacyExperimentalStackRestartCommand } from "./restart.command.ts";
import { textCliOutputFormatter } from "../../../../shared/output/text-formatter.ts";

const stackId = StackIdSchema.make("a".repeat(64));
const status = (lifecycle: StackStatus["lifecycle"] = "running"): StackStatus => ({
  id: stackId,
  lifecycle,
  desiredLifecycle: "running",
  runtime: { kind: "native" },
  endpoints: {},
  versions: {},
  capabilities: [],
  artifacts: [],
});

const flags = (stack = Option.none<string>(), stackIdFlag = Option.none<string>()) => ({
  stack,
  stackId: stackIdFlag,
});

const makeFixture = (options: {
  readonly target?: "current" | "id" | "name";
  readonly config?: "valid" | "invalid" | "missing";
  readonly prepare?: "ok" | "fail";
  readonly stop?: "ok" | "fail";
  readonly start?: "ok" | "fail" | "port";
  readonly format?: "text" | "json";
  readonly legacyOutput?: boolean;
  readonly missingTarget?: boolean;
}) => {
  const root = mkdtempSync(join(tmpdir(), "supabase-experimental-stack-restart-"));
  const projectRoot = join(root, "selected-project");
  mkdirSync(join(projectRoot, "supabase"), { recursive: true });
  if (options.config !== "missing")
    writeFileSync(
      join(projectRoot, "supabase", "config.toml"),
      options.config === "invalid"
        ? 'project_id = "unterminated\n'
        : 'project_id = "restart-test"\n',
    );
  const calls: string[] = [];
  let lifecycle: StackStatus["lifecycle"] = "running";
  const stack: EffectStack = {
    id: stackId,
    status: () => Effect.succeed(status(lifecycle)),
    credentials: () => Effect.die("credentials unused"),
    prepare: () => {
      calls.push("prepare");
      return options.prepare === "fail"
        ? Effect.fail(new StackPreparationError({ message: "prepare failed" }))
        : Effect.succeed({ capabilities: [] });
    },
    stop: () => {
      calls.push("stop");
      return options.stop === "fail"
        ? Effect.fail(new StackLifecycleConflictError({ message: "stop failed" }))
        : Effect.sync(() => {
            lifecycle = "stopped";
          });
    },
    start: () => {
      calls.push("start");
      return options.start === "fail"
        ? Effect.fail(new StackRuntimeError({ message: "start failed" }))
        : options.start === "port"
          ? Effect.fail(new PortUnavailableError({ message: "port 54321 is unavailable" }))
          : Effect.sync(() => {
              lifecycle = "running";
              return status(lifecycle);
            });
    },
    destroy: () => {
      calls.push("destroy");
      return Effect.die("destroy must not run");
    },
    logs: () => Effect.die("logs unused"),
    followLogs: () => Stream.empty,
  };
  const descriptor = {
    id: stackId,
    projectRoot,
    name: "feature-a",
    branchContext: "restart-test",
    runtime: { kind: "native" as const },
    desiredLifecycle: "running" as const,
  };
  const out = mockOutput({ format: options.format });
  const api = Layer.succeed(LegacyExperimentalStackApi, {
    createStack: () => Effect.die("create must not run"),
    findStack: () =>
      Effect.succeed(options.missingTarget === true ? Option.none() : Option.some(descriptor)),
    openStack: () => {
      calls.push("open");
      return Effect.succeed(stack);
    },
    inspectStack: () => Effect.succeed({ descriptor, owner: "running" as const }),
  });
  const layer = Layer.mergeAll(
    out.layer,
    api,
    mockLegacyCliSettings({ workdir: root }),
    ...(options.legacyOutput ? [Layer.succeed(LegacyOutputFlag, Option.some("json"))] : []),
    BunServices.layer,
  );
  const selectedFlags =
    options.target === "id"
      ? flags(Option.none(), Option.some(stackId))
      : options.target === "name"
        ? flags(Option.some("feature-a"))
        : flags();
  return {
    calls,
    stack,
    out,
    projectRoot,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
    layer,
    effect: legacyExperimentalStackRestart(selectedFlags).pipe(
      Effect.provide(layer),
      Effect.ensuring(Effect.sync(() => rmSync(root, { recursive: true, force: true }))),
    ),
  };
};

describe("experimental stack restart", () => {
  it.live("parses --stack-id through the command", () => {
    let parsed: Option.Option<string> | undefined;
    const command = legacyExperimentalStackRestartCommand.pipe(
      Command.withHandler((flags) =>
        Effect.sync(() => {
          parsed = flags.stackId;
        }),
      ),
    );
    return Effect.gen(function* () {
      yield* Command.runWith(command, { version: "0.0.0-test" })(["--stack-id", "a".repeat(64)]);
      expect(parsed).toEqual(Option.some("a".repeat(64)));
    }).pipe(
      Effect.provide(Layer.mergeAll(BunServices.layer, CliOutput.layer(textCliOutputFormatter()))),
    );
  });

  it("registers restart once in the actual parent command", () => {
    const commands = legacyExperimentalStackCommand.subcommands.flatMap(({ commands }) => commands);
    expect(commands.filter((command) => command.name === "restart")).toHaveLength(1);
  });

  it.effect("prepares, stops, and starts the same stack in order", () => {
    const fixture = makeFixture({ target: "id", format: "json" });
    return fixture.effect.pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          expect(fixture.calls).toEqual(["open", "prepare", "stop", "start"]);
          expect(
            fixture.out.messages.find((message) => message.data !== undefined)?.data,
          ).toMatchObject({
            id: stackId,
            lifecycle: "running",
          });
        }),
      ),
    );
  });

  it.effect("renders a concise text result after restart", () => {
    const fixture = makeFixture({ format: "text" });
    return fixture.effect.pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          expect(fixture.out.stdoutText).toContain(`Stack ${stackId}`);
          expect(fixture.out.stdoutText).toContain("Lifecycle: running");
        }),
      ),
    );
  });

  it.effect("uses named target selection and never creates a stack", () => {
    const fixture = makeFixture({ target: "name" });
    return fixture.effect.pipe(
      Effect.tap(() =>
        Effect.sync(() => expect(fixture.calls).toEqual(["open", "prepare", "stop", "start"])),
      ),
    );
  });

  it.effect("does not stop when config or preparation fails", () => {
    const invalid = makeFixture({ config: "invalid" });
    const preparation = makeFixture({ prepare: "fail" });
    return Effect.gen(function* () {
      expect(Exit.isFailure(yield* invalid.effect.pipe(Effect.exit))).toBe(true);
      expect(Exit.isFailure(yield* preparation.effect.pipe(Effect.exit))).toBe(true);
      expect(invalid.calls).toEqual([]);
      expect(preparation.calls).toEqual(["open", "prepare"]);
    });
  });

  it.effect(
    "does not start after stop failure and retains stopped ownership after start failure",
    () => {
      const stop = makeFixture({ stop: "fail" });
      const start = makeFixture({ start: "fail" });
      return Effect.gen(function* () {
        expect(Exit.isFailure(yield* stop.effect.pipe(Effect.exit))).toBe(true);
        expect(Exit.isFailure(yield* start.effect.pipe(Effect.exit))).toBe(true);
        expect(stop.calls).toEqual(["open", "prepare", "stop"]);
        expect(start.calls).toEqual(["open", "prepare", "stop", "start"]);
        expect(start.calls).not.toContain("destroy");
        expect(yield* start.stack.status()).toMatchObject({ id: stackId, lifecycle: "stopped" });
      });
    },
  );

  it.effect("classifies an unavailable start port as actionable configuration", () => {
    const fixture = makeFixture({ start: "port" });
    return Effect.gen(function* () {
      const failure = yield* fixture.effect.pipe(Effect.flip);
      expect(failure.reason).toBe("port");
      expect(failure.suggestion).toContain("port");
      expect(failure[ErrorActionabilityId]).toEqual(actionability.invalidConfig);
      expect(fixture.calls).toEqual(["open", "prepare", "stop", "start"]);
    });
  });

  it.effect("rejects invalid flags and legacy output before lifecycle calls", () => {
    const invalid = makeFixture({});
    const legacy = makeFixture({ legacyOutput: true });
    const invalidEffect = legacyExperimentalStackRestart(
      flags(Option.some("name"), Option.some(stackId)),
    ).pipe(Effect.provide(invalid.layer), Effect.exit);
    return Effect.gen(function* () {
      expect(Exit.isFailure(yield* legacy.effect.pipe(Effect.exit))).toBe(true);
      expect(Exit.isFailure(yield* invalidEffect)).toBe(true);
      expect(legacy.calls).toEqual([]);
      expect(invalid.calls).toEqual([]);
    }).pipe(Effect.ensuring(Effect.sync(invalid.cleanup)));
  });

  it.effect("fails a missing named target without lifecycle calls", () => {
    const fixture = makeFixture({ target: "name", missingTarget: true });
    return fixture.effect.pipe(
      Effect.exit,
      Effect.tap((exit) =>
        Effect.sync(() => {
          expect(Exit.isFailure(exit)).toBe(true);
          expect(fixture.calls).toEqual([]);
        }),
      ),
    );
  });
});
