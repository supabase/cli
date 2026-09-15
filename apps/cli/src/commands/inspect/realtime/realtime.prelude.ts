import { Duration, Effect, Option, Redacted } from "effect";

import type { Param } from "effect/unstable/cli";

import { CliArgs } from "../../../shared/cli/cli-args.service.ts";
import { withJsonErrorHandling } from "../../../shared/output/json-error-handling.ts";
import { Output } from "../../../shared/output/output.service.ts";
import { withCommandTelemetry } from "../../../telemetry/command-telemetry.ts";
import { LinkedProjectCache } from "../../../telemetry/linked-project-cache.service.ts";
import { TelemetryState } from "../../../telemetry/telemetry-state.service.ts";
import { realtimeSignIn, realtimeTokenIdentity } from "./realtime.auth.ts";
import {
  describeRealtimeTarget,
  resolveRealtimeTarget,
  type RealtimeTarget,
} from "./realtime.connection.ts";
import type { RealtimeCategory, RealtimeLogLevel } from "./realtime.events.ts";
import {
  assertRealtimeTargetsExclusive,
  realtimeChannelName,
  realtimeTargetChoice,
  rejectRealtimeOutputFlag,
} from "./realtime.flags.ts";
import type { RealtimePostgresSpec, RealtimeSessionSpec } from "./realtime.session.ts";

export interface RealtimeConnectionFlags {
  readonly url: Option.Option<string>;
  readonly apiKey: Option.Option<string>;
  readonly secretKey: Option.Option<string>;
  readonly serviceRole: boolean;
  readonly projectRef: Option.Option<string>;
  readonly local: boolean;
  readonly linked: boolean;
  readonly userToken: Option.Option<string>;
  readonly email: Option.Option<string>;
  readonly password: Option.Option<string>;
  readonly private: boolean;
  readonly timeout: number;
}

export interface RealtimeConnection {
  readonly target: RealtimeTarget;
  readonly userToken: Redacted.Redacted<string> | undefined;
  readonly identity:
    | { readonly subject: string; readonly role: string | undefined; readonly expired: boolean }
    | undefined;
}

const resolveRealtimeConnection = Effect.fnUntraced(function* (flags: RealtimeConnectionFlags) {
  yield* rejectRealtimeOutputFlag();

  const target = yield* resolveRealtimeTarget({
    url: flags.url,
    apiKey: flags.apiKey,
    secretKey: flags.secretKey,
    serviceRole: flags.serviceRole,
    projectRef: flags.projectRef,
    choice: realtimeTargetChoice(flags),
  });

  const { userToken, identity } = yield* resolveRealtimeIdentity(target, flags);

  return { target, userToken, identity } satisfies RealtimeConnection;
});

const resolveRealtimeIdentity = Effect.fnUntraced(function* (
  target: RealtimeTarget,
  flags: RealtimeConnectionFlags,
) {
  const explicit = Option.getOrUndefined(flags.userToken);
  if (explicit !== undefined) {
    const token = Redacted.make(explicit);
    return { userToken: token, identity: realtimeTokenIdentity(token) };
  }

  const email = Option.getOrUndefined(flags.email);
  if (email === undefined) {
    return { userToken: undefined, identity: undefined };
  }

  const output = yield* Output;
  const password = Option.isSome(flags.password)
    ? flags.password.value
    : yield* output.promptPassword(`Password for ${email}`);

  const signedIn = yield* realtimeSignIn({
    url: target.url,
    apiKey: target.apiKey,
    email,
    password: Redacted.make(password),
  });

  return {
    userToken: signedIn.token,
    identity: { subject: signedIn.subject, role: signedIn.role, expired: false },
  };
});

export function runRealtimeCommand<P, A, E1, E2, R1, R2>(opts: {
  readonly flags: RealtimeConnectionFlags;
  readonly prepare: Effect.Effect<P, E1, R1>;
  readonly run: (prepared: P, connection: RealtimeConnection) => Effect.Effect<A, E2, R2>;
}) {
  return Effect.gen(function* () {
    const telemetryState = yield* TelemetryState;
    const linkedProjectCache = yield* LinkedProjectCache;

    let linkedRef = "";

    return yield* Effect.gen(function* () {
      const prepared = yield* opts.prepare;
      const connection = yield* resolveRealtimeConnection(opts.flags);
      linkedRef = connection.target.projectRef ?? "";
      return yield* opts.run(prepared, connection);
    }).pipe(
      Effect.ensuring(
        Effect.suspend(() =>
          linkedRef === "" ? Effect.void : linkedProjectCache.cache(linkedRef),
        ),
      ),
      Effect.ensuring(telemetryState.flush),
    );
  });
}

