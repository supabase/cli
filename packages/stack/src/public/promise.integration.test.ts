// oxlint-disable effecttsgo/async-function -- integration test exercises the Promise facade directly.
import { describe, expect, it } from "@effect/vitest";
import { Effect, Redacted, Stream } from "effect";
import type { EffectStack } from "./EffectStack.ts";
import { adaptEffectStack, type PromiseStack } from "./PromiseStack.ts";

const stackId = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef" as never;

const status = {
  id: stackId,
  lifecycle: "running" as const,
  desiredLifecycle: "running" as const,
  runtime: { kind: "native" as const },
  endpoints: {},
  versions: {},
  capabilities: [],
};

const effectStack = (): EffectStack =>
  ({
    id: stackId,
    status: () => Effect.succeed(status),
    credentials: () =>
      Effect.succeed({
        database: { url: Redacted.make("postgres://secret"), password: Redacted.make("db-pass") },
        api: {
          publishableKey: "publishable",
          secretKey: Redacted.make("secret-key"),
          anonJwt: "anon",
          serviceRoleJwt: Redacted.make("service-role"),
        },
        storage: {
          endpoint: "http://storage",
          region: "local",
          accessKeyId: "access",
          secretAccessKey: Redacted.make("storage-secret"),
        },
      }),
    prepare: () => Effect.succeed({ capabilities: [] }),
    start: () => Effect.succeed(status),
    restart: () => Effect.succeed(status),
    stop: () => Effect.void,
    destroy: () => Effect.void,
    close: () => Effect.void,
    watchStatus: () => Stream.make(status),
    logs: () => Stream.make(),
  }) satisfies EffectStack;

describe("Promise stack facade", () => {
  it("unwraps every credential secret and exposes explicit close without async disposal", async () => {
    const stack: PromiseStack = adaptEffectStack(effectStack());

    await expect(stack.credentials()).resolves.toEqual({
      database: { url: "postgres://secret", password: "db-pass" },
      api: {
        publishableKey: "publishable",
        secretKey: "secret-key",
        anonJwt: "anon",
        serviceRoleJwt: "service-role",
      },
      storage: {
        endpoint: "http://storage",
        region: "local",
        accessKeyId: "access",
        secretAccessKey: "storage-secret",
      },
    });
    expect(Symbol.asyncDispose in stack).toBe(false);
    await expect(stack.close()).resolves.toBeUndefined();
    await expect(stack.close()).resolves.toBeUndefined();
  });

  it("cancels an async stream when the consumer returns early", async () => {
    const stack = adaptEffectStack(effectStack());
    const iterator = stack.watchStatus()[Symbol.asyncIterator]();
    await expect(iterator.next()).resolves.toMatchObject({ done: false });
    await expect(iterator.return?.()).resolves.toMatchObject({ done: true });
    await stack.close();
  });
});
