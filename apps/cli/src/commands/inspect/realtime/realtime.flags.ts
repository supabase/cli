import { Duration, Effect, Option } from "effect";
import { Flag } from "effect/unstable/cli";

import { changedLinkedLocalFlags } from "../../../command-internal/db-target-flags.ts";
import { OutputFlag } from "../../../command-internal/global-flags.ts";
import {
  REALTIME_CATEGORIES,
  REALTIME_DEFAULT_CATEGORIES,
  REALTIME_LOG_LEVELS,
  isRealtimeCategory,
  type RealtimeCategory,
} from "./realtime.events.ts";
import {
  RealtimeInvalidOptionError,
  RealtimeInvalidPayloadError,
  RealtimeMutuallyExclusiveFlagsError,
  RealtimeOutputFlagUnsupportedError,
} from "./realtime.errors.ts";
import type { RealtimePostgresEvent, RealtimePostgresSpec } from "./realtime.session.ts";
import type { RealtimeTargetChoice } from "./realtime.connection.ts";

export const REALTIME_CONNECTION_FLAGS = {
  url: Flag.string("url").pipe(
    Flag.withDescription(
      "Project URL to connect to, e.g. https://abc.supabase.co. (default $SUPABASE_URL, else the resolved project)",
    ),
    Flag.optional,
  ),
  apiKey: Flag.string("api-key").pipe(
    Flag.withAlias("publishable-key"),
    Flag.withDescription(
      "Publishable or anon key to connect with. (default $SUPABASE_PUBLISHABLE_KEY, $SUPABASE_ANON_KEY, else the resolved project's)",
    ),
    Flag.optional,
  ),
  secretKey: Flag.string("secret-key").pipe(
    Flag.withDescription("Secret or service-role key to connect with, bypassing RLS."),
    Flag.optional,
  ),
  serviceRole: Flag.boolean("service-role").pipe(
    Flag.withDescription(
      "Connect with the resolved project's secret key instead of its publishable key, bypassing RLS.",
    ),
    Flag.withDefault(false),
  ),
  projectRef: Flag.string("project-ref").pipe(
    Flag.withDescription("Project ref of the Supabase project to connect to."),
    Flag.optional,
  ),
  local: Flag.boolean("local").pipe(
    Flag.withDescription("Connect to the local stack's Realtime."),
    Flag.withDefault(false),
  ),
  linked: Flag.boolean("linked").pipe(
    Flag.withDescription("Connect to the linked project's Realtime."),
    Flag.withDefault(false),
  ),
  userToken: Flag.string("user-token").pipe(
    Flag.withDescription("User JWT to join as, for RLS and private channels."),
    Flag.optional,
  ),
  email: Flag.string("email").pipe(
    Flag.withDescription("Sign in with this email to obtain a user JWT."),
    Flag.optional,
  ),
  password: Flag.string("password").pipe(
    Flag.withDescription("Password for --email. Prompted for when omitted on a TTY."),
    Flag.optional,
  ),
  private: Flag.boolean("private").pipe(
    Flag.withDescription("Join the channel as private, so RLS policies are enforced."),
    Flag.withDefault(false),
  ),
  timeout: Flag.integer("timeout").pipe(
    Flag.withDescription("Seconds to wait for the channel to join. (default 15)"),
    Flag.withDefault(15),
  ),
} as const;

export const REALTIME_LOG_FLAGS = {
  logLevel: Flag.choice("server-log-level", REALTIME_LOG_LEVELS).pipe(
    Flag.withDescription(
      "Server-side log verbosity for this connection. Realtime accepts info, warning and error only. (default info)",
    ),
    Flag.withDefault("info" as const),
  ),
  categories: Flag.string("categories").pipe(
    Flag.withDescription(
      `Comma-separated frame categories to record: ${REALTIME_CATEGORIES.join(", ")}, or "all". (default ${REALTIME_DEFAULT_CATEGORIES.join(",")})`,
    ),
    Flag.optional,
  ),
  fullPayload: Flag.boolean("full-payload").pipe(
    Flag.withDescription("Print each payload in full instead of a single clamped line."),
    Flag.withDefault(false),
  ),
} as const;

