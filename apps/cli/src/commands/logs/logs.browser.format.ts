import { dim, inverse, type ColorStream } from "../../command-internal/colors.ts";
import { DateTime, type Schema } from "effect";
import { stripControlSequences } from "../../shared/output/strip-control-sequences.ts";
import { stringWidth } from "../../command-internal/string-width.ts";
import { renderLogsRows, wrapLogsText } from "./logs.display.ts";

const browserHeaderRows = 2;
const browserReservedRows = browserHeaderRows + 1;

export interface BrowserState {
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
}

export const initialBrowserState: BrowserState = {
  rows: [],
  sizes: [],
  bytes: 0,
  viewport: 0,
  visibleRows: 24 - browserReservedRows,
  selected: 0,
  detail: undefined,
  scroll: 0,
  dropped: 0,
  complete: false,
  notice: "",
};

export function resizeBrowser(state: BrowserState, height: number): BrowserState {
  const visibleRows = Math.max(1, Math.floor(height) - browserReservedRows);
  const lastStart = Math.max(0, state.rows.length - visibleRows);
  let viewport = Math.min(state.viewport, lastStart);
  if (state.selected < viewport) viewport = state.selected;
  else if (state.selected >= viewport + visibleRows) viewport = state.selected - visibleRows + 1;
  return { ...state, viewport: Math.max(0, viewport), visibleRows };
}

export function appendBrowserRow(
  state: BrowserState,
  row: Schema.JsonObject,
  mode: "query" | "tail" = "tail",
): BrowserState {
  const following =
    mode === "tail" && state.detail === undefined && state.selected >= state.rows.length - 1;
  const size = JSON.stringify(row).length * 2;
  const sizes = [...state.sizes, size];
  let bytes = state.bytes + size;
  let dropped = 0;
  while (
    mode === "tail" &&
    sizes.length - dropped > 1 &&
    (sizes.length - dropped > 1000 || bytes > 8 * 1024 * 1024)
  ) {
    bytes -= sizes[dropped] ?? 0;
    dropped++;
  }
  const rows = [...state.rows, row].slice(dropped);
  return resizeBrowser(
    {
      ...state,
      rows,
      viewport: Math.max(0, state.viewport - dropped),
      sizes: sizes.slice(dropped),
      bytes,
      dropped: state.dropped + dropped,
      selected: following ? rows.length - 1 : Math.max(0, state.selected - dropped),
    },
    state.visibleRows + browserReservedRows,
  );
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

function loadedRange(rows: ReadonlyArray<Schema.JsonObject>): string {
  if (rows.length === 0) return "Loaded: no logs";
  let earliest = Infinity;
  let latest = -Infinity;
  let unknown = 0;
  for (const row of rows) {
    const time = timestampMillis(row);
    if (time === undefined) unknown++;
    else {
      earliest = Math.min(earliest, time);
      latest = Math.max(latest, time);
    }
  }
  if (unknown === rows.length) return `Loaded: unavailable (${unknown} unknown)`;
  const first = DateTime.toPartsUtc(DateTime.makeUnsafe(earliest));
  const last = DateTime.toPartsUtc(DateTime.makeUnsafe(latest));
  const crossYear = first.year !== last.year;
  const sameDay = !crossYear && first.month === last.month && first.day === last.day;
  const start = `${dateLabel(earliest, crossYear)} ${timeLabel(earliest)}`;
  const end = sameDay ? timeLabel(latest) : `${dateLabel(latest, crossYear)} ${timeLabel(latest)}`;
  const range = earliest === latest ? start : `${start}–${end}`;
  return `Loaded: ${range} UTC${unknown > 0 ? ` | ${unknown} unknown` : ""}`;
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
              Math.max(1, height - browserReservedRows),
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
): string {
  state = resizeBrowser(state, rows);
  const width = Math.max(1, Math.floor(columns) - 1);
  const height = Math.max(1, Math.floor(rows));
  const bodyHeight = Math.max(0, height - browserReservedRows);
  let body: ReadonlyArray<string>;
  if (state.detail !== undefined) {
    const lines = browserDetailLines(state.detail, width);
    const scroll = Math.min(state.scroll, Math.max(0, lines.length - bodyHeight));
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
    state.detail === undefined
      ? `Logs | ${state.rows.length} retained${state.dropped > 0 ? ` | ${state.dropped} older rows discarded` : ""}${state.sizes.some((size) => size > 8 * 1024 * 1024) ? " | oversized record" : ""}${state.complete ? " | complete" : " | live"}`
      : "Log details";
  const keys =
    state.detail === undefined
      ? "↑/↓ select · Enter details · C copy · q quit"
      : "↑/↓ scroll · Esc back · C copy · q quit";
  const lines = [heading, loadedRange(state.rows), ...body];
  while (lines.length < height - 1) lines.push("");
  const notice = clip(state.notice, width);
  const help = stringWidth(notice) + 3 + stringWidth(keys) <= width ? keys : "C copy · q quit";
  if (height > 1) lines.push(notice ? `${notice} | ${help}` : keys);
  return lines
    .slice(0, height)
    .map((line, index) => {
      const plain = clip(line, width);
      const rowIndex = state.viewport + index - browserHeaderRows;
      const row =
        index >= browserHeaderRows &&
        index < body.length + browserHeaderRows &&
        state.detail === undefined
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
