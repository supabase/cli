import { Effect, Encoding, Schema } from "effect";
import { SignJWT } from "jose";
import { ServiceError } from "../Service.ts";
import {
  DEFAULT_LOCAL_JWT_SECRET,
  DEFAULT_LOCAL_PUBLISHABLE_KEY,
  DEFAULT_LOCAL_SECRET_KEY,
  DEFAULT_SIGNING_KEY,
} from "../Defaults.ts";
import type { StackIdentityInput } from "../State.ts";

const serviceError = (operation: string, cause: unknown): ServiceError =>
  cause instanceof ServiceError
    ? cause
    : new ServiceError({
        operation,
        message: cause instanceof Error ? cause.message : String(cause),
        cause,
      });

const stringify = (value: unknown) =>
  Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(value).pipe(
    Effect.mapError((cause) => serviceError("identity", cause)),
  );

export const localJwtSecret = DEFAULT_LOCAL_JWT_SECRET;

const defaultPublicSigningKey = {
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

const fixedJwt = (secret: string, role: "anon" | "service_role") =>
  Effect.tryPromise({
    try: () =>
      new SignJWT({ iss: "supabase-demo", role, exp: 1983812996 })
        .setProtectedHeader({ alg: "HS256", typ: "JWT" })
        .sign(new TextEncoder().encode(secret)),
    catch: (cause) => serviceError("identity", cause),
  });

export const defaultStackIdentity = (jwtSecret: string) =>
  Effect.gen(function* () {
    const anonKey = yield* fixedJwt(jwtSecret, "anon");
    const serviceRoleKey = yield* fixedJwt(jwtSecret, "service_role");
    const jwks = yield* stringify({
      keys: [defaultPublicSigningKey, { kty: "oct", k: Encoding.encodeBase64Url(jwtSecret) }],
    });
    const gotrueJwtKeys = yield* stringify([DEFAULT_SIGNING_KEY]);
    const publicSigningKeys = yield* stringify([defaultPublicSigningKey]);
    return {
      publishableKey: DEFAULT_LOCAL_PUBLISHABLE_KEY,
      secretKey: DEFAULT_LOCAL_SECRET_KEY,
      anonKey,
      serviceRoleKey,
      jwks,
      gotrueJwtKeys,
      publicSigningKeys,
      remoteJwks: "[]",
    };
  });

const JsonArray = Schema.Array(Schema.Unknown);
const jsonArray = (value: string, field: string) =>
  Schema.decodeEffect(Schema.fromJsonString(JsonArray))(value).pipe(
    Effect.mapError((cause) => serviceError("identity", new Error(`${field}: ${cause.message}`))),
  );

export const resolveStackIdentity = Effect.fn("ServiceConfig.resolveStackIdentity")(
  (
    jwtSecret: string,
    input: StackIdentityInput | undefined,
    saved:
      | {
          readonly publishableKey: string;
          readonly secretKey: string;
          readonly anonKey: string;
          readonly serviceRoleKey: string;
          readonly jwks: string;
          readonly gotrueJwtKeys: string;
          readonly jwtSecret: string;
          readonly publicSigningKeys: string;
          readonly remoteJwks: string;
          readonly configuredJwtSecret?: string;
          readonly configuredSigningKeys?: string;
          readonly configuredPublishableKey?: string;
          readonly configuredSecretKey?: string;
          readonly configuredAnonKey?: string;
          readonly configuredServiceRoleKey?: string;
        }
      | undefined,
  ) =>
    Effect.gen(function* () {
      const defaults = yield* defaultStackIdentity(jwtSecret);
      const sourcesChanged =
        saved !== undefined &&
        (saved.jwtSecret !== jwtSecret ||
          saved.configuredSigningKeys !== input?.configuredSigningKeys);
      const tokenSourceChanged =
        saved !== undefined &&
        (saved.jwtSecret !== jwtSecret ||
          saved.configuredSigningKeys !== input?.configuredSigningKeys ||
          saved.configuredAnonKey !== input?.configuredAnonKey ||
          saved.configuredServiceRoleKey !== input?.configuredServiceRoleKey);
      const signingKeysRemoved =
        input !== undefined &&
        input.configuredSigningKeys === undefined &&
        saved?.configuredSigningKeys !== undefined;
      const gotrueJwtKeys =
        input?.gotrueJwtKeys ??
        (input !== undefined && (signingKeysRemoved || sourcesChanged)
          ? defaults.gotrueJwtKeys
          : (saved?.gotrueJwtKeys ?? defaults.gotrueJwtKeys));
      const publicSigningKeys =
        input?.publicSigningKeys ??
        (input !== undefined &&
        (signingKeysRemoved || sourcesChanged || input.gotrueJwtKeys === undefined)
          ? defaults.publicSigningKeys
          : (saved?.publicSigningKeys ?? defaults.publicSigningKeys));
      const remoteJwks =
        input?.remoteJwks ?? (input === undefined ? (saved?.remoteJwks ?? "[]") : "[]");
      let jwks = saved?.jwks ?? defaults.jwks;
      const keySetChanged =
        input?.gotrueJwtKeys !== undefined ||
        input?.publicSigningKeys !== undefined ||
        input?.remoteJwks !== undefined ||
        (saved !== undefined &&
          (saved.jwtSecret !== jwtSecret ||
            saved.publicSigningKeys !== publicSigningKeys ||
            saved.remoteJwks !== remoteJwks)) ||
        (input !== undefined && sourcesChanged);
      if (keySetChanged) {
        const localKeys = yield* jsonArray(publicSigningKeys, "publicSigningKeys");
        const remoteKeys = yield* jsonArray(remoteJwks, "remoteJwks");
        jwks = yield* stringify({
          keys: [
            ...remoteKeys,
            ...localKeys,
            { kty: "oct", k: Encoding.encodeBase64Url(jwtSecret) },
          ],
        });
      }
      const normalizedPublicSigningKeys = yield* stringify(
        yield* jsonArray(publicSigningKeys, "publicSigningKeys"),
      );
      const normalizedRemoteJwks = yield* stringify(yield* jsonArray(remoteJwks, "remoteJwks"));
      return {
        publishableKey:
          input === undefined
            ? (saved?.publishableKey ?? defaults.publishableKey)
            : (input.publishableKey ?? defaults.publishableKey),
        secretKey:
          input === undefined
            ? (saved?.secretKey ?? defaults.secretKey)
            : (input.secretKey ?? defaults.secretKey),
        anonKey:
          input === undefined || (saved !== undefined && !tokenSourceChanged)
            ? (saved?.anonKey ?? defaults.anonKey)
            : (input.anonKey ?? (yield* fixedJwt(jwtSecret, "anon"))),
        serviceRoleKey:
          input === undefined || (saved !== undefined && !tokenSourceChanged)
            ? (saved?.serviceRoleKey ?? defaults.serviceRoleKey)
            : (input.serviceRoleKey ?? (yield* fixedJwt(jwtSecret, "service_role"))),
        jwks,
        gotrueJwtKeys,
        publicSigningKeys: normalizedPublicSigningKeys,
        remoteJwks: normalizedRemoteJwks,
        ...(input === undefined
          ? saved?.configuredJwtSecret === undefined
            ? {}
            : { configuredJwtSecret: saved.configuredJwtSecret }
          : input.configuredJwtSecret === undefined || input.configuredJwtSecret.length === 0
            ? {}
            : { configuredJwtSecret: input.configuredJwtSecret }),
        ...(input === undefined
          ? saved?.configuredSigningKeys === undefined
            ? {}
            : { configuredSigningKeys: saved.configuredSigningKeys }
          : input.configuredSigningKeys === undefined || input.configuredSigningKeys.length === 0
            ? {}
            : { configuredSigningKeys: input.configuredSigningKeys }),
        ...(input === undefined
          ? saved?.configuredPublishableKey === undefined
            ? {}
            : { configuredPublishableKey: saved.configuredPublishableKey }
          : input.configuredPublishableKey === undefined ||
              input.configuredPublishableKey.length === 0
            ? {}
            : { configuredPublishableKey: input.configuredPublishableKey }),
        ...(input === undefined
          ? saved?.configuredSecretKey === undefined
            ? {}
            : { configuredSecretKey: saved.configuredSecretKey }
          : input.configuredSecretKey === undefined || input.configuredSecretKey.length === 0
            ? {}
            : { configuredSecretKey: input.configuredSecretKey }),
        ...(input === undefined
          ? saved?.configuredAnonKey === undefined
            ? {}
            : { configuredAnonKey: saved.configuredAnonKey }
          : input.configuredAnonKey === undefined || input.configuredAnonKey.length === 0
            ? {}
            : { configuredAnonKey: input.configuredAnonKey }),
        ...(input === undefined
          ? saved?.configuredServiceRoleKey === undefined
            ? {}
            : { configuredServiceRoleKey: saved.configuredServiceRoleKey }
          : input.configuredServiceRoleKey === undefined ||
              input.configuredServiceRoleKey.length === 0
            ? {}
            : { configuredServiceRoleKey: input.configuredServiceRoleKey }),
      };
    }),
);

export const serviceJwt = Effect.fn("ServiceConfig.serviceJwt")(
  (role: string, secret: string): Effect.Effect<string, ServiceError> =>
    Effect.tryPromise(() =>
      new SignJWT({ role, aud: "authenticated" })
        .setProtectedHeader({ alg: "HS256", typ: "JWT" })
        .setIssuedAt()
        .sign(new TextEncoder().encode(secret)),
    ).pipe(Effect.mapError((cause) => serviceError("launch", cause))),
);

export const databaseConnection = Effect.fn("ServiceConfig.databaseConnection")(
  (
    value: string,
  ): Effect.Effect<
    Readonly<{
      readonly host: string;
      readonly port: string;
      readonly database: string;
      readonly username: string | undefined;
      readonly password: string | undefined;
    }>,
    ServiceError
  > =>
    Effect.try({
      try: () => {
        const url = new URL(value);
        return {
          host: url.hostname || "127.0.0.1",
          port: url.port || "5432",
          database: url.pathname.replace(/^\//u, "") || "postgres",
          username: url.username === "" ? undefined : decodeURIComponent(url.username),
          password: url.password === "" ? undefined : decodeURIComponent(url.password),
        };
      },
      catch: (cause) => serviceError("launch", cause),
    }),
);
