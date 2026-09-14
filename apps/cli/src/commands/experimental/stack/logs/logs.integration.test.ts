// oxlint-disable-next-line effecttsgo/node-builtin-import -- filesystem test fixture uses the host adapter at this boundary
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
// oxlint-disable-next-line effecttsgo/node-builtin-import -- filesystem test fixture uses the host adapter at this boundary
import { join } from "node:path";
import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Deferred, Effect, Fiber, Layer, Option, Schema, Stream } from "effect";
import { CliError, CliOutput, Command } from "effect/unstable/cli";
import {
  InvalidProjectRootError,
  StackIdSchema,
  StackOwnershipConflictError,
  StackUpgradeRequiredError,
} from "@supabase/stack/effect";
import type {
  EffectStack,
  OpenStackError,
  StackLogBatch,
  StackLogEntry,
  StackDiscoveryError,
  StackStatus,
} from "@supabase/stack/effect";
import { mockCommandSettings } from "../../../../../tests/helpers/command-mocks.ts";
import { mockOutput } from "../../../../../tests/helpers/mocks.ts";
import { OutputFlag } from "../../../../command-internal/global-flags.ts";
import {
  ErrorActionabilityId,
  actionability,
} from "../../../../shared/telemetry/error-actionability.ts";
import { StackApi } from "../stack.shared.ts";
import { stackLogs } from "./logs.handler.ts";
import { StackCommandLogsError } from "./logs.errors.ts";
import { stackLogsCommand } from "./logs.command.ts";
import { mockTelemetryStateLayer } from "../../../../../tests/helpers/command-mocks.ts";
import { textCliOutputFormatter } from "../../../../shared/output/text-formatter.ts";

const id = StackIdSchema.make("a".repeat(64));
const entries: ReadonlyArray<StackLogEntry> = [
  {
    cursor: { opaque: "1" },
    timestamp: "2026-09-08T00:00:00.000Z",
    source: "database",
    stream: "stdout",
    message: "database ready",
  },
  {
    cursor: { opaque: "2" },
    timestamp: "2026-09-08T00:00:01.000Z",
    source: "functions",
    stream: "stderr",
    message: "function failed",
  },
];
const internalEntry: StackLogEntry = {
  cursor: { opaque: "internal-1" },
  timestamp: "2026-09-08T00:00:02.000Z",
  source: "supervisor",
  stream: "internal",
  message: "stack supervisor ready",
};

const status: StackStatus = {
  id,
  lifecycle: "running",
  desiredLifecycle: "running",
  runtime: { kind: "native" },
  endpoints: {},
  versions: {},
  capabilities: [],
  artifacts: [],
};

const flags = (overrides: Partial<Parameters<typeof stackLogs>[0]> = {}) => ({
  stack: Option.none<string>(),
  stackId: Option.none<string>(),
  service: Option.none<"database" | "functions">(),
  tail: 100,
  follow: false,
  ...overrides,
});

const parseErrorMessages = (error: CliError.CliError): ReadonlyArray<string> =>
  Schema.is(CliError.ShowHelp)(error) ? error.errors.map(({ message }) => message) : [];

