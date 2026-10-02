import { DateTime } from "effect";
import { describe, expect, it } from "vitest";
import type { StackLogRecord } from "@supabase/stack/effect";
import { makeHistoryCollector, parseSince } from "./logs.format.ts";

const now = Date.parse("2026-09-29T12:00:00.000Z");

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
    launchId = 1,
  ): StackLogRecord => ({
    kind,
    timestamp: DateTime.formatIso(DateTime.makeUnsafe(now + offset)),
    launchId,
    text,
    service: "auth",
    instanceId,
    position: { generation: 1, byteOffset: offset },
  });
  const textsOf = (records: ReadonlyArray<StackLogRecord>) =>
    records.filter(({ kind }) => kind !== "launch").map(({ text }) => text);

  it("keeps the newest lines across instances, counts every line, and tracks positions", () => {
    const collector = makeHistoryCollector(2, undefined);
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
    const collector = makeHistoryCollector(1, undefined);
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

  it("starts each instance at its highest launch and keeps instances without one", () => {
    const collector = makeHistoryCollector(10, new Map());
    collector.push(at("a", 0, "launch", "", 1));
    collector.push(at("a", 1, "stdout", "a old", 1));
    collector.push(at("a", 5, "launch", "", 2));
    collector.push(at("a", 3, "stderr", "a late old", 1));
    collector.push(at("a", 6, "stdout", "a new", 2));
    collector.push(at("b", 2, "stdout", "b retained"));

    const { window } = collector.finish();

    expect(textsOf(window.records)).toEqual(["b retained", "a new"]);
    expect(window.total).toBe(2);
  });

  it("keeps the highest launch when an older launch's first output arrives after it", () => {
    const collector = makeHistoryCollector(10, new Map());
    collector.push(at("a", 10, "launch", "", 2));
    collector.push(at("a", 11, "stdout", "second launch", 2));
    collector.push(at("a", 20, "launch", "", 1));
    collector.push(at("a", 21, "stdout", "delayed first launch", 1));
    collector.push(at("a", 30, "stdout", "second launch again", 2));

    const { window } = collector.finish();

    expect(textsOf(window.records)).toEqual(["second launch", "second launch again"]);
    expect(window.records.filter(({ kind }) => kind === "launch")).toHaveLength(1);
  });

  it("starts at the launch of the latest owner run, whose ids continue the earlier run's", () => {
    const collector = makeHistoryCollector(10, new Map());
    collector.push({ ...at("a", 0, "launch", "", 3), position: { generation: 1, byteOffset: 0 } });
    collector.push({
      ...at("a", 1, "stdout", "earlier run", 3),
      position: { generation: 1, byteOffset: 40 },
    });
    collector.push({ ...at("a", 50, "launch", "", 4), position: { generation: 2, byteOffset: 0 } });
    collector.push({
      ...at("a", 51, "stdout", "restarted run", 4),
      position: { generation: 2, byteOffset: 40 },
    });

    const { window } = collector.finish();

    expect(textsOf(window.records)).toEqual(["restarted run"]);
  });
});
