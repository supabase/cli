import { wrapTerminalText as wrapLogsText } from "../../shared/output/wrap-terminal-text.ts";
import { dim, inverse, type ColorStream } from "../../command-internal/colors.ts";
import { DateTime, type Schema } from "effect";
import { stripControlSequences } from "../../shared/output/strip-control-sequences.ts";
import { stringWidth } from "../../command-internal/string-width.ts";
import { renderLogsRows } from "./logs.display.ts";

const browserHeaderRows = (state: BrowserState) =>
  state.context === undefined && state.filters === undefined ? 2 : 4;
const browserReservedRows = (state: BrowserState) => browserHeaderRows(state) + 1;

export type LogsBrowserWindow =
  | {
      readonly kind: "range";
      readonly start: string;
      readonly end: string;
      readonly pending?: boolean;
    }
  | { readonly kind: "launch"; readonly end: string };

export interface BrowserState {
  readonly context?: string;
  readonly filters?: string;
  readonly window: LogsBrowserWindow | undefined;
  readonly rows: ReadonlyArray<Schema.JsonObject>;
  readonly sizes: ReadonlyArray<number>;
  readonly bytes: number;
  readonly viewport: number;
  readonly visibleRows: number;
  readonly selected: number;
  readonly detail: Schema.JsonObject | undefined;
  readonly scroll: number;
  readonly dropped: number;
  readonly complete: boolean;
  readonly notice: string;
  readonly error: { readonly message: string; readonly scroll: number } | undefined;
}

export const initialBrowserState: BrowserState = {
  window: undefined,
  rows: [],
  sizes: [],
  bytes: 0,
  viewport: 0,
  visibleRows: 21,
  selected: 0,
  detail: undefined,
  scroll: 0,
  dropped: 0,
  complete: false,
  notice: "",
  error: undefined,
};

export function resizeBrowser(state: BrowserState, height: number): BrowserState {
  const visibleRows = Math.max(1, Math.floor(height) - browserReservedRows(state));
  const lastStart = Math.max(0, state.rows.length - visibleRows);
  let viewport = Math.min(state.viewport, lastStart);
  if (state.selected < viewport) viewport = state.selected;
  else if (state.selected >= viewport + visibleRows) viewport = state.selected - visibleRows + 1;
  return { ...state, viewport: Math.max(0, viewport), visibleRows };
}

function insertBrowserRow(
  state: BrowserState,
  row: Schema.JsonObject,
  mode: "query" | "bounded",
  index: number,
): BrowserState {
  const size = JSON.stringify(row).length * 2;
  const sizes = [...state.sizes.slice(0, index), size, ...state.sizes.slice(index)];
  const inserted = [...state.rows.slice(0, index), row, ...state.rows.slice(index)];
  let bytes = state.bytes + size;
  let dropped = 0;
  while (
    mode !== "query" &&
    sizes.length - dropped > 1 &&
    (sizes.length - dropped > 1000 || bytes > 8 * 1024 * 1024)
  ) {
    bytes -= sizes[dropped] ?? 0;
    dropped++;
  }
  const rows = inserted.slice(dropped);
  return resizeBrowser(
    {
      ...state,
      rows,
      viewport: Math.max(0, state.viewport - dropped),
      sizes: sizes.slice(dropped),
      bytes,
      dropped: state.dropped + dropped,
      selected: Math.max(0, state.selected - dropped),
    },
    state.visibleRows + browserReservedRows(state),
  );
}

export function appendBrowserRow(state: BrowserState, row: Schema.JsonObject): BrowserState {
  return insertBrowserRow(state, row, "query", state.rows.length);
}

export function stageBrowserRow(state: BrowserState, row: Schema.JsonObject): BrowserState {
  const time = timestampMillis(row) ?? -Infinity;
  const identity = String(row["id"] ?? row["instanceId"] ?? "");
  let low = 0;
  let high = state.rows.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    const candidate = state.rows[middle];
    if (candidate === undefined) break;
    const otherTime = timestampMillis(candidate) ?? -Infinity;
    const otherIdentity = String(candidate["id"] ?? candidate["instanceId"] ?? "");
    if (otherTime < time || (otherTime === time && otherIdentity <= identity)) low = middle + 1;
    else high = middle;
  }
  return insertBrowserRow(state, row, "bounded", low);
}

function timestampMillis(row: Schema.JsonObject): number | undefined {
  const millis = row["ts_ms"];
  const timestamp = row["timestamp"];
  const time =
    typeof millis === "number"
      ? millis
      : typeof timestamp === "string" &&
          /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?$/u.test(
            timestamp,
          )
        ? Date.parse(
            /[zZ]|[+-]\d{2}:?\d{2}$/u.test(timestamp)
              ? timestamp
              : `${timestamp.replace(" ", "T")}Z`,
          )
        : Number.NaN;
  return Number.isFinite(time) && Math.abs(time) <= 8_640_000_000_000_000 ? time : undefined;
}

