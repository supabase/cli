import type { LogRecord, StackLogRecord } from "@supabase/stack/effect";
import type { StreamEvent } from "../shared/output/types.ts";

/** Whether a record was read as history or followed live. */
export type LogSource = "history" | "live";

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

/** The text of a launch or lost marker, as `stack logs` prints it. */
export const markerText = (record: LogRecord) => {
  if (record.kind === "launch")
    return record.launchId === undefined ? "--- launch ---" : `--- launch ${record.launchId} ---`;
  if (record.count === undefined) return "--- older records were removed by retention ---";
  const unit = record.count === 1 ? "chunk" : "chunks";
  return `--- ${record.count} ${record.stream ?? "output"} ${unit} lost ---`;
};