export const warnRealtimeChannelPrefix = Effect.fnUntraced(function* (channel: string) {
  const normalized = realtimeChannelName(channel);
  if (!normalized.strippedTopicPrefix) return normalized.channel;
  const output = yield* Output;
  yield* output.warn(
    `"${channel}" is the wire protocol's topic name; using channel "${normalized.channel}". Pass the channel as your application names it, without the "realtime:" prefix.`,
  );
  return normalized.channel;
});

export function describeRealtimeConnection(connection: RealtimeConnection): string {
  const where = describeRealtimeTarget(connection.target);
  const identity = connection.identity;
  if (identity === undefined) {
    return connection.target.elevated
      ? `Connected to ${where} with the secret key, which bypasses RLS.`
      : `Connected to ${where} with the publishable key.`;
  }

  const role = identity.role === undefined ? "" : ` (${identity.role})`;
  const expired = identity.expired ? " — note: this token is expired" : "";
  return `Connected to ${where} as ${identity.subject}${role}${expired}.`;
}

const BUFFER_SIZE = 8192;

export function realtimeSessionSpecOf(opts: {
  readonly connection: RealtimeConnection;
  readonly flags: RealtimeConnectionFlags;
  readonly channel: string;
  readonly categories: ReadonlySet<RealtimeCategory>;
  readonly logLevel: RealtimeLogLevel;
  readonly postgres: RealtimePostgresSpec | undefined;
  readonly presence: boolean;
  readonly presenceKey?: string | undefined;
  readonly broadcastSelf: boolean;
  readonly broadcastAck: boolean;
  readonly broadcastReplay?:
    | { readonly since: number; readonly limit: number | undefined }
    | undefined;
  readonly replicationReady?: boolean;
}): RealtimeSessionSpec {
  return {
    url: opts.connection.target.url,
    apiKey: opts.connection.target.apiKey,
    userToken: opts.connection.userToken,
    channel: realtimeChannelName(opts.channel).channel,
    privateChannel: opts.flags.private,
    broadcastSelf: opts.broadcastSelf,
    broadcastAck: opts.broadcastAck,
    broadcastReplay: opts.broadcastReplay,
    replicationReady: opts.replicationReady ?? false,
    presence: opts.presence,
    presenceKey: opts.presenceKey,
    postgres: opts.postgres,
    logLevel: opts.logLevel,
    categories: opts.categories,
    bufferSize: BUFFER_SIZE,
    joinTimeout: Duration.seconds(opts.flags.timeout),
  };
}

function realtimeConnectionTelemetryFlags(flags: RealtimeConnectionFlags): Record<string, unknown> {
  return {
    url: flags.url,
    "api-key": flags.apiKey,
    "project-ref": flags.projectRef,
    local: flags.local,
    linked: flags.linked,
    "user-token": flags.userToken,
    email: flags.email,
    password: flags.password,
    private: flags.private,
    timeout: flags.timeout,
  };
}

export function inspectRealtimeCommandHandler<Flags extends RealtimeConnectionFlags, E, R>(opts: {
  readonly config: Record<string, Param.Any>;
  readonly telemetryFlags?: (flags: Flags) => Record<string, unknown>;
  readonly handler: (flags: Flags) => Effect.Effect<void, E, R>;
}) {
  return (flags: Flags) =>
    Effect.gen(function* () {
      const cliArgs = yield* CliArgs;
      yield* assertRealtimeTargetsExclusive(cliArgs.args);

      return yield* opts.handler(flags).pipe(
        withCommandTelemetry({
          flags: {
            ...realtimeConnectionTelemetryFlags(flags),
            ...opts.telemetryFlags?.(flags),
          },
          config: opts.config,
        }),
      );
    }).pipe(withJsonErrorHandling);
}