const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const pad = (value: number) => String(value).padStart(2, "0");

function dateLabel(time: number, includeYear = false): string {
  const parts = DateTime.toPartsUtc(DateTime.makeUnsafe(time));
  return `${months[parts.month - 1]} ${pad(parts.day)}${includeYear ? ` ${parts.year}` : ""}`;
}

function timeLabel(time: number): string {
  const parts = DateTime.toPartsUtc(DateTime.makeUnsafe(time));
  return `${pad(parts.hour)}:${pad(parts.minute)}:${pad(parts.second)}`;
}

export function browserTimestamp(row: Schema.JsonObject): string {
  const time = timestampMillis(row);
  return time === undefined ? "—" : `${dateLabel(time)} - ${timeLabel(time)} UTC`;
}

function requestedWindow(window: LogsBrowserWindow | undefined): string {
  if (window === undefined) return "Window: resolving…";
  if (window.kind === "range") {
    const start = Date.parse(window.start);
    const end = Date.parse(window.end);
    const first = DateTime.toPartsUtc(DateTime.makeUnsafe(start));
    const last = DateTime.toPartsUtc(DateTime.makeUnsafe(end));
    const crossYear = first.year !== last.year;
    const sameDay = !crossYear && first.month === last.month && first.day === last.day;
    const from = `${dateLabel(start, crossYear)} ${timeLabel(start)}`;
    const to = sameDay ? timeLabel(end) : `${dateLabel(end, crossYear)} ${timeLabel(end)}`;
    return `Window: ${from}–${to} UTC${window.pending ? " | more pending" : ""}`;
  }
  const end = Date.parse(window.end);
  return `Window: since each service's latest launch → ${dateLabel(end, true)} ${timeLabel(end)} UTC`;
}

export function applyBrowserBatch(
  state: BrowserState,
  batch: Pick<BrowserState, "rows" | "dropped">,
  mode: "append" | "replace",
): BrowserState {
  const selected = state.rows[state.selected];
  const anchor = state.rows[state.viewport];
  let next =
    mode === "replace"
      ? {
          ...state,
          rows: [],
          sizes: [],
          bytes: 0,
          dropped: batch.dropped,
          selected: 0,
          viewport: 0,
        }
      : { ...state, dropped: state.dropped + batch.dropped };
  for (const row of batch.rows)
    next = mode === "replace" ? appendBrowserRow(next, row) : stageBrowserRow(next, row);
  if (mode === "replace") {
    const identity = selected?.["id"];
    const found =
      identity === undefined ? -1 : next.rows.findIndex((row) => row["id"] === identity);
    next = {
      ...next,
      selected: found >= 0 ? found : Math.min(state.selected, Math.max(0, next.rows.length - 1)),
      viewport: state.viewport,
    };
  } else if (state.rows.length === 0)
    next = { ...next, selected: Math.max(0, next.rows.length - 1) };
  else {
    const selectedIndex = selected === undefined ? -1 : next.rows.indexOf(selected);
    const anchorIndex = anchor === undefined ? -1 : next.rows.indexOf(anchor);
    next = {
      ...next,
      selected:
        selectedIndex >= 0
          ? selectedIndex
          : Math.min(next.selected, Math.max(0, next.rows.length - 1)),
      viewport: anchorIndex >= 0 ? anchorIndex : next.viewport,
    };
  }
  return resizeBrowser(next, state.visibleRows + browserReservedRows(state));
}

const clip = (value: string, width: number): string => {
  const clean = stripControlSequences(value).replaceAll("\t", "    ");
  let result = "";
  let used = 0;
  for (const character of clean) {
    const size = stringWidth(character);
    if (used + size > width) break;
    result += character;
    used += size;
  }
  return result;
};

function browserDetailLines(row: Schema.JsonObject, width: number): ReadonlyArray<string> {
  return wrapLogsText(renderLogsRows([row], Math.max(2, width)), Math.max(2, width)).split("\n");
}

export function browserKey(
  state: BrowserState,
  key: string,
  width: number,
  height: number,
): BrowserState {
  state = resizeBrowser(state, height);
  if (state.error !== undefined) {
    if (key === "escape") return { ...state, error: undefined };
    const delta = key === "up" ? -1 : key === "down" ? 1 : 0;
    const lines = wrapLogsText(state.error.message, width).split("\n");
    return {
      ...state,
      error: {
        ...state.error,
        scroll: Math.max(
          0,
          Math.min(Math.max(0, lines.length - state.visibleRows), state.error.scroll + delta),
        ),
      },
    };
  }
  if (key === "escape") return { ...state, detail: undefined, scroll: 0 };
  if ((key === "return" || key === "enter") && state.detail === undefined)
    return { ...state, detail: state.rows[state.selected], scroll: 0 };
  const delta = key === "up" ? -1 : key === "down" ? 1 : 0;
  if (state.detail !== undefined)
    return {
      ...state,
      scroll: Math.max(
        0,
        Math.min(
          Math.max(
            0,
            browserDetailLines(state.detail, width).length -
              Math.max(1, height - browserReservedRows(state)),
          ),
          state.scroll + delta,
        ),
      ),
    };
  return resizeBrowser(
    {
      ...state,
      selected: Math.max(0, Math.min(state.rows.length - 1, state.selected + delta)),
    },
    height,
  );
}

