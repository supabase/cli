import { rmSync } from "node:fs";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Option, Schedule } from "effect";
import {
  makeWorkersProject,
  setupLegacyWorkers,
  workerApiLogRow,
  workerIngressLogRow,
  workerLogRow,
  workerLogsRoute,
  workerResource,
  workersRoute,
  WORKERS_PROJECT_REF,
} from "../../../../../tests/helpers/legacy-workers.ts";
import { LegacyWorkersFollowNotSupportedError } from "../workers.errors.ts";
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
import { LegacyWorkersEnvNotSupportedError } from "../workers.errors.ts";
import { legacyWorkersLogs } from "./logs.handler.ts";

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
    source: Option.none(),
    tail: 100,
    ...overrides,
  } as Parameters<typeof legacyWorkersLogs>[0];
}

/**
 * Follow options that drive the loop instantly and stop after N polls.
 *
 * The real schedule is spaced in seconds; `recurs` also gives the tail an end, so
 * a test does not have to deliver a signal just to finish.
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
 * The query parameters the handler actually sent.
 *
 * Read off the recorded request rather than the URL: `HttpClientRequest` keeps
 * `urlParams` beside the URL rather than appended to it.
 */
function sentQuery(request: { readonly urlParams: Readonly<Record<string, string>> }) {
  return request.urlParams;
}

