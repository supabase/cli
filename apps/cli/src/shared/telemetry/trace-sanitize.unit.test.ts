import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "vitest";
import { Effect, Exit } from "effect";
import type { TraceData } from "effect/unstable/observability/OtlpTracer";
import { SqlError, UniqueViolation } from "effect/unstable/sql/SqlError";
import { DbExecError } from "../../command-internal/db-connection.errors.ts";
import { makeTraceSanitizer, scrubString, sqlStateOf } from "./trace-sanitize.ts";

const JWT =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJyb2xlIjoic2VydmljZV9yb2xlIn0.c2lnbmF0dXJlLXZhbHVl";

const newSanitizer = () =>
  Effect.runSync(makeTraceSanitizer.pipe(Effect.provide(BunServices.layer)));
const sanitizer = newSanitizer();
const sanitizeAttributeEntries = sanitizer.attributeEntries;
const sanitizeTraceData = sanitizer.traceData;

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

  it.each([
    ["a SQL literal", "syntax error near 'hunter2'", "syntax error near '<redacted>'"],
    ["an escaped SQL literal", "value 'it''s hunter2' rejected", "value '<redacted>' rejected"],
    [
      "a constraint detail",
      "Key (email)=(a@b.c) already exists.",
      "Key (email)=(<redacted>) already exists.",
    ],
    [
      "a composite constraint detail",
      "Key (org_id, lower(email))=(7, a@b.c) is not present in table",
      "Key (org_id, lower(email))=(<redacted>) is not present in table",
    ],
  ])("redacts %s", (_label, input, expected) => {
    expect(scrubString(input)).toBe(expected);
  });

  it("keeps apostrophes inside words", () => {
    expect(scrubString("can't read the project's config")).toBe("can't read the project's config");
  });
});

