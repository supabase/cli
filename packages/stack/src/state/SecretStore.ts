import { Clock, Crypto, Effect, FileSystem, Path, Redacted, Schema } from "effect";
// oxlint-disable-next-line effecttsgo/node-builtin-import
import { createHmac, createPrivateKey, createSign } from "node:crypto";
import {
  InvalidJwtSigningMaterialError,
  StackMustBeStoppedError,
  StackSecretMismatchError,
} from "../public/Errors.ts";
import type { DesiredStackLifecycle } from "../public/Status.ts";
import type { PersistedSecretValues } from "./StackState.ts";

type SecretPolicy = "managed" | "passthrough";

export type SecretJwtSigning =
  | { readonly kind: "symmetric" }
  | { readonly kind: "jwks-file"; readonly projectRoot: string; readonly path: string };

/** Lifecycle-only metadata for generating omitted managed credentials. */
export type SecretGenerator =
  | { readonly kind: "publishable-key" }
  | { readonly kind: "secret-key" }
  | { readonly kind: "jwt-secret" }
  | { readonly kind: "random-base64url"; readonly bytes: number }
  | {
      readonly kind: "jwt-token";
      readonly role: "anon" | "service_role";
      readonly signing: SecretJwtSigning;
    };

export interface SecretDeclaration {
  readonly slot: string;
  readonly policy: SecretPolicy;
  readonly value?: Redacted.Redacted<unknown>;
  readonly generator?: SecretGenerator;
}

export interface SecretCandidate {
  /** Complete pass-through declarations plus any managed slots supplied by the caller. */
  readonly declarations: ReadonlyArray<SecretDeclaration>;
}

export interface ResolvedSecrets {
  readonly persisted: PersistedSecretValues;
}

const secretMismatch = (slot: string, message: string) =>
  new StackSecretMismatchError({ slot, message });

const lifecycleChange = (slot?: string) =>
  new StackMustBeStoppedError({
    ...(slot === undefined ? {} : { slot }),
    message: "Pass-through secrets may only change while the stack is stopped",
  });

const readSecret = (value: Redacted.Redacted<unknown>): string => {
  const unredacted = Redacted.value(value);
  return typeof unredacted === "string" ? unredacted : String(unredacted);
};
const validSlot = (slot: string): boolean => /^[A-Za-z0-9_.:/-]+$/.test(slot);

const AUTH_JWT_SECRET_SLOT = "secret:auth.settings.jwt_secret";
const JWT_ISSUER = "supabase-demo";
const JWT_HMAC_EXPIRY = 1_983_812_996;
const JWT_ASYMMETRIC_EXPIRY_SECONDS = 60 * 60 * 24 * 365 * 10;
const BASE64URL = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

const JwtHeaderSchema = Schema.Struct({
  alg: Schema.String,
  kid: Schema.optionalKey(Schema.String),
  typ: Schema.Literal("JWT"),
});
type JwtHeader = Schema.Schema.Type<typeof JwtHeaderSchema>;
const JwtPayloadSchema = Schema.Struct({
  iss: Schema.Literal(JWT_ISSUER),
  role: Schema.Literals(["anon", "service_role"] as const),
  exp: Schema.Finite,
});
type JwtPayload = Schema.Schema.Type<typeof JwtPayloadSchema>;
const JwkSchema = Schema.Struct({
  alg: Schema.optionalKey(Schema.String),
  crv: Schema.optionalKey(Schema.String),
  d: Schema.optionalKey(Schema.String),
  dp: Schema.optionalKey(Schema.String),
  dq: Schema.optionalKey(Schema.String),
  e: Schema.optionalKey(Schema.String),
  kty: Schema.String,
  kid: Schema.optionalKey(Schema.String),
  n: Schema.optionalKey(Schema.String),
  p: Schema.optionalKey(Schema.String),
  q: Schema.optionalKey(Schema.String),
  qi: Schema.optionalKey(Schema.String),
  use: Schema.optionalKey(Schema.String),
  key_ops: Schema.optionalKey(Schema.Array(Schema.String)),
  ext: Schema.optionalKey(Schema.Boolean),
  x: Schema.optionalKey(Schema.String),
  y: Schema.optionalKey(Schema.String),
});
const JwkFileSchema = Schema.Union([Schema.Array(JwkSchema), JwkSchema]);
const encodeJwtHeader = (value: JwtHeader) =>
  Schema.encodeEffect(Schema.fromJsonString(JwtHeaderSchema))(value);
