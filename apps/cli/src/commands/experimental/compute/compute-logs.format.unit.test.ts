import { describe, expect, it } from "@effect/vitest";
import { afterEach, beforeEach, vi } from "vitest";
import type { ComputeLogEntry } from "../../../shared/compute/compute-logs-api.ts";
import { renderComputeLogLine, computeLogLevel } from "./compute-logs.format.ts";

const ESCAPE = "\u001b";

/**
 * Colour is decided by the stream, so the tests supply one — and by the
 * environment, so the tests pin that too. `supportsColor` consults
 * NO_COLOR / CLICOLOR / CLICOLOR_FORCE / CI *before* it ever asks the stream,
 * so a fake stream alone does not make these deterministic: under CI, where
 * `CI` is set, a `hasColors: () => true` stream still renders plain.
 *
 * Neutralised the same way `colors.unit.test.ts` does it — empty string
 * reads as unset for every variable the gate consults.
 */
const PLAIN = { hasColors: () => false };
const COLOURED = { hasColors: () => true };

beforeEach(() => {
  vi.stubEnv("NO_COLOR", "");
  vi.stubEnv("CLICOLOR", "");
  vi.stubEnv("CLICOLOR_FORCE", "");
  vi.stubEnv("CI", "");
});

afterEach(() => {
  vi.unstubAllEnvs();
});
const AT = 1_788_187_532_576;

/**
 * The expected `HH:MM:SS` prefix for an instant, in this machine's zone.
 *
 * Derived rather than hardcoded: the renderer prints local time, so a literal
 * `"14:45:32"` would pass only on a UTC machine and fail everywhere else. This
 * independent native-Date expectation pins the format and zone choice without
 * duplicating the formatter implementation.
 */
function nativeDate(timestampMs: number): Date {
  // oxlint-disable-next-line effecttsgo/global-date -- independent oracle for local-time formatting.
  return new Date(timestampMs);
}

