import { describe, expect, it } from "@effect/vitest";
import type { WorkerLogEntry } from "../../../../shared/workers/worker-logs-api.ts";
import { legacyRenderWorkerLogLine, legacyWorkerLogLevel } from "./workers-logs.format.ts";

const ESCAPE = "\u001b";

/**
 * Colour is decided by the stream, so the tests supply one. This keeps them
 * independent of ambient NO_COLOR / CI / TTY state, and lets the coloured
 * rendering be asserted at all rather than only its absence.
 */
const PLAIN = { hasColors: () => false };
const COLOURED = { hasColors: () => true };
const AT = Date.parse("2026-08-31T14:45:32.576Z");

/**
 * The expected `HH:MM:SS` prefix for an instant, in this machine's zone.
 *
 * Derived rather than hardcoded: the renderer prints local time, so a literal
 * `"14:45:32"` would pass only on a UTC machine and fail everywhere else. Written
 * with the same field accessors the renderer uses, so what it pins is the format
 * and the zone choice, not an arithmetic that could drift with the clock.
 */
function localTime(timestampMs: number): string {
  const at = new Date(timestampMs);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${pad(at.getHours())}:${pad(at.getMinutes())}:${pad(at.getSeconds())}`;
}

const T = localTime(AT);

function entry(overrides: Partial<WorkerLogEntry> = {}): WorkerLogEntry {
  return {
    id: "row-1",
    timestampMs: AT,
    message: "workers shim: listening on :8080 (serving)",
    stream: "worker_guest_logs",
    attributes: { source: "worker_guest_logs", worker: "api" },
    ...overrides,
  };
}

describe("legacyWorkerLogLevel", () => {
  it("derives the level from a request status, which arrives as a string", () => {
    const at = (status: string) =>
      legacyWorkerLogLevel(entry({ stream: "worker_ingress_logs", attributes: { status } }));

    expect(at("200")).toBe("info");
    expect(at("301")).toBe("info");
    expect(at("404")).toBe("warn");
    expect(at("499")).toBe("warn");
    expect(at("500")).toBe("error");
    expect(at("503")).toBe("error");
  });

  it("reports no level for a request row with an unusable status", () => {
    expect(
      legacyWorkerLogLevel(entry({ stream: "worker_ingress_logs", attributes: {} })),
    ).toBeUndefined();
    expect(
      legacyWorkerLogLevel(entry({ stream: "worker_ingress_logs", attributes: { status: "wat" } })),
    ).toBeUndefined();
  });

  it("marks a failed build as an error and other events as info", () => {
    expect(
      legacyWorkerLogLevel(
        entry({ stream: "worker_api_logs", attributes: { event: "build_failed" } }),
      ),
    ).toBe("error");
    expect(
      legacyWorkerLogLevel(
        entry({ stream: "worker_api_logs", attributes: { event: "deploy_accepted" } }),
      ),
    ).toBe("info");
  });

  it("reports no level for guest output rather than guessing one", () => {
    // Nothing short of parsing tenant text could tell, so absent is the honest
    // answer.
    expect(legacyWorkerLogLevel(entry())).toBeUndefined();
  });

  it("reports no level for an unknown stream", () => {
    expect(legacyWorkerLogLevel(entry({ stream: "worker_future_logs" }))).toBeUndefined();
  });
});

describe("legacyRenderWorkerLogLine", () => {
  it("prints the time and message for guest output", () => {
    expect(legacyRenderWorkerLogLine(entry(), { showStream: false, colorStream: PLAIN })).toBe(
      `${T}  workers shim: listening on :8080 (serving)`,
    );
  });

  it("composes the request line from attributes, not the message", () => {
    // On the wire `event_message` is only "GET /" - status and duration live in
    // log_attributes, so the useful line has to be assembled.
    const line = legacyRenderWorkerLogLine(
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
    const line = legacyRenderWorkerLogLine(
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
    const line = legacyRenderWorkerLogLine(
      entry({ stream: "worker_future_logs", message: "something new" }),
      { showStream: false, colorStream: PLAIN },
    );

    expect(line).toBe(`${T}  something new`);
  });

  it("renders local time, not UTC", () => {
    // Pinned against a fixed offset rather than the ambient zone, so the choice is
    // asserted on a UTC machine too, where local and UTC would otherwise coincide.
    const utc = new Date(AT).toISOString().slice(11, 19);
    const offsetMinutes = new Date(AT).getTimezoneOffset();
    const line = legacyRenderWorkerLogLine(entry(), { showStream: false, colorStream: PLAIN });

    expect(line.startsWith(`${T}  `)).toBe(true);
    if (offsetMinutes !== 0) {
      expect(line.startsWith(`${utc}  `)).toBe(false);
    }
  });

  it("renders a blank guest line as a blank line, not a dropped entry", () => {
    expect(
      legacyRenderWorkerLogLine(entry({ message: "" }), { showStream: false, colorStream: PLAIN }),
    ).toBe(`${T}  `);
  });

  it("strips ANSI escapes a worker printed, so it cannot forge output", () => {
    const line = legacyRenderWorkerLogLine(
      entry({ message: `${ESCAPE}[31mfake error${ESCAPE}[0m` }),
      { showStream: false, colorStream: PLAIN },
    );

    expect(line).toBe(`${T}  fake error`);
    expect(line).not.toContain(ESCAPE);
  });

  it("strips a cursor-repositioning sequence", () => {
    const line = legacyRenderWorkerLogLine(
      entry({ message: `${ESCAPE}[2A${ESCAPE}[1Goverwritten` }),
      { showStream: false, colorStream: PLAIN },
    );

    expect(line).toBe(`${T}  overwritten`);
  });

  it("strips an OSC window-title sequence", () => {
    const line = legacyRenderWorkerLogLine(entry({ message: `${ESCAPE}]0;title${ESCAPE}\\kept` }), {
      showStream: false,
      colorStream: PLAIN,
    });

    expect(line).toBe(`${T}  kept`);
  });

  it("keeps a stack trace's newlines and indentation intact", () => {
    const trace = "TypeError: boom\n    at handler (index.js:3:11)\n\tat run (index.js:9:2)";

    expect(
      legacyRenderWorkerLogLine(entry({ message: trace }), {
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

    const errorLine = legacyRenderWorkerLogLine(server, {
      showStream: false,
      colorStream: COLOURED,
    });
    const warnLine = legacyRenderWorkerLogLine(client, {
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
    const line = legacyRenderWorkerLogLine(
      entry({
        stream: "worker_ingress_logs",
        attributes: { status: "200", method: "GET", path: "/" },
      }),
      { showStream: false, colorStream: COLOURED },
    );

    expect(line).not.toContain(ESCAPE);
  });

  it("emits no escapes at all for a stream that cannot colour", () => {
    const line = legacyRenderWorkerLogLine(
      entry({
        stream: "worker_ingress_logs",
        attributes: { status: "500", method: "GET", path: "/" },
      }),
      { showStream: false, colorStream: PLAIN },
    );

    expect(line).not.toContain(ESCAPE);
  });

  it("tags each stream with the word --source accepts", () => {
    const tagged = (stream: string, attributes: Record<string, string> = {}) =>
      legacyRenderWorkerLogLine(entry({ stream, attributes }), {
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
    const app = legacyRenderWorkerLogLine(entry(), { showStream: true, colorStream: PLAIN });
    const build = legacyRenderWorkerLogLine(
      entry({ stream: "worker_api_logs", attributes: { event: "deploy_accepted" } }),
      { showStream: true, colorStream: PLAIN },
    );

    // A ragged left edge is harder to scan than a slightly wider one.
    expect(app.indexOf("workers shim")).toBe(build.indexOf("deploy_accepted"));
  });

  it("names an unknown stream rather than hiding it behind a placeholder", () => {
    const line = legacyRenderWorkerLogLine(
      entry({ stream: "worker_future_logs", message: "from the future" }),
      { showStream: true, colorStream: PLAIN },
    );

    expect(line).toContain("[worker_future_logs]");
    expect(line).toContain("from the future");
  });

  it("omits the tag when one stream was pinned", () => {
    const line = legacyRenderWorkerLogLine(entry(), { showStream: false, colorStream: PLAIN });

    expect(line).not.toContain("[");
    expect(line).toBe(`${T}  workers shim: listening on :8080 (serving)`);
  });
});
