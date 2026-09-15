import { Effect, Layer, Option, Stream } from "effect";
import { BunServices } from "@effect/platform-bun";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";

import { CommandPlatformApi } from "../../src/auth/command-platform-api.service.ts";
import { CommandPlatformApiFactory } from "../../src/auth/command-platform-api-factory.service.ts";
import { ProjectRefResolver } from "../../src/config/project-ref.service.ts";
import { OutputFlag } from "../../src/command-internal/global-flags.ts";
import { CliArgs } from "../../src/shared/cli/cli-args.service.ts";
import { ProjectRefNotLinkedError } from "../../src/config/project-ref.errors.ts";
import { RealtimeSessions } from "../../src/commands/inspect/realtime/realtime-session.service.ts";
import {
  RealtimeBroadcastFailedError,
  RealtimeJoinFailedError,
  RealtimePostgresSubscriptionFailedError,
  type RealtimeJoinFailureReason,
} from "../../src/commands/inspect/realtime/realtime.errors.ts";
import type { RealtimeEvent } from "../../src/commands/inspect/realtime/realtime.events.ts";
import type { RealtimePresenceState } from "@supabase/realtime-js";
import type {
  RealtimeSession,
  RealtimeSessionSpec,
} from "../../src/commands/inspect/realtime/realtime.session.ts";
import {
  mockCommandSettings,
  mockLinkedProjectCacheTracked,
  mockCommandPlatformApiService,
  mockTelemetryStateTracked,
} from "./command-mocks.ts";
import { mockOutput, mockProcessControl } from "./mocks.ts";
import type { OutputFormat } from "../../src/shared/output/types.ts";

export interface RealtimeFrame {
  readonly category: RealtimeEvent["category"];
  readonly event: string;
  readonly payload?: unknown;
  readonly label?: string;
  readonly latencyMs?: number;
}

export interface MockRealtimeSessionOptions {
  readonly frames?: ReadonlyArray<RealtimeFrame>;
  readonly joinFails?: RealtimeJoinFailureReason;
  readonly subscriptionFails?: string;
  readonly replicationFails?: string;
  readonly broadcastFails?: string;
  readonly presence?: RealtimePresenceState<{ presence_ref: string } & Record<string, unknown>>;
  readonly suppressed?: number;
}

export interface MockRealtimeSessionState {
  readonly specs: ReadonlyArray<RealtimeSessionSpec>;
  readonly broadcasts: ReadonlyArray<{ readonly event: string; readonly payload: unknown }>;
  readonly tracked: ReadonlyArray<Record<string, unknown>>;
  readonly closed: number;
}

export function mockRealtimeSession(opts: MockRealtimeSessionOptions = {}) {
  const specs: Array<RealtimeSessionSpec> = [];
  const broadcasts: Array<{ event: string; payload: unknown }> = [];
  const tracked: Array<Record<string, unknown>> = [];
  let closed = 0;

  const frames: ReadonlyArray<RealtimeEvent> = (opts.frames ?? []).map((frame, index) => ({
    seq: index + 1,
    at: new Date(Date.UTC(2026, 0, 1, 12, 0, index)).toISOString(),
    category: frame.category,
    event: frame.event,
    payload: frame.payload ?? {},
    ...(frame.label === undefined ? {} : { label: frame.label }),
    ...(frame.latencyMs === undefined ? {} : { latencyMs: frame.latencyMs }),
  }));

  const layer = Layer.succeed(
    RealtimeSessions,
    RealtimeSessions.of({
      open: (spec) =>
        Effect.gen(function* () {
          specs.push(spec);
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => {
              closed += 1;
            }),
          );

          const session: RealtimeSession = {
            events: Stream.fromIterable(frames),
            joined:
              opts.joinFails === undefined
                ? Effect.void
                : Effect.fail(
                    new RealtimeJoinFailedError({
                      reason: opts.joinFails,
                      message: `channel "${spec.channel}" did not join (${opts.joinFails})`,
                    }),
                  ),
            replicationEstablished:
              opts.replicationFails === undefined
                ? Effect.void
                : Effect.fail(
                    new RealtimePostgresSubscriptionFailedError({
                      message: opts.replicationFails,
                    }),
                  ),
            postgresSubscribed:
              opts.subscriptionFails === undefined
                ? Effect.void
                : Effect.fail(
                    new RealtimePostgresSubscriptionFailedError({
                      message: opts.subscriptionFails,
                    }),
                  ),
            broadcast: (event, payload) =>
              opts.broadcastFails === undefined
                ? Effect.sync(() => {
                    broadcasts.push({ event, payload });
                  })
                : Effect.fail(new RealtimeBroadcastFailedError({ message: opts.broadcastFails })),
            track: (state) =>
              Effect.sync(() => {
                tracked.push(state);
              }),
            presenceState: Effect.succeed(opts.presence ?? {}),
            counts: Effect.succeed({
              emitted: frames.length,
              suppressed: opts.suppressed ?? 0,
            }),
          };

          return session;
        }),
    }),
  );

  return {
    layer,
    get state(): MockRealtimeSessionState {
      return { specs, broadcasts, tracked, closed };
    },
  };
}

