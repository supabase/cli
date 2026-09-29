import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { ConfigProvider, Effect, Exit, FileSystem, Layer, Logger, Option, Path } from "effect";
import {
  VALID_REF,
  VALID_TOKEN,
  buildTestRuntime,
  mockCommandPlatformApi,
  mockCommandSettings,
  useTempWorkdir,
} from "../../../tests/helpers/command-mocks.ts";
import { mockOutput, mockRuntimeInfo } from "../../../tests/helpers/mocks.ts";
import { DbExecError } from "../../command-internal/db-connection.errors.ts";
import { projectsList } from "../../commands/projects/list/list.handler.ts";
import {
  TraceExportConfigError,
  withTraceExport,
  type TraceSettings,
} from "./trace-export.layer.ts";

interface ExportedAttribute {
  readonly key: string;
  readonly value: unknown;
}

interface ExportedSpan {
  readonly traceId: string;
  readonly spanId: string;
  readonly parentSpanId?: string;
  readonly name: string;
  readonly attributes: ReadonlyArray<ExportedAttribute>;
  readonly events: ReadonlyArray<{
    readonly name: string;
    readonly attributes: ReadonlyArray<ExportedAttribute>;
  }>;
  readonly status: { readonly code: number; readonly message?: string };
}

const tempRoot = useTempWorkdir("supabase-trace-export-int-");

const fileSink = (path: string): TraceSettings => ({
  sink: Option.some({ _tag: "File", path }),
});

const readBatches = Effect.fnUntraced(function* (tracePath: string) {
  const fs = yield* FileSystem.FileSystem;
  const text = yield* fs.readFileString(tracePath);
  return text
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line): { resourceSpans: Array<{ scopeSpans: Array<{ spans: Array<ExportedSpan> }> }> } =>
      JSON.parse(line),
    );
});

const spansOf = (
  batches: ReadonlyArray<{
    resourceSpans: Array<{ scopeSpans: Array<{ spans: Array<ExportedSpan> }> }>;
  }>,
) =>
  batches.flatMap((batch) =>
    batch.resourceSpans.flatMap((resource) => resource.scopeSpans.flatMap((scope) => scope.spans)),
  );

const traceFilePath = Effect.map(Path.Path, (path) => path.join(tempRoot.current, "trace.jsonl"));

const runtime = Layer.mergeAll(mockRuntimeInfo(), BunServices.layer);

describe("withTraceExport with a trace file", () => {
  it.live("creates the file with owner-only permissions and writes one line per batch", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const tracePath = yield* traceFilePath;

      yield* Effect.void.pipe(
        Effect.withSpan("Test.child"),
        withTraceExport(fileSink(tracePath), { "process.boot_ms": 12 }),
      );

      const info = yield* fs.stat(tracePath);
      expect(info.mode & 0o777).toBe(0o600);
      const batches = yield* readBatches(tracePath);
      expect(batches).toHaveLength(1);
      expect(
        spansOf(batches)
          .map((span) => span.name)
          .sort(),
      ).toEqual(["Test.child", "cli.run"]);
    }).pipe(Effect.provide(runtime)),
  );

  it.live("appends to an existing file instead of replacing it", () =>
    Effect.gen(function* () {
      const tracePath = yield* traceFilePath;
      const run = Effect.void.pipe(withTraceExport(fileSink(tracePath), {}));

      yield* run;
      yield* run;

      const batches = yield* readBatches(tracePath);
      expect(batches).toHaveLength(2);
      expect(spansOf(batches).filter((span) => span.name === "cli.run")).toHaveLength(2);
    }).pipe(Effect.provide(runtime)),
  );

  it.live("restricts an existing file to owner-only permissions", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const tracePath = yield* traceFilePath;
      yield* fs.writeFileString(tracePath, "", { mode: 0o644 });
      yield* fs.chmod(tracePath, 0o644);

      yield* Effect.void.pipe(withTraceExport(fileSink(tracePath), {}));

      expect((yield* fs.stat(tracePath)).mode & 0o777).toBe(0o600);
    }).pipe(Effect.provide(runtime)),
  );

  it.live("adopts TRACEPARENT as the parent of cli.run", () =>
    Effect.gen(function* () {
      const tracePath = yield* traceFilePath;
      const traceId = "4bf92f3577b34da6a3ce929d0e0e4736";
      const parentId = "00f067aa0ba902b7";

      yield* Effect.void.pipe(
        withTraceExport(fileSink(tracePath), {}),
        Effect.provide(
          ConfigProvider.layer(
            ConfigProvider.fromUnknown({ TRACEPARENT: `00-${traceId}-${parentId}-01` }),
          ),
        ),
      );

      const [root] = spansOf(yield* readBatches(tracePath));
      expect(root).toMatchObject({ name: "cli.run", traceId, parentSpanId: parentId });
    }).pipe(Effect.provide(runtime)),
  );

  it.live("records the run under an unsampled TRACEPARENT", () =>
    Effect.gen(function* () {
      const tracePath = yield* traceFilePath;
      const traceId = "4bf92f3577b34da6a3ce929d0e0e4736";
      const parentId = "00f067aa0ba902b7";

      yield* Effect.void.pipe(
        Effect.withSpan("Test.child"),
        withTraceExport(fileSink(tracePath), {}),
        Effect.provide(
          ConfigProvider.layer(
            ConfigProvider.fromUnknown({ TRACEPARENT: `00-${traceId}-${parentId}-00` }),
          ),
        ),
      );

      const spans = spansOf(yield* readBatches(tracePath));
      expect(spans.map((span) => span.name).sort()).toEqual(["Test.child", "cli.run"]);
      expect(spans.find((span) => span.name === "cli.run")).toMatchObject({
        traceId,
        parentSpanId: parentId,
      });
    }).pipe(Effect.provide(runtime)),
  );

  it.live("flushes the interrupted run before returning", () =>
    Effect.gen(function* () {
      const tracePath = yield* traceFilePath;

      const exit = yield* Effect.interrupt.pipe(
        Effect.withSpan("Test.interrupted"),
        withTraceExport(fileSink(tracePath), {}),
        Effect.exit,
      );

      expect(Exit.hasInterrupts(exit)).toBe(true);
      const names = spansOf(yield* readBatches(tracePath)).map((span) => span.name);
      expect(names).toContain("cli.run");
      expect(names).toContain("Test.interrupted");
    }).pipe(Effect.provide(runtime)),
  );

  it.live("fails with a config error when the file cannot be created", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const tracePath = path.join(tempRoot.current, "missing", "trace.jsonl");

      const error = yield* Effect.void.pipe(withTraceExport(fileSink(tracePath), {}), Effect.flip);

      expect(error).toBeInstanceOf(TraceExportConfigError);
    }).pipe(Effect.provide(runtime)),
  );
});

