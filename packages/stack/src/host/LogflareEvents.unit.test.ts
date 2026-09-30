import { expect, it } from "@effect/vitest";
import { logflareEvent } from "./LogflareEvents.ts";

const received = "2026-09-28T10:00:00.000Z";

it("merges structured Auth lines into metadata and keeps the raw message", () => {
  const line =
    '{"level":"info","msg":"request completed","time":"2026-09-28T09:59:59Z","path":"/health"}';
  expect(logflareEvent("auth", received, line)).toEqual({
    project: "default",
    appname: "auth",
    event_message: line,
    timestamp: received,
    metadata: {
      timestamp: "2026-09-28T09:59:59Z",
      level: "info",
      msg: "request completed",
      time: "2026-09-28T09:59:59Z",
      path: "/health",
    },
  });
});

it("splits PostgREST's timestamp prefix from the message and converts its zone offset", () => {
  expect(
    logflareEvent("rest", received, "28/Sep/2026:12:30:15 +0200: Starting PostgREST 13.0.7..."),
  ).toEqual({
    project: "default",
    appname: "rest",
    event_message: "Starting PostgREST 13.0.7...",
    timestamp: "2026-09-28T10:30:15.000Z",
    metadata: { host: "default" },
  });
});

it("keeps a PostgREST line whose prefix is not a timestamp", () => {
  const event = logflareEvent("rest", received, "Config: schema cache loaded");
  expect(event.event_message).toBe("Config: schema cache loaded");
  expect(event.timestamp).toBe(received);
});

it("extracts the Realtime level and moves the project into metadata", () => {
  expect(
    logflareEvent("realtime", received, "10:00:01.123 [info] Running RealtimeWeb.Endpoint"),
  ).toEqual({
    appname: "realtime",
    event_message: "Running RealtimeWeb.Endpoint",
    timestamp: received,
    metadata: { project: "default", external_id: "default", level: "info" },
  });
});

it("parses Storage JSON lines into the tenant metadata shape", () => {
  expect(
    logflareEvent(
      "storage",
      received,
      '{"level":"info","time":"2026-09-28T09:59:58Z","pid":7,"hostname":"storage","msg":"listening"}',
    ),
  ).toEqual({
    appname: "storage",
    event_message: "listening",
    timestamp: received,
    metadata: {
      project: "default",
      tenantId: "default",
      level: "info",
      timestamp: "2026-09-28T09:59:58Z",
      context: [{ host: "storage", pid: 7 }],
    },
  });
});

it("tags Functions lines with the project ref", () => {
  expect(logflareEvent("functions", received, "booted worker")).toEqual({
    appname: "functions",
    event_message: "booted worker",
    timestamp: received,
    metadata: { project_ref: "default" },
  });
});

it("derives the Postgres severity from the last level marker and defaults to LOG", () => {
  const line = "2026-09-28 10:00:00.000 UTC [77] ERROR:  relation does not exist";
  expect(logflareEvent("database", received, line)).toEqual({
    project: "default",
    appname: "database",
    event_message: line,
    timestamp: received,
    metadata: { host: "db-default", parsed: { timestamp: received, error_severity: "ERROR" } },
  });
  expect(logflareEvent("database", received, "\tat character 15").metadata.parsed).toEqual({
    timestamp: received,
    error_severity: "LOG",
  });
});
