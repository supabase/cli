import { createHmac } from "node:crypto";
import { Cause, Crypto, Effect, Exit } from "effect";
import type { KeyValue, AnyValue } from "effect/unstable/observability/OtlpResource";
import type { ScopeSpan, TraceData } from "effect/unstable/observability/OtlpTracer";
import { isSqlState } from "../../command-internal/connect-errors.ts";

const MAX_STRING_LENGTH = 2048;
const REDACTED = "<redacted>";
const QUERY_HASH_SALT_BYTES = 32;
const QUERY_HASH_HEX_LENGTH = 16;
const MAX_CAUSE_DEPTH = 6;
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
  [/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/giu, `$1${REDACTED}@`],
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

const STORAGE_OBJECT_PATH = "/storage/v1/object/";
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

function redactStorageObjectPath(pathname: string): string {
  const start = pathname.indexOf(STORAGE_OBJECT_PATH);
  if (start === -1) return pathname;
  const prefixEnd = start + STORAGE_OBJECT_PATH.length;
  const [first = "", ...rest] = pathname.slice(prefixEnd).split("/");
  if (STORAGE_OBJECT_VERBS.has(first)) {
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
    return `${url.protocol}//${url.host}${redactStorageObjectPath(url.pathname)}`;
  } catch {
    return scrubString(value);
  }
}

function sanitizeUrlAttribute(key: string, value: string): string | undefined {
  if (key === "url.full") return urlWithoutQuery(value);
  if (key === "url.path") return scrubString(redactStorageObjectPath(value));
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

/** Log events are named after their free-text message, so every non-exception event becomes `log`. */
function sanitizeEvent(event: SpanEvent, hashQuery: QueryHasher): SpanEvent {
  const name = event.name === EXCEPTION_EVENT ? EXCEPTION_EVENT : LOG_EVENT;
  const kept = EVENT_ATTRIBUTE_KEPT[name];
  return {
    ...event,
    name,
    attributes: sanitizeKeyValues(
      event.attributes.filter((attribute) => attribute.key === kept),
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
        attributes: sanitizeKeyValues(resourceSpan.resource.attributes, hashQuery),
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

/** The Postgres SQLSTATE carried by a failed exit's error or its `cause` chain, if any. */
export function sqlStateOf(exit: Exit.Exit<unknown, unknown>): string | undefined {
  if (Exit.isSuccess(exit)) return undefined;
  for (const reason of exit.cause.reasons) {
    let current: unknown = Cause.isFailReason(reason)
      ? reason.error
      : Cause.isDieReason(reason)
        ? reason.defect
        : undefined;
    for (
      let depth = 0;
      depth < MAX_CAUSE_DEPTH && typeof current === "object" && current !== null;
      depth++
    ) {
      const code = Reflect.get(current, "code");
      if (typeof code === "string" && isSqlState(code)) return code;
      current = Reflect.get(current, "cause");
    }
  }
  return undefined;
}
