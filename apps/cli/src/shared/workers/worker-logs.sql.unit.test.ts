import { describe, expect, it } from "@effect/vitest";
import { validateWorkerNameMessage } from "./worker-runtimes.ts";
import {
  ALL_WORKER_LOG_STREAMS,
  isoLogTimestamp,
  logWindow,
  WORKER_LOG_STREAMS,
  WORKER_LOG_WINDOW_MINUTES,
  workerLogsQuery,
} from "./worker-logs.sql.ts";

describe("workerLogsQuery", () => {
  it("filters on log_attributes, never the source column", () => {
    const sql = workerLogsQuery({ name: "api", streams: ALL_WORKER_LOG_STREAMS, tail: 100 });

    expect(sql).toContain("log_attributes['worker'] = 'api'");
    expect(sql).toContain("log_attributes['source'] in (");
    // The load-bearing negative: worker rows carry an empty top-level `source`,
    // so a predicate on that column matches nothing at all.
    expect(sql).not.toMatch(/(?:^|\s)where source =/);
    expect(sql).not.toMatch(/(?:^|\s)and source =/);
  });

  it("constrains to the known streams even when none was requested", () => {
    const sql = workerLogsQuery({ name: "api", streams: ALL_WORKER_LOG_STREAMS, tail: 10 });

    // With `source` empty this list is the only thing keeping a non-worker row
    // that happens to carry a `worker` attribute out of the results.
    expect(sql).toContain("'worker_guest_logs'");
    expect(sql).toContain("'worker_ingress_logs'");
    expect(sql).toContain("'worker_api_logs'");
  });

  it("narrows to a single stream when one was requested", () => {
    const sql = workerLogsQuery({
      name: "api",
      streams: [WORKER_LOG_STREAMS.requests],
      tail: 10,
    });

    expect(sql).toContain("in ('worker_ingress_logs')");
    expect(sql).not.toContain("worker_guest_logs");
  });

  it("projects epoch milliseconds rather than a formatted timestamp", () => {
    const sql = workerLogsQuery({ name: "api", streams: ALL_WORKER_LOG_STREAMS, tail: 1 });

    expect(sql).toContain("toUnixTimestamp64Milli(timestamp) as ts_ms");
    // `%M` is ClickHouse's month name, and bare toString has no zone — neither
    // belongs in this query.
    expect(sql).not.toContain("formatDateTime");
    expect(sql).not.toContain("toString(timestamp)");
  });

  it("orders newest first so limit means the most recent lines", () => {
    const sql = workerLogsQuery({ name: "api", streams: ALL_WORKER_LOG_STREAMS, tail: 42 });

    expect(sql).toContain("order by timestamp desc");
    expect(sql).toContain("limit 42");
  });

  it("escapes a quote in the worker name", () => {
    // Unreachable in practice — the handler validates first, see below — so this
    // pins the backstop rather than the guard.
    const sql = workerLogsQuery({ name: "a'b", streams: ALL_WORKER_LOG_STREAMS, tail: 1 });

    expect(sql).toContain("log_attributes['worker'] = 'a''b'");
  });
});

describe("worker name validation is the injection guard", () => {
  it.each(["a'--", "a' or '1'='1", 'a"b', "a;drop", "a b"])("rejects %j", (name) => {
    expect(validateWorkerNameMessage(name)).toBeDefined();
  });

  it("accepts an ordinary DNS label", () => {
    expect(validateWorkerNameMessage("say-hello")).toBeUndefined();
  });
});

describe("logWindow", () => {
  it("always returns both bounds", () => {
    const window = logWindow(new Date("2026-08-31T12:00:00.000Z"));

    // A lone bound yields a one-minute window server-side, and sending neither is
    // an outright error, so there is no valid single-bound call.
    expect(window.start).toBeDefined();
    expect(window.end).toBeDefined();
  });

  it("stays under the 24 hour span the server clamps at", () => {
    const now = new Date("2026-08-31T12:00:00.000Z");
    const window = logWindow(now);
    const spanMs = Date.parse(window.end) - Date.parse(window.start);

    // Being clamped is worse than being rejected: the server rewrites `end` to
    // `start + 24h`, returning an older slice than the one asked for.
    expect(spanMs).toBeLessThan(24 * 60 * 60 * 1000);
    expect(WORKER_LOG_WINDOW_MINUTES).toBeLessThan(24 * 60);
  });

  it("ends at the given instant", () => {
    const now = new Date("2026-08-31T12:00:00.000Z");

    expect(logWindow(now).end).toBe("2026-08-31T12:00:00.000Z");
  });
});

describe("isoLogTimestamp", () => {
  it("emits a Z suffix and no numeric offset", () => {
    // The v1 DTO validates with `z.string().datetime()`, which requires the Z and
    // rejects `+00:00`.
    const formatted = isoLogTimestamp(new Date("2026-08-31T12:00:00.000Z"));

    expect(formatted).toBe("2026-08-31T12:00:00.000Z");
    expect(formatted.endsWith("Z")).toBe(true);
    expect(formatted).not.toContain("+");
  });
});
