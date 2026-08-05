import { createPrivateKey, createPublicKey, createSign } from "node:crypto";
import { LocalCredentialsError } from "./errors.ts";
import {
  defaultJwtSecret,
  defaultPublishableKey,
  defaultSecretKey,
  generateJwt,
} from "./JwtGenerator.ts";

/** RFC 7517 signing-key fields accepted by the local Auth runtime. */
export interface LocalJwtSigningKey {
  readonly kty: string;
  readonly kid?: string;
  readonly use?: string;
  readonly key_ops?: string[];
  readonly alg?: string;
  readonly ext?: boolean;
  readonly n?: string;
  readonly e?: string;
  readonly d?: string;
  readonly p?: string;
  readonly q?: string;
  readonly dp?: string;
  readonly dq?: string;
  readonly qi?: string;
  readonly crv?: string;
  readonly x?: string;
  readonly y?: string;
}

export type LocalJwtSigningMaterial =
  | {
      readonly _tag: "SymmetricJwtSecret";
      readonly secret: string;
    }
  | {
      readonly _tag: "AsymmetricJwtKeys";
      readonly keys: readonly [LocalJwtSigningKey, ...ReadonlyArray<LocalJwtSigningKey>];
      /**
       * HS256 remains the shared secret for services that have not adopted JWKS verification.
       * Auth signs new tokens with `keys[0]` while accepting both asymmetric and HS256 tokens.
       */
      readonly legacySecret: string;
    };

/** Input credentials for one local stack. Secret values are data, never diagnostic context. */
export interface LocalCredentials {
  readonly signing?: LocalJwtSigningMaterial;
  readonly publishableKey?: string;
  readonly secretKey?: string;
  readonly anonKey?: string;
  readonly serviceRoleKey?: string;
}

export interface ResolvedLocalCredentials {
  readonly signing: LocalJwtSigningMaterial;
  readonly jwtSecret: string;
  readonly publishableKey: string;
  readonly secretKey: string;
  readonly anonKey: string;
  readonly serviceRoleKey: string;
  /**
   * Internal verifier set. In symmetric mode it contains the oct secret and must never be
   * exposed, persisted, or logged. Asymmetric mode contains public fields only.
   */
  readonly jwks: string;
}

const JWT_LIFETIME_SECONDS = 60 * 60 * 24 * 365 * 10;

function base64UrlEncode(input: string): string {
  return Buffer.from(input).toString("base64url");
}

function base64UrlToBigInt(value: string): bigint {
  const hex = Buffer.from(value, "base64url").toString("hex");
  return hex.length === 0 ? 0n : BigInt(`0x${hex}`);
}

function bigIntToBase64Url(value: bigint): string {
  let hex = value.toString(16);
  if (hex.length % 2 === 1) hex = `0${hex}`;
  return Buffer.from(hex, "hex").toString("base64url");
}

function modInverse(a: bigint, m: bigint): bigint {
  let [oldR, r] = [a, m];
  let [oldS, s] = [1n, 0n];
  while (r !== 0n) {
    const quotient = oldR / r;
    [oldR, r] = [r, oldR - quotient * r];
    [oldS, s] = [s, oldS - quotient * s];
  }
  return ((oldS % m) + m) % m;
}

function withRsaCrtParameters(key: LocalJwtSigningKey): LocalJwtSigningKey {
  if (key.dp !== undefined && key.dq !== undefined && key.qi !== undefined) return key;
  if (key.d === undefined || key.p === undefined || key.q === undefined) return key;

  const d = base64UrlToBigInt(key.d);
  const p = base64UrlToBigInt(key.p);
  const q = base64UrlToBigInt(key.q);
  return {
    ...key,
    dp: bigIntToBase64Url(d % (p - 1n)),
    dq: bigIntToBase64Url(d % (q - 1n)),
    qi: bigIntToBase64Url(modInverse(q, p)),
  };
}

function invalidSigningKey(index: number): LocalCredentialsError {
  return new LocalCredentialsError({
    path: `credentials.signing.keys[${index}]`,
    detail: "The configured local JWT signing key is invalid or unsupported.",
  });
}

function validateSharedSecret(secret: string, path: string): void {
  if (secret.length < 32) {
    throw new LocalCredentialsError({
      path,
      detail: "The local JWT shared secret must contain at least 32 characters.",
    });
  }
}

function hasValues(key: LocalJwtSigningKey, fields: ReadonlyArray<keyof LocalJwtSigningKey>) {
  return fields.every((field) => {
    const value = key[field];
    return typeof value === "string" && value.length > 0;
  });
}

