import { rmSync } from "node:fs";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Exit, Option, Schedule } from "effect";
import {
  makeWorkersProject,
  setupWorkers,
  workerApiLogRow,
  workerIngressLogRow,
  workerLogRow,
  workerLogsRoute,
  workerResource,
  workersRoute,
  WORKERS_PROJECT_REF,
} from "../../../../../tests/helpers/workers.ts";
import { WorkersFollowNotSupportedError } from "../workers.errors.ts";
import {
  InvalidWorkerNameError,
  WorkerLogsQueryFailedError,
  WorkerLogsRateLimitedError,
  WorkerLogsUsageExceededError,
  WorkerNotDeployedError,
  WorkersApiNetworkError,
  WorkersApiUnexpectedStatusError,
  WorkersUnavailableError,
} from "../../../../shared/workers/workers.errors.ts";
import { WorkersEnvNotSupportedError } from "../workers.errors.ts";
import { workersLogs } from "./logs.handler.ts";

const ESCAPE = "\u001b";
const CONFIG = 'project_id = "demo"\n\n[workers.api]\nruntime = "node"\n';
const LOGS_ROUTE = `GET ${workerLogsRoute()}`;
const GET_WORKER_ROUTE = `GET ${workersRoute("/api")}`;

const T1 = 1_788_187_525_212;
const T2 = 1_788_187_531_671;
const T3 = 1_788_187_532_576;

function project() {
  const created = makeWorkersProject({
    "supabase/config.toml": CONFIG,
    "supabase/workers/api/index.js": "export default {};\n",
  });
  return { dir: created.dir, cleanup: () => rmSync(created.dir, { recursive: true, force: true }) };
}

/** The default flag set; every test overrides only what it is about. */
function flags(overrides: Record<string, unknown> = {}) {
  return {
    name: "api",
    projectRef: Option.none(),
    kind: Option.none(),
    tail: 100,
    ...overrides,
  } as Parameters<typeof workersLogs>[0];
}

/**
 * Follow options that drive the loop instantly and stop after N polls: the real
 * schedule is spaced in seconds, and `recurs` gives the tail an end so a test
 * doesn't need to deliver a signal to finish.
 */
function followFor(polls: number) {
  return {
    pollSchedule: Schedule.recurs(polls),
    retrySchedule: Schedule.recurs(0),
  };
}

function logsResponse(rows: ReadonlyArray<unknown>) {
  return { status: 200, body: { result: rows, error: null } };
}

/**
 * The query parameters the handler actually sent, read off the recorded
 * request rather than the URL: `HttpClientRequest` keeps `urlParams` separate.
 */
function sentQuery(request: { readonly urlParams: Readonly<Record<string, string>> }) {
  return request.urlParams;
}

