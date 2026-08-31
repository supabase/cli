import { legacyRed, legacyYellow, type LegacyColorStream } from "../../shared/legacy-colors.ts";
import { WORKER_LOG_STREAMS } from "../../../shared/workers/worker-logs.sql.ts";
import type { WorkerLogEntry } from "../../../shared/workers/worker-logs-api.ts";

/**
 * Text rendering for `supabase workers logs`.
 *
 * Pure, like `workers.format.ts` beside it: no Effect, no services, so the line
 * shapes and the level derivation are unit-testable directly.
 *
 * Kept apart from `workers.format.ts` because that file renders *resources* - a
 * worker's details as a key/value block - while this renders a stream of events,
 * one line each, with a different layout per stream.
 */

export type WorkerLogLevel = "info" | "warn" | "error";

/**
 * The level for one line, derived rather than read.
 *
 * `severity_text` on the row is not usable: every observed row of every stream
 * carries `INFO`, including a 200 request log, so it is a pipeline default rather
 * than a signal. Platform's own log presets do the same thing - they derive level
 * from `log_attributes`, and no platform code branches on `severity_text`.
 *
 * Guest output has no level available without parsing tenant text, so it is
 * reported absent rather than guessed at.
 */
export function legacyWorkerLogLevel(entry: WorkerLogEntry): WorkerLogLevel | undefined {
  if (entry.stream === WORKER_LOG_STREAMS.requests) {
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
  if (entry.stream === WORKER_LOG_STREAMS.builds) {
    return entry.attributes.event === "build_failed" ? "error" : "info";
  }
  return undefined;
}

/**
 * The escape-sequence and control-character patterns stripped from a guest line.
 *
 * Module constants so they compile once rather than per line, and so the
 * `no-control-regex` suppression sits in one place: matching control characters is
 * the entire purpose here, and every pattern is written with Unicode escapes so
 * the source itself holds no raw control bytes.
 */
/* oxlint-disable no-control-regex */
/** OSC: ESC ] ... terminated by BEL or ESC backslash. */
const OSC_SEQUENCE = /\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)?/gu;
/** CSI: ESC [ parameters intermediates final. */
const CSI_SEQUENCE = /\u001b\[[0-9;?]*[ -/]*[@-~]/gu;
/** Remaining two-character escape sequences. */
const ESCAPE_SEQUENCE = /\u001b[@-Z\\-_]/gu;
/** Leftover C0 controls and DEL, keeping tab, newline and carriage return. */
const C0_CONTROLS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu;
/* oxlint-enable no-control-regex */

/**
 * Control characters stripped from a line before it reaches a terminal.
 *
 * A `worker_guest_logs` message is bytes the tenant's own code printed, so it is
 * the one untrusted string this CLI displays: left alone, a worker could emit
 * ANSI escapes that reposition the cursor, recolour later output, or forge a line
 * that looks like the CLI's own.
 *
 * Deliberately narrow. Tabs, and the interior newlines and indentation of a stack
 * trace, are content the reader needs - only escape sequences and the other C0
 * controls go.
 */
function stripControlSequences(message: string): string {
  return message
    .replaceAll(OSC_SEQUENCE, "")
    .replaceAll(CSI_SEQUENCE, "")
    .replaceAll(ESCAPE_SEQUENCE, "")
    .replaceAll(C0_CONTROLS, "");
}

/**
 * Colour for a level, or plain text.
 *
 * The stream is threaded through rather than a boolean because
 * `legacyAqua`/`legacyRed`/... already own the colour decision: they consult
 * `NO_COLOR`, `CLICOLOR`, `CLICOLOR_FORCE`, `CI` and the stream's own
 * `hasColors()`. Deciding here - from `isTTY`, say - would both duplicate that
 * gate and get it wrong, since `CLICOLOR_FORCE=1` deliberately styles a piped
 * stream.
 *
 * Only `warn` and `error` are coloured. `info` is the overwhelming majority of
 * lines, and tinting all of them would make the exceptions harder to spot, not
 * easier.
 */
function colourise(
  text: string,
  level: WorkerLogLevel | undefined,
  stream: LegacyColorStream,
): string {
  if (level === "error") {
    return legacyRed(text, stream);
  }
  return level === "warn" ? legacyYellow(text, stream) : text;
}

/**
 * `HH:MM:SS` in UTC.
 *
 * Time only, not a full timestamp: every line in one invocation falls inside a
 * window of at most a day, so repeating the date on all hundred of them costs
 * width the message needs. The machine payload carries the full ISO string and
 * the raw epoch value.
 */
function formatLogTime(timestampMs: number): string {
  return new Date(timestampMs).toISOString().slice(11, 19);
}

/**
 * One rendered line.
 *
 * Per-stream layouts rather than one shared format, because `event_message` means
 * something different in each. On the request stream it is only `"GET /"` - the
 * status and duration live in `log_attributes` - so the useful line has to be
 * *composed*, and a single format wide enough for all three would be mostly empty
 * for each of them.
 *
 * An unrecognised stream falls back to the bare message: the log contract is
 * additive-only, so a stream this CLI has not heard of must still print.
 */
export function legacyRenderWorkerLogLine(
  entry: WorkerLogEntry,
  stream: LegacyColorStream = process.stdout,
): string {
  const time = formatLogTime(entry.timestampMs);
  const level = legacyWorkerLogLevel(entry);

  if (entry.stream === WORKER_LOG_STREAMS.requests) {
    const { status, method, path, duration_ms: duration } = entry.attributes;
    const request = [status, method, path].filter((part) => part !== undefined).join(" ");
    const suffix = duration === undefined ? "" : ` ${duration}ms`;
    return `${time}  ${colourise(`${request}${suffix}`, level, stream)}`;
  }

  if (entry.stream === WORKER_LOG_STREAMS.builds) {
    const { event, reason } = entry.attributes;
    const described = [event ?? entry.message, reason]
      .filter((part) => part !== undefined)
      .join(" ");
    return `${time}  ${colourise(described, level, stream)}`;
  }

  // Guest output, and anything newer. The message is the payload, and it is the
  // untrusted one.
  return `${time}  ${colourise(stripControlSequences(entry.message), level, stream)}`;
}