export interface SetupRealtimeOptions extends MockRealtimeSessionOptions {
  readonly format?: OutputFormat;
  readonly workdir?: string;
  readonly projectRef?: string;
  readonly linkedFails?: boolean;
  readonly apiKeys?: ReadonlyArray<unknown>;
  readonly passwords?: ReadonlyArray<string>;
  readonly httpStatus?: number;
  readonly httpBody?: unknown;
  readonly signal?: "SIGINT" | "SIGTERM";
  readonly goOutput?: "env" | "pretty" | "json" | "toml" | "yaml" | "table" | "csv";
  readonly cliArgs?: ReadonlyArray<string>;
}

export function setupRealtime(opts: SetupRealtimeOptions = {}) {
  const out = mockOutput({
    format: opts.format ?? "text",
    promptPasswordResponses: opts.passwords,
  });
  const processControl = mockProcessControl(
    opts.signal === undefined ? {} : { signal: opts.signal },
  );
  const telemetry = mockTelemetryStateTracked();
  const linkedCache = mockLinkedProjectCacheTracked();
  const sessions = mockRealtimeSession(opts);

  const requests: Array<{ readonly method: string; readonly url: string }> = [];
  const httpLayer = Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) => {
      requests.push({ method: request.method, url: request.url });
      return Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          new Response(JSON.stringify(opts.httpBody ?? {}), {
            status: opts.httpStatus ?? 200,
            headers: { "content-type": "application/json" },
          }),
        ),
      );
    }),
  );

  const projectRef = opts.projectRef ?? "abcdefghijklmnopqrst";
  const notLinked = () =>
    new ProjectRefNotLinkedError({
      message: "Cannot find project ref. Have you run supabase link?",
    });
  const projectRefLayer = Layer.succeed(ProjectRefResolver, {
    resolve: () =>
      opts.linkedFails === true ? Effect.fail(notLinked()) : Effect.succeed(projectRef),
    resolveForLink: () =>
      opts.linkedFails === true ? Effect.fail(notLinked()) : Effect.succeed(projectRef),
    resolveOptional: () => Effect.succeed(Option.some(projectRef)),
    loadProjectRef: (flagValue: Option.Option<string>) =>
      Option.isSome(flagValue) && flagValue.value.length > 0
        ? Effect.succeed(flagValue.value)
        : opts.linkedFails === true
          ? Effect.fail(notLinked())
          : Effect.succeed(projectRef),
    promptProjectRef: () => Effect.succeed(projectRef),
  });

  const managementApi = mockCommandPlatformApiService({
    v1: {
      getProjectApiKeys: () =>
        Effect.succeed(
          opts.apiKeys ?? [{ name: "anon", api_key: "test-publishable-key", type: "publishable" }],
        ),
    },
  });

  const layer = Layer.mergeAll(
    out.layer,
    processControl.layer,
    telemetry.layer,
    linkedCache.layer,
    sessions.layer,
    httpLayer,
    projectRefLayer,
    BunServices.layer,
    Layer.succeed(
      OutputFlag,
      opts.goOutput === undefined ? Option.none() : Option.some(opts.goOutput),
    ),
    Layer.succeed(CliArgs, { args: opts.cliArgs ?? [] }),
    mockCommandSettings({ workdir: opts.workdir ?? "/tmp/legacy-realtime" }),
    Layer.succeed(CommandPlatformApiFactory, {
      make: CommandPlatformApi.pipe(Effect.provide(managementApi.layer)),
    }),
  );

  return { layer, out, sessions, telemetry, linkedCache, requests, processControl };
}

export const REALTIME_EXPLICIT_TARGET = {
  url: Option.some("http://127.0.0.1:54321"),
  apiKey: Option.some("sb_publishable_testtesttesttest"),
  secretKey: Option.none<string>(),
  serviceRole: false,
  projectRef: Option.none<string>(),
  local: false,
  linked: false,
  userToken: Option.none<string>(),
  email: Option.none<string>(),
  password: Option.none<string>(),
  private: false,
  timeout: 15,
} as const;