function setup(opts: {
  root: string;
  logs?: (query: unknown) => Effect.Effect<StackLogBatch, never>;
  followLogs?: (query: unknown) => Stream.Stream<StackLogEntry>;
  openFailure?: OpenStackError;
  findFailure?: StackDiscoveryError;
  noDefault?: boolean;
}) {
  const out = mockOutput();
  const calls: {
    readonly queries: unknown[];
    opened: string[];
    stopCalls: number;
    destroyCalls: number;
  } = { queries: [], opened: [], stopCalls: 0, destroyCalls: 0 };
  const stack = {
    id,
    status: Effect.succeed(status),
    credentials: Effect.die("unused"),
    prepare: () => Effect.die("unused"),
    start: () => Effect.die("must not start"),
    stop: Effect.sync(() => void calls.stopCalls++),
    destroy: Effect.sync(() => void calls.destroyCalls++),
    logs: (query?: unknown) => {
      calls.queries.push(query);
      return (
        opts.logs?.(query) ?? Effect.succeed({ entries, cursor: { opaque: "2" }, running: false })
      );
    },
    followLogs: (query?: unknown) => {
      calls.queries.push(query);
      return opts.followLogs?.(query) ?? Stream.fromIterable(entries);
    },
  } satisfies EffectStack;
  const descriptor = {
    id,
    projectRoot: opts.root,
    name: "feature-a",
    branchContext: "ordinary-workspace",
    runtime: { kind: "native" as const },
    desiredLifecycle: "running" as const,
  };
  const layer = Layer.mergeAll(
    out.layer,
    mockCommandSettings({ workdir: opts.root }),
    mockTelemetryStateLayer,
    Layer.succeed(StackApi, {
      createStack: () => Effect.die("must not create"),
      findStack: (query) =>
        opts.findFailure === undefined
          ? Effect.succeed(
              query.name === "missing" || (query.name === undefined && opts.noDefault)
                ? Option.none()
                : Option.some(descriptor),
            )
          : Effect.fail(opts.findFailure),
      discoverStacks: () => Effect.succeed({ stacks: [], errors: [] }),
      openStack: (stackId) =>
        opts.openFailure === undefined
          ? Effect.sync(() => {
              calls.opened.push(stackId);
              return stack;
            })
          : Effect.fail(opts.openFailure),
      inspectStack: () => Effect.die("must not inspect"),
    }),
    BunServices.layer,
  );
  return { layer, out, calls };
}

