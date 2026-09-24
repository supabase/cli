import { expect, it } from "@effect/vitest";
import { Buffer } from "node:buffer";
import { Effect, Encoding, Schema } from "effect";
import { importJWK, jwtVerify, SignJWT } from "jose";
import {
  DEFAULT_LOCAL_DATABASE_PASSWORD,
  DEFAULT_LOCAL_JWT_SECRET,
  DEFAULT_POSTGRES_ROOT_KEY,
  DEFAULT_SIGNING_KEY,
} from "../Defaults.ts";
import { resolveStackIdentity } from "./ServiceConfig.ts";

const PublishedJwks = Schema.fromJsonString(
  Schema.Struct({
    keys: Schema.Array(
      Schema.Union([
        Schema.Struct({
          kty: Schema.Literal("EC"),
          kid: Schema.String,
          crv: Schema.String,
          x: Schema.String,
          y: Schema.String,
        }),
        Schema.Struct({ kty: Schema.Literal("oct"), k: Schema.String }),
      ]),
    ),
  }),
);

const savedDefaults = Effect.map(
  resolveStackIdentity(DEFAULT_LOCAL_JWT_SECRET, undefined, undefined),
  (identity) => ({
    ...identity,
    jwtSecret: DEFAULT_LOCAL_JWT_SECRET,
    postgresRootKey: DEFAULT_POSTGRES_ROOT_KEY,
    databasePassword: DEFAULT_LOCAL_DATABASE_PASSWORD,
  }),
);

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
      anonKeyIsOverride: true,
      serviceRoleKeyIsOverride: true,
      remoteJwks: '[{"kid":"remote"}]',
      jwks: '{"keys":[{"kid":"remote"},{"kid":"public-signing-key"}]}',
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

it.effect("publishes a usable HMAC key for an empty signing-key file", () =>
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
    const jwks = yield* Schema.decodeEffect(PublishedJwks)(resolved.jwks);
    const hmacKey = jwks.keys.find((key) => key.kty === "oct");
    if (hmacKey === undefined) return yield* Effect.die("JWKS has no HMAC key");
    yield* Effect.tryPromise(() =>
      jwtVerify(resolved.anonKey, Buffer.from(hmacKey.k, "base64url")),
    );
    yield* Effect.tryPromise(() =>
      jwtVerify(resolved.serviceRoleKey, Buffer.from(hmacKey.k, "base64url")),
    );
  }),
);

it.effect(
  "rotates tokens when switching between HMAC and an explicit copy of the default key",
  () =>
    Effect.gen(function* () {
      const defaults = yield* savedDefaults;
      const publicSigningKey = {
        kty: DEFAULT_SIGNING_KEY.kty,
        kid: DEFAULT_SIGNING_KEY.kid,
        use: DEFAULT_SIGNING_KEY.use,
        key_ops: ["verify"],
        alg: DEFAULT_SIGNING_KEY.alg,
        ext: DEFAULT_SIGNING_KEY.ext,
        crv: DEFAULT_SIGNING_KEY.crv,
        x: DEFAULT_SIGNING_KEY.x,
        y: DEFAULT_SIGNING_KEY.y,
      };
      const privateSigningKey = { ...DEFAULT_SIGNING_KEY, key_ops: ["sign"] };
      const privateKey = yield* Effect.tryPromise(() => importJWK(privateSigningKey, "ES256"));
      const anonKey = yield* Effect.tryPromise(() =>
        new SignJWT({ iss: "supabase-demo", role: "anon", exp: 1983812996 })
          .setProtectedHeader({ alg: "ES256", typ: "JWT", kid: DEFAULT_SIGNING_KEY.kid })
          .sign(privateKey),
      );
      const serviceRoleKey = yield* Effect.tryPromise(() =>
        new SignJWT({ iss: "supabase-demo", role: "service_role", exp: 1983812996 })
          .setProtectedHeader({ alg: "ES256", typ: "JWT", kid: DEFAULT_SIGNING_KEY.kid })
          .sign(privateKey),
      );
      const configured = yield* resolveStackIdentity(
        DEFAULT_LOCAL_JWT_SECRET,
        {
          gotrueJwtKeys: JSON.stringify([DEFAULT_SIGNING_KEY]),
          publicSigningKeys: JSON.stringify([publicSigningKey]),
          anonKey,
          serviceRoleKey,
          anonKeyIsOverride: false,
          serviceRoleKeyIsOverride: false,
        },
        { ...defaults, anonKeyIsOverride: false, serviceRoleKeyIsOverride: false },
      );
      expect(configured.anonKey).toBe(anonKey);
      expect(configured.serviceRoleKey).toBe(serviceRoleKey);
      expect(configured.jwks).toContain(DEFAULT_SIGNING_KEY.kid);
      expect(configured.jwks).not.toContain('"kty":"oct"');
      const configuredJwks = yield* Schema.decodeEffect(PublishedJwks)(configured.jwks);
      const publishedKeyData = configuredJwks.keys.find((key) => key.kty === "EC");
      if (publishedKeyData === undefined) return yield* Effect.die("JWKS has no EC key");
      const publishedKey = yield* Effect.tryPromise(() => importJWK(publishedKeyData, "ES256"));
      yield* Effect.tryPromise(() => jwtVerify(configured.anonKey, publishedKey));
      yield* Effect.tryPromise(() => jwtVerify(configured.serviceRoleKey, publishedKey));

      const reverted = yield* resolveStackIdentity(
        DEFAULT_LOCAL_JWT_SECRET,
        {},
        {
          ...configured,
          jwtSecret: DEFAULT_LOCAL_JWT_SECRET,
          postgresRootKey: DEFAULT_POSTGRES_ROOT_KEY,
          databasePassword: DEFAULT_LOCAL_DATABASE_PASSWORD,
        },
      );
      expect(reverted.anonKey).toBe(defaults.anonKey);
      expect(reverted.serviceRoleKey).toBe(defaults.serviceRoleKey);
      const revertedJwks = yield* Schema.decodeEffect(PublishedJwks)(reverted.jwks);
      const revertedHmacKey = revertedJwks.keys.find((key) => key.kty === "oct");
      if (revertedHmacKey === undefined) return yield* Effect.die("JWKS has no HMAC key");
      yield* Effect.tryPromise(() =>
        jwtVerify(reverted.anonKey, Buffer.from(revertedHmacKey.k, "base64url")),
      );
      yield* Effect.tryPromise(() =>
        jwtVerify(reverted.serviceRoleKey, Buffer.from(revertedHmacKey.k, "base64url")),
      );
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
      jwks: '{"keys":[{"kid":"public-signing-key"}]}',
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
      jwks: '{"keys":[{"kid":"local-public"}]}',
    };
    const resolved = yield* resolveStackIdentity(
      DEFAULT_LOCAL_JWT_SECRET,
      {
        gotrueJwtKeys: saved.gotrueJwtKeys,
        publicSigningKeys: '[{"kid":"local-public"}]',
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
      jwks: '{"keys":[{"kid":"local-public"}]}',
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