const encodeJwtPayload = (value: JwtPayload) =>
  Schema.encodeEffect(Schema.fromJsonString(JwtPayloadSchema))(value);

export const base64UrlEncode = (bytes: Uint8Array): string => {
  let output = "";
  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index] ?? 0;
    const second = bytes[index + 1];
    const third = bytes[index + 2];
    output += BASE64URL[first >> 2] ?? "";
    output += BASE64URL[((first & 3) << 4) | ((second ?? 0) >> 4)] ?? "";
    if (second !== undefined) output += BASE64URL[((second & 15) << 2) | ((third ?? 0) >> 6)] ?? "";
    if (third !== undefined) output += BASE64URL[third & 63] ?? "";
  }
  return output;
};

const base64UrlEncodeText = (value: string): string =>
  base64UrlEncode(new TextEncoder().encode(value));

/** Redacts known exact values without attempting to infer transformed/derived secrets. */
export const redactKnownSecrets = (message: string, known: Iterable<string>): string => {
  let result = message;
  const secrets = [...new Set([...known].filter((secret) => secret.length > 0))].sort(
    (left, right) => right.length - left.length,
  );
  for (const secret of secrets) result = result.split(secret).join("[REDACTED]");
  return result;
};

const generatedSecret = (crypto: Crypto.Crypto) =>
  crypto.randomUUIDv4.pipe(
    Effect.mapError((error) =>
      secretMismatch("managed", `Unable to generate managed secret: ${error.message}`),
    ),
  );

const randomEncoded = (
  crypto: Crypto.Crypto,
  bytes: number,
  slot: string,
): Effect.Effect<string, StackSecretMismatchError> =>
  crypto.randomBytes(bytes).pipe(
    Effect.map(base64UrlEncode),
    Effect.mapError((error) =>
      secretMismatch(slot, `Unable to generate managed secret: ${error.message}`),
    ),
  );