/** Validate algorithms, key types, public components, and the first key's private material. */
export function validateLocalJwtSigningKeys(
  keys: ReadonlyArray<LocalJwtSigningKey>,
): asserts keys is readonly [LocalJwtSigningKey, ...ReadonlyArray<LocalJwtSigningKey>] {
  if (keys.length === 0) throw invalidSigningKey(0);

  for (const [index, key] of keys.entries()) {
    const isRsa = key.alg === "RS256" && key.kty === "RSA";
    const isEc = key.alg === "ES256" && key.kty === "EC" && key.crv === "P-256";
    const hasPublicMaterial = isRsa ? hasValues(key, ["n", "e"]) : hasValues(key, ["x", "y"]);
    const hasPrivateMaterial =
      index !== 0 || (isRsa ? hasValues(key, ["d", "p", "q"]) : hasValues(key, ["d"]));
    if ((!isRsa && !isEc) || !hasPublicMaterial || !hasPrivateMaterial) {
      throw invalidSigningKey(index);
    }

    try {
      createPublicKey({ key, format: "jwk" });
      if (index === 0) {
        createPrivateKey({ key: isRsa ? withRsaCrtParameters(key) : key, format: "jwk" });
      }
    } catch {
      throw invalidSigningKey(index);
    }
  }
}

function generateAsymmetricJwt(key: LocalJwtSigningKey, role: "anon" | "service_role"): string {
  const algorithm = key.alg;
  if (
    (algorithm !== "RS256" || key.kty !== "RSA") &&
    (algorithm !== "ES256" || key.kty !== "EC" || key.crv !== "P-256")
  ) {
    throw invalidSigningKey(0);
  }

  const header =
    key.kid === undefined || key.kid.length === 0
      ? { alg: algorithm, typ: "JWT" }
      : { alg: algorithm, kid: key.kid, typ: "JWT" };
  const payload = {
    iss: "supabase-demo",
    role,
    exp: Math.floor(Date.now() / 1000) + JWT_LIFETIME_SECONDS,
  };
  const data = `${base64UrlEncode(JSON.stringify(header))}.${base64UrlEncode(JSON.stringify(payload))}`;
  try {
    const privateKey = createPrivateKey({
      key: algorithm === "RS256" ? withRsaCrtParameters(key) : key,
      format: "jwk",
    });
    const signature =
      algorithm === "RS256"
        ? createSign("RSA-SHA256").update(data).end().sign(privateKey)
        : createSign("sha256")
            .update(data)
            .end()
            .sign({ key: privateKey, dsaEncoding: "ieee-p1363" });
    return `${data}.${signature.toString("base64url")}`;
  } catch {
    throw invalidSigningKey(0);
  }
}

function publicSigningKey(key: LocalJwtSigningKey): LocalJwtSigningKey {
  const { d: _d, p: _p, q: _q, dp: _dp, dq: _dq, qi: _qi, ...publicKey } = key;
  return publicKey;
}

export function authSigningKeysJson(signing: LocalJwtSigningMaterial): string | undefined {
  return signing._tag === "AsymmetricJwtKeys" ? JSON.stringify(signing.keys) : undefined;
}

export function resolveLocalCredentials(
  input: LocalCredentials | undefined,
): ResolvedLocalCredentials {
  const signing = input?.signing ?? {
    _tag: "SymmetricJwtSecret",
    secret: defaultJwtSecret,
  };
  const jwtSecret = signing._tag === "SymmetricJwtSecret" ? signing.secret : signing.legacySecret;
  if (signing._tag === "SymmetricJwtSecret") {
    validateSharedSecret(signing.secret, "credentials.signing.secret");
  } else {
    validateSharedSecret(signing.legacySecret, "credentials.signing.legacySecret");
    validateLocalJwtSigningKeys(signing.keys);
  }
  const generateRoleKey = (role: "anon" | "service_role") =>
    signing._tag === "SymmetricJwtSecret"
      ? generateJwt(signing.secret, role)
      : generateAsymmetricJwt(signing.keys[0], role);
  const jwks =
    signing._tag === "SymmetricJwtSecret"
      ? JSON.stringify({
          keys: [{ kty: "oct", k: Buffer.from(jwtSecret).toString("base64url") }],
        })
      : JSON.stringify({ keys: signing.keys.map(publicSigningKey) });

  return {
    signing,
    jwtSecret,
    publishableKey: input?.publishableKey ?? defaultPublishableKey,
    secretKey: input?.secretKey ?? defaultSecretKey,
    anonKey: input?.anonKey ?? generateRoleKey("anon"),
    serviceRoleKey: input?.serviceRoleKey ?? generateRoleKey("service_role"),
    jwks,
  };
}
