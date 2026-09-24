import { expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { DEFAULT_LOCAL_JWT_SECRET } from "../Defaults.ts";
import { defaultStackIdentity, resolveStackIdentity } from "./ServiceConfig.ts";

it.effect("removing identity overrides restores local defaults and drops remote JWKS keys", () =>
  Effect.gen(function* () {
    const savedDefaults = yield* defaultStackIdentity(DEFAULT_LOCAL_JWT_SECRET);
    const saved = {
      ...savedDefaults,
      jwtSecret: DEFAULT_LOCAL_JWT_SECRET,
      configuredPublishableKey: "configured-publishable",
      configuredSecretKey: "configured-secret",
      configuredAnonKey: "configured-anon",
      configuredServiceRoleKey: "configured-service-role",
      configuredSigningKeys: "keys.json",
      configuredJwtSecret: "configured-jwt",
      publishableKey: "configured-publishable",
      secretKey: "configured-secret",
      anonKey: "configured-anon",
      serviceRoleKey: "configured-service-role",
      remoteJwks: '[{"kid":"remote"}]',
      jwks: '[{"kid":"remote"}]',
    };
    const resolved = yield* resolveStackIdentity(DEFAULT_LOCAL_JWT_SECRET, {}, saved);

    expect(resolved.publishableKey).toBe(savedDefaults.publishableKey);
    expect(resolved.secretKey).toBe(savedDefaults.secretKey);
    expect(resolved.anonKey).toBe(savedDefaults.anonKey);
    expect(resolved.serviceRoleKey).toBe(savedDefaults.serviceRoleKey);
    expect(resolved.remoteJwks).toBe("[]");
    expect(resolved.jwks).not.toContain("remote");
    expect(resolved.configuredPublishableKey).toBeUndefined();
    expect(resolved.configuredSigningKeys).toBeUndefined();
  }),
);

it.effect("derives local HMAC tokens and publishes its key after JWT secret rotation", () =>
  Effect.gen(function* () {
    const saved = {
      ...(yield* defaultStackIdentity(DEFAULT_LOCAL_JWT_SECRET)),
      jwtSecret: DEFAULT_LOCAL_JWT_SECRET,
    };
    const rotated = yield* defaultStackIdentity("rotated-jwt-secret-with-at-least-32-characters");
    const resolved = yield* resolveStackIdentity(
      "rotated-jwt-secret-with-at-least-32-characters",
      {},
      saved,
    );

    expect(resolved.anonKey).toBe(rotated.anonKey);
    expect(resolved.serviceRoleKey).toBe(rotated.serviceRoleKey);
    expect(resolved.jwks).toBe(rotated.jwks);
    expect(resolved.jwks).not.toBe(saved.jwks);
  }),
);

it.effect("retains saved tokens when the signing source is unchanged", () =>
  Effect.gen(function* () {
    const defaults = yield* defaultStackIdentity(DEFAULT_LOCAL_JWT_SECRET);
    const source = '[{"kid":"signing-key"}]';
    const saved = {
      ...defaults,
      jwtSecret: DEFAULT_LOCAL_JWT_SECRET,
      anonKey: "saved-asymmetric-anon-token",
      serviceRoleKey: "saved-asymmetric-service-token",
      gotrueJwtKeys: source,
      configuredSigningKeys: source,
    };
    const resolved = yield* resolveStackIdentity(
      DEFAULT_LOCAL_JWT_SECRET,
      {
        gotrueJwtKeys: source,
        configuredSigningKeys: source,
        publicSigningKeys: defaults.publicSigningKeys,
        remoteJwks: "[]",
        anonKey: "newly-minted-anon-token",
        serviceRoleKey: "newly-minted-service-token",
      },
      saved,
    );

    expect(resolved.anonKey).toBe(saved.anonKey);
    expect(resolved.serviceRoleKey).toBe(saved.serviceRoleKey);
    expect(resolved.jwks).toBe(saved.jwks);
  }),
);
