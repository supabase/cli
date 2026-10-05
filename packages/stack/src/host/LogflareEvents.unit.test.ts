import { expect, it } from "@effect/vitest";
import { formatAccess } from "./GatewayLog.ts";
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

it("ships an Auth JSON line nested too deep for metadata as its raw message", () => {
  const depth = 16_000;
  const line = `{"msg":"deep","detail":${"[".repeat(depth)}${"]".repeat(depth)}}`;
  expect(logflareEvent("auth", received, line)).toEqual({
    project: "default",
    appname: "auth",
    event_message: line,
    timestamp: received,
    metadata: {},
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

it("splits PostgREST's timestamp prefix from a message that contains a colon", () => {
  const event = logflareEvent(
    "rest",
    received,
    "28/Sep/2026:12:30:15 +0200: Failed to load schema cache: connection refused",
  );
  expect(event.event_message).toBe("Failed to load schema cache: connection refused");
  expect(event.timestamp).toBe("2026-09-28T10:30:15.000Z");
});

it("parses a PostgREST request line into request metadata stamped with the request time", () => {
  const line =
    '172.18.0.1 - anon [28/Sep/2026:12:30:15 +0200] "GET /items?select=id HTTP/1.1" 200 2 "" "curl/8.7.1"';
  expect(logflareEvent("rest", received, line)).toEqual({
    project: "default",
    appname: "rest",
    event_message: line,
    timestamp: "2026-09-28T10:30:15.000Z",
    metadata: {
      host: "default",
      method: "GET",
      path: "/items?select=id",
      protocol: "HTTP/1.1",
      status: 200,
    },
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

it("ships a gateway access line as an API Gateway request stamped with its request time", () => {
  const line = formatAccess({
    time: Date.parse("2026-10-01T09:25:23.456Z"),
    client: "127.0.0.1",
    method: "GET",
    target: '/rest/v1/todos?select=*&q="x"',
    protocol: "HTTP/1.1",
    status: 200,
    bytes: 126,
    userAgent: "curl/8.7.1",
    durationMillis: 12,
  });

  expect(line).toBe(
    '127.0.0.1 - - [01/Oct/2026:09:25:23.456 +0000] "GET /rest/v1/todos?select=*&q=\\x22x\\x22 HTTP/1.1" 200 126 "-" "curl/8.7.1" 12ms',
  );
  expect(logflareEvent("gateway", received, line)).toEqual({
    project: "default",
    appname: "gateway",
    event_message: line,
    timestamp: "2026-10-01T09:25:23.456Z",
    metadata: {
      request: {
        method: "GET",
        path: "/rest/v1/todos",
        search: '?select=*&q="x"',
        protocol: "HTTP/1.1",
        headers: { cf_connecting_ip: "127.0.0.1", user_agent: "curl/8.7.1" },
      },
      response: { status_code: 200 },
    },
  });
});

it("passes a malformed gateway line through without request metadata", () => {
  expect(logflareEvent("gateway", received, "not an access line")).toEqual({
    project: "default",
    appname: "gateway",
    event_message: "not an access line",
    timestamp: received,
    metadata: {},
  });
});

it("replaces NUL and unpaired surrogates, which Postgres jsonb rejects, in the message and metadata", () => {
  const line = String.raw`{"msg":"a\u0000b","detail":["\ud800"],"k\u0000":"\udc00 x"}`;
  const event = logflareEvent("auth", received, line);

  expect(logflareEvent("database", received, "a\u0000b").event_message).toBe("a�b");
  expect(event.metadata).toMatchObject({
    msg: "a�b",
    detail: ["�"],
    "k�": "� x",
  });
  expect(event.event_message).toBe(line);
});
