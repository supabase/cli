import type { StreamEvent } from "../../../shared/output/types.ts";
import { realtimeEventLabel, type RealtimeEvent } from "./realtime.events.ts";

const CATEGORY_WIDTH = 9;
const LABEL_WIDTH = 22;
const SUMMARY_LIMIT = 200;

export interface RealtimeRenderOptions {
  readonly fullPayload: boolean;
}

function formatRealtimeTime(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return iso;
  const time = at.toISOString();
  return time.slice(11, 23);
}

function formatRealtimePayload(payload: unknown, limit = SUMMARY_LIMIT): string {
  if (payload === undefined || payload === null) return "";
  const json = JSON.stringify(payload);
  if (json === undefined) return "";
  if (json === "{}" || json === "[]") return "";
  return json.length > limit ? `${json.slice(0, limit)}…` : json;
}

export function formatRealtimeLine(
  event: RealtimeEvent,
  options: RealtimeRenderOptions = { fullPayload: false },
): string {
  const label = event.label ?? realtimeEventLabel(event.event);
  const latency = event.latencyMs === undefined ? "" : ` +${Math.round(event.latencyMs)}ms`;

  const head = [
    formatRealtimeTime(event.at),
    event.category.padEnd(CATEGORY_WIDTH),
    `${label}${latency}`.padEnd(LABEL_WIDTH),
  ].join("  ");

  if (options.fullPayload) {
    const pretty = JSON.stringify(event.payload, null, 2);
    if (pretty === undefined || pretty === "{}") return head.trimEnd();
    return `${head.trimEnd()}\n${legacyIndent(pretty, 2)}`;
  }

  const summary = formatRealtimePayload(event.payload);
  return summary.length === 0 ? head.trimEnd() : `${head}  ${summary}`;
}

function legacyIndent(text: string, spaces: number): string {
  const pad = " ".repeat(spaces);
  return text
    .split("\n")
    .map((line) => `${pad}${line}`)
    .join("\n");
}

export function realtimeFrameEvent(
  event: RealtimeEvent,
  options: RealtimeRenderOptions = { fullPayload: false },
): StreamEvent {
  return {
    type: "realtime-frame",
    timestamp: event.at,
    seq: event.seq,
    category: event.category,
    event: event.event,
    label: event.label ?? realtimeEventLabel(event.event),
    line: formatRealtimeLine(event, options),
    payload: event.payload,
    ...(event.latencyMs === undefined ? {} : { latencyMs: event.latencyMs }),
  };
}

export function formatRealtimeHeader(): string {
  return [
    "TIME".padEnd(12),
    "CATEGORY".padEnd(CATEGORY_WIDTH),
    "EVENT".padEnd(LABEL_WIDTH),
    "PAYLOAD",
  ].join("  ");
}

interface RealtimeSummary {
  readonly emitted: number;
  readonly suppressed: number;
  readonly byCategory: Readonly<Record<string, number>>;
}

export function realtimeNoChangesHint(opts: {
  readonly table: string;
  readonly filtered: boolean;
  readonly elevated: boolean;
  readonly asUser: boolean;
}): string {
  const causes = [`nothing changed in ${opts.table}`];
  if (opts.filtered) causes.push("the --filter excludes the rows that did change");
  if (!opts.elevated && !opts.asUser) {
    causes.push(
      "or RLS on the table does not grant the anon role — retry with --email/--user-token, or --service-role to rule RLS out",
    );
  } else if (opts.asUser) {
    causes.push("or RLS does not grant this user — retry with --service-role to rule RLS out");
  }
  return `The subscription was confirmed but no database changes arrived: either ${causes.join(", ")}.`;
}

export function realtimeSummaryLine(summary: RealtimeSummary): string {
  const breakdown = Object.entries(summary.byCategory)
    .filter(([, count]) => count > 0)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([category, count]) => `${category} ${count}`)
    .join(", ");

  const suppressed =
    summary.suppressed > 0 ? ` (${summary.suppressed} filtered out by --categories)` : "";

  if (summary.emitted === 0) {
    return `No frames received${suppressed}.`;
  }
  return `${summary.emitted} frame${summary.emitted === 1 ? "" : "s"}: ${breakdown}${suppressed}.`;
}