export interface SigningJwk {
  readonly kty: "EC" | "RSA";
  readonly alg: "ES256" | "RS256";
  readonly d: string;
  readonly kid?: string;
  readonly use?: string;
  readonly key_ops?: Array<string>;
  readonly ext?: boolean;
  readonly crv?: string;
  readonly x?: string;
  readonly y?: string;
  readonly n?: string;
  readonly e?: string;
  readonly p?: string;
  readonly q?: string;
  readonly dp?: string;
  readonly dq?: string;
  readonly qi?: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const stringField = (record: Record<string, unknown>, key: string): string | undefined => {
  const value = record[key];
  return value === undefined ? undefined : typeof value === "string" ? value : undefined;
};

const booleanField = (record: Record<string, unknown>, key: string): boolean | undefined => {
  const value = record[key];
  return value === undefined ? undefined : typeof value === "boolean" ? value : undefined;
};

const stringArrayField = (
  record: Record<string, unknown>,
  key: string,
): Array<string> | undefined => {
  const value = record[key];
  return value === undefined
    ? undefined
    : Array.isArray(value) && value.every((entry) => typeof entry === "string")
      ? value
      : undefined;
};

const privateSigningJwk = (value: unknown): SigningJwk | undefined => {
  if (!isRecord(value)) return undefined;
  const kty = value.kty;
  const alg = value.alg;
  const d = stringField(value, "d");
  if (typeof d !== "string") return undefined;
  const kid = stringField(value, "kid");
  const use = stringField(value, "use");
  const keyOps = stringArrayField(value, "key_ops");
  const ext = booleanField(value, "ext");
  if (use !== undefined && use !== "sig") return undefined;
  if (keyOps !== undefined && !keyOps.includes("sign")) return undefined;
  if (kty === "EC" && alg === "ES256") {
    const crv = stringField(value, "crv");
    const x = stringField(value, "x");
    const y = stringField(value, "y");
    if (crv !== "P-256" || x === undefined || y === undefined) return undefined;
    return {
      kty,
      alg,
      d,
      ...(kid === undefined ? {} : { kid }),
      ...(use === undefined ? {} : { use }),
      ...(keyOps === undefined ? {} : { key_ops: keyOps }),
      ...(ext === undefined ? {} : { ext }),
      crv,
      x,
      y,
    };
  }
  if (kty === "RSA" && alg === "RS256") {
    const n = stringField(value, "n");
    const e = stringField(value, "e");
    const p = stringField(value, "p");
    const q = stringField(value, "q");
    if (n === undefined || e === undefined || p === undefined || q === undefined) return undefined;
    const dp = stringField(value, "dp");
    const dq = stringField(value, "dq");
    const qi = stringField(value, "qi");
    return {
      kty,
      alg,
      d,
      ...(kid === undefined ? {} : { kid }),
      ...(use === undefined ? {} : { use }),
      ...(keyOps === undefined ? {} : { key_ops: keyOps }),
      ...(ext === undefined ? {} : { ext }),
      n,
      e,
      p,
      q,
      ...(dp === undefined ? {} : { dp }),
      ...(dq === undefined ? {} : { dq }),
      ...(qi === undefined ? {} : { qi }),
    };
  }
  return undefined;
};

const invalidSigningMaterial = () =>
  new InvalidJwtSigningMaterialError({ message: "Unable to resolve JWT signing material" });

const readSigningJwks = (
  signing: Extract<SecretJwtSigning, { readonly kind: "jwks-file" }>,
): Effect.Effect<
  ReadonlyArray<SigningJwk>,
  InvalidJwtSigningMaterialError,
  FileSystem.FileSystem | Path.Path
> =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const fs = yield* FileSystem.FileSystem;
    const projectRoot = path.resolve(signing.projectRoot);
    const candidate = path.resolve(projectRoot, signing.path);
    const relative = path.relative(projectRoot, candidate);
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
      return yield* invalidSigningMaterial();
    const canonicalRoot = yield* fs
      .realPath(projectRoot)
      .pipe(Effect.mapError(() => invalidSigningMaterial()));
    const canonicalCandidate = yield* fs
      .realPath(candidate)
      .pipe(Effect.mapError(() => invalidSigningMaterial()));
    const canonicalRelative = path.relative(canonicalRoot, canonicalCandidate);
    if (
      canonicalRelative === ".." ||
      canonicalRelative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(canonicalRelative)
    )
      return yield* invalidSigningMaterial();
    const raw = yield* fs
      .readFileString(canonicalCandidate)
      .pipe(Effect.mapError(() => invalidSigningMaterial()));
    const parsed = yield* Schema.decodeEffect(Schema.fromJsonString(JwkFileSchema))(raw).pipe(
      Effect.mapError(() => invalidSigningMaterial()),
    );
    const entries = Array.isArray(parsed) ? parsed : [parsed];
    const keys: Array<SigningJwk> = [];
    for (const entry of entries) {
      const key = privateSigningJwk(entry);
      if (key === undefined) return yield* invalidSigningMaterial();
      yield* Effect.try({
        try: () => {
          createPrivateKey({ key, format: "jwk" });
        },
        catch: () => invalidSigningMaterial(),
      });
      keys.push(key);
    }
    if (keys.length === 0) return yield* invalidSigningMaterial();
    return keys;
  });

const readSigningJwk = (
  signing: Extract<SecretJwtSigning, { readonly kind: "jwks-file" }>,
): Effect.Effect<SigningJwk, InvalidJwtSigningMaterialError, FileSystem.FileSystem | Path.Path> =>
  readSigningJwks(signing).pipe(Effect.map((keys) => keys[0]!));

export interface ResolvedSigningKeyMaterial {
  /** The private signing keys as a JSON array for GoTrue's signing-key input. */
  readonly privateKeysJson: string;
  /** Public-only JWKs suitable for JWT verification. */
  readonly publicKeys: ReadonlyArray<Readonly<Record<string, unknown>>>;
  /** Public-only JWKs wrapped in a JWKS document. */
  readonly publicJwksJson: string;
}

