import { DateTime, Option } from "effect";
import type { LogPosition, LogRecord, StackLogRecord } from "@supabase/stack/effect";
import {
  aqua,
  blue,
  type ColorStream,
  dim,
  green,
  magenta,
  yellow,
} from "../../../../command-internal/colors.ts";
import { stripControlSequences } from "../../../../shared/output/strip-control-sequences.ts";
import type { StreamEvent } from "../../../../shared/output/types.ts";

export type LogSource = "history" | "live";

/** A `--since` bound: an absolute time, or each instance's latest launch. */
export type SinceBound =
  | { readonly kind: "time"; readonly iso: string }
  | { readonly kind: "start" };

const durationShape = /^(?:\d+(?:\.\d+)?(?:ms|s|m|h|d))+$/u;
const durationPart = /(\d+(?:\.\d+)?)(ms|s|m|h|d)/gu;
const unitMillis: Readonly<Record<string, number>> = {
  ms: 1,
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
};
const isoDate = /^\d{4}-\d{2}-\d{2}/u;

/** Parses `start`, a duration before `nowMillis` such as `1h30m`, or an ISO-8601 time. */
export const parseSince = (value: string, nowMillis: number): SinceBound | undefined => {
  if (value === "start") return { kind: "start" };
  if (durationShape.test(value)) {
    let millis = 0;
    for (const [, amount, unit] of value.matchAll(durationPart))
      millis += Number(amount) * (unitMillis[unit ?? ""] ?? 0);
    return Option.match(DateTime.make(nowMillis - millis), {
      onNone: () => undefined,
      onSome: (time) => ({ kind: "time", iso: DateTime.formatIso(time) }),
    });
  }
  if (!isoDate.test(value)) return undefined;
  return Option.match(DateTime.make(value), {
    onNone: () => undefined,
    onSome: (time) => ({ kind: "time", iso: DateTime.formatIso(time) }),
  });
};

const isLine = (record: LogRecord) => record.kind === "stdout" || record.kind === "stderr";

/** The newest `tail` output lines, with the markers between them, and how many lines exist. */
export interface LogWindow {
  readonly records: ReadonlyArray<StackLogRecord>;
  readonly shown: number;
  readonly total: number;
}

const tailWindow = (records: ReadonlyArray<StackLogRecord>, tail: number): LogWindow => {
  const total = records.filter(isLine).length;
  if (total <= tail) return { records, shown: total, total };
  let seen = 0;
  let start = records.length;
  while (seen < tail && start > 0) {
    start -= 1;
    const record = records[start];
    if (record !== undefined && isLine(record)) seen += 1;
  }
  return { records: seen === 0 ? [] : records.slice(start), shown: seen, total };
};

const comparePositions = (left: LogPosition, right: LogPosition) =>
  left.generation - right.generation || left.byteOffset - right.byteOffset;

const origin: LogPosition = { generation: 0, byteOffset: 0 };
const compareText = (left: string, right: string) => (left < right ? -1 : left > right ? 1 : 0);
const compareRecords = (left: StackLogRecord, right: StackLogRecord) =>
  compareText(left.timestamp, right.timestamp) ||
  compareText(left.service, right.service) ||
  compareText(left.instanceId, right.instanceId) ||
  comparePositions(
    left.position ?? left.resumeAt ?? origin,
    right.position ?? right.resumeAt ?? origin,
  );

interface Launch {
  readonly id: number;
  /** Unknown until its launch record is read; a saved launch may not have written one. */
  readonly timestamp: string | undefined;
}

interface InstanceTail {
  records: Array<StackLogRecord>;
  head: number;
  lines: number;
  total: number;
  launch: Launch | undefined;
}

/** Whether a record belongs to `launchId` or a later launch; a gap marker carries no launch id. */
export const isFromLaunch = (record: LogRecord, launchId: number | undefined) =>
  launchId === undefined || record.launchId === undefined || record.launchId >= launchId;

/** Launch ids increase per instance; a gap marker carries none, so its time decides. */
const fromLaunch = (record: StackLogRecord, launch: Launch) =>
  record.launchId === undefined
    ? launch.timestamp === undefined || record.timestamp >= launch.timestamp
    : isFromLaunch(record, launch.id);

/**
 * Collects each instance's newest `tail` lines and last position. With `startLaunches`, it keeps
 * only the records of each instance's current launch: its saved launch id, or else its highest
 * launch record, which `launches` reports for following.
 */
