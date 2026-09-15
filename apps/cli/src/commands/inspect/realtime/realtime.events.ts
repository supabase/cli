const REALTIME_CHANNEL_CATEGORIES = ["system", "broadcast", "presence", "postgres"] as const;

const REALTIME_CLIENT_CATEGORIES = ["transport", "channel", "error"] as const;

export const REALTIME_CATEGORIES = [
  ...REALTIME_CHANNEL_CATEGORIES,
  ...REALTIME_CLIENT_CATEGORIES,
] as const;

export const REALTIME_DEFAULT_CATEGORIES = [...REALTIME_CHANNEL_CATEGORIES, "error"] as const;

export type RealtimeCategory = (typeof REALTIME_CATEGORIES)[number];

export const REALTIME_LOG_LEVELS = ["info", "warning", "error"] as const;

export type RealtimeLogLevel = (typeof REALTIME_LOG_LEVELS)[number];

export interface RealtimeEvent {
  readonly seq: number;
  readonly at: string;
  readonly category: RealtimeCategory;
  readonly event: string;
  readonly label?: string;
  readonly payload: unknown;
  readonly latencyMs?: number;
}

export function isRealtimeCategory(value: string): value is RealtimeCategory {
  return (REALTIME_CATEGORIES as ReadonlyArray<string>).includes(value);
}

export function realtimeCategoryOfLogKind(kind: string): RealtimeCategory {
  if (kind === "error") return "error";
  if (kind === "transport") return "transport";
  return "channel";
}

const MAX_STRING = 2048;
const MAX_DEPTH = 8;

const CREDENTIAL_PARAM = /([?&](?:apikey|token|access_token)=)[^&\s]+/gi;
const JWT = /\beyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\b/g;
const SUPABASE_KEY = /\bsb_(?:publishable|secret)_[A-Za-z0-9_-]{8,}\b/g;

const REDACTED = "[redacted]";

export function redactRealtimeText(text: string): string {
  return text
    .replace(CREDENTIAL_PARAM, `$1${REDACTED}`)
    .replace(JWT, REDACTED)
    .replace(SUPABASE_KEY, REDACTED);
}

function realtimeEventFields(value: object): Record<string, unknown> | null {
  if (typeof Event === "undefined" || !(value instanceof Event)) return null;

  const event: Record<string, unknown> = { type: value.type };
  if (value instanceof CloseEvent) {
    event["code"] = value.code;
    if (value.reason.length > 0) event["reason"] = value.reason;
    event["was_clean"] = value.wasClean;
  }
  if (value instanceof MessageEvent && typeof value.data === "string") {
    event["data"] = value.data;
  }
  return event;
}

export function cleanRealtimePayload(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return undefined;
  if (depth > MAX_DEPTH) return "[nested]";

  if (typeof value === "string") {
    const trimmed = redactRealtimeText(value.trim());
    if (trimmed === "") return undefined;
    return trimmed.length > MAX_STRING
      ? `${trimmed.slice(0, MAX_STRING)}… (${trimmed.length} chars)`
      : trimmed;
  }

  if (typeof value !== "object") return value;

  if (value instanceof Error) {
    return { name: value.name, message: redactRealtimeText(value.message) };
  }

  const eventFields = realtimeEventFields(value);
  if (eventFields !== null) return cleanRealtimePayload(eventFields, depth);

  if (Array.isArray(value)) {
    const items = value
      .map((item) => cleanRealtimePayload(item, depth + 1))
      .filter((item) => item !== undefined);
    return items.length > 0 ? items : undefined;
  }

  const cleaned: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    const next = cleanRealtimePayload(item, depth + 1);
    if (next !== undefined) cleaned[key] = next;
  }
  return Object.keys(cleaned).length > 0 ? cleaned : undefined;
}

export function unwrapRealtimePayload(payload: unknown): unknown {
  const cleaned = cleanRealtimePayload(payload);
  if (cleaned !== null && typeof cleaned === "object" && !Array.isArray(cleaned)) {
    const keys = Object.keys(cleaned);
    if (keys.length === 1 && keys[0] === "data") {
      return (cleaned as { data: unknown }).data;
    }
  }
  return cleaned;
}

export function isRealtimeHeartbeat(message: string): boolean {
  return message.includes("heartbeat") || /(^|\s)phoenix\s/.test(message);
}

export function realtimeEventLabel(event: string): string {
  if (event.startsWith("connected to ")) return "Transport connected";
  if (event.startsWith("connecting to ")) return "Transport connecting";

  const { status, topic, verb } = parseRealtimeEvent(event);
  const channel = realtimeChannelName(topic);

  switch (verb) {
    case "phx_join":
      return `Joining ${channel}`;
    case "phx_reply":
      if (status === "ok") return `Joined ${channel}`;
      if (status === "error") return "Join rejected";
      return "Reply";
    case "phx_leave":
    case "leave":
      return `Leaving ${channel}`;
    case "phx_close":
    case "close":
      return "Channel closed";
    case "phx_error":
    case "error":
      return "Channel error";
    case "broadcast":
      return "Broadcast";
    case "postgres_changes":
      return "Database change";
    case "presence_state":
      return "Presence sync";
    case "presence_diff":
      return "Presence change";
    case "system":
      return "Subscription confirmed";
    case undefined:
      return event;
    default:
      return verb;
  }
}

function parseRealtimeEvent(event: string): {
  readonly status: string | undefined;
  readonly topic: string | undefined;
  readonly verb: string | undefined;
} {
  const tokens = event
    .replace(/\s*\([^)]*\)\s*$/, "")
    .split(" ")
    .filter((token) => token.length > 0);

  const topic = tokens.find((token) => token.includes(":"));

  const rest = tokens.filter((token) => !token.includes(":"));
  if (rest.length === 2) return { status: rest[0], topic, verb: rest[1] };
  if (rest.length === 1) return { status: undefined, topic, verb: rest[0] };
  return { status: undefined, topic, verb: undefined };
}

function realtimeChannelName(topic: string | undefined): string {
  if (topic === undefined) return "channel";
  const separator = topic.indexOf(":");
  if (separator === -1) return topic;
  const name = topic.slice(separator + 1);
  return name.length > 0 ? name : topic;
}
