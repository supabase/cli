import { LogsClipboard } from "./logs.clipboard.ts";
import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import {
  Cause,
  ConfigProvider,
  Effect,
  Layer,
  Option,
  Stream,
  Schema,
  Queue,
  Terminal,
} from "effect";
import { DebugFlag, ProfileFlag, WorkdirFlag } from "../../command-internal/global-flags.ts";
import { mockContextualAnalytics, mockTelemetryRuntime } from "../../../tests/helpers/mocks.ts";
import { TestClock } from "effect/testing";
import { CommandPlatformApi } from "../../auth/command-platform-api.service.ts";
import { CommandPlatformApiFactory } from "../../auth/command-platform-api-factory.service.ts";
import { TargetPolicy } from "../../command-internal/target/target-policy.ts";
import { Tty } from "../../shared/runtime/tty.service.ts";
import { Stdin } from "../../shared/runtime/stdin.service.ts";
import {
  makeComputeProject,
  setupCompute,
  COMPUTE_PROJECT_REF,
} from "../../../tests/helpers/compute.ts";
import { StackApi, StackTargetResolver } from "../../command-internal/stack-target.ts";
import { logs, logsSources } from "./logs.handler.ts";
import type { LogsFlags } from "./logs.session.ts";
import {
  classifyCliErrorActionability,
  ErrorActionabilityId,
} from "../../shared/telemetry/error-actionability.ts";
import { LogsApiError, LogsInputError } from "./logs.errors.ts";

const decodeRows = Schema.decodeSync(Schema.fromJsonString(Schema.Array(Schema.JsonObject)));

const route = `GET /v1/projects/${COMPUTE_PROJECT_REF}/analytics/endpoints/logs`;
const now = Date.parse("2026-11-02T12:00:00Z");
const baseFlags = (overrides: Partial<LogsFlags> = {}): LogsFlags => ({
  remote: Option.some({ _tag: "Linked" }),
  projectRef: Option.none(),
  local: false,
  linked: false,
  stack: Option.none(),
  stackId: Option.none(),
  service: [],
  resource: Option.none(),
  kind: Option.none(),
  level: [],
  search: Option.none(),
  since: Option.none(),
  from: Option.none(),
  to: Option.none(),
  sql: Option.none(),
  file: Option.none(),
  limit: 100,
  ...overrides,
});
const queryFlags = (overrides: Partial<LogsFlags> = {}): LogsFlags =>
  baseFlags({
    sql: Option.some("select event_message, log_attributes from logs limit 2"),
    ...overrides,
  });
const tailFlags = (overrides: Partial<LogsFlags> = {}): LogsFlags =>
  baseFlags({ service: ["postgres"], ...overrides });
const runQuery = (flags: LogsFlags) => logs(flags);
const stdin = (text?: string) =>
  Layer.succeed(Stdin, {
    isTTY: text === undefined,
    readPipedText: Effect.succeed(Option.fromUndefinedOr(text)),
    readPipedBytes: Effect.succeed(Option.none()),
    pipedBytesStream:
      text === undefined ? Stream.empty : Stream.make(new TextEncoder().encode(text)),
    readLine: () => Effect.succeed(Option.none()),
  });
const row = (id: string, ts = now - 1000) => ({
  id,
  ts_ms: ts,
  source: "postgres_logs",
  severity_text: "INFO",
  level: "error",
  event_message: "db failure",
  log_attributes: { "parsed.error_severity": "ERROR", trace_id: "correlation" },
});

const prepare = Effect.fnUntraced(function* (
  options: Parameters<typeof setupCompute>[0],
  piped?: string,
) {
  const setup = setupCompute({ interactive: false, ...options });
  const api = yield* CommandPlatformApi.pipe(Effect.provide(setup.layer));
  const layer = Layer.mergeAll(
    setup.layer,
    ConfigProvider.layer(ConfigProvider.fromUnknown({})),
    Layer.mock(LogsClipboard, {}),
    Layer.mock(StackApi, {}),
    Layer.mock(StackTargetResolver, {}),
    Layer.succeed(DebugFlag, false),
    Layer.succeed(ProfileFlag, "supabase"),
    Layer.succeed(WorkdirFlag, Option.none()),
    mockContextualAnalytics().layer,
    mockTelemetryRuntime(),
    Layer.succeed(CommandPlatformApiFactory, { make: Effect.succeed(api) }),
    stdin(piped),
    Layer.succeed(TargetPolicy, {
      group: "selectable",
      consent: "none",
      consentExemptReason: "Read logs",
    }),
  );
  return { ...setup, layer };
});

