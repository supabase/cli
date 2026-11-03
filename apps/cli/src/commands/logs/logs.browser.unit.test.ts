import { beforeEach, afterEach, vi } from "vitest";
import { stripControlSequences } from "../../shared/output/strip-control-sequences.ts";
import { stringWidth } from "../../command-internal/string-width.ts";
import { describe, expect, it } from "@effect/vitest";
import {
  appendBrowserRow,
  browserKey,
  browserTimestamp,
  initialBrowserState,
  renderBrowser,
  resizeBrowser,
} from "./logs.browser.format.ts";

beforeEach(() => {
  for (const variable of ["NO_COLOR", "CLICOLOR", "CLICOLOR_FORCE", "CI"]) vi.stubEnv(variable, "");
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe("log browser formatting", () => {
  it.each([
    [{ ts_ms: 0 }, "Jan 01 - 00:00:00 UTC"],
    [{ timestamp: "2026-11-02 12:34:56.123" }, "Nov 02 - 12:34:56 UTC"],
    [{ timestamp: "2026-11-02T14:34:56.123+02:00" }, "Nov 02 - 12:34:56 UTC"],
    [{ timestamp: "2026-11-03T16:51:32Z" }, "Nov 03 - 16:51:32 UTC"],
    [{ timestamp: "2026-01-01T00:15:30+01:00" }, "Dec 31 - 23:15:30 UTC"],
    [{ timestamp: "2026-10-31T23:59:59-01:00" }, "Nov 01 - 00:59:59 UTC"],
    [{ timestamp: "garbage" }, "—"],
    [{ timestamp: 123 }, "—"],
    [{ ts_ms: 8640000000000001 }, "—"],
    [{ count: 3 }, "—"],
  ])("formats only known timestamp representations: %j", (row, expected) => {
    expect(browserTimestamp(row)).toBe(expected);
  });

  it("keeps visible rows stationary while selection moves inside a multi-screen list", () => {
    let state = initialBrowserState;
    for (let index = 0; index < 20; index++)
      state = appendBrowserRow(state, { message: `visible-${index}` }, "query");
    const visible = () =>
      renderBrowser(state, 80, 8)
        .split("\r\n")
        .slice(1, 7)
        .map((line) => line.slice(line.indexOf("visible-")).trimEnd());
    expect(visible()).toEqual([
      "visible-0",
      "visible-1",
      "visible-2",
      "visible-3",
      "visible-4",
      "visible-5",
    ]);
    for (let index = 0; index < 6; index++) state = browserKey(state, "down", 79, 8);
    expect(visible()).toEqual([
      "visible-1",
      "visible-2",
      "visible-3",
      "visible-4",
      "visible-5",
      "visible-6",
    ]);
    state = browserKey(state, "up", 79, 8);
    expect(visible()).toEqual([
      "visible-1",
      "visible-2",
      "visible-3",
      "visible-4",
      "visible-5",
      "visible-6",
    ]);
    for (let index = 0; index < 4; index++) state = browserKey(state, "up", 79, 8);
    expect(visible()).toEqual([
      "visible-1",
      "visible-2",
      "visible-3",
      "visible-4",
      "visible-5",
      "visible-6",
    ]);
    state = browserKey(state, "up", 79, 8);
    expect(visible()).toEqual([
      "visible-0",
      "visible-1",
      "visible-2",
      "visible-3",
      "visible-4",
      "visible-5",
    ]);
  });

  it("preserves the viewport through details and adjusts only enough for resize", () => {
    let state = resizeBrowser(initialBrowserState, 8);
    for (let index = 0; index < 20; index++)
      state = appendBrowserRow(state, { message: `row-${index}` }, "query");
    for (let index = 0; index < 8; index++) state = browserKey(state, "down", 79, 8);
    expect(state.viewport).toBe(3);
    state = browserKey(state, "return", 79, 8);
    state = resizeBrowser(state, 12);
    state = browserKey(state, "escape", 79, 12);
    expect(state.viewport).toBe(3);
    expect(state.selected).toBe(8);
    expect(renderBrowser(state, 80, 12).split("\r\n")[1]).toContain("row-3");
    state = resizeBrowser(state, 6);
    expect(state.viewport).toBe(5);
    expect(renderBrowser(state, 80, 6).split("\r\n")[4]).toContain("> — — row-8");
    state = resizeBrowser(state, 12);
    expect(state.viewport).toBe(5);
  });

  it("keeps the visible live window stable across eviction while browsing older rows", () => {
    let state = resizeBrowser(initialBrowserState, 8);
    for (let index = 0; index < 1000; index++)
      state = appendBrowserRow(state, { message: `live-${index}` });
    expect(state.selected).toBe(999);
    expect(state.viewport).toBe(994);
    for (let index = 0; index < 3; index++) state = browserKey(state, "up", 79, 8);
    const before = state.rows.slice(state.viewport, state.viewport + 6);
    state = appendBrowserRow(state, { message: "newest" });
    expect(state.rows.slice(state.viewport, state.viewport + 6)).toEqual(before);
    expect(state.rows[state.selected]).toEqual({ message: "live-996" });
    state = browserKey(state, "return", 79, 8);
    state = appendBrowserRow(state, { message: "later" });
    state = browserKey(state, "escape", 79, 8);
    expect(state.rows.slice(state.viewport, state.viewport + 6)).toEqual(before);
    expect(state.rows[state.selected]).toEqual({ message: "live-996" });
  });

  it("highlights the full selected row and dims only unselected timestamps after safe clipping", () => {
    let state = resizeBrowser(initialBrowserState, 8);
    const first = {
      timestamp: "2026-11-03T16:51:32Z",
      service: "postgres",
      message: "你好\u001b[31m selected",
    };
    state = appendBrowserRow(state, first, "query");
    state = appendBrowserRow(state, { ...first, message: "normal message" }, "query");
    const lines = renderBrowser(state, 61, 8, { hasColors: () => true }).split("\r\n");
    const selected = lines[1] ?? "";
    const ordinary = lines[2] ?? "";
    expect(selected.startsWith("\u001b[7m>")).toBe(true);
    expect(selected.endsWith("\u001b[27m")).toBe(true);
    expect(selected).not.toContain("\u001b[2m");
    expect(selected).not.toContain("\u001b[31m");
    expect(stringWidth(stripControlSequences(selected))).toBe(60);
    expect(ordinary).toContain("\u001b[2mNov 03 - 16:51:32 UTC\u001b[22m postgres normal message");
    expect(lines.every((line) => stringWidth(stripControlSequences(line)) <= 60)).toBe(true);
    vi.stubEnv("NO_COLOR", "1");
    const monochrome = renderBrowser(state, 61, 8, { hasColors: () => true });
    expect(monochrome).not.toContain("\u001b");
    expect(monochrome.split("\r\n")[1]).toContain("> Nov 03 - 16:51:32 UTC postgres 你好 selected");
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
