import { expect, it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import * as Realtime from "./Realtime.ts";
import * as Rest from "./Rest.ts";
import * as Storage from "./Storage.ts";
import * as Studio from "./Studio.ts";

it("forwards PostgREST JWKS through its consumed JWT secret setting", () => {
  const creation = Schema.decodeSync(Rest.Creation)({
    service: "rest",
    config: {
      databaseUrl: "postgresql://localhost/postgres",
      jwtSecret: "active-hmac-secret",
      jwks: '{"keys":[{"kty":"EC"}]}',
    },
  });
  const env = Effect.runSync(Rest.makeSpec().env(creation, new Map(), false));

  expect(env.PGRST_JWT_SECRET).toBe('{"keys":[{"kty":"EC"}]}');
  expect(env).not.toHaveProperty("PGRST_JWT_JWKS");
});

it("forwards a PostgREST HMAC secret when JWKS is omitted", () => {
  const creation = Schema.decodeSync(Rest.Creation)({
    service: "rest",
    config: { databaseUrl: "postgresql://localhost/postgres", jwtSecret: "active-hmac-secret" },
  });
  const env = Effect.runSync(Rest.makeSpec().env(creation, new Map(), false));

  expect(env.PGRST_JWT_SECRET).toBe("active-hmac-secret");
});

it("forwards Realtime JWKS while retaining its default JWT secret", () => {
  const creation = Schema.decodeSync(Realtime.Creation)({
    service: "realtime",
    config: { databaseUrl: "postgresql://localhost/postgres", jwks: "active-jwks" },
  });
  const env = Effect.runSync(Realtime.makeSpec().env(creation, new Map(), false));

  expect(env.API_JWT_JWKS).toBe("active-jwks");
  expect(env.API_JWT_SECRET).toBeDefined();
});

it.effect("forwards Storage JWKS and active anon/service-role keys", () =>
  Effect.gen(function* () {
    const creation = yield* Schema.decodeEffect(Storage.Creation)({
      service: "storage",
      config: {
        databaseUrl: "postgresql://localhost/postgres",
        filePath: "/tmp/storage",
        jwks: "active-jwks",
        anonKey: "active-anon",
        serviceRoleKey: "active-service-role",
      },
    });
    const env = yield* Storage.makeSpec().env(creation, new Map(), false);

    expect(env.JWT_JWKS).toBe("active-jwks");
    expect(env.ANON_KEY).toBe("active-anon");
    expect(env.SERVICE_KEY).toBe("active-service-role");
  }),
);

it("forwards active client keys to Studio without requiring a JWT secret", () => {
  const creation = Schema.decodeSync(Studio.Creation)({
    service: "studio",
    config: {
      anonKey: "active-anon",
      serviceRoleKey: "active-service-role",
      publishableKey: "active-publishable",
      secretKey: "active-secret",
    },
  });
  const env = Effect.runSync(Studio.makeSpec().env(creation, new Map(), false));

  expect(env.SUPABASE_ANON_KEY).toBe("active-anon");
  expect(env.SUPABASE_SERVICE_KEY).toBe("active-service-role");
  expect(env.SUPABASE_PUBLISHABLE_KEY).toBe("active-publishable");
  expect(env.SUPABASE_SECRET_KEY).toBe("active-secret");
});
