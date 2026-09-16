import { describe, expect, it } from "@effect/vitest";
import { DateTime } from "effect";
import { validateComputeNameMessage } from "./compute-runtimes.ts";
import {
  ALL_COMPUTE_LOG_STREAMS,
  followWindow,
  logWindow,
  COMPUTE_LOG_POLL_SECONDS,
  COMPUTE_LOG_STREAMS,
  COMPUTE_LOG_WINDOW_MINUTES,
  computeLogsQuery,
} from "./compute-logs.sql.ts";

describe("computeLogsQuery", () => {
  it("filters on log_attributes, never the source column", () => {
    const sql = computeLogsQuery({ name: "api", streams: ALL_COMPUTE_LOG_STREAMS, tail: 100 });

    expect(sql).toContain("log_attributes['worker'] = 'api'");
    expect(sql).toContain("log_attributes['source'] in (");
    expect(sql).not.toMatch(/(?:^|\s)where source =/);
    expect(sql).not.toMatch(/(?:^|\s)and source =/);
  });

  it("constrains to the known streams even when none was requested", () => {
    const sql = computeLogsQuery({ name: "api", streams: ALL_COMPUTE_LOG_STREAMS, tail: 10 });

    expect(sql).toContain("'worker_guest_logs'");
    expect(sql).toContain("'worker_ingress_logs'");
    expect(sql).toContain("'worker_api_logs'");
  });

  it("narrows to a single stream when one was requested", () => {
    const sql = computeLogsQuery({
      name: "api",
      streams: [COMPUTE_LOG_STREAMS.requests],
      tail: 10,
    });

    expect(sql).toContain("in ('worker_ingress_logs')");
    expect(sql).not.toContain("worker_guest_logs");
  });

  it("projects epoch milliseconds rather than a formatted timestamp", () => {
    const sql = computeLogsQuery({ name: "api", streams: ALL_COMPUTE_LOG_STREAMS, tail: 1 });

    expect(sql).toContain("toUnixTimestamp64Milli(timestamp) as ts_ms");
    expect(sql).not.toContain("formatDateTime");
    expect(sql).not.toContain("toString(timestamp)");
  });

  it("orders newest first so limit means the most recent lines", () => {
    const sql = computeLogsQuery({ name: "api", streams: ALL_COMPUTE_LOG_STREAMS, tail: 42 });

    expect(sql).toContain("order by timestamp desc");
    expect(sql).toContain("limit 42");
  });

  it("escapes a quote in the compute name", () => {
    // Unreachable in practice — the handler validates first, see below — so this
    // pins the backstop rather than the guard.
    const sql = computeLogsQuery({ name: "a'b", streams: ALL_COMPUTE_LOG_STREAMS, tail: 1 });

    expect(sql).toContain("log_attributes['worker'] = 'a''b'");
  });
});

describe("compute name validation is the injection guard", () => {
  it.each(["a'--", "a' or '1'='1", 'a"b', "a;drop", "a b"])("rejects %j", (name) => {
    expect(validateComputeNameMessage(name)).toBeDefined();
  });

  it("accepts an ordinary DNS label", () => {
    expect(validateComputeNameMessage("say-hello")).toBeUndefined();
  });
});

describe("logWindow", () => {
  it("always returns both bounds", () => {
    const window = logWindow(DateTime.makeUnsafe("2026-08-31T12:00:00.000Z"));

    expect(window.start).toBeDefined();
    expect(window.end).toBeDefined();
  });

  it("stays under the 24 hour span the server clamps at", () => {
    const now = DateTime.makeUnsafe("2026-08-31T12:00:00.000Z");
    const window = logWindow(now);
    const spanMs =
      DateTime.toEpochMillis(DateTime.makeUnsafe(window.end)) -
      DateTime.toEpochMillis(DateTime.makeUnsafe(window.start));

    expect(spanMs).toBeLessThan(24 * 60 * 60 * 1000);
    expect(COMPUTE_LOG_WINDOW_MINUTES).toBeLessThan(24 * 60);
  });

  it("ends at the given instant", () => {
    const now = DateTime.makeUnsafe("2026-08-31T12:00:00.000Z");

    expect(logWindow(now).end).toBe("2026-08-31T12:00:00.000Z");
  });
});

/**
 * The grace and clamp are written as literals rather than read from the module, so a change
 * to the constant under test doesn't silently keep these green.
 */
describe("followWindow", () => {
  const now = DateTime.makeUnsafe("2026-08-31T12:00:00.000Z");

  it("starts a grace period behind the newest line seen", () => {
    const cursor = DateTime.makeUnsafe("2026-08-31T11:59:30.000Z");
    const window = followWindow(now, cursor);

    expect(window.start).toBe("2026-08-31T11:58:30.000Z");
    expect(DateTime.toEpochMillis(DateTime.makeUnsafe(window.start))).toBe(
      DateTime.toEpochMillis(cursor) - 60_000,
    );
  });

  it("reaches back further than one poll interval, so a line delayed a full cycle still lands", () => {
    const cursor = now;
    const reachMs =
      DateTime.toEpochMillis(cursor) -
      DateTime.toEpochMillis(DateTime.makeUnsafe(followWindow(now, cursor).start));

    expect(reachMs).toBeGreaterThan(COMPUTE_LOG_POLL_SECONDS * 1000);
  });

  it("clamps a cursor left behind by a suspend to the 24 hour span", () => {
    // The case this clamp exists for: a tail left running across a laptop
    // suspend resumes with a cursor days old. Unclamped, the server answers an
    // over-wide request by rewriting `end` to `start + 24h` — returning an older
    // slice rather than a truncated one, so the tail replays yesterday.
    const staleCursor = DateTime.makeUnsafe("2026-08-28T09:00:00.000Z");
    const window = followWindow(now, staleCursor);

    expect(DateTime.toEpochMillis(DateTime.makeUnsafe(window.start))).toBe(
      DateTime.toEpochMillis(now) - COMPUTE_LOG_WINDOW_MINUTES * 60_000,
    );
    expect(
      DateTime.toEpochMillis(DateTime.makeUnsafe(window.end)) -
        DateTime.toEpochMillis(DateTime.makeUnsafe(window.start)),
    ).toBeLessThan(24 * 60 * 60 * 1000);
  });

  it("ends at the given instant, whatever the cursor", () => {
    expect(followWindow(now, DateTime.makeUnsafe("2020-01-01T00:00:00.000Z")).end).toBe(
      "2026-08-31T12:00:00.000Z",
    );
  });
});
