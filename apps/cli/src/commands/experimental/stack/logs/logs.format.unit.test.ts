import { DateTime } from "effect";
import { describe, expect, it } from "vitest";
import type { StackLogRecord } from "@supabase/stack/effect";
import { makeHistoryCollector, parseSince, tailWindow } from "./logs.format.ts";

const now = Date.parse("2026-09-29T12:00:00.000Z");
const record = (kind: StackLogRecord["kind"], text: string): StackLogRecord => ({
  kind,
  timestamp: "2026-09-29T10:00:00.000Z",
  text,
  service: "auth",
  instanceId: "auth-a",
});

describe("parseSince", () => {
  it("subtracts compound durations from now", () => {
    expect(parseSince("1h30m", now)).toEqual({ kind: "time", iso: "2026-09-29T10:30:00.000Z" });
    expect(parseSince("2d", now)).toEqual({ kind: "time", iso: "2026-09-27T12:00:00.000Z" });
    expect(parseSince("1.5s", now)).toEqual({ kind: "time", iso: "2026-09-29T11:59:58.500Z" });
  });

  it("accepts ISO-8601 times and start, and rejects bare numbers and words", () => {
    expect(parseSince("2026-09-29T11:00:00+02:00", now)).toEqual({
      kind: "time",
      iso: "2026-09-29T09:00:00.000Z",
    });
    expect(parseSince("start", now)).toEqual({ kind: "start" });
    expect(parseSince("10", now)).toBeUndefined();
    expect(parseSince("soon", now)).toBeUndefined();
  });

  it("rejects durations reaching past the representable time range", () => {
    expect(parseSince("99999999999d", now)).toBeUndefined();
    expect(parseSince(`${"9".repeat(400)}s`, now)).toBeUndefined();
  });
});

describe("makeHistoryCollector", () => {
  const at = (
    instanceId: string,
    offset: number,
    kind: StackLogRecord["kind"],
    text = "",
  ): StackLogRecord => ({
    kind,
    timestamp: DateTime.formatIso(DateTime.makeUnsafe(now + offset)),
    text,
    service: "auth",
    instanceId,
    position: { generation: 1, byteOffset: offset },
  });

  it("keeps the newest lines across instances, counts every line, and tracks positions", () => {
    const collector = makeHistoryCollector(2, false);
    for (let offset = 0; offset < 1_000; offset += 2) {
      collector.push(at("a", offset, "stdout", `a ${offset}`));
      collector.push(at("b", offset + 1, "stdout", `b ${offset + 1}`));
    }

    const { window, positions } = collector.finish();

    expect(window.records.map(({ text }) => text)).toEqual(["a 998", "b 999"]);
    expect(window).toMatchObject({ shown: 2, total: 1_000 });
    expect(positions.get("a")).toEqual({ generation: 1, byteOffset: 998 });
  });

  it("keeps the newest line by time when an older partial line is flushed after it", () => {
    const collector = makeHistoryCollector(1, false);
    collector.push({
      ...at("a", 10, "stdout", "newer"),
      position: { generation: 1, byteOffset: 0 },
    });
    collector.push({
      ...at("a", 5, "stderr", "late older"),
      position: { generation: 1, byteOffset: 40 },
    });

    const { window, positions } = collector.finish();

    expect(window.records.map(({ text }) => text)).toEqual(["newer"]);
    expect(window).toMatchObject({ shown: 1, total: 2 });
    expect(positions.get("a")).toEqual({ generation: 1, byteOffset: 40 });
  });

  it("starts each instance at its latest launch and keeps instances without one", () => {
    const collector = makeHistoryCollector(10, true);
    collector.push(at("a", 0, "launch"));
    collector.push(at("a", 1, "stdout", "a old"));
    collector.push(at("a", 5, "launch"));
    collector.push(at("a", 3, "stderr", "a late old"));
    collector.push(at("a", 6, "stdout", "a new"));
    collector.push(at("b", 2, "stdout", "b retained"));

    const { window } = collector.finish();

    expect(window.records.filter(({ kind }) => kind !== "launch").map(({ text }) => text)).toEqual([
      "b retained",
      "a new",
    ]);
    expect(window.total).toBe(2);
  });
});

describe("tailWindow", () => {
  it("counts only output lines and keeps the markers between the shown lines", () => {
    const records = [
      record("launch", ""),
      record("stdout", "one"),
      record("launch", ""),
      record("stderr", "two"),
      record("lost", ""),
      record("stdout", "three"),
    ];

    const window = tailWindow(records, 2);

    expect(window.records.map(({ kind }) => kind)).toEqual(["stderr", "lost", "stdout"]);
    expect(window).toMatchObject({ shown: 2, total: 3 });
    expect(tailWindow(records, 0)).toEqual({ records: [], shown: 0, total: 3 });
    expect(tailWindow(records, 5).records).toBe(records);
  });
});