export const makeHistoryCollector = (
  tail: number,
  startLaunches: ReadonlyMap<string, number> | undefined,
) => {
  const instances = new Map<string, InstanceTail>();
  const positions = new Map<string, LogPosition>();
  const launches = new Map(startLaunches);
  const push = (record: StackLogRecord) => {
    const position = record.position;
    const last = positions.get(record.instanceId);
    if (position !== undefined && (last === undefined || comparePositions(position, last) > 0))
      positions.set(record.instanceId, position);
    let state = instances.get(record.instanceId);
    if (state === undefined) {
      const saved = startLaunches?.get(record.instanceId);
      state = {
        records: [],
        head: 0,
        lines: 0,
        total: 0,
        launch: saved === undefined ? undefined : { id: saved, timestamp: undefined },
      };
      instances.set(record.instanceId, state);
    }
    if (startLaunches !== undefined) {
      const latest = state.launch;
      if (
        record.kind === "launch" &&
        record.launchId !== undefined &&
        (latest === undefined ||
          record.launchId > latest.id ||
          (record.launchId === latest.id && latest.timestamp === undefined))
      ) {
        const launch = { id: record.launchId, timestamp: record.timestamp };
        state.records = state.records.slice(state.head).filter((kept) => fromLaunch(kept, launch));
        state.head = 0;
        state.lines = state.records.filter(isLine).length;
        state.total = state.lines;
        state.launch = launch;
        launches.set(record.instanceId, launch.id);
      } else if (latest !== undefined && !fromLaunch(record, latest)) return;
    }
    const line = isLine(record);
    if (line) state.total += 1;
    // Kept records stay in display order; a record older than every kept line of a full window
    // would be trimmed at once.
    const oldest = state.records[state.head];
    if (state.lines >= tail && oldest !== undefined && compareRecords(record, oldest) < 0) return;
    let low = state.head;
    let high = state.records.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      const kept = state.records[middle];
      if (kept !== undefined && compareRecords(kept, record) <= 0) low = middle + 1;
      else high = middle;
    }
    if (low === state.records.length) state.records.push(record);
    else state.records.splice(low, 0, record);
    if (line) state.lines += 1;
    while (state.lines > tail && state.head < state.records.length) {
      const dropped = state.records[state.head];
      state.head += 1;
      if (dropped !== undefined && isLine(dropped)) state.lines -= 1;
    }
    if (state.head > 1024 && state.head * 2 > state.records.length) {
      state.records = state.records.slice(state.head);
      state.head = 0;
    }
  };
  const finish = (): {
    readonly window: LogWindow;
    readonly positions: typeof positions;
    readonly launches: ReadonlyMap<string, number>;
  } => {
    const kept = [...instances.values()].flatMap((state) => state.records.slice(state.head));
    const total = [...instances.values()].reduce((sum, state) => sum + state.total, 0);
    const window = tailWindow(kept.toSorted(compareRecords), tail);
    return { window: { ...window, total }, positions, launches };
  };
  return { push, finish };
};

/** Whether a followed record comes after the history already printed. */
export const isAfter = (record: LogRecord, printed: LogPosition | undefined) =>
  printed === undefined ||
  record.position === undefined ||
  comparePositions(record.position, printed) > 0;

/** The `log-entry` or `log-marker` event of a record. */
export const logEvent = (record: StackLogRecord, source: LogSource): StreamEvent => {
  const subject = { service: record.service, instance_id: record.instanceId };
  if (record.kind === "stdout" || record.kind === "stderr")
    return {
      type: "log-entry",
      timestamp: record.timestamp,
      source,
      ...subject,
      stream: record.kind,
      line: record.text ?? "",
    };
  return {
    type: "log-marker",
    timestamp: record.timestamp,
    source,
    ...subject,
    kind: record.kind,
    ...(record.stream === undefined ? {} : { stream: record.stream }),
    ...(record.count === undefined ? {} : { count: record.count }),
  };
};

const palette = [aqua, yellow, green, magenta, blue];
const pad = (value: number, width: number) => String(value).padStart(width, "0");

const localTime = (iso: string) =>
  Option.match(DateTime.make(iso), {
    onNone: () => iso,
    onSome: (time) => {
      const parts = DateTime.toParts(DateTime.setZone(time, DateTime.zoneMakeLocal()));
      return `${pad(parts.hour, 2)}:${pad(parts.minute, 2)}:${pad(parts.second, 2)}.${pad(parts.millisecond, 3)}`;
    },
  });

const markerText = (record: LogRecord) => {
  if (record.kind === "launch")
    return record.launchId === undefined ? "--- launch ---" : `--- launch ${record.launchId} ---`;
  if (record.count === undefined) return "--- older records were removed by retention ---";
  const unit = record.count === 1 ? "chunk" : "chunks";
  return `--- ${record.count} ${record.stream ?? "output"} ${unit} lost ---`;
};

/** Formats records as `<label> | <local time> <line>`, labels aligned across `instances`. */
export const makeTextFormatter = (
  instances: ReadonlyArray<{ readonly id: string; readonly service: string }>,
  stream: ColorStream,
) => {
  const kinds = new Map<string, number>();
  for (const { service } of instances) kinds.set(service, (kinds.get(service) ?? 0) + 1);
  const labels = new Map(
    instances.map(({ id, service }, index) => {
      const text = (kinds.get(service) ?? 0) > 1 ? `${service}:${id.slice(0, 8)}` : service;
      return [id, { text, paint: palette[index % palette.length] ?? aqua }] as const;
    }),
  );
  const width = Math.max(0, ...[...labels.values()].map(({ text }) => text.length));
  return (record: StackLogRecord): string => {
    const label = labels.get(record.instanceId) ?? { text: record.service, paint: aqua };
    const prefix = `${label.paint(label.text.padEnd(width), stream)} | `;
    const time = localTime(record.timestamp);
    return isLine(record)
      ? `${prefix}${time} ${stripControlSequences(record.text ?? "")}\n`
      : `${prefix}${dim(`${time} ${markerText(record)}`, stream)}\n`;
  };
};

/** The note printed when the tail hides older lines. */
export const truncationFooter = (window: LogWindow) =>
  `showing last ${window.shown.toLocaleString("en-US")} of ${window.total.toLocaleString("en-US")} lines, use --tail/--since`;
