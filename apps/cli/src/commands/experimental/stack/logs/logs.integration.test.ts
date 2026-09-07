import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Fiber, Layer, Option, Stream } from "effect";
import { CliOutput, Command } from "effect/unstable/cli";
import { StackIdSchema } from "@supabase/stack/effect";
import type {
  EffectStack,
  StackLogBatch,
  StackLogEntry,
  StackStatus,
} from "@supabase/stack/effect";
import { mockLegacyCliSettings } from "../../../../../tests/helpers/legacy-mocks.ts";
import { mockOutput } from "../../../../../tests/helpers/mocks.ts";
import { LegacyOutputFlag } from "../../../../shared/legacy/global-flags.ts";
import {
  ErrorActionabilityId,
  actionability,
} from "../../../../shared/telemetry/error-actionability.ts";
import { LegacyExperimentalStackApi } from "../stack.shared.ts";
import { legacyExperimentalStackLogs } from "./logs.handler.ts";
import { LegacyExperimentalStackLogsError } from "./logs.errors.ts";
import { legacyExperimentalStackLogsCommand } from "./logs.command.ts";
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

const flags = (overrides: Partial<Parameters<typeof legacyExperimentalStackLogs>[0]> = {}) => ({
  stack: Option.none<string>(),
  stackId: Option.none<string>(),
  service: Option.none<"database" | "functions">(),
  tail: 100,
  follow: false,
  ...overrides,
});

function setup(opts: {
  root: string;
  logs?: (query: unknown) => Effect.Effect<StackLogBatch, never>;
  followLogs?: (query: unknown) => Stream.Stream<StackLogEntry>;
}) {
  const out = mockOutput();
  const calls: { readonly queries: unknown[]; opened: string[] } = { queries: [], opened: [] };
  const stack = {
    id,
    status: () => Effect.succeed(status),
    credentials: () => Effect.die("unused"),
    prepare: () => Effect.die("unused"),
    start: () => Effect.die("must not start"),
    stop: () => Effect.die("must not stop"),
    destroy: () => Effect.die("must not destroy"),
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
    mockLegacyCliSettings({ workdir: opts.root }),
    Layer.succeed(LegacyExperimentalStackApi, {
      createStack: () => Effect.die("must not create"),
      findStack: (query) =>
        Effect.succeed(query.name === "missing" ? Option.none() : Option.some(descriptor)),
      openStack: (stackId) =>
        Effect.sync(() => {
          calls.opened.push(stackId);
          return stack;
        }),
      inspectStack: () => Effect.die("must not inspect"),
    }),
    BunServices.layer,
  );
  return { layer, out, calls };
}