describe("workers logs", () => {
  it.live("prints a worker's own output oldest first", () => {
    const repo = project();
    const { layer, out } = setupWorkers({
      workdir: repo.dir,
      routes: {
        [LOGS_ROUTE]: logsResponse([
          workerLogRow({ id: "c", tsMs: T3, message: "app drained" }),
          workerLogRow({ id: "a", tsMs: T1, message: "listening on :8080" }),
          workerLogRow({ id: "b", tsMs: T2, message: "terminate hook" }),
        ]),
      },
    });

    return Effect.gen(function* () {
      yield* workersLogs(flags());

      // Strips the `<time>  [app]` prefix; the tag appears since no --kind pinned a stream.
      const messages = out.stdoutText
        .trimEnd()
        .split("\n")
        .map((line) => line.replace(/^\S+\s+\[\S+\]\s+/u, ""));
      expect(messages).toEqual(["listening on :8080", "terminate hook", "app drained"]);
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(repo.cleanup)));
  });

  it.live("composes a request line from attributes rather than the message", () => {
    const repo = project();
    const { layer, out } = setupWorkers({
      workdir: repo.dir,
      routes: {
        [LOGS_ROUTE]: logsResponse([
          workerIngressLogRow({
            tsMs: T1,
            status: "500",
            method: "POST",
            path: "/checkout",
            durationMs: "7",
          }),
        ]),
      },
    });

    return Effect.gen(function* () {
      yield* workersLogs(flags());

      expect(out.stdoutText).toContain("500 POST /checkout 7ms");
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(repo.cleanup)));
  });

  it.live("prints a build event with its reason", () => {
    const repo = project();
    const { layer, out } = setupWorkers({
      workdir: repo.dir,
      routes: {
        [LOGS_ROUTE]: logsResponse([
          workerApiLogRow({ tsMs: T1, event: "build_failed", reason: "exit status 1" }),
        ]),
      },
    });

    return Effect.gen(function* () {
      yield* workersLogs(flags());

      expect(out.stdoutText).toContain("build_failed exit status 1");
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(repo.cleanup)));
  });

  it.live("always sends both timestamp bounds, under a 24 hour span", () => {
    const repo = project();
    const { layer, http } = setupWorkers({
      workdir: repo.dir,
      routes: { [LOGS_ROUTE]: logsResponse([workerLogRow({})]) },
    });

    return Effect.gen(function* () {
      yield* workersLogs(flags());

      const query = sentQuery(http.requests[0]!);
      const start = query.iso_timestamp_start;
      const end = query.iso_timestamp_end;

      expect(start).toBeTruthy();
      expect(end).toBeTruthy();
      expect(start!.endsWith("Z")).toBe(true);
      expect(end!.endsWith("Z")).toBe(true);
      expect(Date.parse(end!) - Date.parse(start!)).toBeLessThan(24 * 60 * 60 * 1000);
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(repo.cleanup)));
  });

  it.live("filters on log_attributes, never the empty source column", () => {
    const repo = project();
    const { layer, http } = setupWorkers({
      workdir: repo.dir,
      routes: { [LOGS_ROUTE]: logsResponse([workerLogRow({})]) },
    });

    return Effect.gen(function* () {
      yield* workersLogs(flags());

      const sql = sentQuery(http.requests[0]!).sql ?? "";
      expect(sql).toContain("log_attributes['worker'] = 'api'");
      expect(sql).toContain("log_attributes['source'] in (");
      expect(sql).not.toMatch(/where source =/);
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(repo.cleanup)));
  });

  it.live("narrows to one stream for --kind, and to all three without it", () => {
    const repo = project();
    const { layer, http } = setupWorkers({
      workdir: repo.dir,
      routes: { [LOGS_ROUTE]: logsResponse([workerLogRow({})]) },
    });

    return Effect.gen(function* () {
      yield* workersLogs(flags({ kind: Option.some("requests") }));
      const narrowed = sentQuery(http.requests[0]!).sql ?? "";
      expect(narrowed).toContain("in ('worker_ingress_logs')");

      yield* workersLogs(flags());
      const all = sentQuery(http.requests[1]!).sql ?? "";
      expect(all).toContain("'worker_guest_logs'");
      expect(all).toContain("'worker_ingress_logs'");
      expect(all).toContain("'worker_api_logs'");
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(repo.cleanup)));
  });

  it.live("renders a stream it has never heard of rather than failing", () => {
    const repo = project();
    const { layer, out } = setupWorkers({
      workdir: repo.dir,
      routes: {
        [LOGS_ROUTE]: logsResponse([
          workerLogRow({ tsMs: T1, stream: "worker_future_logs", message: "from the future" }),
        ]),
      },
    });

    return Effect.gen(function* () {
      yield* workersLogs(flags());

      expect(out.stdoutText).toContain("from the future");
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(repo.cleanup)));
  });

  it.live("strips escape sequences a worker printed", () => {
    const repo = project();
    const { layer, out } = setupWorkers({
      workdir: repo.dir,
      routes: {
        [LOGS_ROUTE]: logsResponse([
          workerLogRow({ tsMs: T1, message: `${ESCAPE}[31mERROR: not really${ESCAPE}[0m` }),
        ]),
      },
    });

    return Effect.gen(function* () {
      yield* workersLogs(flags());

      expect(out.stdoutText).toContain("ERROR: not really");
      expect(out.stdoutText).not.toContain(ESCAPE);
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(repo.cleanup)));
  });

  it.live("keeps a blank guest line as a line", () => {
    const repo = project();
    const { layer, out } = setupWorkers({
      workdir: repo.dir,
      routes: {
        [LOGS_ROUTE]: logsResponse([
          workerLogRow({ id: "a", tsMs: T1, message: "before" }),
          workerLogRow({ id: "b", tsMs: T2, message: "" }),
          workerLogRow({ id: "c", tsMs: T3, message: "after" }),
        ]),
      },
    });

    return Effect.gen(function* () {
      yield* workersLogs(flags());

      expect(out.stdoutText.trimEnd().split("\n")).toHaveLength(3);
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(repo.cleanup)));
  });

  it.live("makes no request at all for --tail 0", () => {
    const repo = project();
    const { layer, http } = setupWorkers({
      workdir: repo.dir,
      routes: {
        [GET_WORKER_ROUTE]: { status: 200, body: { data: workerResource({ name: "api" }) } },
      },
    });

    return Effect.gen(function* () {
      yield* workersLogs(flags({ tail: 0 }));

      expect(http.routeKeys).not.toContain(workerLogsRoute());
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(repo.cleanup)));
  });

  it.live("passes --tail through as the row limit", () => {
    const repo = project();
    const { layer, http } = setupWorkers({
      workdir: repo.dir,
      routes: { [LOGS_ROUTE]: logsResponse([workerLogRow({})]) },
    });

    return Effect.gen(function* () {
      yield* workersLogs(flags({ tail: 7 }));

      expect(sentQuery(http.requests[0]!).sql).toContain("limit 7");
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(repo.cleanup)));
  });

  it.live("reports a worker that is not deployed rather than an empty screen", () => {
    const repo = project();
    const { layer } = setupWorkers({
      workdir: repo.dir,
      routes: {
        [LOGS_ROUTE]: logsResponse([]),
        [GET_WORKER_ROUTE]: { status: 404 },
      },
    });

    return Effect.gen(function* () {
      const error = yield* workersLogs(flags()).pipe(Effect.flip);

      expect(error).toBeInstanceOf(WorkerNotDeployedError);
      const suggestion = error instanceof WorkerNotDeployedError ? error.suggestion : "";
      expect(suggestion).toContain("supabase experimental workers push api");
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(repo.cleanup)));
  });

  it.live("says so when a deployed worker has simply been quiet", () => {
    const repo = project();
    const { layer, out } = setupWorkers({
      workdir: repo.dir,
      routes: {
        [LOGS_ROUTE]: logsResponse([]),
        [GET_WORKER_ROUTE]: { status: 200, body: { data: workerResource({ name: "api" }) } },
      },
    });

    return Effect.gen(function* () {
      yield* workersLogs(flags());

      expect(out.stdoutText).toContain('No logs for "api" in the last 24 hours.');
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(repo.cleanup)));
  });

  it.live("treats absent, null and empty result identically", () => {
    const repo = project();
    const { layer, out } = setupWorkers({
      workdir: repo.dir,
      routes: {
        [LOGS_ROUTE]: [
          { status: 200, body: {} },
          { status: 200, body: { result: null } },
          { status: 200, body: { result: [] } },
        ],
        [GET_WORKER_ROUTE]: { status: 200, body: { data: workerResource({ name: "api" }) } },
      },
    });

    return Effect.gen(function* () {
      for (const _ of [0, 1, 2]) {
        yield* workersLogs(flags());
      }

      expect(out.stdoutText.match(/No logs for/gu)).toHaveLength(3);
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(repo.cleanup)));
  });

  it.live("fails on a 200 that carries a query error", () => {
    const repo = project();
    const { layer } = setupWorkers({
      workdir: repo.dir,
      routes: {
        [LOGS_ROUTE]: { status: 200, body: { result: null, error: "query timed out" } },
      },
    });

    return Effect.gen(function* () {
      const error = yield* workersLogs(flags()).pipe(Effect.flip);

      expect(error).toBeInstanceOf(WorkerLogsQueryFailedError);
      const detail = error instanceof WorkerLogsQueryFailedError ? error.detail : "";
      expect(detail).toContain("query timed out");
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(repo.cleanup)));
  });

  it.live("reads the structured form of a query error too", () => {
    const repo = project();
    const { layer } = setupWorkers({
      workdir: repo.dir,
      routes: {
        [LOGS_ROUTE]: {
          status: 200,
          body: {
            result: null,
            error: { code: 400, message: "Unknown expression", status: "INVALID", errors: [] },
          },
        },
      },
    });

    return Effect.gen(function* () {
      const error = yield* workersLogs(flags()).pipe(Effect.flip);

      const detail = error instanceof WorkerLogsQueryFailedError ? error.detail : "";
      expect(detail).toContain("Unknown expression");
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(repo.cleanup)));
  });

  it.live("maps 402 to a usage error and 429 to a rate limit error", () => {
    const repo = project();
    const { layer } = setupWorkers({
      workdir: repo.dir,
      routes: { [LOGS_ROUTE]: [{ status: 402 }, { status: 429 }] },
    });

    return Effect.gen(function* () {
      const usage = yield* workersLogs(flags()).pipe(Effect.flip);
      const limited = yield* workersLogs(flags()).pipe(Effect.flip);

      expect(usage).toBeInstanceOf(WorkerLogsUsageExceededError);
      expect(limited).toBeInstanceOf(WorkerLogsRateLimitedError);
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(repo.cleanup)));
  });

  it.live("reports a project outside the alpha for a 404", () => {
    const repo = project();
    const { layer } = setupWorkers({
      workdir: repo.dir,
      routes: { [LOGS_ROUTE]: { status: 404 } },
    });

    return Effect.gen(function* () {
      const error = yield* workersLogs(flags()).pipe(Effect.flip);

      expect(error).toBeInstanceOf(WorkersUnavailableError);
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(repo.cleanup)));
  });

  it.live("reports an unexpected status, which is where a rejected query lands", () => {
    const repo = project();
    const { layer } = setupWorkers({
      workdir: repo.dir,
      routes: { [LOGS_ROUTE]: { status: 500, body: { message: "query rejected" } } },
    });

    return Effect.gen(function* () {
      const error = yield* workersLogs(flags()).pipe(Effect.flip);

      expect(error).toBeInstanceOf(WorkersApiUnexpectedStatusError);
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(repo.cleanup)));
  });

  it.live("reports a transport failure", () => {
    const repo = project();
    const { layer } = setupWorkers({
      workdir: repo.dir,
      routes: { [LOGS_ROUTE]: { transportError: "connection reset" } },
    });

    return Effect.gen(function* () {
      const error = yield* workersLogs(flags()).pipe(Effect.flip);

      expect(error).toBeInstanceOf(WorkersApiNetworkError);
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(repo.cleanup)));
  });

  it.live("rejects an impossible worker name before any request", () => {
    const repo = project();
    const { layer, http } = setupWorkers({ workdir: repo.dir, routes: {} });

    return Effect.gen(function* () {
      const error = yield* workersLogs(flags({ name: "Not A Name" })).pipe(Effect.flip);

      expect(error).toBeInstanceOf(InvalidWorkerNameError);
      expect(http.requests).toHaveLength(0);
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(repo.cleanup)));
  });

  it.live("refuses -o env before spending the query", () => {
    const repo = project();
    const { layer, http } = setupWorkers({
      workdir: repo.dir,
      goOutput: "env",
      routes: { [LOGS_ROUTE]: logsResponse([workerLogRow({})]) },
    });

    return Effect.gen(function* () {
      const error = yield* workersLogs(flags()).pipe(Effect.flip);

      expect(error).toBeInstanceOf(WorkersEnvNotSupportedError);
      expect(http.requests).toHaveLength(0);
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(repo.cleanup)));
  });

  it.live("emits only the payload on stdout for -o json", () => {
    const repo = project();
    const { layer, out } = setupWorkers({
      workdir: repo.dir,
      goOutput: "json",
      routes: {
        [LOGS_ROUTE]: logsResponse([
          workerIngressLogRow({ tsMs: T1, status: "503", durationMs: "12" }),
        ]),
      },
    });

    return Effect.gen(function* () {
      yield* workersLogs(flags());

      const payload = JSON.parse(out.stdoutText) as {
        worker_name: string;
        logs: ReadonlyArray<Record<string, unknown>>;
      };
      expect(payload.worker_name).toBe("api");
      expect(payload.logs[0]?.level).toBe("error");
      expect(payload.logs[0]?.timestamp).toBe(new Date(T1).toISOString());
      expect(payload.logs[0]?.timestamp_ms).toBe(T1);
      const attributes = payload.logs[0]?.attributes as Record<string, string> | undefined;
      expect(attributes?.duration_ms).toBe("12");
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(repo.cleanup)));
  });

  it.live("emits exactly one structured result for --output-format json", () => {
    const repo = project();
    const { layer, out } = setupWorkers({
      workdir: repo.dir,
      format: "json",
      routes: { [LOGS_ROUTE]: logsResponse([workerLogRow({ tsMs: T1 })]) },
    });

    return Effect.gen(function* () {
      yield* workersLogs(flags());

      expect(out.stdoutText).toBe("");
      const results = out.messages.filter((message) => message.type === "success");
      expect(results).toHaveLength(1);
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(repo.cleanup)));
  });

  it.live("flushes telemetry even when the query fails", () => {
    const repo = project();
    const { layer, telemetry } = setupWorkers({
      workdir: repo.dir,
      routes: { [LOGS_ROUTE]: { status: 500 } },
    });

    return Effect.gen(function* () {
      yield* workersLogs(flags()).pipe(Effect.ignore);

      expect(telemetry.flushed).toBe(true);
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(repo.cleanup)));
  });

  it.live("flushes telemetry when the project ref cannot be resolved", () => {
    const repo = project();
    const { layer, telemetry, http } = setupWorkers({
      workdir: repo.dir,
      linked: false,
      routes: {},
    });

    return Effect.gen(function* () {
      const exit = yield* workersLogs(flags()).pipe(Effect.exit);

      expect(Exit.isFailure(exit)).toBe(true);
      expect(telemetry.flushed).toBe(true);
      expect(http.requests).toHaveLength(0);
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(repo.cleanup)));
  });

  it.live("uses the project ref from the flag and echoes it in suggestions", () => {
    const repo = project();
    const { layer } = setupWorkers({
      workdir: repo.dir,
      linked: false,
      routes: {
        [`GET /v1/projects/${WORKERS_PROJECT_REF}/analytics/endpoints/logs`]: logsResponse([]),
        [GET_WORKER_ROUTE]: { status: 404 },
      },
    });

    return Effect.gen(function* () {
      const error = yield* workersLogs(
        flags({ projectRef: Option.some(WORKERS_PROJECT_REF) }),
      ).pipe(Effect.flip);

      const suggestion = error instanceof WorkerNotDeployedError ? error.suggestion : "";
      expect(suggestion).toContain(`--project-ref ${WORKERS_PROJECT_REF}`);
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(repo.cleanup)));
  });

  it.live("keeps printing new lines, sending both bounds on every poll", () => {
    const repo = project();
    const { layer, out, http } = setupWorkers({
      workdir: repo.dir,
      routes: {
        [LOGS_ROUTE]: [
          logsResponse([workerLogRow({ id: "a", tsMs: T1, message: "first" })]),
          logsResponse([workerLogRow({ id: "b", tsMs: T2, message: "second" })]),
          logsResponse([workerLogRow({ id: "c", tsMs: T3, message: "third" })]),
        ],
      },
    });

    return Effect.gen(function* () {
      yield* workersLogs(flags({ follow: true }), followFor(2));

      expect(out.stdoutText).toContain("first");
      expect(out.stdoutText).toContain("second");
      expect(out.stdoutText).toContain("third");

      for (const request of http.requests) {
        const query = sentQuery(request);
        expect(query.iso_timestamp_start).toBeTruthy();
        expect(query.iso_timestamp_end).toBeTruthy();
        expect(
          Date.parse(query.iso_timestamp_end!) - Date.parse(query.iso_timestamp_start!),
        ).toBeLessThan(24 * 60 * 60 * 1000);
      }
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(repo.cleanup)));
  });

  it.live("does not reprint a line an overlapping window returns again", () => {
    const repo = project();
    const { layer, out } = setupWorkers({
      workdir: repo.dir,
      routes: {
        [LOGS_ROUTE]: [
          logsResponse([workerLogRow({ id: "a", tsMs: T1, message: "only once" })]),
          // The cursor lags, which is why the same row appears in both responses.
          logsResponse([
            workerLogRow({ id: "a", tsMs: T1, message: "only once" }),
            workerLogRow({ id: "b", tsMs: T2, message: "and this" }),
          ]),
        ],
      },
    });

    return Effect.gen(function* () {
      yield* workersLogs(flags({ follow: true }), followFor(1));

      expect(out.stdoutText.match(/only once/gu)).toHaveLength(1);
      expect(out.stdoutText).toContain("and this");
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(repo.cleanup)));
  });

  it.live("still emits a line that arrived late, inside the grace window", () => {
    const repo = project();
    const { layer, out } = setupWorkers({
      workdir: repo.dir,
      routes: {
        [LOGS_ROUTE]: [
          logsResponse([workerLogRow({ id: "a", tsMs: T3, message: "newest first" })]),
          // Older than the cursor — this is what the grace period is for.
          logsResponse([workerLogRow({ id: "late", tsMs: T1, message: "arrived late" })]),
        ],
      },
    });

    return Effect.gen(function* () {
      yield* workersLogs(flags({ follow: true }), followFor(1));

      expect(out.stdoutText).toContain("arrived late");
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(repo.cleanup)));
  });

  it.live("skips history for --tail 0 but still follows", () => {
    const repo = project();
    const { layer, out, http } = setupWorkers({
      workdir: repo.dir,
      routes: {
        [GET_WORKER_ROUTE]: { status: 200, body: { data: workerResource({ name: "api" }) } },
        [LOGS_ROUTE]: logsResponse([
          workerLogRow({ id: "new", tsMs: Date.now() + 5_000, message: "brand new" }),
        ]),
      },
    });

    return Effect.gen(function* () {
      yield* workersLogs(flags({ follow: true, tail: 0 }), followFor(1));

      expect(out.stdoutText).toContain("brand new");
      const sql = http.requests.map((request) => sentQuery(request).sql).filter(Boolean);
      expect(sql).not.toHaveLength(0);
      for (const query of sql) {
        expect(query).not.toContain("limit 0");
      }
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(repo.cleanup)));
  });

  it.live("emits a log-entry event per line under stream-json", () => {
    const repo = project();
    const { layer, out } = setupWorkers({
      workdir: repo.dir,
      format: "stream-json",
      routes: {
        [LOGS_ROUTE]: [
          logsResponse([workerIngressLogRow({ id: "a", tsMs: T1, status: "500" })]),
          logsResponse([workerLogRow({ id: "b", tsMs: T2, message: "app line" })]),
        ],
      },
    });

    return Effect.gen(function* () {
      yield* workersLogs(flags({ follow: true }), followFor(1));

      const entries = out.events.filter((event) => event.type === "log-entry");
      expect(entries).toHaveLength(2);
      expect(out.events.filter((event) => event.type === "result")).toHaveLength(0);
      expect(entries[0]).toMatchObject({ stream: "stderr", source: "history" });
      expect(entries[1]).toMatchObject({ stream: "stdout", source: "live" });
      expect(entries[0]).toMatchObject({ line: "500 GET / 23ms" });
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(repo.cleanup)));
  });

  it.live("renders text when -o pretty overrides --output-format json", () => {
    const repo = project();
    const { layer, out } = setupWorkers({
      workdir: repo.dir,
      goOutput: "pretty",
      format: "json",
      routes: { [LOGS_ROUTE]: logsResponse([workerLogRow({ tsMs: T1 })]) },
    });

    return Effect.gen(function* () {
      yield* workersLogs(flags());

      expect(out.stdoutText).not.toBe("");
      expect(out.messages.filter((message) => message.type === "success")).toHaveLength(0);
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(repo.cleanup)));
  });

  it.live("allows --follow when -o pretty overrides --output-format json", () => {
    const repo = project();
    const { layer, out } = setupWorkers({
      workdir: repo.dir,
      goOutput: "pretty",
      format: "json",
      routes: { [LOGS_ROUTE]: logsResponse([workerLogRow({ tsMs: T1 })]) },
    });

    return Effect.gen(function* () {
      yield* workersLogs(flags({ follow: true }), followFor(1));

      expect(out.stdoutText).not.toBe("");
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(repo.cleanup)));
  });

  it.live("refuses --follow for the single-payload output formats", () => {
    const repo = project();

    return Effect.gen(function* () {
      for (const setup of [
        setupWorkers({ workdir: repo.dir, goOutput: "json", routes: {} }),
        setupWorkers({ workdir: repo.dir, format: "json", routes: {} }),
      ]) {
        const error = yield* workersLogs(flags({ follow: true })).pipe(
          Effect.flip,
          Effect.provide(setup.layer),
        );

        expect(error).toBeInstanceOf(WorkersFollowNotSupportedError);
        expect(setup.http.requests).toHaveLength(0);
      }
    }).pipe(Effect.ensuring(Effect.sync(repo.cleanup)));
  });

  it.live("does not replay pre-invocation lines for --tail 0 --follow", () => {
    const repo = project();
    const { layer, out } = setupWorkers({
      workdir: repo.dir,
      routes: {
        [GET_WORKER_ROUTE]: { status: 200, body: { data: workerResource({ name: "api" }) } },
        [LOGS_ROUTE]: [
          logsResponse([
            workerLogRow({ id: "before", tsMs: Date.now() - 30_000, message: "written before" }),
            workerLogRow({ id: "after", tsMs: Date.now() + 5_000, message: "written after" }),
          ]),
        ],
      },
    });

    return Effect.gen(function* () {
      yield* workersLogs(flags({ tail: 0, follow: true }), followFor(0));

      expect(out.stdoutText).toContain("written after");
      expect(out.stdoutText).not.toContain("written before");
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(repo.cleanup)));
  });

  it.live("still checks the worker exists for --tail 0 --follow", () => {
    const repo = project();
    const { layer, out } = setupWorkers({
      workdir: repo.dir,
      routes: { [GET_WORKER_ROUTE]: { status: 404 } },
    });

    return Effect.gen(function* () {
      const error = yield* workersLogs(flags({ tail: 0, follow: true }), followFor(0)).pipe(
        Effect.flip,
      );

      expect(error).toBeInstanceOf(WorkerNotDeployedError);
      expect(out.progressEvents).toContainEqual(
        expect.objectContaining({ type: "start", message: "Checking worker..." }),
      );
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(repo.cleanup)));
  });

  // `ts_ms` feeds `new Date(...).toISOString()`, which throws `RangeError` on an
  // out-of-range value.
  it.live("fails typed rather than throwing on an out-of-range timestamp", () => {
    const repo = project();
    const { layer } = setupWorkers({
      workdir: repo.dir,
      routes: {
        [LOGS_ROUTE]: logsResponse([workerLogRow({ id: "bad", tsMs: 8.7e15 })]),
      },
    });

    return Effect.gen(function* () {
      const error = yield* workersLogs(flags()).pipe(Effect.flip);

      expect(error).toBeInstanceOf(WorkersApiUnexpectedStatusError);
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(repo.cleanup)));
  });

  it.live("surfaces a definitive poll failure without retrying it", () => {
    const repo = project();
    const { layer, http } = setupWorkers({
      workdir: repo.dir,
      routes: {
        [LOGS_ROUTE]: [logsResponse([workerLogRow({ id: "a", tsMs: T1 })]), { status: 404 }],
      },
    });

    return Effect.gen(function* () {
      yield* workersLogs(flags({ follow: true }), {
        pollSchedule: Schedule.recurs(0),
        retrySchedule: Schedule.recurs(3),
      }).pipe(Effect.flip);

      expect(http.requests).toHaveLength(2);
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(repo.cleanup)));
  });

  it.live("retries a rate-limited poll", () => {
    const repo = project();
    const { layer, http } = setupWorkers({
      workdir: repo.dir,
      routes: {
        [LOGS_ROUTE]: [
          logsResponse([workerLogRow({ id: "a", tsMs: T1 })]),
          { status: 429 },
          logsResponse([workerLogRow({ id: "b", tsMs: T2, message: "after the limit" })]),
        ],
      },
    });

    return Effect.gen(function* () {
      yield* workersLogs(flags({ follow: true }), {
        pollSchedule: Schedule.recurs(0),
        retrySchedule: Schedule.recurs(3),
      });

      expect(http.requests).toHaveLength(3);
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(repo.cleanup)));
  });

  it.live("polls with a page size independent of --tail", () => {
    const repo = project();
    const { layer, http } = setupWorkers({
      workdir: repo.dir,
      routes: {
        [LOGS_ROUTE]: [
          logsResponse([workerLogRow({ id: "a", tsMs: T1 })]),
          logsResponse([workerLogRow({ id: "b", tsMs: T2 })]),
        ],
      },
    });

    return Effect.gen(function* () {
      yield* workersLogs(flags({ tail: 1, follow: true }), followFor(0));

      expect(sentQuery(http.requests[0]!).sql ?? "").toContain("limit 1");
      expect(sentQuery(http.requests[1]!).sql ?? "").toContain("limit 1000");
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(repo.cleanup)));
  });

  it.live("drains a burst larger than one page before advancing the cursor", () => {
    const repo = project();
    const fullPage = Array.from({ length: 1000 }, (_, index) =>
      workerLogRow({ id: `burst-${index}`, tsMs: T2 + index, message: `burst ${index}` }),
    );
    const { layer, out, http } = setupWorkers({
      workdir: repo.dir,
      routes: {
        [LOGS_ROUTE]: [
          // Non-empty, so the run skips the deployed-worker check an empty history would trigger.
          logsResponse([workerLogRow({ id: "seed", tsMs: T1 - 100_000, message: "seed" })]),
          logsResponse(fullPage),
          logsResponse([workerLogRow({ id: "straggler", tsMs: T1, message: "older line" })]),
        ],
      },
    });

    return Effect.gen(function* () {
      yield* workersLogs(flags({ follow: true }), followFor(0));

      expect(http.requests).toHaveLength(3);
      expect(out.stdoutText).toContain("older line");
      expect(out.stdoutText).toContain("burst 999");
      expect(out.stdoutText.indexOf("older line")).toBeLessThan(out.stdoutText.indexOf("burst 0"));
      expect(out.stderrText).not.toContain("Skipped part of a burst");
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(repo.cleanup)));
  });

  it.live("says so on stderr when a burst outruns the page budget", () => {
    const repo = project();
    // Each page older than the last, so every page narrows the window and the
    // loop runs to its bound.
    const pages = Array.from({ length: 5 }, (_unused, page) =>
      logsResponse(
        Array.from({ length: 1000 }, (_row, index) =>
          workerLogRow({
            id: `p${page}-${index}`,
            tsMs: T2 - page * 1_000_000 + index,
            message: `page ${page} line ${index}`,
          }),
        ),
      ),
    );
    const { layer, out, http } = setupWorkers({
      workdir: repo.dir,
      routes: {
        [LOGS_ROUTE]: [
          logsResponse([workerLogRow({ id: "seed", tsMs: T1 - 100_000, message: "seed" })]),
          ...pages,
        ],
      },
    });

    return Effect.gen(function* () {
      yield* workersLogs(flags({ follow: true }), followFor(0));

      expect(http.requests).toHaveLength(6);
      expect(out.stderrText).toContain("Skipped part of a burst larger than 5000 lines");
      expect(out.stderrText).toContain("--kind");
      expect(out.stdoutText).toContain("page 0 line 999");
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(repo.cleanup)));
  });

  it.live("warns once about a skipped burst, however long the tail runs", () => {
    const repo = project();
    const fullPage = (page: number, poll: number) =>
      logsResponse(
        Array.from({ length: 1000 }, (_row, index) =>
          workerLogRow({
            id: `poll${poll}-p${page}-${index}`,
            tsMs: T2 + poll * 10_000_000 - page * 1_000_000 + index,
            message: `poll ${poll} page ${page} line ${index}`,
          }),
        ),
      );
    const burst = (poll: number) => Array.from({ length: 5 }, (_u, page) => fullPage(page, poll));
    const { layer, out } = setupWorkers({
      workdir: repo.dir,
      routes: {
        [LOGS_ROUTE]: [
          logsResponse([workerLogRow({ id: "seed", tsMs: T1 - 100_000, message: "seed" })]),
          ...burst(0),
          ...burst(1),
        ],
      },
    });

    return Effect.gen(function* () {
      yield* workersLogs(flags({ follow: true }), followFor(1));

      const notices = out.stderrText.split("Skipped part of a burst").length - 1;
      expect(notices).toBe(1);
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(repo.cleanup)));
  });

  it.live("records exit 130 on SIGINT and still runs its finalizers", () => {
    const repo = project();
    const { layer, processControl, telemetry } = setupWorkers({
      workdir: repo.dir,
      signal: "SIGINT",
      routes: { [LOGS_ROUTE]: logsResponse([workerLogRow({ id: "a", tsMs: T1 })]) },
    });

    return Effect.gen(function* () {
      yield* workersLogs(flags({ follow: true }), {
        pollSchedule: Schedule.forever,
        retrySchedule: Schedule.recurs(0),
      });

      expect(processControl.exitCode).toBe(130);
      expect(telemetry.flushed).toBe(true);
      expect(processControl.exitCalls).toEqual([]);
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(repo.cleanup)));
  });
});