describe("legacy workers logs", () => {
  it.live("prints a worker's own output oldest first", () => {
    const repo = project();
    const { layer, out } = setupLegacyWorkers({
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
      yield* legacyWorkersLogs(flags());

      const lines = out.stdoutText.trimEnd().split("\n");
      expect(lines.map((line) => line.split("  ")[1])).toEqual([
        "listening on :8080",
        "terminate hook",
        "app drained",
      ]);
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(repo.cleanup)));
  });

  it.live("composes a request line from attributes rather than the message", () => {
    const repo = project();
    const { layer, out } = setupLegacyWorkers({
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
      yield* legacyWorkersLogs(flags());

      expect(out.stdoutText).toContain("500 POST /checkout 7ms");
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(repo.cleanup)));
  });

  it.live("prints a build event with its reason", () => {
    const repo = project();
    const { layer, out } = setupLegacyWorkers({
      workdir: repo.dir,
      routes: {
        [LOGS_ROUTE]: logsResponse([
          workerApiLogRow({ tsMs: T1, event: "build_failed", reason: "exit status 1" }),
        ]),
      },
    });

    return Effect.gen(function* () {
      yield* legacyWorkersLogs(flags());

      expect(out.stdoutText).toContain("build_failed exit status 1");
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(repo.cleanup)));
  });

  it.live("always sends both timestamp bounds, under a 24 hour span", () => {
    const repo = project();
    const { layer, http } = setupLegacyWorkers({
      workdir: repo.dir,
      routes: { [LOGS_ROUTE]: logsResponse([workerLogRow({})]) },
    });

    return Effect.gen(function* () {
      yield* legacyWorkersLogs(flags());

      const query = sentQuery(http.requests[0]!);
      const start = query.iso_timestamp_start;
      const end = query.iso_timestamp_end;

      // A lone bound yields a one-minute window server-side and sending neither
      // is an outright error, so both must always be present.
      expect(start).toBeTruthy();
      expect(end).toBeTruthy();
      expect(start!.endsWith("Z")).toBe(true);
      expect(end!.endsWith("Z")).toBe(true);
      // Over 24h the server silently clamps to start+24h, returning an older
      // slice than the one asked for.
      expect(Date.parse(end!) - Date.parse(start!)).toBeLessThan(24 * 60 * 60 * 1000);
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(repo.cleanup)));
  });

  it.live("filters on log_attributes, never the empty source column", () => {
    const repo = project();
    const { layer, http } = setupLegacyWorkers({
      workdir: repo.dir,
      routes: { [LOGS_ROUTE]: logsResponse([workerLogRow({})]) },
    });

    return Effect.gen(function* () {
      yield* legacyWorkersLogs(flags());

      const sql = sentQuery(http.requests[0]!).sql ?? "";
      expect(sql).toContain("log_attributes['worker'] = 'api'");
      expect(sql).toContain("log_attributes['source'] in (");
      expect(sql).not.toMatch(/where source =/);
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(repo.cleanup)));
  });

  it.live("narrows to one stream for --source, and to all three without it", () => {
    const repo = project();
    const { layer, http } = setupLegacyWorkers({
      workdir: repo.dir,
      routes: { [LOGS_ROUTE]: logsResponse([workerLogRow({})]) },
    });

    return Effect.gen(function* () {
      yield* legacyWorkersLogs(flags({ source: Option.some("requests") }));
      const narrowed = sentQuery(http.requests[0]!).sql ?? "";
      expect(narrowed).toContain("in ('worker_ingress_logs')");

      yield* legacyWorkersLogs(flags());
      const all = sentQuery(http.requests[1]!).sql ?? "";
      expect(all).toContain("'worker_guest_logs'");
      expect(all).toContain("'worker_ingress_logs'");
      expect(all).toContain("'worker_api_logs'");
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(repo.cleanup)));
  });

  it.live("renders a stream it has never heard of rather than failing", () => {
    const repo = project();
    const { layer, out } = setupLegacyWorkers({
      workdir: repo.dir,
      routes: {
        [LOGS_ROUTE]: logsResponse([
          workerLogRow({ tsMs: T1, stream: "worker_future_logs", message: "from the future" }),
        ]),
      },
    });

    return Effect.gen(function* () {
      // The log contract is additive-only: unknown streams must be ignored, not
      // rejected.
      yield* legacyWorkersLogs(flags());

      expect(out.stdoutText).toContain("from the future");
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(repo.cleanup)));
  });

  it.live("strips escape sequences a worker printed", () => {
    const repo = project();
    const { layer, out } = setupLegacyWorkers({
      workdir: repo.dir,
      routes: {
        [LOGS_ROUTE]: logsResponse([
          workerLogRow({ tsMs: T1, message: `${ESCAPE}[31mERROR: not really${ESCAPE}[0m` }),
        ]),
      },
    });

    return Effect.gen(function* () {
      yield* legacyWorkersLogs(flags());

      expect(out.stdoutText).toContain("ERROR: not really");
      expect(out.stdoutText).not.toContain(ESCAPE);
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(repo.cleanup)));
  });

  it.live("keeps a blank guest line as a line", () => {
    const repo = project();
    const { layer, out } = setupLegacyWorkers({
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
      yield* legacyWorkersLogs(flags());

      expect(out.stdoutText.trimEnd().split("\n")).toHaveLength(3);
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(repo.cleanup)));
  });

  it.live("makes no request at all for --tail 0", () => {
    const repo = project();
    const { layer, http } = setupLegacyWorkers({
      workdir: repo.dir,
      routes: {
        [GET_WORKER_ROUTE]: { status: 200, body: { data: workerResource({ name: "api" }) } },
      },
    });

    return Effect.gen(function* () {
      // `limit 0` would be a 400, so no-history has to mean no query.
      yield* legacyWorkersLogs(flags({ tail: 0 }));

      expect(http.routeKeys).not.toContain(workerLogsRoute());
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(repo.cleanup)));
  });

  it.live("passes --tail through as the row limit", () => {
    const repo = project();
    const { layer, http } = setupLegacyWorkers({
      workdir: repo.dir,
      routes: { [LOGS_ROUTE]: logsResponse([workerLogRow({})]) },
    });

    return Effect.gen(function* () {
      yield* legacyWorkersLogs(flags({ tail: 7 }));

      expect(sentQuery(http.requests[0]!).sql).toContain("limit 7");
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(repo.cleanup)));
  });

  it.live("reports a worker that is not deployed rather than an empty screen", () => {
    const repo = project();
    const { layer } = setupLegacyWorkers({
      workdir: repo.dir,
      routes: {
        [LOGS_ROUTE]: logsResponse([]),
        [GET_WORKER_ROUTE]: { status: 404 },
      },
    });

    return Effect.gen(function* () {
      const error = yield* legacyWorkersLogs(flags()).pipe(Effect.flip);

      expect(error).toBeInstanceOf(WorkerNotDeployedError);
      const suggestion = error instanceof WorkerNotDeployedError ? error.suggestion : "";
      expect(suggestion).toContain("supabase workers push api");
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(repo.cleanup)));
  });

  it.live("says so when a deployed worker has simply been quiet", () => {
    const repo = project();
    const { layer, out } = setupLegacyWorkers({
      workdir: repo.dir,
      routes: {
        [LOGS_ROUTE]: logsResponse([]),
        [GET_WORKER_ROUTE]: { status: 200, body: { data: workerResource({ name: "api" }) } },
      },
    });

    return Effect.gen(function* () {
      yield* legacyWorkersLogs(flags());

      expect(out.stdoutText).toContain('No logs for "api" in the last 24 hours.');
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(repo.cleanup)));
  });

  it.live("treats absent, null and empty result identically", () => {
    const repo = project();
    const { layer, out } = setupLegacyWorkers({
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
        yield* legacyWorkersLogs(flags());
      }

      expect(out.stdoutText.match(/No logs for/gu)).toHaveLength(3);
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(repo.cleanup)));
  });

  it.live("fails on a 200 that carries a query error", () => {
    const repo = project();
    const { layer } = setupLegacyWorkers({
      workdir: repo.dir,
      routes: {
        [LOGS_ROUTE]: { status: 200, body: { result: null, error: "query timed out" } },
      },
    });

    return Effect.gen(function* () {
      // The endpoint reports a failed query with a 200, so reading `result`
      // first would report success.
      const error = yield* legacyWorkersLogs(flags()).pipe(Effect.flip);

      expect(error).toBeInstanceOf(WorkerLogsQueryFailedError);
      const detail = error instanceof WorkerLogsQueryFailedError ? error.detail : "";
      expect(detail).toContain("query timed out");
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(repo.cleanup)));
  });

  it.live("reads the structured form of a query error too", () => {
    const repo = project();
    const { layer } = setupLegacyWorkers({
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
      const error = yield* legacyWorkersLogs(flags()).pipe(Effect.flip);

      const detail = error instanceof WorkerLogsQueryFailedError ? error.detail : "";
      expect(detail).toContain("Unknown expression");
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(repo.cleanup)));
  });

  it.live("maps 402 to a usage error and 429 to a rate limit error", () => {
    const repo = project();
    const { layer } = setupLegacyWorkers({
      workdir: repo.dir,
      routes: { [LOGS_ROUTE]: [{ status: 402 }, { status: 429 }] },
    });

    return Effect.gen(function* () {
      const usage = yield* legacyWorkersLogs(flags()).pipe(Effect.flip);
      const limited = yield* legacyWorkersLogs(flags()).pipe(Effect.flip);

      expect(usage).toBeInstanceOf(WorkerLogsUsageExceededError);
      expect(limited).toBeInstanceOf(WorkerLogsRateLimitedError);
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(repo.cleanup)));
  });

  it.live("reports a project outside the alpha for a 404", () => {
    const repo = project();
    const { layer } = setupLegacyWorkers({
      workdir: repo.dir,
      routes: { [LOGS_ROUTE]: { status: 404 } },
    });

    return Effect.gen(function* () {
      const error = yield* legacyWorkersLogs(flags()).pipe(Effect.flip);

      expect(error).toBeInstanceOf(WorkersUnavailableError);
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(repo.cleanup)));
  });

  it.live("reports an unexpected status, which is where a rejected query lands", () => {
    const repo = project();
    const { layer } = setupLegacyWorkers({
      workdir: repo.dir,
      routes: { [LOGS_ROUTE]: { status: 500, body: { message: "query rejected" } } },
    });

    return Effect.gen(function* () {
      const error = yield* legacyWorkersLogs(flags()).pipe(Effect.flip);

      expect(error).toBeInstanceOf(WorkersApiUnexpectedStatusError);
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(repo.cleanup)));
  });

  it.live("reports a transport failure", () => {
    const repo = project();
    const { layer } = setupLegacyWorkers({
      workdir: repo.dir,
      routes: { [LOGS_ROUTE]: { transportError: "connection reset" } },
    });

    return Effect.gen(function* () {
      const error = yield* legacyWorkersLogs(flags()).pipe(Effect.flip);

      expect(error).toBeInstanceOf(WorkersApiNetworkError);
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(repo.cleanup)));
  });

  it.live("rejects an impossible worker name before any request", () => {
    const repo = project();
    const { layer, http } = setupLegacyWorkers({ workdir: repo.dir, routes: {} });

    return Effect.gen(function* () {
      const error = yield* legacyWorkersLogs(flags({ name: "Not A Name" })).pipe(Effect.flip);

      expect(error).toBeInstanceOf(InvalidWorkerNameError);
      expect(http.requests).toHaveLength(0);
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(repo.cleanup)));
  });

  it.live("refuses -o env before spending the query", () => {
    const repo = project();
    const { layer, http } = setupLegacyWorkers({
      workdir: repo.dir,
      goOutput: "env",
      routes: { [LOGS_ROUTE]: logsResponse([workerLogRow({})]) },
    });

    return Effect.gen(function* () {
      const error = yield* legacyWorkersLogs(flags()).pipe(Effect.flip);

      expect(error).toBeInstanceOf(LegacyWorkersEnvNotSupportedError);
      expect(http.requests).toHaveLength(0);
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(repo.cleanup)));
  });

  it.live("emits only the payload on stdout for -o json", () => {
    const repo = project();
    const { layer, out } = setupLegacyWorkers({
      workdir: repo.dir,
      goOutput: "json",
      routes: {
        [LOGS_ROUTE]: logsResponse([
          workerIngressLogRow({ tsMs: T1, status: "503", durationMs: "12" }),
        ]),
      },
    });

    return Effect.gen(function* () {
      yield* legacyWorkersLogs(flags());

      const payload = JSON.parse(out.stdoutText) as {
        worker_name: string;
        logs: ReadonlyArray<Record<string, unknown>>;
      };
      expect(payload.worker_name).toBe("api");
      expect(payload.logs[0]?.level).toBe("error");
      // Both timestamp forms, and the raw attributes.
      expect(payload.logs[0]?.timestamp).toBe(new Date(T1).toISOString());
      expect(payload.logs[0]?.timestamp_ms).toBe(T1);
      const attributes = payload.logs[0]?.attributes as Record<string, string> | undefined;
      expect(attributes?.duration_ms).toBe("12");
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(repo.cleanup)));
  });

  it.live("emits exactly one structured result for --output-format json", () => {
    const repo = project();
    const { layer, out } = setupLegacyWorkers({
      workdir: repo.dir,
      format: "json",
      routes: { [LOGS_ROUTE]: logsResponse([workerLogRow({ tsMs: T1 })]) },
    });

    return Effect.gen(function* () {
      yield* legacyWorkersLogs(flags());

      expect(out.stdoutText).toBe("");
      const results = out.messages.filter((message) => message.type === "success");
      expect(results).toHaveLength(1);
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(repo.cleanup)));
  });

  it.live("flushes telemetry even when the query fails", () => {
    const repo = project();
    const { layer, telemetry } = setupLegacyWorkers({
      workdir: repo.dir,
      routes: { [LOGS_ROUTE]: { status: 500 } },
    });

    return Effect.gen(function* () {
      yield* legacyWorkersLogs(flags()).pipe(Effect.ignore);

      expect(telemetry.flushed).toBe(true);
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(repo.cleanup)));
  });

  it.live("uses the project ref from the flag and echoes it in suggestions", () => {
    const repo = project();
    const { layer } = setupLegacyWorkers({
      workdir: repo.dir,
      linked: false,
      routes: {
        [`GET /v1/projects/${WORKERS_PROJECT_REF}/analytics/endpoints/logs`]: logsResponse([]),
        [GET_WORKER_ROUTE]: { status: 404 },
      },
    });

    return Effect.gen(function* () {
      const error = yield* legacyWorkersLogs(
        flags({ projectRef: Option.some(WORKERS_PROJECT_REF) }),
      ).pipe(Effect.flip);

      // A copy-pasted suggestion must not silently re-resolve to whatever this
      // checkout happens to be linked to.
      const suggestion = error instanceof WorkerNotDeployedError ? error.suggestion : "";
      expect(suggestion).toContain(`--project-ref ${WORKERS_PROJECT_REF}`);
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(repo.cleanup)));
  });

  it.live("keeps printing new lines, sending both bounds on every poll", () => {
    const repo = project();
    const { layer, out, http } = setupLegacyWorkers({
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
      yield* legacyWorkersLogs(flags({ follow: true }), followFor(2));

      expect(out.stdoutText).toContain("first");
      expect(out.stdoutText).toContain("second");
      expect(out.stdoutText).toContain("third");

      // Every request, history and polls alike, must carry both bounds: a lone
      // start silently yields a one-minute window and neither is an error.
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
    const { layer, out } = setupLegacyWorkers({
      workdir: repo.dir,
      routes: {
        [LOGS_ROUTE]: [
          logsResponse([workerLogRow({ id: "a", tsMs: T1, message: "only once" })]),
          // The cursor lags deliberately, so the same row comes back.
          logsResponse([
            workerLogRow({ id: "a", tsMs: T1, message: "only once" }),
            workerLogRow({ id: "b", tsMs: T2, message: "and this" }),
          ]),
        ],
      },
    });

    return Effect.gen(function* () {
      yield* legacyWorkersLogs(flags({ follow: true }), followFor(1));

      expect(out.stdoutText.match(/only once/gu)).toHaveLength(1);
      expect(out.stdoutText).toContain("and this");
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(repo.cleanup)));
  });

  it.live("still emits a line that arrived late, inside the grace window", () => {
    const repo = project();
    const { layer, out } = setupLegacyWorkers({
      workdir: repo.dir,
      routes: {
        [LOGS_ROUTE]: [
          logsResponse([workerLogRow({ id: "a", tsMs: T3, message: "newest first" })]),
          // Older than the cursor, which is why the cursor lags at all.
          logsResponse([workerLogRow({ id: "late", tsMs: T1, message: "arrived late" })]),
        ],
      },
    });

    return Effect.gen(function* () {
      yield* legacyWorkersLogs(flags({ follow: true }), followFor(1));

      expect(out.stdoutText).toContain("arrived late");
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(repo.cleanup)));
  });

  it.live("skips history for --tail 0 but still follows", () => {
    const repo = project();
    const { layer, out, http } = setupLegacyWorkers({
      workdir: repo.dir,
      routes: {
        [LOGS_ROUTE]: logsResponse([workerLogRow({ id: "new", tsMs: T2, message: "brand new" })]),
      },
    });

    return Effect.gen(function* () {
      yield* legacyWorkersLogs(flags({ follow: true, tail: 0 }), followFor(1));

      expect(out.stdoutText).toContain("brand new");
      // No history request; every request belongs to the poll loop, and none may
      // ask for `limit 0`, which the endpoint rejects.
      for (const request of http.requests) {
        expect(sentQuery(request).sql).not.toContain("limit 0");
      }
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(repo.cleanup)));
  });

  it.live("emits a log-entry event per line under stream-json", () => {
    const repo = project();
    const { layer, out } = setupLegacyWorkers({
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
      yield* legacyWorkersLogs(flags({ follow: true }), followFor(1));

      const entries = out.events.filter((event) => event.type === "log-entry");
      expect(entries).toHaveLength(2);
      // A tail has no terminal payload, so no single `result` is emitted.
      expect(out.events.filter((event) => event.type === "result")).toHaveLength(0);
      // An error line is routed to stderr so a consumer can split diagnostics.
      expect(entries[0]).toMatchObject({ stream: "stderr", source: "history" });
      expect(entries[1]).toMatchObject({ stream: "stdout", source: "live" });
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(repo.cleanup)));
  });

  it.live("refuses --follow for the single-payload output formats", () => {
    const repo = project();

    return Effect.gen(function* () {
      for (const setup of [
        setupLegacyWorkers({ workdir: repo.dir, goOutput: "json", routes: {} }),
        setupLegacyWorkers({ workdir: repo.dir, format: "json", routes: {} }),
      ]) {
        const error = yield* legacyWorkersLogs(flags({ follow: true })).pipe(
          Effect.flip,
          Effect.provide(setup.layer),
        );

        expect(error).toBeInstanceOf(LegacyWorkersFollowNotSupportedError);
        // Refused before any query is paid for.
        expect(setup.http.requests).toHaveLength(0);
      }
    }).pipe(Effect.ensuring(Effect.sync(repo.cleanup)));
  });

  it.live("exits 130 when interrupted with SIGINT", () => {
    const repo = project();
    const { layer, processControl } = setupLegacyWorkers({
      workdir: repo.dir,
      signal: "SIGINT",
      routes: { [LOGS_ROUTE]: logsResponse([workerLogRow({ id: "a", tsMs: T1 })]) },
    });

    return Effect.gen(function* () {
      // `exit` never returns - in production the process is gone - so the handler
      // cannot be awaited here. Fork it and synchronise on the exit itself, which
      // is the observable condition, rather than on a delay.
      yield* Effect.forkChild(
        legacyWorkersLogs(flags({ follow: true }), {
          pollSchedule: Schedule.forever,
          retrySchedule: Schedule.recurs(0),
        }).pipe(Effect.ignore),
      );

      const code = yield* processControl.awaitExit;

      expect(code).toBe(130);
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(repo.cleanup)));
  });
});