export function renderBrowser(
  state: BrowserState,
  columns: number,
  rows: number,
  stream: ColorStream = {},
  mode: "append" | "replace" = "append",
): string {
  state = resizeBrowser(state, rows);
  const width = Math.max(1, Math.floor(columns) - 1);
  const height = Math.max(1, Math.floor(rows));
  const bodyHeight = Math.max(0, height - browserReservedRows(state));
  let body: ReadonlyArray<string>;
  if (state.error !== undefined || state.detail !== undefined) {
    const lines =
      state.error !== undefined
        ? wrapLogsText(state.error.message, width).split("\n")
        : state.detail === undefined
          ? []
          : browserDetailLines(state.detail, width);
    const scroll = Math.min(
      state.error?.scroll ?? state.scroll,
      Math.max(0, lines.length - bodyHeight),
    );
    body = lines.slice(scroll, scroll + bodyHeight);
  } else {
    const start = state.viewport;
    body = state.rows.slice(start, start + bodyHeight).map((row, index) => {
      const service = row["service"] ?? row["source"] ?? "—";
      const message = row["event_message"] ?? row["text"] ?? row["message"] ?? JSON.stringify(row);
      const summary = stripControlSequences(
        `${String(service)} ${typeof message === "string" ? message : JSON.stringify(message)}`,
      ).replaceAll(/\s+/gu, " ");
      return `${start + index === state.selected ? ">" : " "} ${browserTimestamp(row)} ${summary}`;
    });
    if (body.length === 0 && bodyHeight > 0)
      body = [state.complete ? "No log rows." : "Waiting for logs…"];
  }
  const heading =
    state.error !== undefined
      ? "Load failed"
      : state.detail === undefined
        ? `Logs | ${state.rows.length} retained${state.dropped > 0 ? ` | ${state.dropped} older rows discarded` : ""}${state.sizes.some((size) => size > 8 * 1024 * 1024) ? " | oversized record" : ""}${state.complete ? " | ready" : " | loading"}`
        : "Log details";
  const keys =
    state.error !== undefined
      ? "↑/↓ scroll · Esc back · L retry · q quit"
      : state.detail === undefined
        ? `↑/↓ select · Enter details · ${mode === "replace" ? "L rerun" : "L load more"} · C copy · q quit`
        : `↑/↓ scroll · Esc back · ${mode === "replace" ? "L rerun" : "L load more"} · C copy · q quit`;
  const metadata =
    browserHeaderRows(state) === 2
      ? []
      : [state.context ?? "Logs", state.filters ?? "Filters: all"].map((value) =>
          stripControlSequences(value).replaceAll(/\s+/gu, " "),
        );
  const lines = [heading, ...metadata, requestedWindow(state.window), ...body];
  while (lines.length < height - 1) lines.push("");
  const compact = !state.complete
    ? "q quit"
    : state.error !== undefined
      ? "Esc back · L retry · q quit"
      : `${mode === "replace" ? "L rerun" : "L load more"} · C copy · q quit`;
  const fullNotice = clip(state.notice, width);
  const help = stringWidth(fullNotice) + 3 + stringWidth(keys) <= width ? keys : compact;
  const notice = clip(state.notice, Math.max(0, width - stringWidth(help) - 3));
  if (height > 1) lines.push(notice ? `${notice} | ${help}` : keys);
  return lines
    .slice(0, height)
    .map((line, index) => {
      const plain = clip(line, width);
      const rowIndex = state.viewport + index - browserHeaderRows(state);
      const row =
        index >= browserHeaderRows(state) &&
        index < body.length + browserHeaderRows(state) &&
        state.detail === undefined &&
        state.error === undefined
          ? state.rows[rowIndex]
          : undefined;
      if (row === undefined) return plain;
      if (rowIndex === state.selected)
        return inverse(plain + " ".repeat(Math.max(0, width - stringWidth(plain))), stream);
      const timeEnd = Math.min(plain.length, 2 + browserTimestamp(row).length);
      return plain.slice(0, 2) + dim(plain.slice(2, timeEnd), stream) + plain.slice(timeEnd);
    })
    .join("\r\n");
}
