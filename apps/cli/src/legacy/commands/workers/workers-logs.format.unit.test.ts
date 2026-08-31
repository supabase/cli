import { describe, expect, it } from "@effect/vitest";
import type { WorkerLogEntry } from "../../../shared/workers/worker-logs-api.ts";
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
    expect(legacyRenderWorkerLogLine(entry(), PLAIN)).toBe(
      "14:45:32  workers shim: listening on :8080 (serving)",
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
      PLAIN,
    );

    expect(line).toBe("14:45:32  200 GET / 23ms");
  });

  it("prints the event and reason for a build line", () => {
    const line = legacyRenderWorkerLogLine(
      entry({
        stream: "worker_api_logs",
        message: "build_failed ref/api",
        attributes: { event: "build_failed", reason: "exit status 1" },
      }),
      PLAIN,
    );

    expect(line).toBe("14:45:32  build_failed exit status 1");
  });

  it("falls back to the message for an unknown stream", () => {
    // The log contract is additive-only, so a new stream must still print.
    const line = legacyRenderWorkerLogLine(
      entry({ stream: "worker_future_logs", message: "something new" }),
      PLAIN,
    );

    expect(line).toBe("14:45:32  something new");
  });

  it("renders a blank guest line as a blank line, not a dropped entry", () => {
    expect(legacyRenderWorkerLogLine(entry({ message: "" }), PLAIN)).toBe("14:45:32  ");
  });

  it("strips ANSI escapes a worker printed, so it cannot forge output", () => {
    const line = legacyRenderWorkerLogLine(
      entry({ message: `${ESCAPE}[31mfake error${ESCAPE}[0m` }),
      PLAIN,
    );

    expect(line).toBe("14:45:32  fake error");
    expect(line).not.toContain(ESCAPE);
  });

  it("strips a cursor-repositioning sequence", () => {
    const line = legacyRenderWorkerLogLine(
      entry({ message: `${ESCAPE}[2A${ESCAPE}[1Goverwritten` }),
      PLAIN,
    );

    expect(line).toBe("14:45:32  overwritten");
  });

  it("strips an OSC window-title sequence", () => {
    const line = legacyRenderWorkerLogLine(
      entry({ message: `${ESCAPE}]0;title${ESCAPE}\\kept` }),
      PLAIN,
    );

    expect(line).toBe("14:45:32  kept");
  });

  it("keeps a stack trace's newlines and indentation intact", () => {
    const trace = "TypeError: boom\n    at handler (index.js:3:11)\n\tat run (index.js:9:2)";

    expect(legacyRenderWorkerLogLine(entry({ message: trace }), PLAIN)).toBe(`14:45:32  ${trace}`);
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

    const errorLine = legacyRenderWorkerLogLine(server, COLOURED);
    const warnLine = legacyRenderWorkerLogLine(client, COLOURED);

    // The timestamp stays plain so nothing a script greps on changes colour.
    expect(errorLine.startsWith("14:45:32  ")).toBe(true);
    expect(warnLine.startsWith("14:45:32  ")).toBe(true);
    expect(errorLine).toContain(`${ESCAPE}[31m`);
    expect(warnLine).toContain(`${ESCAPE}[33m`);
  });

  it("leaves an info line untinted, so the exceptions stand out", () => {
    const line = legacyRenderWorkerLogLine(
      entry({
        stream: "worker_ingress_logs",
        attributes: { status: "200", method: "GET", path: "/" },
      }),
      COLOURED,
    );

    expect(line).not.toContain(ESCAPE);
  });

  it("emits no escapes at all for a stream that cannot colour", () => {
    const line = legacyRenderWorkerLogLine(
      entry({
        stream: "worker_ingress_logs",
        attributes: { status: "500", method: "GET", path: "/" },
      }),
      PLAIN,
    );

    expect(line).not.toContain(ESCAPE);
  });
});