describe("experimental stack logs", () => {
  it.live("parses --service as a value-consuming flag", () => {
    let parsed: { service: Option.Option<string>; tail: number } | undefined;
    const command = legacyExperimentalStackLogsCommand.pipe(
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

  it.effect(
    "reads a finite tail and passes the service filter without starting or stopping",
    () => {
      const root = mkdtempSync(join(tmpdir(), "supabase-stack-logs-"));
      const setupResult = setup({ root });
      return Effect.gen(function* () {
        yield* legacyExperimentalStackLogs(flags({ service: Option.some("database"), tail: 2 }));
        expect(setupResult.calls.queries).toEqual([{ capabilities: ["database"], tail: 2 }]);
        expect(setupResult.calls.opened).toEqual([id]);
        expect(setupResult.out.stdoutText).toContain("database ready");
        expect(setupResult.out.stdoutText).toContain("function failed");
      }).pipe(
        Effect.provide(setupResult.layer),
        Effect.ensuring(Effect.sync(() => rmSync(root, { recursive: true, force: true }))),
      );
    },
  );

  it.effect(
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
        yield* legacyExperimentalStackLogs(flags({ follow: true }));
        expect(setupResult.out.stdoutText).toContain("function failed");
        const interrupted = setup({ root, followLogs: () => Stream.never });
        const fiber = yield* Effect.forkChild(
          legacyExperimentalStackLogs(flags({ follow: true })).pipe(
            Effect.provide(interrupted.layer),
          ),
        );
        yield* Fiber.interrupt(fiber);
        expect(interrupted.calls.opened).toEqual([]);
      }).pipe(
        Effect.provide(setupResult.layer),
        Effect.ensuring(Effect.sync(() => rmSync(root, { recursive: true, force: true }))),
      );
    },
  );

  it.effect("emits a bounded JSON result", () => {
    const root = mkdtempSync(join(tmpdir(), "supabase-stack-logs-json-result-"));
    const setupResult = setup({ root });
    const output = mockOutput({ format: "json" });
    return Effect.gen(function* () {
      yield* legacyExperimentalStackLogs(flags({ tail: 2 }));
      expect(output.messages.find((message) => message.type === "success")?.data).toEqual({
        entries,
        cursor: { opaque: "2" },
        running: false,
      });
    }).pipe(
      Effect.provide(Layer.mergeAll(setupResult.layer, output.layer)),
      Effect.ensuring(Effect.sync(() => rmSync(root, { recursive: true, force: true }))),
    );
  });

  it.effect("emits bounded stream-json log-entry events", () => {
    const root = mkdtempSync(join(tmpdir(), "supabase-stack-logs-stream-"));
    const setupResult = setup({ root });
    const output = mockOutput({ format: "stream-json" });
    return Effect.gen(function* () {
      yield* legacyExperimentalStackLogs(flags({ tail: 2 }));
      expect(output.events).toEqual(
        entries.map((entry) =>
          expect.objectContaining({
            type: "log-entry",
            line: entry.message,
            source: "history",
          }),
        ),
      );
    }).pipe(
      Effect.provide(Layer.mergeAll(setupResult.layer, output.layer)),
      Effect.ensuring(Effect.sync(() => rmSync(root, { recursive: true, force: true }))),
    );
  });

  it.effect("rejects legacy output before selecting a stack", () => {
    const root = mkdtempSync(join(tmpdir(), "supabase-stack-logs-output-"));
    const setupResult = setup({ root });
    return Effect.gen(function* () {
      const failure = yield* legacyExperimentalStackLogs(flags()).pipe(Effect.flip);
      expect(failure[ErrorActionabilityId]).toEqual(actionability.provideFlags);
      expect(setupResult.calls.opened).toEqual([]);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(setupResult.layer, Layer.succeed(LegacyOutputFlag, Option.some("json"))),
      ),
      Effect.ensuring(Effect.sync(() => rmSync(root, { recursive: true, force: true }))),
    );
  });

  it.effect("rejects JSON follow mode before selecting a stack", () => {
    const root = mkdtempSync(join(tmpdir(), "supabase-stack-logs-json-"));
    const setupResult = setup({ root });
    const out = mockOutput({ format: "json" });
    const layer = Layer.mergeAll(setupResult.layer, out.layer);
    return Effect.gen(function* () {
      const failure = yield* legacyExperimentalStackLogs(flags({ follow: true })).pipe(Effect.flip);
      expect(failure).toBeInstanceOf(LegacyExperimentalStackLogsError);
      expect(failure[ErrorActionabilityId]).toEqual(actionability.provideFlags);
      expect(failure.suggestion).toContain("stream-json");
      expect(setupResult.calls.opened).toEqual([]);
    }).pipe(
      Effect.provide(layer),
      Effect.ensuring(Effect.sync(() => rmSync(root, { recursive: true, force: true }))),
    );
  });

  it.effect("rejects invalid targets without package calls", () =>
    Effect.gen(function* () {
      const result = setup({ root: "/tmp/unused" });
      const failure = yield* legacyExperimentalStackLogs(
        flags({ stackId: Option.some("invalid") }),
      ).pipe(Effect.flip, Effect.provide(result.layer));
      expect(failure[ErrorActionabilityId]).toEqual(actionability.provideFlags);
      expect(result.calls.queries).toEqual([]);
      expect(result.calls.opened).toEqual([]);
    }),
  );
});