export const REALTIME_POSTGRES_FLAGS = {
  postgres: Flag.string("postgres").pipe(
    Flag.withDescription(
      "Subscribe to database changes for a table, as schema.table (e.g. public.messages) or a bare schema.",
    ),
    Flag.optional,
  ),
  event: Flag.choice("event", ["*", "INSERT", "UPDATE", "DELETE"]).pipe(
    Flag.withDescription("Which database change to subscribe to. (default *)"),
    Flag.withDefault("*" as const),
  ),
  filter: Flag.string("filter").pipe(
    Flag.withDescription(
      "Row filter for database changes, e.g. id=eq.1. Combine conditions with commas (AND).",
    ),
    Flag.optional,
  ),
  select: Flag.string("select").pipe(
    Flag.withDescription("Comma-separated columns to return for database changes."),
    Flag.optional,
  ),
} as const;

export function realtimeChannelName(channel: string): {
  readonly channel: string;
  readonly strippedTopicPrefix: boolean;
} {
  const trimmed = channel.trim();
  return trimmed.startsWith("realtime:")
    ? { channel: trimmed.slice("realtime:".length), strippedTopicPrefix: true }
    : { channel: trimmed, strippedTopicPrefix: false };
}

export function requirePositive(
  name: string,
  value: number,
): Effect.Effect<number, RealtimeInvalidOptionError> {
  return value >= 1
    ? Effect.succeed(value)
    : Effect.fail(
        new RealtimeInvalidOptionError({
          message: `--${name} must be at least 1, got ${value}`,
        }),
      );
}

export function parseRealtimeCategories(
  value: Option.Option<string>,
): Effect.Effect<ReadonlySet<RealtimeCategory>, RealtimeInvalidOptionError> {
  const raw = Option.getOrUndefined(value);
  if (raw === undefined) {
    return Effect.succeed(new Set(REALTIME_DEFAULT_CATEGORIES));
  }

  const tokens = raw
    .split(",")
    .map((token) => token.trim().toLowerCase())
    .filter((token) => token.length > 0);

  if (tokens.length === 0) {
    return Effect.fail(
      new RealtimeInvalidOptionError({
        message: "--categories was empty; pass at least one category, or omit the flag",
      }),
    );
  }

  if (tokens.includes("all")) {
    return Effect.succeed(new Set(REALTIME_CATEGORIES));
  }

  const unknown = tokens.filter((token) => !isRealtimeCategory(token));
  if (unknown.length > 0) {
    return Effect.fail(
      new RealtimeInvalidOptionError({
        message: `unknown --categories value${unknown.length === 1 ? "" : "s"} ${unknown.join(", ")}; valid values are ${REALTIME_CATEGORIES.join(", ")} or all`,
      }),
    );
  }

  return Effect.succeed(new Set(tokens.filter(isRealtimeCategory)));
}

export function parseRealtimeDuration(
  value: Option.Option<string>,
): Effect.Effect<Option.Option<Duration.Duration>, RealtimeInvalidOptionError> {
  const raw = Option.getOrUndefined(value);
  if (raw === undefined) return Effect.succeed(Option.none());

  const match = /^(\d+)(ms|s|m|h)?$/.exec(raw.trim());
  if (match === null) {
    return Effect.fail(
      new RealtimeInvalidOptionError({
        message: `invalid --duration "${raw}"; expected a number of seconds or a value like 30s, 5m, 1h`,
      }),
    );
  }

  const amount = Number(match[1]);
  if (amount === 0) {
    return Effect.fail(
      new RealtimeInvalidOptionError({
        message: "--duration must be greater than zero",
      }),
    );
  }

  switch (match[2]) {
    case "ms":
      return Effect.succeed(Option.some(Duration.millis(amount)));
    case "m":
      return Effect.succeed(Option.some(Duration.minutes(amount)));
    case "h":
      return Effect.succeed(Option.some(Duration.hours(amount)));
    default:
      return Effect.succeed(Option.some(Duration.seconds(amount)));
  }
}