function localTime(timestampMs: number): string {
  const at = nativeDate(timestampMs);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${pad(at.getHours())}:${pad(at.getMinutes())}:${pad(at.getSeconds())}`;
}

const T = localTime(AT);

function entry(overrides: Partial<ComputeLogEntry> = {}): ComputeLogEntry {
  return {
    id: "row-1",
    timestampMs: AT,
    message: "compute shim: listening on :8080 (serving)",
    stream: "worker_guest_logs",
    attributes: { source: "worker_guest_logs", worker: "api" },
    ...overrides,
  };
}

describe("computeLogLevel", () => {
  it("derives the level from a request status, which arrives as a string", () => {
    const at = (status: string) =>
      computeLogLevel(entry({ stream: "worker_ingress_logs", attributes: { status } }));

    expect(at("200")).toBe("info");
    expect(at("301")).toBe("info");
    expect(at("404")).toBe("warn");
    expect(at("499")).toBe("warn");
    expect(at("500")).toBe("error");
    expect(at("503")).toBe("error");
  });

  it("reports no level for a request row with an unusable status", () => {
    expect(
      computeLogLevel(entry({ stream: "worker_ingress_logs", attributes: {} })),
    ).toBeUndefined();
    expect(
      computeLogLevel(entry({ stream: "worker_ingress_logs", attributes: { status: "wat" } })),
    ).toBeUndefined();
  });

  it("marks a failed build as an error and other events as info", () => {
    expect(
      computeLogLevel(entry({ stream: "worker_api_logs", attributes: { event: "build_failed" } })),
    ).toBe("error");
    expect(
      computeLogLevel(
        entry({ stream: "worker_api_logs", attributes: { event: "deploy_accepted" } }),
      ),
    ).toBe("info");
  });

  it("reports no level for guest output rather than guessing one", () => {
    // Nothing short of parsing tenant text could tell, so absent is the honest
    // answer.
    expect(computeLogLevel(entry())).toBeUndefined();
  });

  it("reports no level for an unknown stream", () => {
    expect(computeLogLevel(entry({ stream: "compute_future_logs" }))).toBeUndefined();
  });
});

describe("renderComputeLogLine", () => {
  it("prints the time and message for guest output", () => {
    expect(renderComputeLogLine(entry(), { showStream: false, colorStream: PLAIN })).toBe(
      `${T}  compute shim: listening on :8080 (serving)`,
    );
  });

  it("composes the request line from attributes, not the message", () => {
    // On the wire `event_message` is only "GET /" - status and duration live in
    // log_attributes, so the useful line has to be assembled.
    const line = renderComputeLogLine(
      entry({
        stream: "worker_ingress_logs",
        message: "GET /",
        attributes: { status: "200", method: "GET", path: "/", duration_ms: "23" },
      }),
      { showStream: false, colorStream: PLAIN },
    );

    expect(line).toBe(`${T}  200 GET / 23ms`);
  });

  it("prints the event and reason for a build line", () => {
    const line = renderComputeLogLine(
      entry({
        stream: "worker_api_logs",
        message: "build_failed ref/api",
        attributes: { event: "build_failed", reason: "exit status 1" },
      }),
      { showStream: false, colorStream: PLAIN },
    );

    expect(line).toBe(`${T}  build_failed exit status 1`);
  });

  it("falls back to the message for an unknown stream", () => {
    // The log contract is additive-only, so a new stream must still print.
    const line = renderComputeLogLine(
      entry({ stream: "compute_future_logs", message: "something new" }),
      { showStream: false, colorStream: PLAIN },
    );

    expect(line).toBe(`${T}  something new`);
  });

  it("renders local time, not UTC", () => {
    // Pinned against a fixed offset rather than the ambient zone, so the choice is
    // asserted on a UTC machine too, where local and UTC would otherwise coincide.
    const utc = nativeDate(AT).toISOString().slice(11, 19);
    const offsetMinutes = nativeDate(AT).getTimezoneOffset();
    const line = renderComputeLogLine(entry(), { showStream: false, colorStream: PLAIN });

    expect(line.startsWith(`${T}  `)).toBe(true);
    if (offsetMinutes !== 0) {
      expect(line.startsWith(`${utc}  `)).toBe(false);
    }
  });

  it("renders host-local midnight with an explicit zero-padded hour", () => {
    const midnight = nativeDate(AT);
    midnight.setHours(0, 0, 0, 0);
    const line = renderComputeLogLine(entry({ timestampMs: midnight.getTime() }), {
      showStream: false,
      colorStream: PLAIN,
    });

    expect(line.startsWith("00:00:00  ")).toBe(true);
  });

  it("renders a blank guest line as a blank line, not a dropped entry", () => {
    expect(
      renderComputeLogLine(entry({ message: "" }), { showStream: false, colorStream: PLAIN }),
    ).toBe(`${T}  `);
  });

  it("strips ANSI escapes a compute printed, so it cannot forge output", () => {
    const line = renderComputeLogLine(entry({ message: `${ESCAPE}[31mfake error${ESCAPE}[0m` }), {
      showStream: false,
      colorStream: PLAIN,
    });

    expect(line).toBe(`${T}  fake error`);
    expect(line).not.toContain(ESCAPE);
  });

  it("strips a cursor-repositioning sequence", () => {
    const line = renderComputeLogLine(entry({ message: `${ESCAPE}[2A${ESCAPE}[1Goverwritten` }), {
      showStream: false,
      colorStream: PLAIN,
    });

    expect(line).toBe(`${T}  overwritten`);
  });

  it("strips an OSC window-title sequence", () => {
    const line = renderComputeLogLine(entry({ message: `${ESCAPE}]0;title${ESCAPE}\\kept` }), {
      showStream: false,
      colorStream: PLAIN,
    });

    expect(line).toBe(`${T}  kept`);
  });

  // A carriage return returns the cursor to column zero, so a line carrying one
  // can overwrite the timestamp and tag already printed to its left.
  it("strips a carriage return so a line cannot overwrite its own prefix", () => {
    const line = renderComputeLogLine(entry({ message: "harmless\r00:00:00  forged" }), {
      showStream: false,
      colorStream: PLAIN,
    });

    expect(line).toBe(`${T}  harmless00:00:00  forged`);
    expect(line).not.toContain("\r");
  });

  it("folds a CRLF to a newline rather than dropping the break", () => {
    expect(
      renderComputeLogLine(entry({ message: "first\r\nsecond" }), {
        showStream: false,
        colorStream: PLAIN,
      }),
    ).toBe(`${T}  first\nsecond`);
  });

  // The request path is chosen by whoever called the compute, so it is as
  // untrusted as anything the compute printed itself.
  it("strips control sequences from request attributes", () => {
    const line = renderComputeLogLine(
      entry({
        stream: "worker_ingress_logs",
        attributes: {
          status: "200",
          method: "GET",
          path: `/${ESCAPE}[31m\rforged`,
          duration_ms: `12${ESCAPE}[0m`,
        },
      }),
      { showStream: false, colorStream: PLAIN },
    );

    expect(line).toBe(`${T}  200 GET /forged 12ms`);
    expect(line).not.toContain(ESCAPE);
  });

  // A build reason is relayed from the builder, which reports what it was given.
  it("strips control sequences from build attributes", () => {
    const line = renderComputeLogLine(
      entry({
        stream: "worker_api_logs",
        attributes: { event: `build_failed${ESCAPE}[2A`, reason: "oom\rforged" },
      }),
      { showStream: false, colorStream: PLAIN },
    );

    expect(line).toBe(`${T}  build_failed oomforged`);
    expect(line).not.toContain(ESCAPE);
  });

  it("keeps a stack trace's newlines and indentation intact", () => {
    const trace = "TypeError: boom\n    at handler (index.js:3:11)\n\tat run (index.js:9:2)";

    expect(
      renderComputeLogLine(entry({ message: trace }), {
        showStream: false,
        colorStream: PLAIN,
      }),
    ).toBe(`${T}  ${trace}`);
  });

  it("tints an error line red and a warning yellow, on the message only", () => {
    const server = entry({
      stream: "worker_ingress_logs",
      attributes: { status: "500", method: "GET", path: "/" },
    });
    const client = entry({
      stream: "worker_ingress_logs",
      attributes: { status: "404", method: "GET", path: "/" },
    });

    const errorLine = renderComputeLogLine(server, {
      showStream: false,
      colorStream: COLOURED,
    });
    const warnLine = renderComputeLogLine(client, {
      showStream: false,
      colorStream: COLOURED,
    });

    // The timestamp stays plain so nothing a script greps on changes colour.
    expect(errorLine.startsWith(`${T}  `)).toBe(true);
    expect(warnLine.startsWith(`${T}  `)).toBe(true);
    expect(errorLine).toContain(`${ESCAPE}[31m`);
    expect(warnLine).toContain(`${ESCAPE}[33m`);
  });

  it("leaves an info line untinted, so the exceptions stand out", () => {
    const line = renderComputeLogLine(
      entry({
        stream: "worker_ingress_logs",
        attributes: { status: "200", method: "GET", path: "/" },
      }),
      { showStream: false, colorStream: COLOURED },
    );

    expect(line).not.toContain(ESCAPE);
  });

  it("emits no escapes at all for a stream that cannot colour", () => {
    const line = renderComputeLogLine(
      entry({
        stream: "worker_ingress_logs",
        attributes: { status: "500", method: "GET", path: "/" },
      }),
      { showStream: false, colorStream: PLAIN },
    );

    expect(line).not.toContain(ESCAPE);
  });

  it("tags each stream with the word --kind accepts", () => {
    const tagged = (stream: string, attributes: Record<string, string> = {}) =>
      renderComputeLogLine(entry({ stream, attributes }), {
        showStream: true,
        colorStream: PLAIN,
      });

    expect(tagged("worker_guest_logs")).toContain("[app]");
    expect(tagged("worker_ingress_logs", { status: "200", method: "GET", path: "/" })).toContain(
      "[req]",
    );
    expect(tagged("worker_api_logs", { event: "deploy_accepted" })).toContain("[build]");
  });

  it("pads the tags so messages line up", () => {
    const app = renderComputeLogLine(entry(), { showStream: true, colorStream: PLAIN });
    const build = renderComputeLogLine(
      entry({ stream: "worker_api_logs", attributes: { event: "deploy_accepted" } }),
      { showStream: true, colorStream: PLAIN },
    );

    // A ragged left edge is harder to scan than a slightly wider one.
    expect(app.indexOf("compute shim")).toBe(build.indexOf("deploy_accepted"));
  });

  it("names an unknown stream rather than hiding it behind a placeholder", () => {
    const line = renderComputeLogLine(
      entry({ stream: "compute_future_logs", message: "from the future" }),
      { showStream: true, colorStream: PLAIN },
    );

    expect(line).toContain("[compute_future_logs]");
    expect(line).toContain("from the future");
  });

  it("omits the tag when one stream was pinned", () => {
    const line = renderComputeLogLine(entry(), { showStream: false, colorStream: PLAIN });

    expect(line).not.toContain("[");
    expect(line).toBe(`${T}  compute shim: listening on :8080 (serving)`);
  });
});