describe("withTraceExport for a failed migration", () => {
  it.live("exports the error type, SQLSTATE, and log levels but no error or log text", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const tracePath = yield* traceFilePath;
      const failure = new DbExecError({
        message: 'ERROR: null value in column "role" violates not-null constraint (SQLSTATE 23502)',
        code: "23502",
        detail: "Failing row contains (1, alice@example.com, s3cret).",
      });

      yield* Effect.logWarning(
        "applying CREATE FUNCTION seed() RETURNS text AS $$ SELECT $pw$dollar-quoted-secret$pw$ $$",
      ).pipe(
        Effect.andThen(Effect.logError("syntax error at or near E'it\\'s-e-literal-secret'")),
        Effect.andThen(Effect.logInfo("Object not found: bucket/private/key.pdf")),
        Effect.andThen(Effect.fail(failure)),
        Effect.withSpan("Migration.apply"),
        withTraceExport(fileSink(tracePath), {}),
        Effect.provide(Logger.layer([Logger.tracerLogger])),
        Effect.exit,
      );

      const raw = yield* fs.readFileString(tracePath);
      const span = spansOf(yield* readBatches(tracePath)).find(
        (candidate) => candidate.name === "Migration.apply",
      );
      const logEvent = (level: string) => ({
        name: "log",
        attributes: [{ key: "effect.logLevel", value: { stringValue: level } }],
      });
      expect(span?.status).toEqual({ code: 2 });
      expect(span?.attributes).toContainEqual({
        key: "db.response.status_code",
        value: { stringValue: "23502" },
      });
      expect(span?.events.map(({ name, attributes }) => ({ name, attributes }))).toEqual([
        logEvent("WARN"),
        logEvent("ERROR"),
        logEvent("INFO"),
        {
          name: "exception",
          attributes: [{ key: "exception.type", value: { stringValue: "DbExecError" } }],
        },
      ]);
      for (const text of [
        "alice@example.com",
        "s3cret",
        "not-null constraint",
        "dollar-quoted-secret",
        "e-literal-secret",
        "bucket/private/key.pdf",
      ]) {
        expect(raw).not.toContain(text);
      }
    }).pipe(Effect.provide(runtime)),
  );
});

describe("withTraceExport around a command handler", () => {
  it.live("records one sanitized, connected trace for projects list within the span budget", () =>
    Effect.gen(function* () {
      const tracePath = yield* traceFilePath;
      const out = mockOutput({ format: "text" });
      const api = mockCommandPlatformApi({ response: { status: 200, body: [] } });
      const layer = buildTestRuntime({
        out,
        api,
        cliSettings: mockCommandSettings({
          workdir: tempRoot.current,
          projectId: Option.some(VALID_REF),
        }),
      });

      yield* projectsList({}).pipe(
        Effect.provide(layer),
        withTraceExport(fileSink(tracePath), { "process.boot_ms": 5 }),
      );

      const fs = yield* FileSystem.FileSystem;
      const raw = yield* fs.readFileString(tracePath);
      const spans = spansOf(yield* readBatches(tracePath));
      const roots = spans.filter((span) => span.parentSpanId === undefined);
      const ids = new Set(spans.map((span) => span.spanId));
      const counts = new Map<string, number>();
      for (const span of spans) counts.set(span.name, (counts.get(span.name) ?? 0) + 1);

      expect(roots.map((span) => span.name)).toEqual(["cli.run"]);
      expect(spans.filter((span) => !ids.has(span.parentSpanId ?? span.spanId))).toEqual([]);
      expect(spans.some((span) => span.name.startsWith("http.client"))).toBe(true);
      expect(spans.length).toBeLessThanOrEqual(2000);
      expect(Math.max(...counts.values())).toBeLessThanOrEqual(200);
      expect(raw).not.toContain(VALID_TOKEN);
      expect(raw).not.toMatch(/bearer\s/iu);
      expect(api.requests.map((request) => request.headers["traceparent"])).toEqual([undefined]);
    }).pipe(Effect.provide(runtime)),
  );
});