describe("experimental stack logs", () => {
  it.live("parses --service as a value-consuming flag", () => {
    let parsed: { service: Option.Option<string>; tail: number } | undefined;
    const command = stackLogsCommand.pipe(
      Command.withHandler((flags) =>
        Effect.sync(() => {
          parsed = { service: flags.service, tail: flags.tail };
        }),
      ),
    );
    return Effect.gen(function* () {
      yield* Command.runWith(command, { version: "0.0.0-test" })([
        "--service",
        "database",
        "--tail",
        "4",
      ]);
      expect(parsed?.service).toEqual(Option.some("database"));
      expect(parsed?.tail).toBe(4);
    }).pipe(
      Effect.provide(Layer.mergeAll(BunServices.layer, CliOutput.layer(textCliOutputFormatter()))),
    );
  });

  it.live("accepts zero tail with the follow alias and rejects out-of-range tails", () => {
    let parsed: { tail: number; follow: boolean } | undefined;
    const command = stackLogsCommand.pipe(
      Command.withHandler((flags) =>
        Effect.sync(() => {
          parsed = { tail: flags.tail, follow: flags.follow };
        }),
      ),
    );
    const outputLayer = Layer.mergeAll(
      BunServices.layer,
      CliOutput.layer(textCliOutputFormatter()),
    );
    return Effect.gen(function* () {
      yield* Command.runWith(command, { version: "0.0.0-test" })(["--tail", "0", "-f"]);
      expect(parsed).toEqual({ tail: 0, follow: true });
      const belowMinimum = yield* Command.runWith(command, { version: "0.0.0-test" })([
        "--tail=-1",
      ]).pipe(Effect.flip);
      const aboveMaximum = yield* Command.runWith(command, { version: "0.0.0-test" })([
        "--tail=10001",
      ]).pipe(Effect.flip);
      expect(belowMinimum).toBeInstanceOf(CliError.ShowHelp);
      expect(aboveMaximum).toBeInstanceOf(CliError.ShowHelp);
      expect(parseErrorMessages(belowMinimum)).toContain(
        'Invalid value for flag --tail: "-1". Expected --tail between 0 and 10000, got -1',
      );
      expect(parseErrorMessages(aboveMaximum)).toContain(
        'Invalid value for flag --tail: "10001". Expected --tail between 0 and 10000, got 10001',
      );
    }).pipe(Effect.provide(outputLayer));
  });

  it.live("reads a finite tail and passes the service filter without starting or stopping", () => {
    const root = mkdtempSync(join(tmpdir(), "supabase-stack-logs-"));
    const setupResult = setup({ root });
    return Effect.gen(function* () {
      yield* stackLogs(flags({ service: Option.some("database"), tail: 2 }));
      expect(setupResult.calls.queries).toEqual([{ capabilities: ["database"], tail: 2 }]);
      expect(setupResult.calls.opened).toEqual([id]);
      expect(setupResult.out.stdoutText).toContain("database ready");
      expect(setupResult.out.stdoutText).toContain("function failed");
    }).pipe(
      Effect.provide(setupResult.layer),
      Effect.ensuring(Effect.sync(() => rmSync(root, { recursive: true, force: true }))),
    );
  });

  it.live("rejects conflicting targets before resolving a stack", () => {
    const root = mkdtempSync(join(tmpdir(), "supabase-stack-logs-conflict-"));
    const setupResult = setup({ root });
    return Effect.gen(function* () {
      const failure = yield* stackLogs(
        flags({ stack: Option.some("feature-a"), stackId: Option.some(id) }),
      ).pipe(Effect.flip);
      expect(failure.reason).toBe("flags");
      expect(setupResult.calls.queries).toEqual([]);
      expect(setupResult.calls.opened).toEqual([]);
    }).pipe(
      Effect.provide(setupResult.layer),
      Effect.ensuring(Effect.sync(() => rmSync(root, { recursive: true, force: true }))),
    );
  });

  it.live("distinguishes an absent default stack from a missing named stack", () => {
    const defaultRoot = mkdtempSync(join(tmpdir(), "supabase-stack-logs-default-missing-"));
    const namedRoot = mkdtempSync(join(tmpdir(), "supabase-stack-logs-named-missing-"));
    const absent = setup({ root: defaultRoot, noDefault: true });
    const named = setup({ root: namedRoot });
    return Effect.gen(function* () {
      yield* stackLogs(flags()).pipe(Effect.provide(absent.layer));
      expect(absent.out.messages).toContainEqual(
        expect.objectContaining({
          type: "success",
          message: "No managed stack found for this context.",
        }),
      );
      const failure = yield* stackLogs(flags({ stack: Option.some("missing") })).pipe(
        Effect.flip,
        Effect.provide(named.layer),
      );
      expect(failure.reason).toBe("flags");
      expect(failure.message).toContain("No managed stack named");
    }).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          rmSync(defaultRoot, { recursive: true, force: true });
          rmSync(namedRoot, { recursive: true, force: true });
        }),
      ),
    );
  });

  it.live(
    "streams finite follow output and supports interruption without owner lifecycle calls",
    () => {
      const root = mkdtempSync(join(tmpdir(), "supabase-stack-logs-follow-"));
      const setupResult = setup({
        root,
        logs: () =>
          Effect.succeed({ entries: [entries[0]!], cursor: { opaque: "1" }, running: true }),
        followLogs: (query) => {
          expect(query).toEqual({ cursor: { opaque: "1" } });
          return Stream.fromIterable([entries[1]!]);
        },
      });
      return Effect.gen(function* () {
        yield* stackLogs(flags({ follow: true }));
        expect(setupResult.out.stdoutText).toContain("function failed");
        const followStarted = yield* Deferred.make<void>();
        let finalized = false;
        const interrupted = setup({
          root,
          logs: () =>
            Effect.succeed({ entries: [entries[0]!], cursor: { opaque: "1" }, running: true }),
          followLogs: (): Stream.Stream<StackLogEntry> =>
            Stream.fromEffect(
              Effect.as(Deferred.succeed(followStarted, undefined), undefined),
            ).pipe(
              Stream.flatMap(() => Stream.empty),
              Stream.concat(Stream.never),
              Stream.ensuring(Effect.sync(() => void (finalized = true))),
            ),
        });
        const fiber = yield* Effect.forkChild(
          stackLogs(flags({ follow: true })).pipe(Effect.provide(interrupted.layer)),
        );
        yield* Deferred.await(followStarted);
        expect(interrupted.calls.opened).toEqual([id]);
        yield* Fiber.interrupt(fiber);
        expect(finalized).toBe(true);
        expect(interrupted.calls.stopCalls).toBe(0);
        expect(interrupted.calls.destroyCalls).toBe(0);
      }).pipe(
        Effect.provide(setupResult.layer),
        Effect.ensuring(Effect.sync(() => rmSync(root, { recursive: true, force: true }))),
      );
    },
  );

  it.live("emits a bounded JSON result", () => {
    const root = mkdtempSync(join(tmpdir(), "supabase-stack-logs-json-result-"));
    const setupResult = setup({ root });
    const output = mockOutput({ format: "json" });
    return Effect.gen(function* () {
      yield* stackLogs(flags({ tail: 2 }));
      expect(output.messages.find((message) => message.type === "success")?.data).toEqual({
        found: true,
        id,
        entries,
        cursor: { opaque: "2" },
        running: false,
      });
    }).pipe(
      Effect.provide(Layer.mergeAll(setupResult.layer, output.layer)),
      Effect.ensuring(Effect.sync(() => rmSync(root, { recursive: true, force: true }))),
    );
  });

  it.live("emits bounded stream-json log-entry events", () => {
    const root = mkdtempSync(join(tmpdir(), "supabase-stack-logs-stream-"));
    const setupResult = setup({
      root,
      logs: () =>
        Effect.succeed({
          entries: [internalEntry],
          cursor: { opaque: "internal-1" },
          running: false,
        }),
    });
    const output = mockOutput({ format: "stream-json" });
    return Effect.gen(function* () {
      yield* stackLogs(flags({ tail: 2 }));
      expect(output.events).toEqual([
        expect.objectContaining({
          type: "log-entry",
          line: internalEntry.message,
          stream: "internal",
          source: "history",
        }),
      ]);
    }).pipe(
      Effect.provide(Layer.mergeAll(setupResult.layer, output.layer)),
      Effect.ensuring(Effect.sync(() => rmSync(root, { recursive: true, force: true }))),
    );
  });

  it.live("emits history and live events while following stream-json", () => {
    const root = mkdtempSync(join(tmpdir(), "supabase-stack-logs-stream-follow-"));
    const setupResult = setup({
      root,
      logs: () =>
        Effect.succeed({ entries: [entries[0]!], cursor: { opaque: "1" }, running: true }),
      followLogs: () => Stream.fromIterable([entries[1]!]),
    });
    const output = mockOutput({ format: "stream-json" });
    return Effect.gen(function* () {
      yield* stackLogs(flags({ follow: true })).pipe(
        Effect.provide(Layer.mergeAll(setupResult.layer, output.layer)),
      );
      expect(output.events).toEqual([
        expect.objectContaining({
          type: "log-entry",
          source: "history",
          line: entries[0]!.message,
        }),
        expect.objectContaining({ type: "log-entry", source: "live", line: entries[1]!.message }),
      ]);
    }).pipe(Effect.ensuring(Effect.sync(() => rmSync(root, { recursive: true, force: true }))));
  });

  it.live("finishes follow after printing retained history when the stack is stopped", () => {
    const root = mkdtempSync(join(tmpdir(), "supabase-stack-logs-stopped-"));
    const setupResult = setup({
      root,
      logs: () =>
        Effect.succeed({ entries: [entries[0]!], cursor: { opaque: "1" }, running: false }),
      followLogs: () => Stream.die("follow must not be opened for a stopped stack"),
    });
    return Effect.gen(function* () {
      yield* stackLogs(flags({ follow: true }));
      expect(setupResult.out.stdoutText).toContain("database ready");
      expect(setupResult.calls.queries).toEqual([{ tail: 100 }]);
    }).pipe(
      Effect.provide(setupResult.layer),
      Effect.ensuring(Effect.sync(() => rmSync(root, { recursive: true, force: true }))),
    );
  });

  it.live("rejects legacy output before selecting a stack", () => {
    const root = mkdtempSync(join(tmpdir(), "supabase-stack-logs-output-"));
    const setupResult = setup({ root });
    return Effect.gen(function* () {
      const failure = yield* stackLogs(flags()).pipe(Effect.flip);
      expect(failure[ErrorActionabilityId]).toEqual(actionability.provideFlags);
      expect(setupResult.calls.opened).toEqual([]);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(setupResult.layer, Layer.succeed(OutputFlag, Option.some("json"))),
      ),
      Effect.ensuring(Effect.sync(() => rmSync(root, { recursive: true, force: true }))),
    );
  });

  it.live("rejects JSON follow mode before selecting a stack", () => {
    const root = mkdtempSync(join(tmpdir(), "supabase-stack-logs-json-"));
    const setupResult = setup({ root });
    const out = mockOutput({ format: "json" });
    const layer = Layer.mergeAll(setupResult.layer, out.layer);
    return Effect.gen(function* () {
      const failure = yield* stackLogs(flags({ follow: true })).pipe(Effect.flip);
      expect(failure).toBeInstanceOf(StackCommandLogsError);
      expect(failure[ErrorActionabilityId]).toEqual(actionability.provideFlags);
      expect(failure.suggestion).toContain("stream-json");
      expect(setupResult.calls.opened).toEqual([]);
    }).pipe(
      Effect.provide(layer),
      Effect.ensuring(Effect.sync(() => rmSync(root, { recursive: true, force: true }))),
    );
  });

  it.live("rejects invalid targets without package calls", () =>
    Effect.gen(function* () {
      const result = setup({ root: "/tmp/unused" });
      const failure = yield* stackLogs(flags({ stackId: Option.some("invalid") })).pipe(
        Effect.flip,
        Effect.provide(result.layer),
      );
      expect(failure[ErrorActionabilityId]).toEqual(actionability.provideFlags);
      expect(result.calls.queries).toEqual([]);
      expect(result.calls.opened).toEqual([]);
    }),
  );

  it.live("classifies an invalid project root as invalid config", () => {
    const root = mkdtempSync(join(tmpdir(), "supabase-stack-logs-invalid-root-"));
    const setupResult = setup({
      root,
      findFailure: new InvalidProjectRootError({ message: "Project root is invalid" }),
    });
    return Effect.gen(function* () {
      const failure = yield* stackLogs(flags()).pipe(Effect.flip);
      expect(failure.reason).toBe("invalid-config");
      expect(failure[ErrorActionabilityId]).toEqual(actionability.invalidConfig);
      expect(setupResult.calls.opened).toEqual([]);
    }).pipe(
      Effect.provide(setupResult.layer),
      Effect.ensuring(Effect.sync(() => rmSync(root, { recursive: true, force: true }))),
    );
  });

  it.live("gives retry guidance for busy owners and upgrade guidance for old owners", () => {
    const busyRoot = mkdtempSync(join(tmpdir(), "supabase-stack-logs-busy-"));
    const upgradeRoot = mkdtempSync(join(tmpdir(), "supabase-stack-logs-upgrade-"));
    const busy = setup({
      root: busyRoot,
      openFailure: new StackOwnershipConflictError({ message: "Stack owner is busy" }),
    });
    const upgrade = setup({
      root: upgradeRoot,
      openFailure: new StackUpgradeRequiredError({
        expectedRelease: "next",
        actualRelease: "current",
        message: "Stack upgrade required",
      }),
    });
    return Effect.gen(function* () {
      const busyFailure = yield* stackLogs(flags()).pipe(Effect.flip, Effect.provide(busy.layer));
      const upgradeFailure = yield* stackLogs(flags({ stack: Option.some("feature-a") })).pipe(
        Effect.flip,
        Effect.provide(upgrade.layer),
      );
      expect(busyFailure.suggestion).toContain("no longer running");
      expect(busyFailure.suggestion).toContain("reconcile");
      expect(upgradeFailure.suggestion).toContain("Stop and restart the selected stack");
      expect(upgradeFailure.suggestion).toContain("matches this release");
    }).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          rmSync(busyRoot, { recursive: true, force: true });
          rmSync(upgradeRoot, { recursive: true, force: true });
        }),
      ),
    );
  });
});