describe("attribute entries", () => {
  it("replaces the query text with its shape", () => {
    const text = "SELECT * FROM auth.users WHERE email = 'a@b.c'";

    const attributes = Object.fromEntries(sanitizeAttributeEntries([["db.query.text", text]]));

    expect(attributes).toEqual({
      "db.operation.name": "SELECT",
      "db.query.hash": expect.stringMatching(/^[0-9a-f]{16}$/u),
      "db.query.length": text.length,
    });
  });

  it("hashes a repeated query the same within one sanitizer and differently across sanitizers", () => {
    const query = [["db.query.text", "SELECT * FROM storage.objects WHERE id = $1"]] as const;
    const hashOf = (entries: ReadonlyArray<readonly [string, unknown]>) =>
      Object.fromEntries(entries)["db.query.hash"];

    const first = hashOf(sanitizeAttributeEntries(query));
    const repeated = hashOf(sanitizeAttributeEntries(query));
    const otherRun = hashOf(newSanitizer().attributeEntries(query));

    expect(repeated).toBe(first);
    expect(otherRun).not.toBe(first);
  });

  it("strips the query from url.full and drops url.query", () => {
    const attributes = Object.fromEntries(
      sanitizeAttributeEntries([
        ["url.full", "https://user:pw@x.supabase.co/storage/v1/object/sign/a.png?token=abc"],
        ["url.query", "token=abc"],
      ]),
    );

    expect(attributes).toEqual({
      "url.full": "https://x.supabase.co/storage/v1/object/sign/<redacted>",
    });
  });

  it.each([
    ["/storage/v1/object/sign/avatars/u1/a.png", "/storage/v1/object/sign/<redacted>"],
    ["/storage/v1/object/avatars/u1/a.png", "/storage/v1/object/<redacted>"],
    ["/storage/v1/object/list/avatars", "/storage/v1/object/list/<redacted>"],
    ["/storage/v1/object/move", "/storage/v1/object/move"],
    ["/v1/projects/abc/functions", "/v1/projects/abc/functions"],
  ])("redacts the Storage object in url.path and url.full for %s", (path, expected) => {
    const attributes = Object.fromEntries(
      sanitizeAttributeEntries([
        ["url.path", path],
        ["url.full", `https://x.supabase.co${path}`],
      ]),
    );

    expect(attributes).toEqual({
      "url.path": expected,
      "url.full": `https://x.supabase.co${expected}`,
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

  it("keeps numeric and boolean values under credential-named keys", () => {
    const attributes = Object.fromEntries(
      sanitizeAttributeEntries([
        ["secret.count", 3],
        ["secret.batch_count", 1],
        ["config.access_token_from_env", true],
        ["secret.name", "STRIPE_KEY"],
      ]),
    );

    expect(attributes).toEqual({
      "secret.count": 3,
      "secret.batch_count": 1,
      "config.access_token_from_env": true,
    });
  });
});

const failingMigration = [
  'ERROR: null value in column "role" violates not-null constraint (SQLSTATE 23502)',
  "Detail: Failing row contains (1, alice@example.com, s3cret).",
].join("\n");
const dollarQuotedBody =
  "CREATE FUNCTION seed() RETURNS text AS $$ SELECT $pw$dollar-quoted-secret$pw$ $$ LANGUAGE sql";
const escapeLiteral = "syntax error at or near E'it\\'s-e-literal-secret'";
const storageError = "Object not found: bucket/private/key.pdf";

describe("trace data", () => {
  it("exports only allowlisted resource attributes", () => {
    const data = traceWith({});
    const withResource: TraceData = {
      resourceSpans: data.resourceSpans.map((resourceSpan) => ({
        ...resourceSpan,
        resource: {
          ...resourceSpan.resource,
          attributes: [
            { key: "service.name", value: { stringValue: "supabase-cli" } },
            { key: "os", value: { stringValue: "darwin" } },
            { key: "deployment.owner", value: { stringValue: "alice@example.com" } },
          ],
        },
      })),
    };

    expect(
      sanitizeTraceData(withResource).resourceSpans[0]!.resource.attributes.map(
        (attribute) => attribute.key,
      ),
    ).toEqual(["service.name", "os"]);
  });

  it("exports exception events with only the error type and drops the status message", () => {
    const data = traceWith({
      statusMessage: failingMigration,
      events: [
        {
          name: "exception",
          timeUnixNano: "1",
          droppedAttributesCount: 0,
          attributes: [
            { key: "exception.type", value: { stringValue: "DbExecError" } },
            { key: "exception.message", value: { stringValue: failingMigration } },
            {
              key: "exception.stacktrace",
              value: { stringValue: `DbExecError: ${storageError}\n    at ${escapeLiteral}` },
            },
          ],
        },
      ],
    });

    const span = firstSpan(sanitizeTraceData(data));

    expect(span.status).toEqual({ code: 2 });
    expect(span.events.map(({ name, attributes }) => ({ name, attributes }))).toEqual([
      {
        name: "exception",
        attributes: [{ key: "exception.type", value: { stringValue: "DbExecError" } }],
      },
    ]);
  });

  it("renames log events to log and keeps only their level", () => {
    const data = traceWith({
      events: [dollarQuotedBody, escapeLiteral, storageError].map((message) => ({
        name: message,
        timeUnixNano: "1",
        droppedAttributesCount: 0,
        attributes: [
          { key: "effect.fiberId", value: { intValue: 7 } },
          { key: "effect.logLevel", value: { stringValue: "INFO" } },
          { key: "effect.cause", value: { stringValue: failingMigration } },
          { key: "migration.file", value: { stringValue: "20240101_seed.sql" } },
        ],
      })),
    });

    const span = firstSpan(sanitizeTraceData(data));

    expect(span.events.map(({ name, attributes }) => ({ name, attributes }))).toEqual(
      Array.from({ length: 3 }, () => ({
        name: "log",
        attributes: [{ key: "effect.logLevel", value: { stringValue: "INFO" } }],
      })),
    );
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

  it("keeps numeric and boolean values under credential-named keys", () => {
    const data = traceWith({
      attributes: [
        { key: "vault.secret_count", value: { intValue: 2 } },
        { key: "config.access_token_from_env", value: { boolValue: false } },
        { key: "secret.value", value: { stringValue: "hunter2" } },
      ],
    });

    expect(firstSpan(sanitizeTraceData(data)).attributes).toEqual([
      { key: "vault.secret_count", value: { intValue: 2 } },
      { key: "config.access_token_from_env", value: { boolValue: false } },
    ]);
  });

  it("redacts the Storage object key in url.path", () => {
    const data = traceWith({
      attributes: [
        { key: "url.path", value: { stringValue: "/storage/v1/object/public/avatars/u1.png" } },
      ],
    });

    expect(firstSpan(sanitizeTraceData(data)).attributes).toEqual([
      { key: "url.path", value: { stringValue: "/storage/v1/object/public/<redacted>" } },
    ]);
  });
});

describe("sqlStateOf", () => {
  it("reads the code of a CLI exec error", () => {
    const error = new DbExecError({ message: failingMigration, code: "23502" });

    expect(sqlStateOf(Exit.fail(error))).toBe("23502");
  });

  it("reads the driver code through a SqlError reason", () => {
    const driverError = { severity: "ERROR", code: "23505", message: "duplicate key" };
    const error = new SqlError({
      reason: new UniqueViolation({ cause: driverError, constraint: "users_email_key" }),
    });

    expect(sqlStateOf(Exit.fail(error))).toBe("23505");
  });

  it("ignores node errno codes and successful exits", () => {
    const errno = (code: string) => Object.assign(new Error(`failed ${code}`), { code });

    for (const code of ["ECONNREFUSED", "EPERM", "EPIPE", "E2BIG"]) {
      expect(sqlStateOf(Exit.fail(errno(code)))).toBeUndefined();
    }
    expect(sqlStateOf(Exit.void)).toBeUndefined();
  });

  it("accepts letter-class SQLSTATEs", () => {
    expect(sqlStateOf(Exit.fail(new DbExecError({ message: "raise", code: "P0001" })))).toBe(
      "P0001",
    );
  });
});
