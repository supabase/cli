import { Effect, Encoding, Schema } from "effect";
import { SignJWT } from "jose";
import { ServiceError } from "../Service.ts";
import {
  DEFAULT_LOCAL_JWT_SECRET,
  DEFAULT_LOCAL_PUBLISHABLE_KEY,
  DEFAULT_LOCAL_SECRET_KEY,
  DEFAULT_SIGNING_KEY,
} from "../Defaults.ts";
import type { StackCredentials, StackIdentityInput } from "../State.ts";

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
    Effect.mapError((cause) => serviceError("keys", cause)),
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
    catch: (cause) => serviceError("keys", cause),
  });

const defaultStackKeys = (jwtSecret: string) =>
  Effect.gen(function* () {
    const anonKey = yield* fixedJwt(jwtSecret, "anon");
    const serviceRoleKey = yield* fixedJwt(jwtSecret, "service_role");
    const gotrueJwtKeys = yield* stringify([DEFAULT_SIGNING_KEY]);
    const publicSigningKeys = yield* stringify([defaultPublicSigningKey]);
    return {
      publishableKey: DEFAULT_LOCAL_PUBLISHABLE_KEY,
      secretKey: DEFAULT_LOCAL_SECRET_KEY,
      anonKey,
      serviceRoleKey,
      gotrueJwtKeys,
      publicSigningKeys,
    };
  });

const JsonArray = Schema.Array(Schema.Unknown);
const jsonArray = (value: string, field: string) =>
  Schema.decodeEffect(Schema.fromJsonString(JsonArray))(value).pipe(
    Effect.mapError((cause) => serviceError("keys", new Error(`${field}: ${cause.message}`))),
  );

export const resolveStackKeys = Effect.fn("ServiceConfig.resolveStackKeys")(
  (jwtSecret: string, input: StackIdentityInput | undefined, saved: StackCredentials | undefined) =>
    Effect.gen(function* () {
      if (input === undefined && saved !== undefined) return saved;
      const defaults = yield* defaultStackKeys(jwtSecret);
      const gotrueJwtKeys = input?.gotrueJwtKeys ?? defaults.gotrueJwtKeys;
      const publicSigningKeys = input?.publicSigningKeys ?? defaults.publicSigningKeys;
      const remoteJwks = input?.remoteJwks ?? "[]";
      const privateKeys = yield* jsonArray(gotrueJwtKeys, "gotrueJwtKeys");
      const normalizedGotrueJwtKeys = yield* stringify(privateKeys);
      const localKeys = yield* jsonArray(publicSigningKeys, "publicSigningKeys");
      const remoteKeys = yield* jsonArray(remoteJwks, "remoteJwks");
      const hasConfiguredSigningKeys = input?.gotrueJwtKeys !== undefined && privateKeys.length > 0;
      let savedLocalKeys: ReadonlyArray<unknown> = [];
      if (saved !== undefined) {
        const savedJwks = yield* Schema.decodeEffect(
          Schema.fromJsonString(Schema.Struct({ keys: Schema.Array(Schema.Unknown) })),
        )(saved.jwks).pipe(Effect.mapError((cause) => serviceError("keys", cause)));
        const savedRemoteKeys = yield* jsonArray(saved.remoteJwks, "remoteJwks");
        savedLocalKeys = savedJwks.keys.slice(savedRemoteKeys.length);
      }
      const tokenSourceChanged =
        saved !== undefined &&
        (saved.jwtSecret !== jwtSecret ||
          saved.gotrueJwtKeys !== normalizedGotrueJwtKeys ||
          savedLocalKeys.some(
            (key) => typeof key === "object" && key !== null && "kty" in key && key.kty === "oct",
          ) !== !hasConfiguredSigningKeys);
      const jwks = yield* stringify({
        keys: [
          ...remoteKeys,
          ...localKeys,
          ...(hasConfiguredSigningKeys
            ? []
            : [{ kty: "oct", k: Encoding.encodeBase64Url(jwtSecret) }]),
        ],
      });
      const normalizedRemoteJwks = yield* stringify(remoteKeys);
      const anonKeyIsOverride = input?.anonKeyIsOverride ?? input?.anonKey !== undefined;
      const serviceRoleKeyIsOverride =
        input?.serviceRoleKeyIsOverride ?? input?.serviceRoleKey !== undefined;
      return {
        publishableKey: input?.publishableKey ?? defaults.publishableKey,
        secretKey: input?.secretKey ?? defaults.secretKey,
        anonKey: anonKeyIsOverride
          ? (input?.anonKey ?? defaults.anonKey)
          : saved !== undefined && !saved.anonKeyIsOverride && !tokenSourceChanged
            ? saved.anonKey
            : (input?.anonKey ?? defaults.anonKey),
        serviceRoleKey: serviceRoleKeyIsOverride
          ? (input?.serviceRoleKey ?? defaults.serviceRoleKey)
          : saved !== undefined && !saved.serviceRoleKeyIsOverride && !tokenSourceChanged
            ? saved.serviceRoleKey
            : (input?.serviceRoleKey ?? defaults.serviceRoleKey),
        jwks,
        gotrueJwtKeys: normalizedGotrueJwtKeys,
        remoteJwks: normalizedRemoteJwks,
        anonKeyIsOverride,
        serviceRoleKeyIsOverride,
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

/** A required input that is neither bound by a composition nor provided in config. */
export const missingInput = (service: string, input: string): ServiceError =>
  new ServiceError({
    operation: "input",
    message: `${service} requires input ${input}; bind it through a composition or provide it in config`,
  });

/** Fails a launch whose required input is neither bound by a composition nor provided in config. */
export const requiredInput = (
  service: string,
  input: string,
  value: string | undefined,
): Effect.Effect<string, ServiceError> =>
  value === undefined ? Effect.fail(missingInput(service, input)) : Effect.succeed(value);

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