const publicSigningJwk = (key: SigningJwk): Readonly<Record<string, unknown>> => ({
  kty: key.kty,
  ...(key.kid === undefined ? {} : { kid: key.kid }),
  use: "sig",
  key_ops: ["verify"],
  alg: key.alg,
  ...(key.ext === undefined ? {} : { ext: key.ext }),
  ...(key.kty === "RSA" ? { n: key.n, e: key.e } : { crv: key.crv, x: key.x, y: key.y }),
});

/** Reads every valid private key from a contained JWKS file and derives public material. */
export const resolveSigningKeyMaterial = (
  signing: Extract<SecretJwtSigning, { readonly kind: "jwks-file" }>,
): Effect.Effect<
  ResolvedSigningKeyMaterial,
  InvalidJwtSigningMaterialError,
  FileSystem.FileSystem | Path.Path
> =>
  readSigningJwks(signing).pipe(
    Effect.map((keys) => {
      const publicKeys = keys.map(publicSigningJwk);
      return {
        privateKeysJson: JSON.stringify(keys),
        publicKeys,
        publicJwksJson: JSON.stringify({ keys: publicKeys }),
      };
    }),
  );

const signWithJwk = (
  jwk: SigningJwk,
  payload: string,
): Effect.Effect<string, InvalidJwtSigningMaterialError> =>
  Effect.gen(function* () {
    const header: JwtHeader =
      jwk.kid === undefined
        ? { alg: jwk.alg, typ: "JWT" }
        : { alg: jwk.alg, kid: jwk.kid, typ: "JWT" };
    const headerJson = yield* encodeJwtHeader(header).pipe(
      Effect.mapError(() => invalidSigningMaterial()),
    );
    const data = `${base64UrlEncodeText(headerJson)}.${base64UrlEncodeText(payload)}`;
    return yield* Effect.try({
      try: () => {
        const privateKey = createPrivateKey({ key: jwk, format: "jwk" });
        const signer = createSign(jwk.alg === "RS256" ? "RSA-SHA256" : "sha256").update(data);
        const signature =
          jwk.alg === "RS256"
            ? signer.end().sign(privateKey)
            : signer.end().sign({ key: privateKey, dsaEncoding: "ieee-p1363" });
        return `${data}.${base64UrlEncode(signature)}`;
      },
      catch: () => invalidSigningMaterial(),
    });
  });

const generateJwtToken = (
  generator: Extract<SecretGenerator, { readonly kind: "jwt-token" }>,
  jwtSecret: string | undefined,
): Effect.Effect<string, InvalidJwtSigningMaterialError, FileSystem.FileSystem | Path.Path> => {
  const payloadFor = (expiry: number): JwtPayload => ({
    iss: JWT_ISSUER,
    role: generator.role,
    exp: expiry,
  });
  if (generator.signing.kind === "symmetric") {
    if (jwtSecret === undefined || jwtSecret.length === 0)
      return Effect.fail(invalidSigningMaterial());
    return Effect.gen(function* () {
      const header = base64UrlEncodeText(
        yield* encodeJwtHeader({ alg: "HS256", typ: "JWT" }).pipe(
          Effect.mapError(() => invalidSigningMaterial()),
        ),
      );
      const payload = base64UrlEncodeText(
        yield* encodeJwtPayload(payloadFor(JWT_HMAC_EXPIRY)).pipe(
          Effect.mapError(() => invalidSigningMaterial()),
        ),
      );
      const data = `${header}.${payload}`;
      return yield* Effect.try({
        try: () => `${data}.${createHmac("sha256", jwtSecret).update(data).digest("base64url")}`,
        catch: () => invalidSigningMaterial(),
      });
    });
  }
  return readSigningJwk(generator.signing).pipe(
    Effect.flatMap((jwk) =>
      Clock.currentTimeMillis.pipe(
        Effect.flatMap((nowMillis) =>
          encodeJwtPayload(
            payloadFor(Math.floor(nowMillis / 1000) + JWT_ASYMMETRIC_EXPIRY_SECONDS),
          ).pipe(
            Effect.mapError(() => invalidSigningMaterial()),
            Effect.flatMap((payload) => signWithJwk(jwk, payload)),
          ),
        ),
      ),
    ),
  );
};

