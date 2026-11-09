import type { LogPosition, LogRecord, StackLogRecord } from "@supabase/stack/effect";

const isLine = (record: LogRecord) => record.kind === "stdout" || record.kind === "stderr";

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
  readonly timestamp: string;
}

interface InstanceTail {
  records: Array<StackLogRecord>;
  head: number;
  lines: number;
  total: number;
  launch: Launch | undefined;
}

export const isFromLaunch = (record: LogRecord, launchId: number | undefined) =>
  launchId === undefined || record.launchId === undefined || record.launchId >= launchId;

const fromLaunch = (record: StackLogRecord, launch: Launch) =>
  record.launchId === undefined
    ? record.timestamp >= launch.timestamp
    : isFromLaunch(record, launch.id);

export const makeHistoryCollector = (tail: number, fromLatestLaunch: boolean) => {
  const instances = new Map<string, InstanceTail>();
  const positions = new Map<string, LogPosition>();
  const launches = new Map<string, number>();
  const push = (record: StackLogRecord) => {
    const position = record.position;
    const last = positions.get(record.instanceId);
    if (position !== undefined && (last === undefined || comparePositions(position, last) > 0))
      positions.set(record.instanceId, position);
    let state = instances.get(record.instanceId);
    if (state === undefined) {
      state = { records: [], head: 0, lines: 0, total: 0, launch: undefined };
      instances.set(record.instanceId, state);
    }
    if (fromLatestLaunch) {
      const latest = state.launch;
      if (
        record.kind === "launch" &&
        record.launchId !== undefined &&
        (latest === undefined || record.launchId > latest.id)
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

export const isAfter = (record: LogRecord, printed: LogPosition | undefined) =>
  printed === undefined ||
  record.position === undefined ||
  comparePositions(record.position, printed) > 0;
