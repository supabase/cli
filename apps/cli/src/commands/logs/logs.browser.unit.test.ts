import { describe, expect, it } from "@effect/vitest";
import {
  appendBrowserRow,
  browserKey,
  browserTimestamp,
  initialBrowserState,
  renderBrowser,
} from "./logs.browser.format.ts";

describe("log browser formatting", () => {
  it.each([
    [{ ts_ms: 0 }, "1970-01-01 00:00:00.000 UTC"],
    [{ timestamp: "2026-11-02 12:34:56.123" }, "2026-11-02 12:34:56.123 UTC"],
    [{ timestamp: "2026-11-02T14:34:56.123+02:00" }, "2026-11-02 12:34:56.123 UTC"],
    [{ timestamp: "garbage" }, "—"],
    [{ timestamp: 123 }, "—"],
    [{ ts_ms: 8640000000000001 }, "—"],
    [{ count: 3 }, "—"],
  ])("formats only known timestamp representations: %j", (row, expected) => {
    expect(browserTimestamp(row)).toBe(expected);
  });

  it("preserves query order and starts at the first row", () => {
    let state = appendBrowserRow(initialBrowserState, { count: 7 }, "query");
    state = appendBrowserRow(state, { count: 8 }, "query");
    expect(state.rows).toEqual([{ count: 7 }, { count: 8 }]);
    for (let index = 0; index < 1001; index++)
      state = appendBrowserRow(state, { count: index }, "query");
    expect(state.rows).toHaveLength(1003);
    expect(state.rows[0]).toEqual({ count: 7 });
    expect(state.selected).toBe(0);
  });

  it("keeps older selection and open details stable as retained rows are evicted", () => {
    let state = initialBrowserState;
    for (let index = 0; index < 1000; index++)
      state = appendBrowserRow(state, { message: `row-${index}` });
    expect(state.selected).toBe(999);
    state = browserKey(state, "up", 80, 24);
    state = appendBrowserRow(state, { message: "newest" });
    expect(state.rows[state.selected]).toEqual({ message: "row-998" });
    state = browserKey(state, "return", 80, 24);
    for (let index = 0; index < 1000; index++)
      state = appendBrowserRow(state, { message: `later-${index}` });
    expect(state.rows).toHaveLength(1000);
    expect(state.detail).toEqual({ message: "row-998" });
    expect(renderBrowser(state, 80, 24)).toContain("row-998");
    state = browserKey(state, "escape", 80, 24);
    expect(renderBrowser(state, 80, 24)).toContain("older rows discarded");
  });

  it("bounds retained payload bytes while keeping an oversized record complete", () => {
    const text = "x".repeat(5 * 1024 * 1024);
    let state = appendBrowserRow(initialBrowserState, { text });
    state = appendBrowserRow(state, { text: "newer" });
    expect(state.rows).toEqual([{ text: "newer" }]);
    expect(state.dropped).toBe(1);
    state = appendBrowserRow(state, { text });
    expect(state.rows).toEqual([{ text }]);
    expect(renderBrowser(state, 80, 8)).toContain("oversized record");
  });

  it("sanitizes untrusted summaries and wraps full detail data for scrolling", () => {
    const row = {
      service: "postgres",
      event_message: "unsafe\u001b[2J\u001b]0;title\u0007 safe",
      nested: { text: "last detail line".repeat(40) },
    };
    let state = appendBrowserRow(initialBrowserState, row);
    const summary = renderBrowser(state, 65, 8);
    expect(summary).toContain("unsafe safe");
    expect(summary).not.toContain("\u001b");
    expect(summary.split("\r\n")).toHaveLength(8);
    expect(summary.split("\r\n").every((line) => line.length <= 64)).toBe(true);
    state = browserKey(state, "return", 64, 8);
    for (let index = 0; index < 100; index++) state = browserKey(state, "down", 64, 8);
    expect(renderBrowser(state, 65, 8)).toContain("last detail line");
    expect(state.scroll).toBeGreaterThan(0);
  });
});
