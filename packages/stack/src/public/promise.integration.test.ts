import { describe, expect, it } from "@effect/vitest";
import { Effect, Redacted, Stream } from "effect";
import type {
  EffectStack,
  PrepareStackOptions,
  RestartStackOptions,
  StartStackOptions,
  ServiceSelection,
} from "./EffectStack.ts";
import { adaptEffectStack } from "./PromiseStack.ts";
import type { StackLogBatch, StackLogEntry } from "./Logs.ts";
import type { StackStatus } from "./Status.ts";
import { StackIdSchema } from "./StackId.ts";
import { ServiceInstanceIdSchema } from "./ServiceInstanceId.ts";
import type { EffectServiceCollection } from "./Service.ts";
import { CAPABILITY_NAMES } from "./Capability.ts";

const stackId = StackIdSchema.make(
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
);
const status: StackStatus = {
  id: stackId,
  lifecycle: "running",
  desiredLifecycle: "running",
  runtime: { kind: "native" },
  endpoints: {},
  versions: {},
  capabilities: CAPABILITY_NAMES.map((name) => ({
    name,
    activation: "eager" as const,
    state: "ready" as const,
  })),
  artifacts: [],
  instances: [],
};
const emptyServices = {
  create: () => Effect.die("unused"),
  get: () => Effect.die("unused"),
  list: Effect.succeed([]),
} satisfies EffectServiceCollection;
const batch: StackLogBatch = { entries: [], cursor: { opaque: "v1_0" }, running: false };

const effectStack = (overrides: Partial<EffectStack> = {}): EffectStack => ({
  id: stackId,
  services: emptyServices,
  status: Effect.succeed(status),
  followStatus: Stream.empty,
  credentials: Effect.succeed({
    database: { url: Redacted.make("postgres://secret"), password: Redacted.make("db-pass") },
    api: {
      publishableKey: "publishable",
      secretKey: Redacted.make("secret-key"),
      anonJwt: "anon",
      serviceRoleJwt: Redacted.make("service-role"),
    },
  }),
  prepare: (_options?: PrepareStackOptions) => Effect.succeed({ instances: [] }),
  start: (_options?: StartStackOptions) => Effect.succeed(status),
  sleep: (_options?: ServiceSelection) => Effect.succeed(status),
  stop: (_options?: ServiceSelection) => Effect.succeed(status),
  restart: (_options?: RestartStackOptions) => Effect.succeed(status),
  destroy: (_options?: ServiceSelection) => Effect.void,
  logs: () => Effect.succeed(batch),
  followLogs: () => Stream.empty,
  ...overrides,
});

describe("Promise stack facade", () => {
  it.live("converts credentials and forwards selected lifecycle operations", () =>
    Effect.gen(function* () {
      let selected: ReadonlyArray<string> | undefined;
      let restartOptions: RestartStackOptions | undefined;
      const stack = adaptEffectStack(
        effectStack({
          start: (options) => {
            selected = options?.services;
            return Effect.succeed(status);
          },
          restart: (options) => {
            restartOptions = options;
            return Effect.succeed(status);
          },
        }),
      );
      expect(yield* Effect.promise(() => stack.credentials())).toEqual({
        database: { url: "postgres://secret", password: "db-pass" },
        api: {
          publishableKey: "publishable",
          secretKey: "secret-key",
          anonJwt: "anon",
          serviceRoleJwt: "service-role",
        },
      });
      const serviceId = ServiceInstanceIdSchema.make("instance-a");
      yield* Effect.promise(() => stack.start({ services: [serviceId] }));
      expect(selected).toEqual(["instance-a"]);
      yield* Effect.promise(() => stack.restart({ config: {} }));
      expect(restartOptions).toEqual({ config: {} });
    }),
  );

  it.live("keeps log observation as an async iterable", () =>
    Effect.gen(function* () {
      const entry: StackLogEntry = {
        cursor: { opaque: "v1_1" },
        timestamp: "2026-01-01T00:00:00.000Z",
        source: "auth",
        stream: "stdout",
        message: "ready",
      };
      const stack = adaptEffectStack(
        effectStack({
          followLogs: () => Stream.succeed(entry),
        }),
      );
      const iterator = stack.followLogs()[Symbol.asyncIterator]();
      expect(yield* Effect.promise(() => iterator.next())).toEqual({ done: false, value: entry });
      expect(yield* Effect.promise(() => iterator.next())).toEqual({
        done: true,
        value: undefined,
      });
    }),
  );
});