export function parseRealtimePostgresTarget(
  value: string,
): Effect.Effect<{ readonly schema: string; readonly table: string }, RealtimeInvalidOptionError> {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return Effect.fail(
      new RealtimeInvalidOptionError({
        message: "--postgres was empty; pass a schema, or schema.table",
      }),
    );
  }

  const parts = trimmed.split(".");
  if (parts.length > 2) {
    return Effect.fail(
      new RealtimeInvalidOptionError({
        message: `invalid --postgres "${value}"; expected schema or schema.table`,
      }),
    );
  }

  const schema = parts[0] ?? "";
  const table = parts.length === 2 ? (parts[1] ?? "") : "*";
  if (schema.length === 0 || table.length === 0) {
    return Effect.fail(
      new RealtimeInvalidOptionError({
        message: `invalid --postgres "${value}"; expected schema or schema.table`,
      }),
    );
  }

  return Effect.succeed({ schema, table });
}

export function parseRealtimeReplaySince(
  value: Option.Option<string>,
  now: number = Date.now(),
): Effect.Effect<number | undefined, RealtimeInvalidOptionError> {
  const raw = Option.getOrUndefined(value);
  if (raw === undefined) return Effect.succeed(undefined);

  const relative = /^(\d+)(ms|s|m|h)?$/.exec(raw.trim());
  if (relative !== null) {
    return Effect.map(
      parseRealtimeDuration(Option.some(raw)),
      (duration) => now - Duration.toMillis(Option.getOrThrow(duration)),
    );
  }

  const absolute = Date.parse(raw.trim());
  if (Number.isNaN(absolute)) {
    return Effect.fail(
      new RealtimeInvalidOptionError({
        message: `invalid --replay-since "${raw}"; expected a timestamp or an age like 5m, 1h`,
      }),
    );
  }
  return Effect.succeed(absolute);
}

export function parseRealtimeSelect(value: Option.Option<string>): ReadonlyArray<string> {
  const raw = Option.getOrUndefined(value);
  if (raw === undefined) return [];
  return [
    ...new Set(
      raw
        .split(",")
        .map((column) => column.trim())
        .filter((column) => column.length > 0),
    ),
  ];
}

export const resolveRealtimePostgresSpec = Effect.fnUntraced(function* (flags: {
  readonly postgres: Option.Option<string>;
  readonly event: RealtimePostgresEvent;
  readonly filter: Option.Option<string>;
  readonly select: Option.Option<string>;
}) {
  const target = Option.getOrUndefined(flags.postgres);
  if (target === undefined) return undefined;

  const { schema, table } = yield* parseRealtimePostgresTarget(target);
  return {
    schema,
    table,
    event: flags.event,
    filter: Option.getOrUndefined(flags.filter),
    select: parseRealtimeSelect(flags.select),
  } satisfies RealtimePostgresSpec;
});

export function parseRealtimePayload(
  raw: string,
): Effect.Effect<unknown, RealtimeInvalidPayloadError> {
  return Effect.try({
    try: (): unknown => JSON.parse(raw),
    catch: (cause) =>
      new RealtimeInvalidPayloadError({
        message: `payload is not valid JSON: ${cause instanceof Error ? cause.message : String(cause)}`,
      }),
  });
}

export const assertRealtimeTargetsExclusive = Effect.fnUntraced(function* (
  args: ReadonlyArray<string>,
) {
  const setFlags = changedLinkedLocalFlags(args);
  if (setFlags.length > 1) {
    return yield* new RealtimeMutuallyExclusiveFlagsError({
      message: `if any flags in the group [linked local] are set none of the others can be; [${setFlags.join(" ")}] were all set`,
    });
  }
});

export function realtimeTargetChoice(flags: {
  readonly local: boolean;
  readonly linked: boolean;
}): RealtimeTargetChoice | undefined {
  if (flags.local) return "local";
  if (flags.linked) return "linked";
  return undefined;
}

export const rejectRealtimeOutputFlag = Effect.fnUntraced(function* () {
  if (Option.isSome(yield* OutputFlag)) {
    return yield* new RealtimeOutputFlagUnsupportedError({
      message:
        "the -o/--output flag is not supported by inspect realtime; use --output-format json|stream-json instead.",
    });
  }
});
