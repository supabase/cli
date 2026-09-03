import { describe, expect, it } from "@effect/vitest";
import { validateWorkerNameMessage } from "./worker-runtimes.ts";
import {
  ALL_WORKER_LOG_STREAMS,
  followWindow,
  isoLogTimestamp,
  logWindow,
  WORKER_LOG_POLL_SECONDS,
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

/**
 * The grace and the clamp are written as literals rather than read from the
 * module. Deriving the expectation from the constant under test would keep these
 * green through exactly the change they exist to catch.
 */
describe("followWindow", () => {
  const now = new Date("2026-08-31T12:00:00.000Z");

  it("starts a grace period behind the newest line seen", () => {
    const cursor = Date.parse("2026-08-31T11:59:30.000Z");
    const window = followWindow(now, cursor);

    // Guest lines are relayed late and out of order, so a window starting exactly
    // on the cursor drops every straggler permanently.
    expect(window.start).toBe("2026-08-31T11:58:30.000Z");
    expect(Date.parse(window.start)).toBe(cursor - 60_000);
  });

  it("reaches back further than one poll interval, so a line delayed a full cycle still lands", () => {
    const cursor = now.getTime();
    const reachMs = cursor - Date.parse(followWindow(now, cursor).start);

    expect(reachMs).toBeGreaterThan(WORKER_LOG_POLL_SECONDS * 1000);
  });

  it("clamps a cursor left behind by a suspend to the 24 hour span", () => {
    // The case this clamp exists for: a tail left running across a laptop
    // suspend resumes with a cursor days old. Unclamped, the server answers an
    // over-wide request by rewriting `end` to `start + 24h` — returning an older
    // slice rather than a truncated one, so the tail replays yesterday.
    const staleCursor = Date.parse("2026-08-28T09:00:00.000Z");
    const window = followWindow(now, staleCursor);

    expect(Date.parse(window.start)).toBe(now.getTime() - WORKER_LOG_WINDOW_MINUTES * 60_000);
    expect(Date.parse(window.end) - Date.parse(window.start)).toBeLessThan(24 * 60 * 60 * 1000);
  });

  it("ends at the given instant, whatever the cursor", () => {
    expect(followWindow(now, Date.parse("2020-01-01T00:00:00.000Z")).end).toBe(
      "2026-08-31T12:00:00.000Z",
    );
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
