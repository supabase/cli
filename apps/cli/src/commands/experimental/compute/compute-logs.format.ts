import { DateTime } from "effect";
import { red, yellow, type ColorStream } from "../../../command-internal/colors.ts";
import { COMPUTE_LOG_STREAMS } from "../../../shared/compute/compute-logs.sql.ts";
import type { ComputeLogEntry } from "../../../shared/compute/compute-logs-api.ts";

/**
 * Text rendering for `supabase compute logs`.
 *
 * Pure, so line shapes and level derivation are unit-testable directly. Kept
 * apart from `compute.format.ts`, which renders a compute's details as a
 * key/value block rather than a stream of per-line events.
 */

export type ComputeLogLevel = "info" | "warn" | "error";

/**
 * The level for one line, derived rather than read: `severity_text` carries
 * `INFO` on every observed row (including 200s), so it's a pipeline default,
 * not a signal — the platform's own presets derive level from
 * `log_attributes` too. Guest output has no level without parsing tenant
 * text, so it's reported absent rather than guessed.
 */
export function computeLogLevel(entry: ComputeLogEntry): ComputeLogLevel | undefined {
  if (entry.stream === COMPUTE_LOG_STREAMS.requests) {
    // `log_attributes` is a Map(String, String), so this is "200", not 200.
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

/**
 * Escape-sequence and control-character patterns stripped from a guest line,
 * as module constants so they compile once. Every pattern uses Unicode
 * escapes so the source itself holds no raw control bytes.
 */
/* oxlint-disable no-control-regex */
/** OSC: ESC ] ... terminated by BEL or ESC backslash. */
const OSC_SEQUENCE = /\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)?/gu;
/** CSI: ESC [ parameters intermediates final. */
const CSI_SEQUENCE = /\u001b\[[0-9;?]*[ -/]*[@-~]/gu;
/** Remaining two-character escape sequences. */
const ESCAPE_SEQUENCE = /\u001b[@-Z\\-_]/gu;
/** CRLF pairs, folded to a bare newline before lone carriage returns go. */
const CRLF_PAIR = /\u000d\u000a/gu;
/**
 * Leftover C0 controls and DEL, keeping only tab and newline. A carriage
 * return is stripped since it returns the cursor to column zero, letting a
 * line overwrite the timestamp and stream tag already printed to its left.
 */
const C0_CONTROLS = /[\u0000-\u0008\u000b-\u001f\u007f]/gu;
/* oxlint-enable no-control-regex */

/**
 * Control characters stripped from a line before it reaches a terminal.
 * `worker_guest_logs` is bytes the tenant's own code printed — the one
 * untrusted string this CLI displays — so left alone it could reposition the
 * cursor or forge a line that looks like the CLI's own. Tabs and interior
 * newlines are kept; only escape sequences and other C0 controls go.
 */
function stripControlSequences(message: string): string {
  return message
    .replaceAll(CRLF_PAIR, "\n")
    .replaceAll(OSC_SEQUENCE, "")
    .replaceAll(CSI_SEQUENCE, "")
    .replaceAll(ESCAPE_SEQUENCE, "")
    .replaceAll(C0_CONTROLS, "");
}

/**
 * Colour for a level, or plain text. The stream is threaded through rather
 * than a boolean since `aqua`/`red`/... already own the colour decision
 * (`NO_COLOR`, `CLICOLOR`, `CLICOLOR_FORCE`, `CI`, `hasColors()`); only
 * `warn`/`error` are coloured, since tinting the overwhelming majority
 * (`info`) would bury the exceptions instead of highlighting them.
 */
function colourise(text: string, level: ComputeLogLevel | undefined, stream: ColorStream): string {
  if (level === "error") {
    return red(text, stream);
  }
  return level === "warn" ? yellow(text, stream) : text;
}

/**
 * `HH:MM:SS` in the reader's own timezone, matching the only other log-line
 * format this shell prints (the `--debug` HTTP logger). Machine output keeps
 * unambiguous forms instead, carrying an ISO-8601 UTC `timestamp` and raw
 * `timestamp_ms`. Date is omitted since a single invocation's lines all fall
 * inside one day.
 */
function formatLogTime(timestampMs: number): string {
  return DateTime.formatLocal(DateTime.makeUnsafe(timestampMs), {
    locale: "en-GB",
    hourCycle: "h23",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

/**
 * The short label for a stream, and the column it sits in. Bracketed and
 * left-aligned so interleaved sources are easy to scan, and padded so
 * messages line up. Abbreviated since the wire names are long internal
 * strings; the words match `--kind`, so what's printed is what the flag accepts.
 */
const STREAM_TAGS: Readonly<Record<string, string>> = {
  [COMPUTE_LOG_STREAMS.app]: "app",
  [COMPUTE_LOG_STREAMS.requests]: "req",
  [COMPUTE_LOG_STREAMS.builds]: "build",
};

const TAG_WIDTH = Math.max(...Object.values(STREAM_TAGS).map((tag) => tag.length)) + 2;

/**
 * An unrecognised stream gets its raw name rather than a placeholder: the log
 * contract is additive-only, so the name is more useful than a `?`.
 */
function streamTag(stream: string): string {
  return `[${STREAM_TAGS[stream] ?? stream}]`.padEnd(TAG_WIDTH);
}

/**
 * What one entry says, composed and sanitised but not coloured or prefixed.
 *
 * Split out from the renderer since `stream-json` needs the same sentence:
 * `event_message` alone would drop the status/duration or build reason, which
 * live in `log_attributes` instead. Per-stream layouts, not one shared
 * format, since `event_message` means something different on each stream.
 */
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

  // Guest output, and anything newer — the message is the payload. Every
  // branch above sanitises too, since a request `path` or build `reason` is
  // not guaranteed trustworthy either; `stream` needs no sanitising, since
  // the query only returns one of three literal values.
  return stripControlSequences(entry.message);
}

/**
 * One rendered line. Per-stream layouts, not one shared format, since
 * `event_message` means something different on each — a single format wide
 * enough for all three would be mostly empty for each of them. An
 * unrecognised stream falls back to the bare message, since the log contract
 * is additive-only.
 */
export function renderComputeLogLine(
  entry: ComputeLogEntry,
  options: {
    /**
     * Whether to prefix the stream tag. False when `--kind` has already pinned
     * one stream, where every line would carry the same tag and it would be
     * width spent saying nothing.
     */
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
