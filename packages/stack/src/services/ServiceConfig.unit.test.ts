import { expect, it } from "@effect/vitest";
import { Effect, Encoding } from "effect";
import {
  DEFAULT_LOCAL_DATABASE_PASSWORD,
  DEFAULT_LOCAL_JWT_SECRET,
  DEFAULT_POSTGRES_ROOT_KEY,
} from "../Defaults.ts";
import { defaultStackIdentity, resolveStackIdentity } from "./ServiceConfig.ts";

const savedDefaults = Effect.map(defaultStackIdentity(DEFAULT_LOCAL_JWT_SECRET), (identity) => ({
  ...identity,
  jwtSecret: DEFAULT_LOCAL_JWT_SECRET,
  postgresRootKey: DEFAULT_POSTGRES_ROOT_KEY,
  databasePassword: DEFAULT_LOCAL_DATABASE_PASSWORD,
  anonKeyIsOverride: false,
  serviceRoleKeyIsOverride: false,
}));

it.effect("preserves the full saved identity when no identity input is supplied", () =>
  Effect.gen(function* () {
    const saved = {
      ...(yield* savedDefaults),
      publishableKey: "saved-publishable",
      secretKey: "saved-secret",
      anonKey: "saved-anon",
      serviceRoleKey: "saved-service-role",
      remoteJwks: '[{"kid":"saved-remote"}]',
      jwks: '[{"kid":"saved-jwks"}]',
    };

    expect(yield* resolveStackIdentity(DEFAULT_LOCAL_JWT_SECRET, undefined, saved)).toEqual(saved);
  }),
);

it.effect("removing key overrides uses new signing-key tokens and drops remote JWKS", () =>
  Effect.gen(function* () {
    const defaults = yield* savedDefaults;
    const privateKeys = '[{"kid":"private-signing-key"}]';
    const publicKeys = '[{"kid":"public-signing-key"}]';
    const saved = {
      ...defaults,
      publishableKey: "configured-publishable",
      secretKey: "configured-secret",
      anonKey: "configured-anon",
      serviceRoleKey: "configured-service-role",
      gotrueJwtKeys: privateKeys,
      publicSigningKeys: publicKeys,
      anonKeyIsOverride: true,
      serviceRoleKeyIsOverride: true,
      remoteJwks: '[{"kid":"remote"}]',
      jwks: '[{"kid":"remote"}]',
    };
    const resolved = yield* resolveStackIdentity(
      DEFAULT_LOCAL_JWT_SECRET,
      {
        gotrueJwtKeys: privateKeys,
        publicSigningKeys: publicKeys,
        anonKey: "new-signing-key-anon-token",
        serviceRoleKey: "new-signing-key-service-token",
        anonKeyIsOverride: false,
        serviceRoleKeyIsOverride: false,
      },
      saved,
    );

    expect(resolved.publishableKey).toBe(defaults.publishableKey);
    expect(resolved.secretKey).toBe(defaults.secretKey);
    expect(resolved.anonKey).toBe("new-signing-key-anon-token");
    expect(resolved.serviceRoleKey).toBe("new-signing-key-service-token");
    expect(resolved.anonKeyIsOverride).toBe(false);
    expect(resolved.serviceRoleKeyIsOverride).toBe(false);
    expect(resolved.remoteJwks).toBe("[]");
    expect(resolved.jwks).not.toContain("remote");
    expect(resolved.jwks).toContain("public-signing-key");
  }),
);

it.effect("publishes the HMAC key for an empty signing-key file", () =>
  Effect.gen(function* () {
    const resolved = yield* resolveStackIdentity(
      DEFAULT_LOCAL_JWT_SECRET,
      { gotrueJwtKeys: "[]", publicSigningKeys: "[]" },
      undefined,
    );

    const defaults = yield* savedDefaults;
    expect(resolved.anonKey).toBe(defaults.anonKey);
    expect(resolved.serviceRoleKey).toBe(defaults.serviceRoleKey);
    expect(resolved.jwks).toContain('"kty":"oct"');
    expect(resolved.jwks).toContain(Encoding.encodeBase64Url(DEFAULT_LOCAL_JWT_SECRET));
    expect(resolved.gotrueJwtKeys).toBe("[]");
  }),
);

