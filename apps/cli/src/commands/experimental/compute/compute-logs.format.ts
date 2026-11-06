import { DateTime } from "effect";
import { red, yellow, type ColorStream } from "../../../command-internal/colors.ts";
import { COMPUTE_LOG_STREAMS } from "../../../shared/compute/compute-logs.sql.ts";
import type { ComputeLogEntry } from "../../../shared/compute/compute-logs-api.ts";
import { stripControlSequences } from "../../../shared/output/strip-control-sequences.ts";

export type ComputeLogLevel = "info" | "warn" | "error";

export function computeLogLevel(entry: ComputeLogEntry): ComputeLogLevel | undefined {
  if (entry.stream === COMPUTE_LOG_STREAMS.requests) {
    const status = Number(entry.attributes.status);
    if (!Number.isFinite(status)) {
      return undefined;
    }
    if (status >= 500) {
      return "error";
    }
    return status >= 400 ? "warn" : "info";
  }
  if (entry.stream === COMPUTE_LOG_STREAMS.builds) {
    return entry.attributes.event === "build_failed" ? "error" : "info";
  }
  return undefined;
}

function colourise(text: string, level: ComputeLogLevel | undefined, stream: ColorStream): string {
  if (level === "error") {
    return red(text, stream);
  }
  return level === "warn" ? yellow(text, stream) : text;
}

function formatLogTime(timestampMs: number): string {
  return DateTime.formatLocal(DateTime.makeUnsafe(timestampMs), {
    locale: "en-GB",
    hourCycle: "h23",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

const STREAM_TAGS: Readonly<Record<string, string>> = {
  [COMPUTE_LOG_STREAMS.app]: "app",
  [COMPUTE_LOG_STREAMS.requests]: "req",
  [COMPUTE_LOG_STREAMS.builds]: "build",
};

const TAG_WIDTH = Math.max(...Object.values(STREAM_TAGS).map((tag) => tag.length)) + 2;

function streamTag(stream: string): string {
  return `[${STREAM_TAGS[stream] ?? stream}]`.padEnd(TAG_WIDTH);
}

export function computeLogText(entry: ComputeLogEntry): string {
  if (entry.stream === COMPUTE_LOG_STREAMS.requests) {
    const { status, method, path, duration_ms: duration } = entry.attributes;
    const request = [status, method, path]
      .filter((part) => part !== undefined)
      .map(stripControlSequences)
      .join(" ");
    const suffix = duration === undefined ? "" : ` ${stripControlSequences(duration)}ms`;
    return `${request}${suffix}`;
  }

  if (entry.stream === COMPUTE_LOG_STREAMS.builds) {
    const { event, reason } = entry.attributes;
    return [event ?? entry.message, reason]
      .filter((part) => part !== undefined)
      .map(stripControlSequences)
      .join(" ");
  }

  return stripControlSequences(entry.message);
}

export function renderComputeLogLine(
  entry: ComputeLogEntry,
  options: {
    readonly showStream: boolean;
    readonly colorStream?: ColorStream;
  },
): string {
  const time = formatLogTime(entry.timestampMs);
  const level = computeLogLevel(entry);
  const colorStream = options.colorStream ?? process.stdout;
  const prefix = options.showStream ? `${time}  ${streamTag(entry.stream)}` : time;

  return `${prefix}  ${colourise(computeLogText(entry), level, colorStream)}`;
}
