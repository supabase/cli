import { createHmac } from "node:crypto";
import { Cause, Crypto, Effect, Exit } from "effect";
import type { KeyValue, AnyValue } from "effect/observability/OtlpResource";
import type { ScopeSpan, TraceData } from "effect/observability/OtlpTracer";

const MAX_STRING_LENGTH = 2048;
const REDACTED = "<redacted>";
const QUERY_HASH_SALT_BYTES = 32;
const QUERY_HASH_HEX_LENGTH = 16;
const MAX_CAUSE_DEPTH = 6;
/** SQLSTATE classes start with a digit or `F0`/`HV`/`P0`/`XX`, which excludes errno names like `E2BIG`. */
const POSTGRES_SQLSTATE = /^(?:[0-9][0-9A-Z]|F0|HV|P0|XX)[0-9A-Z]{3}$/u;
const TRACE_IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$.]{0,99}$/u;
const FALLBACK_ERROR_TYPE = "Error";
/** Effect also merges `OTEL_RESOURCE_ATTRIBUTES` into the resource; only these keys are exported. */
const RESOURCE_ATTRIBUTE_KEPT: ReadonlySet<string> = new Set([
  "service.name",
  "service.version",
  "os",
  "arch",
  "is_ci",
  "service.instance.id",
  "telemetry.sdk.name",
  "telemetry.sdk.language",
  "telemetry.sdk.version",
]);
const EXCEPTION_EVENT = "exception";
const LOG_EVENT = "log";
const EVENT_ATTRIBUTE_KEPT = {
  [EXCEPTION_EVENT]: "exception.type",
  [LOG_EVENT]: "effect.logLevel",
};

type SpanEvent = ScopeSpan["spans"][number]["events"][number];
type QueryHasher = (text: string) => string;

const ALLOWED_HEADERS: ReadonlySet<string> = new Set([
  "content-type",
  "content-length",
  "user-agent",
  "x-request-id",
  "cf-ray",
  "retry-after",
]);
const HEADER_ATTRIBUTE = /^http\.(?:request|response)\.header\.(.+)$/u;
const DENIED_KEY = /token|password|secret|apikey|api_key|authorization|cookie/iu;