describe("unified logs", () => {
  it.effect.each([
    {
      from: Option.none<string>(),
      to: Option.none<string>(),
      start: "2026-11-02T11:00:00.000Z",
      end: "2026-11-02T12:00:00.000Z",
      header: "Window: Nov 02 11:00:00–12:00:00 UTC",
    },
    {
      from: Option.some("2027-01-01T08:00:00Z"),
      to: Option.some("2027-01-01T09:00:00Z"),
      start: "2027-01-01T08:00:00.000Z",
      end: "2027-01-01T09:00:00.000Z",
      header: "Window: Jan 01 08:00:00–09:00:00 UTC",
    },
  ])(
    "shows the exact query request window after time advances and undated results arrive: $header",
    (test) =>
      Effect.gen(function* () {
        yield* TestClock.setTime(now);
        const repo = yield* makeComputeProject();
        const setup = yield* prepare({
          workdir: repo.dir,
          interactive: true,
          routes: {
            [route]: {
              status: 200,
              body: { result: [{ count: 8 }, { timestamp: "2000-01-01T00:00:00Z" }], error: null },
            },
          },
        });
        const input = yield* Queue.unbounded<Terminal.UserInput>();
        const screens: string[] = [];
        let advanced = false;
        yield* runQuery(queryFlags({ from: test.from, to: test.to })).pipe(
          Effect.provideService(
            Terminal.Terminal,
            Terminal.make({
              columns: Effect.succeed(80),
              rows: Effect.succeed(12),
              size: Queue.unbounded<Terminal.Size, Cause.Done>(),
              readInput: Effect.succeed(input),
              readLine: Effect.die("unused"),
              display: (text) =>
                Effect.gen(function* () {
                  screens.push(text);
                  if (!advanced && text.includes("Window:")) {
                    advanced = true;
                    yield* TestClock.adjust("5 minutes");
                  }
                  if (text.includes(" | ready"))
                    yield* Queue.offer(input, {
                      input: Option.none(),
                      key: { name: "q", ctrl: false, meta: false, shift: false },
                    });
                }),
            }),
          ),
          Effect.provide(setup.layer),
        );
        expect(setup.http.requests[0]?.urlParams).toMatchObject({
          iso_timestamp_start: test.start,
          iso_timestamp_end: test.end,
        });
        const headers = screens
          .filter((screen) => screen.includes("Window:") && !screen.includes("resolving…"))
          .map((screen) => screen.split("\r\n")[1]);
        expect(headers.length).toBeGreaterThan(0);
        expect(headers.every((header) => header === test.header)).toBe(true);
      }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  );

  it.effect("routes terminal query rows into details and leaves piped stdin on normal output", () =>
    Effect.gen(function* () {
      const repo = yield* makeComputeProject();
      for (const stdinIsTty of [true, false]) {
        const setup = yield* prepare({
          workdir: repo.dir,
          interactive: true,
          routes: {
            [route]: {
              status: 200,
              body: {
                result: [
                  {
                    timestamp: "2026-11-02T12:00:00Z",
                    service: "postgres",
                    event_message: "first query row",
                    private_field: "first full detail",
                  },
                  {
                    timestamp: "2026-11-01T12:00:00Z",
                    service: "auth",
                    event_message: "second query row",
                  },
                ],
                error: null,
              },
            },
          },
        });
        const input = yield* Queue.unbounded<Terminal.UserInput>();
        const screens: string[] = [];
        let opened = false;
        const terminal = Terminal.make({
          columns: Effect.succeed(100),
          rows: Effect.succeed(20),
          size: Queue.unbounded<Terminal.Size, Cause.Done>(),
          readInput: stdinIsTty
            ? Effect.succeed(input)
            : Effect.die("piped stdin must not acquire terminal input"),
          readLine: Effect.die("unused"),
          display: (text) =>
            Effect.gen(function* () {
              screens.push(text);
              if (!opened && text.includes("first query row")) {
                opened = true;
                yield* Queue.offer(input, {
                  input: Option.none(),
                  key: { name: "return", ctrl: false, meta: false, shift: false },
                });
              } else if (text.includes("Log details")) {
                yield* Queue.offer(input, {
                  input: Option.none(),
                  key: { name: "q", ctrl: false, meta: false, shift: false },
                });
              }
            }),
        });
        const sql =
          "select timestamp, service, event_message, private_field from logs order by timestamp desc";
        yield* runQuery(queryFlags({ sql: Option.some(sql) })).pipe(
          Effect.provideService(Terminal.Terminal, terminal),
          Effect.provideService(Tty, { stdinIsTty, stdoutIsTty: true, stdoutIsPipe: false }),
          Effect.provide(setup.layer),
        );
        expect(setup.http.requests[0]?.urlParams.sql).toBe(sql);
        if (stdinIsTty) {
          expect(
            screens.some((screen) =>
              screen.includes("> Nov 02 - 12:00:00 UTC postgres first query row"),
            ),
          ).toBe(true);
          expect(screens.find((screen) => screen.includes("Log details"))).toContain(
            "first full detail",
          );
          expect(screens.at(-1)).toContain("?1049l");
        } else {
          expect(screens).toEqual([]);
          expect(setup.out.stdoutText).toContain("first full detail");
        }
      }
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  );

  it.effect("queries arbitrary hosted SQL from a file with exact bounds and raw attributes", () =>
    Effect.gen(function* () {
      const repo = yield* makeComputeProject({
        "query.sql": "select id, log_attributes from logs limit 2",
      });
      const setup = yield* prepare({
        workdir: repo.dir,
        format: "json",
        routes: {
          [route]: {
            status: 200,
            body: {
              result: [{ id: "a", log_attributes: { "user.id": "123", trace_id: "abc" } }],
              error: null,
            },
          },
        },
      });
      yield* runQuery(
        queryFlags({
          sql: Option.none(),
          file: Option.some("query.sql"),
          from: Option.some("2026-11-02T11:00:00Z"),
          to: Option.some("2026-11-02T12:00:00Z"),
        }),
      ).pipe(Effect.provide(setup.layer));
      expect(setup.out.stdoutText).toContain('\n    "log_attributes": {\n');
      expect(decodeRows(setup.out.stdoutText)).toEqual([
        { id: "a", log_attributes: { "user.id": "123", trace_id: "abc" } },
      ]);
      expect(setup.http.requests[0]?.urlParams).toMatchObject({
        sql: "select id, log_attributes from logs limit 2",
        iso_timestamp_start: "2026-11-02T11:00:00.000Z",
        iso_timestamp_end: "2026-11-02T12:00:00.000Z",
      });
      expect(setup.telemetry.flushed).toBe(true);
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  );

  it.effect(
    "rejects conflicting SQL inputs, oversized ranges, and invalid formats before querying",
    () =>
      Effect.gen(function* () {
        const repo = yield* makeComputeProject();
        for (const test of [
          { flags: queryFlags({ file: Option.some("query.sql") }) },
          { flags: queryFlags({ since: Option.some("25h") }) },
          { flags: queryFlags(), format: "env" as const },
        ]) {
          const setup = yield* prepare({ workdir: repo.dir, routes: {}, outputFlag: test.format });
          const error = yield* runQuery(test.flags).pipe(Effect.flip, Effect.provide(setup.layer));
          expect(Schema.is(LogsInputError)(error)).toBe(true);
          expect(setup.http.requests).toEqual([]);
        }
      }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  );

  it.effect("surfaces HTTP-200 query errors and accepts null empty results", () =>
    Effect.gen(function* () {
      const repo = yield* makeComputeProject();
      const bad = yield* prepare({
        workdir: repo.dir,
        routes: {
          [route]: { status: 200, body: { result: null, error: { message: "Unknown field" } } },
        },
      });
      const error = yield* runQuery(queryFlags()).pipe(Effect.flip, Effect.provide(bad.layer));
      expect(Schema.is(LogsApiError)(error) && error.message).toContain("Unknown field");
      const empty = yield* prepare({
        workdir: repo.dir,
        format: "json",
        routes: { [route]: { status: 200, body: { result: null, error: null } } },
      });
      yield* runQuery(queryFlags()).pipe(Effect.provide(empty.layer));
      expect(empty.out.stdoutText).toBe("[]\n");
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  );

  it.effect(
    "tails oldest first with raw IDs and attributes and escapes literal filter values",
    () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(now);
        const repo = yield* makeComputeProject();
        const setup = yield* prepare({
          workdir: repo.dir,
          format: "json",
          routes: {
            [route]: {
              status: 200,
              body: { result: [row("new"), row("old", now - 2000)], error: null },
            },
          },
        });
        yield* logs(
          tailFlags({ limit: 2, level: ["error"], search: Option.some("can't_%\\") }),
        ).pipe(Effect.provide(setup.layer));
        const lines = decodeRows(setup.out.stdoutText);
        expect(setup.out.stderrText).toContain("History reached --limit; older rows may exist.");
        expect(lines.map((line) => line.id)).toEqual(["old", "new"]);
        expect(lines[0]?.log_attributes).toMatchObject({ trace_id: "correlation" });
        const sql = setup.http.requests[0]?.urlParams.sql;
        expect(sql).toContain("source = 'postgres_logs'");
        expect(sql).toContain("positionCaseInsensitiveUTF8(event_message, 'can''t_%\\\\') > 0");
        expect(sql).toContain("parsed.error_severity");
      }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  );

  it.effect("discovers truthful hosted capabilities without querying logs", () =>
    Effect.gen(function* () {
      const repo = yield* makeComputeProject();
      const setup = yield* prepare({ workdir: repo.dir, format: "json", routes: {} });
      yield* logsSources({ ...tailFlags(), service: Option.some("storage") }).pipe(
        Effect.provide(setup.layer),
      );
      const sources = decodeRows(setup.out.stdoutText);
      expect(sources).toHaveLength(1);
      expect(sources[0]).toMatchObject({ service: "storage", severity: null });
      expect(sources[0]?.filters).not.toContain("level");
      expect(setup.http.requests).toEqual([]);
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  );
  it.effect("renders source summaries and full selected-service details in text", () =>
    Effect.gen(function* () {
      const repo = yield* makeComputeProject({
        "supabase/config.toml": "[experimental]\ncompute = true\n",
      });
      const overview = yield* prepare({ workdir: repo.dir, format: "text", routes: {} });
      yield* logsSources({ ...tailFlags(), service: Option.none() }).pipe(
        Effect.provide(overview.layer),
      );
      expect(overview.out.stdoutText).toContain("Use --service <service>");
      expect(overview.out.stdoutText).not.toContain("log_attributes");
      const detail = yield* prepare({ workdir: repo.dir, format: "text", routes: {} });
      yield* logsSources({ ...tailFlags(), service: Option.some("compute") }).pipe(
        Effect.provide(detail.layer),
      );
      expect(detail.out.stdoutText).toContain("Service:\n  compute");
      expect(detail.out.stdoutText).toContain("Kinds:\n  app, requests, builds");
      expect(detail.out.stdoutText).toContain("worker_api_logs");
      expect(detail.out.stdoutText.split("\n").every((line) => line.length <= 80)).toBe(true);
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  );

  it.effect("reads stdin only for --file - and preserves unrelated piped input", () =>
    Effect.gen(function* () {
      const repo = yield* makeComputeProject();
      const setup = yield* prepare(
        {
          workdir: repo.dir,
          format: "json",
          routes: { [route]: { status: 200, body: { result: [], error: null } } },
        },
        "select count() from logs",
      );
      yield* runQuery(queryFlags({ sql: Option.none(), file: Option.some("-") })).pipe(
        Effect.provide(setup.layer),
      );
      expect(setup.http.requests[0]?.urlParams.sql).toBe("select count() from logs");
      const failOnRead = Layer.succeed(Stdin, {
        isTTY: false,
        readPipedText: Effect.die("explicit SQL must not consume stdin"),
        readPipedBytes: Effect.succeed(Option.none()),
        pipedBytesStream: Stream.empty,
        readLine: () => Effect.succeed(Option.none()),
      });
      yield* runQuery(queryFlags()).pipe(Effect.provide(Layer.merge(setup.layer, failOnRead)));
      expect(setup.http.requests[1]?.urlParams.sql).toContain("select event_message");
      yield* logs(tailFlags()).pipe(Effect.provide(Layer.merge(setup.layer, failOnRead)));
      expect(setup.http.requests[2]?.urlParams.sql).toContain("postgres_logs");
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  );
  it.effect("does not read an open stdin pipe for ordinary logs", () =>
    Effect.gen(function* () {
      const repo = yield* makeComputeProject();
      const setup = yield* prepare({
        workdir: repo.dir,
        format: "json",
        routes: { [route]: { status: 200, body: { result: [], error: null } } },
      });
      yield* logs(tailFlags()).pipe(
        Effect.provideService(Stdin, {
          isTTY: false,
          readPipedText: Effect.die("ordinary logs consumed stdin"),
          readPipedBytes: Effect.die("ordinary logs consumed stdin"),
          pipedBytesStream: Stream.die("ordinary logs consumed stdin"),
          readLine: () => Effect.die("ordinary logs consumed stdin"),
        }),
        Effect.provide(setup.layer),
      );
      expect(setup.http.requests[0]?.urlParams.sql).toContain("postgres_logs");
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  );

  it.effect.each([
    { file: "-", piped: undefined, message: "Pipe SQL into stdin" },
    { file: "-", piped: "   ", message: "SQL input is empty" },
    { file: "missing.sql", piped: undefined, message: 'Could not read SQL file "missing.sql"' },
  ])("rejects unusable SQL input from $file: $message", ({ file, piped, message }) =>
    Effect.gen(function* () {
      const repo = yield* makeComputeProject();
      const setup = yield* prepare({ workdir: repo.dir, routes: {} }, piped);
      const error = yield* runQuery(
        queryFlags({ sql: Option.none(), file: Option.some(file) }),
      ).pipe(Effect.flip, Effect.provide(setup.layer));
      expect(error).toMatchObject({
        _tag: "LogsInputError",
        message: expect.stringContaining(message),
      });
      expect(setup.http.requests).toEqual([]);
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  );
  it.effect.each([401, 402, 403, 404, 429, 500])(
    "surfaces hosted query HTTP %s as a typed API failure",
    (status) =>
      Effect.gen(function* () {
        const repo = yield* makeComputeProject();
        const setup = yield* prepare({ workdir: repo.dir, routes: { [route]: { status } } });
        const error = yield* runQuery(queryFlags()).pipe(Effect.flip, Effect.provide(setup.layer));
        expect(error).toMatchObject({ _tag: "LogsApiError", status });
        if (Schema.is(LogsApiError)(error) && [401, 402, 403].includes(status))
          expect(error.message).toMatch(/login|usage|permission/i);
        expect(setup.http.requests).toHaveLength(1);
        expect(setup.telemetry.flushed).toBe(true);
      }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  );

  it.effect("preserves transport failure classification without an invented HTTP status", () =>
    Effect.gen(function* () {
      const repo = yield* makeComputeProject();
      const setup = yield* prepare({
        workdir: repo.dir,
        routes: { [route]: { transportError: "connection refused" } },
      });
      const error = yield* runQuery(queryFlags()).pipe(Effect.flip, Effect.provide(setup.layer));
      expect(error).toMatchObject({ _tag: "HttpClientError", reason: { _tag: "TransportError" } });
      expect(error).not.toHaveProperty("status");
      expect(classifyCliErrorActionability(error)).toMatchObject({
        error_kind: "external_service",
        error_category: "network",
      });
      expect(setup.http.requests).toHaveLength(1);
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  );

  it.effect("classifies an unreadable successful response without inventing an HTTP failure", () =>
    Effect.gen(function* () {
      const repo = yield* makeComputeProject();
      const setup = yield* prepare({
        workdir: repo.dir,
        routes: { [route]: { status: 200, body: { result: "not rows" } } },
      });
      const error = yield* runQuery(queryFlags()).pipe(Effect.flip, Effect.provide(setup.layer));
      expect(error).toMatchObject({ _tag: "LogsApiError", status: 200, reason: "response" });
      if (!Schema.is(LogsApiError)(error)) return yield* Effect.die("Expected logs response error");
      expect(error[ErrorActionabilityId]).toMatchObject({
        error_category: "api_status",
        fingerprint_suffix: "api_response",
      });
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  );

  it.effect("fails typed for an out-of-range log timestamp", () =>
    Effect.gen(function* () {
      const repo = yield* makeComputeProject();
      const setup = yield* prepare({
        workdir: repo.dir,
        routes: { [route]: { status: 200, body: { result: [row("bad", 8.7e15)], error: null } } },
      });
      const error = yield* logs(tailFlags()).pipe(Effect.flip, Effect.provide(setup.layer));
      expect(error).toMatchObject({
        _tag: "LogsApiError",
        status: 200,
        reason: "response",
        message: "The logs API returned an unreadable log row.",
      });
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  );

  it.effect("finishes a structured read without automatic polling", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(now);
      const repo = yield* makeComputeProject();
      const setup = yield* prepare({
        workdir: repo.dir,
        format: "stream-json",
        routes: {
          [route]: [{ status: 200, body: { result: [row("seed")], error: null } }, { status: 404 }],
        },
      });
      yield* logs(tailFlags()).pipe(Effect.provide(setup.layer));
      yield* TestClock.adjust("10 seconds");
      expect(setup.http.requests).toHaveLength(1);
      expect(setup.out.events).toContainEqual(
        expect.objectContaining({
          type: "log-entry",
          data: expect.objectContaining({ id: "seed" }),
        }),
      );
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  );
});
