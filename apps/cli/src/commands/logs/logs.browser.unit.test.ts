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
  type LogsBrowserWindow,
} from "./logs.browser.format.ts";

beforeEach(() => {
  for (const variable of ["NO_COLOR", "CLICOLOR", "CLICOLOR_FORCE", "CI"]) vi.stubEnv(variable, "");
});
afterEach(() => {
  vi.unstubAllEnvs();
});

const requestCases: ReadonlyArray<{
  readonly window: LogsBrowserWindow | undefined;
  readonly label: string;
}> = [
  {
    window: { kind: "range", start: "2026-11-03T17:13:35Z", end: "2026-11-03T17:14:55Z" },
    label: "Window: Nov 03 17:13:35–17:14:55 UTC",
  },
  {
    window: { kind: "range", start: "2026-11-03T23:59:59Z", end: "2026-11-04T00:00:01Z" },
    label: "Window: Nov 03 23:59:59–Nov 04 00:00:01 UTC",
  },
  {
    window: { kind: "range", start: "2026-12-31T23:59:59Z", end: "2027-01-01T00:00:01Z" },
    label: "Window: Dec 31 2026 23:59:59–Jan 01 2027 00:00:01 UTC",
  },
  {
    window: { kind: "since", start: "2026-11-03T11:00:00Z", live: false },
    label: "Window: since Nov 03 2026 11:00:00 UTC",
  },
  {
    window: { kind: "since", start: "2026-11-03T11:00:00Z", live: true },
    label: "Window: since Nov 03 2026 11:00:00 UTC → now (live)",
  },
  { window: { kind: "launch", live: false }, label: "Window: since each service's latest launch" },
  {
    window: { kind: "launch", live: true, newEntriesOnly: true },
    label: "Window: new entries only; since each service's latest launch → now (live)",
  },
  { window: { kind: "all", live: false }, label: "Window: all retained history" },
  { window: undefined, label: "Window: resolving…" },
];

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

  it.each(requestCases)(
    "shows resolved request metadata regardless of row timestamps: $label",
    ({ window, label }) => {
      let state = { ...initialBrowserState, window };
      state = appendBrowserRow(state, { count: 8 }, "query");
      state = appendBrowserRow(state, { timestamp: "invalid" }, "query");
      state = appendBrowserRow(state, { ts_ms: 0 }, "query");
      for (const columns of [80, 120]) {
        const lines = renderBrowser(state, columns, 8).split("\r\n");
        expect(lines[0]).toContain("3 retained");
        expect(lines[1]).toBe(label);
        expect(lines).toHaveLength(8);
        expect(lines.every((line) => stringWidth(line) < columns)).toBe(true);
      }
    },
  );

  it("preserves the requested window through scrolling, resize, and details", () => {
    let state = resizeBrowser(
      {
        ...initialBrowserState,
        window: { kind: "range", start: "2026-11-03T10:00:00Z", end: "2026-11-03T12:00:00Z" },
      },
      8,
    );
    for (let index = 0; index < 15; index++)
      state = appendBrowserRow(
        state,
        { ts_ms: 1762190100000 - index * 1000, message: `range-${index}` },
        "query",
      );
    const first = renderBrowser(state, 80, 8).split("\r\n");
    expect(first[1]).toBe("Window: Nov 03 10:00:00–12:00:00 UTC");
    expect(first.slice(2, 7).map((line) => line.match(/range-\d+/u)?.[0])).toEqual([
      "range-0",
      "range-1",
      "range-2",
      "range-3",
      "range-4",
    ]);
    for (let index = 0; index < 5; index++) state = browserKey(state, "down", 79, 8);
    expect(renderBrowser(state, 80, 8).split("\r\n")[2]).toContain("range-1");
    state = browserKey(state, "up", 79, 8);
    expect(
      renderBrowser(state, 80, 8)
        .split("\r\n")
        .slice(2, 7)
        .map((line) => line.match(/range-\d+/u)?.[0]),
    ).toEqual(["range-1", "range-2", "range-3", "range-4", "range-5"]);
    state = browserKey(state, "return", 79, 8);
    const details = renderBrowser(state, 120, 6).split("\r\n");
    expect(details[0]).toBe("Log details");
    expect(details[1]).toBe(first[1]);
    expect(details).toHaveLength(6);
    expect(details[5]).toContain("Esc back");
    state = resizeBrowser(state, 6);
    state = browserKey(state, "escape", 119, 6);
    expect(renderBrowser(state, 120, 6).split("\r\n")[1]).toBe(first[1]);
    expect(renderBrowser(state, 120, 6).split("\r\n")[4]).toContain(
      "> Nov 03 - 17:14:56 UTC — range-4",
    );
  });

  it("keeps the requested live start fixed when retention evicts rows", () => {
    let state: typeof initialBrowserState = {
      ...initialBrowserState,
      window: { kind: "since", start: "2026-11-03T11:00:00Z", live: true },
    };
    for (let index = 0; index < 1000; index++)
      state = appendBrowserRow(state, { ts_ms: index * 1000 });
    const expected = "Window: since Nov 03 2026 11:00:00 UTC → now (live)";
    expect(renderBrowser(state, 80, 8).split("\r\n")[1]).toBe(expected);
    state = appendBrowserRow(state, { ts_ms: 1000000 });
    expect(state.dropped).toBe(1);
    expect(renderBrowser(state, 80, 8).split("\r\n")[1]).toBe(expected);
  });

  it("keeps the window and controls visible when only headers and footer fit", () => {
    const state: typeof initialBrowserState = {
      ...appendBrowserRow(initialBrowserState, { ts_ms: 0 }),
      window: { kind: "range", start: "2026-11-03T10:00:00Z", end: "2026-11-03T12:00:00Z" },
    };
    const lines = renderBrowser(state, 80, 3).split("\r\n");
    expect(lines).toHaveLength(3);
    expect(lines[1]).toBe("Window: Nov 03 10:00:00–12:00:00 UTC");
    expect(lines[2]).toContain("C copy · q quit");
  });

  it("keeps visible rows stationary while selection moves inside a multi-screen list", () => {
    let state = initialBrowserState;
    for (let index = 0; index < 20; index++)
      state = appendBrowserRow(state, { message: `visible-${index}` }, "query");
    const visible = () =>
      renderBrowser(state, 80, 9)
        .split("\r\n")
        .slice(2, 8)
        .map((line) => line.slice(line.indexOf("visible-")).trimEnd());
    expect(visible()).toEqual([
      "visible-0",
      "visible-1",
      "visible-2",
      "visible-3",
      "visible-4",
      "visible-5",
    ]);
    for (let index = 0; index < 6; index++) state = browserKey(state, "down", 79, 9);
    expect(visible()).toEqual([
      "visible-1",
      "visible-2",
      "visible-3",
      "visible-4",
      "visible-5",
      "visible-6",
    ]);
    state = browserKey(state, "up", 79, 9);
    expect(visible()).toEqual([
      "visible-1",
      "visible-2",
      "visible-3",
      "visible-4",
      "visible-5",
      "visible-6",
    ]);
    for (let index = 0; index < 4; index++) state = browserKey(state, "up", 79, 9);
    expect(visible()).toEqual([
      "visible-1",
      "visible-2",
      "visible-3",
      "visible-4",
      "visible-5",
      "visible-6",
    ]);
    state = browserKey(state, "up", 79, 9);
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
    let state = resizeBrowser(initialBrowserState, 9);
    for (let index = 0; index < 20; index++)
      state = appendBrowserRow(state, { message: `row-${index}` }, "query");
    for (let index = 0; index < 8; index++) state = browserKey(state, "down", 79, 9);
    expect(state.viewport).toBe(3);
    state = browserKey(state, "return", 79, 9);
    state = resizeBrowser(state, 13);
    state = browserKey(state, "escape", 79, 13);
    expect(state.viewport).toBe(3);
    expect(state.selected).toBe(8);
    expect(renderBrowser(state, 80, 13).split("\r\n")[2]).toContain("row-3");
    state = resizeBrowser(state, 7);
    expect(state.viewport).toBe(5);
    expect(renderBrowser(state, 80, 7).split("\r\n")[5]).toContain("> — — row-8");
    state = resizeBrowser(state, 13);
    expect(state.viewport).toBe(5);
  });

  it("keeps the visible live window stable across eviction while browsing older rows", () => {
    let state = resizeBrowser(initialBrowserState, 9);
    for (let index = 0; index < 1000; index++)
      state = appendBrowserRow(state, { message: `live-${index}` });
    expect(state.selected).toBe(999);
    expect(state.viewport).toBe(994);
    for (let index = 0; index < 3; index++) state = browserKey(state, "up", 79, 9);
    const before = state.rows.slice(state.viewport, state.viewport + 6);
    state = appendBrowserRow(state, { message: "newest" });
    expect(state.rows.slice(state.viewport, state.viewport + 6)).toEqual(before);
    expect(state.rows[state.selected]).toEqual({ message: "live-996" });
    state = browserKey(state, "return", 79, 9);
    state = appendBrowserRow(state, { message: "later" });
    state = browserKey(state, "escape", 79, 9);
    expect(state.rows.slice(state.viewport, state.viewport + 6)).toEqual(before);
    expect(state.rows[state.selected]).toEqual({ message: "live-996" });
  });

  it("highlights the full selected row and dims only unselected timestamps after safe clipping", () => {
    let state = resizeBrowser(initialBrowserState, 9);
    const first = {
      timestamp: "2026-11-03T16:51:32Z",
      service: "postgres",
      message: "你好\u001b[31m selected",
    };
    state = appendBrowserRow(state, first, "query");
    state = appendBrowserRow(state, { ...first, message: "normal message" }, "query");
    const lines = renderBrowser(state, 61, 9, { hasColors: () => true }).split("\r\n");
    const selected = lines[2] ?? "";
    const ordinary = lines[3] ?? "";
    expect(selected.startsWith("\u001b[7m>")).toBe(true);
    expect(selected.endsWith("\u001b[27m")).toBe(true);
    expect(selected).not.toContain("\u001b[2m");
    expect(selected).not.toContain("\u001b[31m");
    expect(stringWidth(stripControlSequences(selected))).toBe(60);
    expect(ordinary).toContain("\u001b[2mNov 03 - 16:51:32 UTC\u001b[22m postgres normal message");
    expect(lines.every((line) => stringWidth(stripControlSequences(line)) <= 60)).toBe(true);
    vi.stubEnv("NO_COLOR", "1");
    const monochrome = renderBrowser(state, 61, 9, { hasColors: () => true });
    expect(monochrome).not.toContain("\u001b");
    expect(monochrome.split("\r\n")[2]).toContain("> Nov 03 - 16:51:32 UTC postgres 你好 selected");
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
    expect(renderBrowser(state, 80, 9)).toContain("oversized record");
  });

  it("sanitizes untrusted summaries and wraps full detail data for scrolling", () => {
    const row = {
      service: "postgres",
      event_message: "unsafe\u001b[2J\u001b]0;title\u0007 safe",
      nested: { text: "last detail line".repeat(40) },
    };
    let state = appendBrowserRow(initialBrowserState, row);
    const summary = renderBrowser(state, 65, 9);
    expect(summary).toContain("unsafe safe");
    expect(summary).not.toContain("\u001b");
    expect(summary.split("\r\n")).toHaveLength(9);
    expect(summary.split("\r\n").every((line) => line.length <= 64)).toBe(true);
    state = browserKey(state, "return", 64, 9);
    for (let index = 0; index < 100; index++) state = browserKey(state, "down", 64, 9);
    expect(renderBrowser(state, 65, 9)).toContain("last detail line");
    expect(state.scroll).toBeGreaterThan(0);
  });
});