const VALUE_SCRUBBERS: ReadonlyArray<readonly [RegExp, string]> = [
  // Greedy to the last `@`, since a password may itself contain `/` or `@`.
  [/\b([a-z][a-z0-9+.-]*:\/\/)[^\s"'<>]+@/giu, `$1${REDACTED}@`],
  [/(https?:\/\/[^\s?#"'<>]+)\?[^\s#"'<>]*/giu, `$1?${REDACTED}`],
  [/\b(bearer\s+)[A-Za-z0-9._~+/=-]+/giu, `$1${REDACTED}`],
  [/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*/gu, REDACTED],
  [/\b(?:sbp|sba|sb_secret|sb_publishable)_[A-Za-z0-9_-]{8,}/gu, REDACTED],
  [/(\bpassword\s+)'(?:[^']|'')*'/giu, `$1'${REDACTED}'`],
  [
    /\b(password|passwd|pwd|secret|token|apikey|api_key)(\s*[=:]\s*)("[^"]*"|'[^']*'|[^\s&;,]+)/giu,
    `$1$2${REDACTED}`,
  ],
  // Postgres constraint details such as `Key (email)=(a@b.c) already exists.`
  [/(\bkey \((?:[^()]|\([^()]*\))*\)=\()(?:[^()]|\([^()]*\))*\)/giu, `$1${REDACTED})`],
  // SQL string literals; the lookarounds leave apostrophes inside words alone.
  [/(?<![\w'])'(?:[^']|'')*'(?!\w)/gu, `'${REDACTED}'`],
];

const STORAGE_PATH = "/storage/v1/";
const STORAGE_OBJECT_ROUTE = "object/";
/** Storage routes whose remaining path segments name a bucket or object. */
const STORAGE_NAMED_ROUTES: ReadonlyArray<string> = [
  STORAGE_OBJECT_ROUTE,
  "bucket/",
  "iceberg/bucket/",
];
const STORAGE_OBJECT_VERBS: ReadonlySet<string> = new Set([
  "sign",
  "public",
  "authenticated",
  "list",
  "info",
  "move",
  "copy",
  "upload",
]);

/** Removes credentials from free text and caps its length. */
export function scrubString(value: string): string {
  let scrubbed = value;
  for (const [pattern, replacement] of VALUE_SCRUBBERS) {
    scrubbed = scrubbed.replace(pattern, replacement);
  }
  return scrubbed.length > MAX_STRING_LENGTH
    ? `${scrubbed.slice(0, MAX_STRING_LENGTH)}…[truncated]`
    : scrubbed;
}

function redactStoragePath(pathname: string): string {
  const start = pathname.indexOf(STORAGE_PATH);
  if (start === -1) return pathname;
  const routeStart = start + STORAGE_PATH.length;
  const route = STORAGE_NAMED_ROUTES.find((candidate) =>
    pathname.startsWith(candidate, routeStart),
  );
  if (route === undefined) return pathname;
  const prefixEnd = routeStart + route.length;
  const [first = "", ...rest] = pathname.slice(prefixEnd).split("/");
  if (route === STORAGE_OBJECT_ROUTE && STORAGE_OBJECT_VERBS.has(first)) {
    return rest.join("/").length === 0
      ? pathname
      : `${pathname.slice(0, prefixEnd)}${first}/${REDACTED}`;
  }
  return first.length === 0 && rest.length === 0
    ? pathname
    : `${pathname.slice(0, prefixEnd)}${REDACTED}`;
}

function urlWithoutQuery(value: string): string {
  try {
    const url = new URL(value);
    return scrubString(`${url.protocol}//${url.host}${redactStoragePath(url.pathname)}`);
  } catch {
    return scrubString(value);
  }
}

function sanitizeUrlAttribute(key: string, value: string): string | undefined {
  if (key === "url.full") return urlWithoutQuery(value);
  if (key === "url.path") return scrubString(redactStoragePath(value));
  return undefined;
}

function queryAttributes(
  text: string,
  hashQuery: QueryHasher,
): ReadonlyArray<readonly [string, string | number]> {
  const keyword = /^\s*([A-Za-z]+)/u.exec(text)?.[1]?.toUpperCase();
  return [
    ...(keyword === undefined ? [] : [["db.operation.name", keyword] as const]),
    ["db.query.hash", hashQuery(text)],
    ["db.query.length", text.length],
  ];
}

type AttributeDecision =
  | { readonly _tag: "Drop" }
  | { readonly _tag: "Keep" }
  | { readonly _tag: "Query" };

/** `numericOrBoolean` values such as `secret.count` carry no credential and survive the key denylist. */
function decide(key: string, numericOrBoolean: boolean): AttributeDecision {
  if (key === "db.query.text") return { _tag: "Query" };
  if (key === "url.query") return { _tag: "Drop" };
  const header = HEADER_ATTRIBUTE.exec(key);
  if (header !== null) {
    return ALLOWED_HEADERS.has(header[1]!.toLowerCase()) ? { _tag: "Keep" } : { _tag: "Drop" };
  }
  if (!numericOrBoolean && DENIED_KEY.test(key)) return { _tag: "Drop" };
  return { _tag: "Keep" };
}

function isNumericOrBoolean(value: unknown): boolean {
  return typeof value === "number" || typeof value === "bigint" || typeof value === "boolean";
}

function isNumericOrBooleanAnyValue(value: AnyValue): boolean {
  return value.intValue != null || value.doubleValue != null || value.boolValue != null;
}

function scrubUnknown(value: unknown): unknown {
  if (typeof value === "string") return scrubString(value);
  if (Array.isArray(value)) return value.map(scrubUnknown);
  return value;
}

function sanitizeAttributeEntries(
  entries: Iterable<readonly [string, unknown]>,
  hashQuery: QueryHasher,
): Array<readonly [string, unknown]> {
  const result: Array<readonly [string, unknown]> = [];
  for (const [key, value] of entries) {
    const decision = decide(key, isNumericOrBoolean(value));
    switch (decision._tag) {
      case "Drop":
        break;
      case "Query":
        if (typeof value === "string") result.push(...queryAttributes(value, hashQuery));
        break;
      default:
        result.push([
          key,
          (typeof value === "string" ? sanitizeUrlAttribute(key, value) : undefined) ??
            scrubUnknown(value),
        ]);
    }
  }
  return result;
}

function scrubAnyValue(value: AnyValue, hashQuery: QueryHasher): AnyValue {
  if (typeof value.stringValue === "string") {
    return { ...value, stringValue: scrubString(value.stringValue) };
  }
  if (value.arrayValue !== undefined) {
    return {
      ...value,
      arrayValue: { values: value.arrayValue.values.map((item) => scrubAnyValue(item, hashQuery)) },
    };
  }
  if (value.kvlistValue !== undefined) {
    return {
      ...value,
      kvlistValue: { values: sanitizeKeyValues(value.kvlistValue.values, hashQuery) },
    };
  }
  return value;
}

function toAnyValue(value: string | number): AnyValue {
  return typeof value === "number" ? { intValue: value } : { stringValue: value };
}

function sanitizeKeyValues(
  attributes: ReadonlyArray<KeyValue>,
  hashQuery: QueryHasher,
): Array<KeyValue> {
  const result: Array<KeyValue> = [];
  for (const attribute of attributes) {
    const decision = decide(attribute.key, isNumericOrBooleanAnyValue(attribute.value));
    switch (decision._tag) {
      case "Drop":
        break;
      case "Query": {
        const text = attribute.value.stringValue;
        if (typeof text === "string") {
          for (const [key, value] of queryAttributes(text, hashQuery)) {
            result.push({ key, value: toAnyValue(value) });
          }
        }
        break;
      }
      default: {
        const text = attribute.value.stringValue;
        const url =
          typeof text === "string" ? sanitizeUrlAttribute(attribute.key, text) : undefined;
        result.push({
          key: attribute.key,
          value:
            url === undefined ? scrubAnyValue(attribute.value, hashQuery) : { stringValue: url },
        });
      }
    }
  }
  return result;
}

/** `value` when it reads as a class or tag name; an error's `name` is free text that may carry user data. */
function errorTypeName(value: unknown): string {
  return typeof value === "string" && TRACE_IDENTIFIER.test(value) ? value : FALLBACK_ERROR_TYPE;
}

/** Log events are named after their free-text message, so every non-exception event becomes `log`. */
function sanitizeEvent(event: SpanEvent, hashQuery: QueryHasher): SpanEvent {
  if (event.name === EXCEPTION_EVENT) {
    return {
      ...event,
      attributes: event.attributes
        .filter((attribute) => attribute.key === EVENT_ATTRIBUTE_KEPT[EXCEPTION_EVENT])
        .map((attribute) => ({
          key: attribute.key,
          value: { stringValue: errorTypeName(attribute.value.stringValue) },
        })),
    };
  }
  return {
    ...event,
    name: LOG_EVENT,
    attributes: sanitizeKeyValues(
      event.attributes.filter((attribute) => attribute.key === EVENT_ATTRIBUTE_KEPT[LOG_EVENT]),
      hashQuery,
    ),
  };
}

function sanitizeTraceData(data: TraceData, hashQuery: QueryHasher): TraceData {
  return {
    resourceSpans: data.resourceSpans.map((resourceSpan) => ({
      ...resourceSpan,
      resource: {
        ...resourceSpan.resource,
        attributes: sanitizeKeyValues(
          resourceSpan.resource.attributes.filter((attribute) =>
            RESOURCE_ATTRIBUTE_KEPT.has(attribute.key),
          ),
          hashQuery,
        ),
      },
      scopeSpans: resourceSpan.scopeSpans.map((scopeSpan) => ({
        ...scopeSpan,
        spans: scopeSpan.spans.map((span) => ({
          ...span,
          attributes: sanitizeKeyValues(span.attributes, hashQuery),
          events: span.events.map((event) => sanitizeEvent(event, hashQuery)),
          links: span.links.map((link) => ({
            ...link,
            attributes: sanitizeKeyValues(link.attributes, hashQuery),
          })),
          status: { code: span.status.code },
        })),
      })),
    })),
  };
}

/** Sanitizes span data before it leaves the process or reaches the debug console. */
export interface TraceSanitizer {
  /** Sanitizes span attributes for local display. */
  readonly attributeEntries: (
    entries: Iterable<readonly [string, unknown]>,
  ) => Array<readonly [string, unknown]>;
  /** Keeps only structured data: attributes, event and exception types, and status codes. */
  readonly traceData: (data: TraceData) => TraceData;
}

/**
 * Creates a sanitizer whose `db.query.hash` is keyed by a fresh random salt, so repeated
 * statements share a hash within one sanitizer but hashes cannot be compared across runs.
 */
export const makeTraceSanitizer: Effect.Effect<TraceSanitizer, never, Crypto.Crypto> = Effect.gen(
  function* () {
    const crypto = yield* Crypto.Crypto;
    const salt = yield* Effect.orDie(crypto.randomBytes(QUERY_HASH_SALT_BYTES));
    const hashQuery: QueryHasher = (text) =>
      createHmac("sha256", salt).update(text).digest("hex").slice(0, QUERY_HASH_HEX_LENGTH);
    return {
      attributeEntries: (entries) => sanitizeAttributeEntries(entries, hashQuery),
      traceData: (data) => sanitizeTraceData(data, hashQuery),
    };
  },
);

function failureOf(reason: Cause.Reason<unknown>): unknown {
  if (Cause.isFailReason(reason)) return reason.error;
  if (Cause.isDieReason(reason)) return reason.defect;
  return undefined;
}

/** The `_tag` of a failed exit's first tagged error, if any, reduced to an identifier. */
export function errorTypeOf(exit: Exit.Exit<unknown, unknown>): string | undefined {
  if (Exit.isSuccess(exit)) return undefined;
  for (const reason of exit.cause.reasons) {
    const failure = failureOf(reason);
    if (typeof failure !== "object" || failure === null) continue;
    const tag = Reflect.get(failure, "_tag");
    if (typeof tag === "string") return errorTypeName(tag);
  }
  return undefined;
}

/** The Postgres SQLSTATE carried by a failed exit's error or its `cause` chain, if any. */
export function sqlStateOf(exit: Exit.Exit<unknown, unknown>): string | undefined {
  if (Exit.isSuccess(exit)) return undefined;
  for (const reason of exit.cause.reasons) {
    let current: unknown = failureOf(reason);
    for (
      let depth = 0;
      depth < MAX_CAUSE_DEPTH && typeof current === "object" && current !== null;
      depth++
    ) {
      const code = Reflect.get(current, "code");
      if (typeof code === "string" && POSTGRES_SQLSTATE.test(code)) return code;
      current = Reflect.get(current, "cause");
    }
  }
  return undefined;
}