it.effect("omits the HMAC key when asymmetric signing keys are configured", () =>
  Effect.gen(function* () {
    const resolved = yield* resolveStackIdentity(
      DEFAULT_LOCAL_JWT_SECRET,
      {
        gotrueJwtKeys: '[{"kid":"private-key"}]',
        publicSigningKeys: '[{"kid":"public-key"}]',
      },
      undefined,
    );

    expect(resolved.jwks).toContain("public-key");
    expect(resolved.jwks).not.toContain('"kty":"oct"');
  }),
);

it.effect("retains generated asymmetric tokens when the signing source is unchanged", () =>
  Effect.gen(function* () {
    const defaults = yield* savedDefaults;
    const privateKeys = '[{"kid":"private-signing-key"}]';
    const publicKeys = '[{"kid":"public-signing-key"}]';
    const saved = {
      ...defaults,
      anonKey: "saved-asymmetric-anon-token",
      serviceRoleKey: "saved-asymmetric-service-token",
      gotrueJwtKeys: privateKeys,
      publicSigningKeys: publicKeys,
    };
    const resolved = yield* resolveStackIdentity(
      DEFAULT_LOCAL_JWT_SECRET,
      {
        gotrueJwtKeys: privateKeys,
        publicSigningKeys: publicKeys,
        anonKey: "newly-minted-anon-token",
        serviceRoleKey: "newly-minted-service-token",
        anonKeyIsOverride: false,
        serviceRoleKeyIsOverride: false,
      },
      saved,
    );

    expect(resolved.anonKey).toBe(saved.anonKey);
    expect(resolved.serviceRoleKey).toBe(saved.serviceRoleKey);
  }),
);

it.effect("does not rotate local tokens when only remote JWKS changes", () =>
  Effect.gen(function* () {
    const defaults = yield* savedDefaults;
    const saved = {
      ...defaults,
      anonKey: "saved-asymmetric-anon-token",
      serviceRoleKey: "saved-asymmetric-service-token",
      gotrueJwtKeys: '[{"kid":"local-private"}]',
      publicSigningKeys: '[{"kid":"local-public"}]',
    };
    const resolved = yield* resolveStackIdentity(
      DEFAULT_LOCAL_JWT_SECRET,
      {
        gotrueJwtKeys: saved.gotrueJwtKeys,
        publicSigningKeys: saved.publicSigningKeys,
        remoteJwks: '[{"kid":"rotated-remote"}]',
        anonKeyIsOverride: false,
        serviceRoleKeyIsOverride: false,
      },
      saved,
    );

    expect(resolved.anonKey).toBe(saved.anonKey);
    expect(resolved.serviceRoleKey).toBe(saved.serviceRoleKey);
    expect(resolved.jwks).toContain("rotated-remote");
  }),
);

it.effect("keeps generated tokens when signing key JSON formatting changes", () =>
  Effect.gen(function* () {
    const defaults = yield* savedDefaults;
    const saved = {
      ...defaults,
      anonKey: "saved-asymmetric-anon-token",
      serviceRoleKey: "saved-asymmetric-service-token",
      gotrueJwtKeys: '[{"kid":"local-private"}]',
      publicSigningKeys: '[{"kid":"local-public"}]',
    };
    const resolved = yield* resolveStackIdentity(
      DEFAULT_LOCAL_JWT_SECRET,
      {
        gotrueJwtKeys: '[ { "kid" : "local-private" } ]',
        publicSigningKeys: '[{"kid":"local-public"}]',
        anonKey: "newly-minted-anon-token",
        serviceRoleKey: "newly-minted-service-token",
        anonKeyIsOverride: false,
        serviceRoleKeyIsOverride: false,
      },
      saved,
    );

    expect(resolved.anonKey).toBe(saved.anonKey);
    expect(resolved.serviceRoleKey).toBe(saved.serviceRoleKey);
  }),
);
