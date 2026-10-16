import { describe, expect, it } from "@effect/vitest";
import { Effect, Fiber, Layer } from "effect";
import * as HttpClient from "effect/http/HttpClient";
import * as TestClock from "effect/testing/TestClock";

import { probeTenantVersions } from "./tenant-versions.ts";

const hangingClient = Layer.succeed(
  HttpClient.HttpClient,
  HttpClient.make(() => Effect.never),
);

describe("probeTenantVersions", () => {
  it.effect("reports every service of a tenant that never answers as failed", () =>
    Effect.gen(function* () {
      const probe = yield* probeTenantVersions({
        ref: "abcdefghijklmnopqrst",
        projectHost: "supabase.test",
        serviceKey: "key",
        userAgent: "test",
      }).pipe(Effect.forkChild({ startImmediately: true }));

      yield* TestClock.adjust("10 seconds");

      const observed = yield* Fiber.join(probe);
      expect(observed.rest._tag).toBe("Failed");
      expect(observed.auth._tag).toBe("Failed");
      expect(observed.storage._tag).toBe("Failed");
    }).pipe(Effect.provide(hangingClient)),
  );
});