const generatedFor = (
  declaration: SecretDeclaration,
  crypto: Crypto.Crypto,
  resolved: Record<string, { readonly policy: SecretPolicy; readonly value: string }>,
): Effect.Effect<
  string,
  StackSecretMismatchError | InvalidJwtSigningMaterialError,
  FileSystem.FileSystem | Path.Path
> => {
  const generator = declaration.generator;
  if (generator === undefined) return generatedSecret(crypto);
  switch (generator.kind) {
    case "publishable-key":
      return randomEncoded(crypto, 24, declaration.slot).pipe(
        Effect.map((value) => `sb_publishable_${value}`),
      );
    case "secret-key":
      return randomEncoded(crypto, 24, declaration.slot).pipe(
        Effect.map((value) => `sb_secret_${value}`),
      );
    case "jwt-secret":
      return randomEncoded(crypto, 32, declaration.slot);
    case "random-base64url":
      return randomEncoded(crypto, generator.bytes, declaration.slot);
    case "jwt-token":
      return generateJwtToken(generator, resolved[AUTH_JWT_SECRET_SLOT]?.value);
  }
};

/**
 * Resolves managed and pass-through secret declarations against dedicated persisted values.
 * Managed omission reuses/generates exactly once; pass-through declarations are complete and
 * can change only at a stopped lifecycle boundary.
 */
export const resolveSecrets = (
  candidate: SecretCandidate,
  persisted: PersistedSecretValues | undefined,
  lifecycle: DesiredStackLifecycle,
): Effect.Effect<
  ResolvedSecrets,
  StackSecretMismatchError | StackMustBeStoppedError | InvalidJwtSigningMaterialError,
  Crypto.Crypto | FileSystem.FileSystem | Path.Path
> =>
  Effect.gen(function* () {
    const crypto = yield* Crypto.Crypto;
    const isUnconfigured = persisted === undefined;
    const previous = persisted ?? {};
    const declarations = new Map<string, SecretDeclaration>();
    for (const declaration of candidate.declarations) {
      if (!validSlot(declaration.slot))
        return yield* secretMismatch("unknown", "Secret slot name is invalid");
      if (declarations.has(declaration.slot))
        return yield* secretMismatch(declaration.slot, "Duplicate secret declaration");
      declarations.set(declaration.slot, declaration);
    }

    const resolved: Record<string, { readonly policy: SecretPolicy; readonly value: string }> = {};
    const deferred: Array<[string, SecretDeclaration]> = [];
    for (const [slot, declaration] of declarations) {
      const old = previous[slot];
      if (old !== undefined && old.policy !== declaration.policy) {
        return yield* secretMismatch(slot, "Secret policy cannot change for an existing slot");
      }
      if (declaration.policy === "managed") {
        const supplied =
          declaration.value === undefined ? undefined : readSecret(declaration.value);
        if (old !== undefined) {
          if (supplied !== undefined && supplied !== old.value)
            return yield* secretMismatch(
              slot,
              "Supplied managed secret differs from persisted value",
            );
          resolved[slot] = old;
        } else {
          if (supplied === undefined && declaration.generator?.kind === "jwt-token") {
            deferred.push([slot, declaration]);
            continue;
          }
          const value = supplied ?? (yield* generatedFor(declaration, crypto, resolved));
          resolved[slot] = { policy: "managed", value };
        }
      } else {
        if (declaration.value === undefined)
          return yield* secretMismatch(slot, "Pass-through secret declarations require a value");
        const value = readSecret(declaration.value);
        if (
          lifecycle !== "stopped" &&
          ((old === undefined && !isUnconfigured) || (old !== undefined && old.value !== value))
        )
          return yield* lifecycleChange(slot);
        resolved[slot] = { policy: "passthrough", value };
      }
    }

    for (const [slot, declaration] of deferred) {
      const value = yield* generatedFor(declaration, crypto, resolved);
      resolved[slot] = { policy: "managed", value };
    }

    for (const [slot, old] of Object.entries(previous)) {
      if (old.policy === "managed") {
        resolved[slot] ??= old;
      } else if (!declarations.has(slot)) {
        if (lifecycle !== "stopped") return yield* lifecycleChange(slot);
      }
    }

    return { persisted: resolved };
  });
