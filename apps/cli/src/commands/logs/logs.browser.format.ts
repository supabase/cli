import { DateTime, type Schema } from "effect";
import { stripControlSequences } from "../../shared/output/strip-control-sequences.ts";
import { stringWidth } from "../../command-internal/string-width.ts";
import { renderLogsRows, wrapLogsText } from "./logs.display.ts";

export interface BrowserState {
  readonly rows: ReadonlyArray<Schema.JsonObject>;
  readonly sizes: ReadonlyArray<number>;
  readonly bytes: number;
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
  selected: 0,
  detail: undefined,
  scroll: 0,
  dropped: 0,
  complete: false,
  notice: "",
};

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
  return {
    ...state,
    rows,
    sizes: sizes.slice(dropped),
    bytes,
    dropped: state.dropped + dropped,
    selected: following ? rows.length - 1 : Math.max(0, state.selected - dropped),
  };
}

export function browserTimestamp(row: Schema.JsonObject): string {
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
  return Number.isFinite(time) && Math.abs(time) <= 8_640_000_000_000_000
    ? `${DateTime.formatIso(DateTime.makeUnsafe(time)).replace("T", " ").replace("Z", " UTC")}`
    : "—";
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
          Math.max(0, browserDetailLines(state.detail, width).length - Math.max(1, height - 2)),
          state.scroll + delta,
        ),
      ),
    };
  return {
    ...state,
    selected: Math.max(0, Math.min(state.rows.length - 1, state.selected + delta)),
  };
}

export function renderBrowser(state: BrowserState, columns: number, rows: number): string {
  const width = Math.max(1, Math.floor(columns) - 1);
  const height = Math.max(1, Math.floor(rows));
  const bodyHeight = Math.max(0, height - 2);
  let body: ReadonlyArray<string>;
  if (state.detail !== undefined) {
    const lines = browserDetailLines(state.detail, width);
    const scroll = Math.min(state.scroll, Math.max(0, lines.length - bodyHeight));
    body = lines.slice(scroll, scroll + bodyHeight);
  } else {
    const start = Math.max(0, state.selected - bodyHeight + 1);
    body = state.rows.slice(start, start + bodyHeight).map((row, index) => {
      const service = row["service"] ?? row["source"] ?? "—";
      const message = row["event_message"] ?? row["text"] ?? row["message"] ?? JSON.stringify(row);
      return `${start + index === state.selected ? ">" : " "} ${browserTimestamp(row)} ${String(service)} ${typeof message === "string" ? message : JSON.stringify(message)}`.replaceAll(
        /\s+/gu,
        " ",
      );
    });
    if (body.length === 0) body = [state.complete ? "No log rows." : "Waiting for logs…"];
  }
  const heading =
    state.detail === undefined
      ? `Logs | ${state.rows.length} retained${state.dropped > 0 ? ` | ${state.dropped} older rows discarded` : ""}${state.sizes.some((size) => size > 8 * 1024 * 1024) ? " | oversized record" : ""}${state.complete ? " | complete" : " | live"}`
      : "Log details";
  const keys =
    state.detail === undefined
      ? "↑/↓ select · Enter details · q quit"
      : "↑/↓ scroll · Esc back · q quit";
  const lines = [heading, ...body];
  while (lines.length < height - 1) lines.push("");
  if (height > 1) lines.push(`${keys}${state.notice ? ` | ${state.notice}` : ""}`);
  return lines
    .slice(0, height)
    .map((line) => clip(line, width))
    .join("\r\n");
}
