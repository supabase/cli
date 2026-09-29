import { describe, expect, it } from "vitest";
import type { TraceData } from "effect/unstable/observability/OtlpTracer";
import { sanitizeAttributeEntries, sanitizeTraceData, scrubString } from "./trace-sanitize.ts";

const JWT =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJyb2xlIjoic2VydmljZV9yb2xlIn0.c2lnbmF0dXJlLXZhbHVl";

function traceWith(span: {
  readonly attributes?: TraceData["resourceSpans"][number]["scopeSpans"][number]["spans"][number]["attributes"];
  readonly events?: TraceData["resourceSpans"][number]["scopeSpans"][number]["spans"][number]["events"];
  readonly statusMessage?: string;
}): TraceData {
  return {
    resourceSpans: [
      {
        resource: { attributes: [], droppedAttributesCount: 0 },
        scopeSpans: [
          {
            scope: { name: "supabase-cli" },
            spans: [
              {
                traceId: "0".repeat(32),
                spanId: "0".repeat(16),
                parentSpanId: undefined,
                name: "span",
                kind: 1,
                startTimeUnixNano: "0",
                endTimeUnixNano: "1",
                attributes: span.attributes ?? [],
                droppedAttributesCount: 0,
                events: span.events ?? [],
                droppedEventsCount: 0,
                status:
                  span.statusMessage === undefined
                    ? { code: 1 }
                    : { code: 2, message: span.statusMessage },
                links: [],
                droppedLinksCount: 0,
              },
            ],
          },
        ],
      },
    ],
  };
}

const firstSpan = (data: TraceData) => data.resourceSpans[0]!.scopeSpans[0]!.spans[0]!;

describe("scrubString", () => {
  it.each([
    [
      "DSN credentials",
      "connect postgresql://postgres:hunter2@db.example.com:5432/postgres",
      "hunter2",
    ],
    ["bearer token", "Authorization: Bearer sbp_0123456789abcdef0123", "sbp_0123456789abcdef0123"],
    ["JWT", `token was ${JWT}`, JWT],
    ["Supabase secret key", "key sb_secret_abcdefghijklmnop", "sb_secret_abcdefghijklmnop"],
    ["password pair", "host=db user=postgres password=hunter2 dbname=x", "hunter2"],
    ["SQL literal password", "ALTER ROLE app WITH LOGIN PASSWORD 'hunter2'", "hunter2"],
    [
      "signed URL query",
      "GET https://x.supabase.co/storage/v1/object/sign/a.png?token=abc123",
      "abc123",
    ],
  ])("removes %s", (_label, input, secret) => {
    const scrubbed = scrubString(input);

    expect(scrubbed).not.toContain(secret);
    expect(scrubbed).toContain("<redacted>");
  });

  it("truncates long strings to 2 KB", () => {
    const scrubbed = scrubString("a".repeat(5000));

    expect(scrubbed.startsWith("a".repeat(2048))).toBe(true);
    expect(scrubbed.length).toBeLessThan(2100);
    expect(scrubbed).toContain("[truncated]");
  });

  it("keeps ordinary text unchanged", () => {
    expect(scrubString("migration 20240101 applied")).toBe("migration 20240101 applied");
  });
});

describe("sanitizeAttributeEntries", () => {
  it("replaces the query text with its shape", () => {
    const text = "SELECT * FROM auth.users WHERE email = 'a@b.c'";

    const attributes = Object.fromEntries(sanitizeAttributeEntries([["db.query.text", text]]));

    expect(attributes).toEqual({
      "db.operation.name": "SELECT",
      "db.query.hash": expect.stringMatching(/^[0-9a-f]+$/u),
      "db.query.length": text.length,
    });
  });

  it("strips the query from url.full and drops url.query", () => {
    const attributes = Object.fromEntries(
      sanitizeAttributeEntries([
        ["url.full", "https://user:pw@x.supabase.co/storage/v1/object/sign/a.png?token=abc"],
        ["url.query", "token=abc"],
      ]),
    );

    expect(attributes).toEqual({
      "url.full": "https://x.supabase.co/storage/v1/object/sign/a.png",
    });
  });

  it("keeps only allowlisted headers", () => {
    const attributes = Object.fromEntries(
      sanitizeAttributeEntries([
        ["http.request.header.content-type", "application/json"],
        ["http.request.header.authorization", "Bearer abc"],
        ["http.response.header.location", "https://x.supabase.co/cb?code=secret"],
        ["http.response.header.x-request-id", "req-1"],
      ]),
    );

    expect(attributes).toEqual({
      "http.request.header.content-type": "application/json",
      "http.response.header.x-request-id": "req-1",
    });
  });

  it("drops keys that name credentials", () => {
    const attributes = Object.fromEntries(
      sanitizeAttributeEntries([
        ["db.password", "hunter2"],
        ["access_token", "abc"],
        ["service", "db"],
      ]),
    );

    expect(attributes).toEqual({ service: "db" });
  });
});

describe("sanitizeTraceData", () => {
  it("scrubs a DSN in the exception message, stacktrace, and status message", () => {
    const dsn = "postgresql://postgres:hunter2@127.0.0.1:54322/postgres";
    const data = traceWith({
      statusMessage: `connect failed for ${dsn}`,
      events: [
        {
          name: "exception",
          timeUnixNano: "1",
          droppedAttributesCount: 0,
          attributes: [
            { key: "exception.message", value: { stringValue: `connect failed for ${dsn}` } },
            { key: "exception.stacktrace", value: { stringValue: `Error: ${dsn}\n    at x` } },
          ],
        },
      ],
    });

    const serialized = JSON.stringify(sanitizeTraceData(data));

    expect(serialized).not.toContain("hunter2");
    expect(firstSpan(sanitizeTraceData(data)).status.message).toContain("<redacted>@127.0.0.1");
  });

  it("replaces db.query.text with the operation, hash, and length", () => {
    const text = "ALTER ROLE app PASSWORD 'hunter2'";
    const data = traceWith({
      attributes: [{ key: "db.query.text", value: { stringValue: text } }],
    });

    const attributes = firstSpan(sanitizeTraceData(data)).attributes;

    expect(attributes.map((attribute) => attribute.key)).toEqual([
      "db.operation.name",
      "db.query.hash",
      "db.query.length",
    ]);
    expect(JSON.stringify(attributes)).not.toContain("hunter2");
  });

  it("drops a location header carrying a signed URL", () => {
    const data = traceWith({
      attributes: [
        {
          key: "http.response.header.location",
          value: { stringValue: "https://x.supabase.co/object/sign/a?token=abc" },
        },
        { key: "http.response.status_code", value: { intValue: 302 } },
      ],
    });

    expect(firstSpan(sanitizeTraceData(data)).attributes).toEqual([
      { key: "http.response.status_code", value: { intValue: 302 } },
    ]);
  });
});
