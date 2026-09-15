import { Data, Effect, Schema } from "effect";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";
import {
  actionability,
  ErrorActionabilityId,
  type CliErrorActionabilityDeclaration,
} from "../telemetry/error-actionability.ts";

const remoteJwksTimeoutMs = 10_000;

/**
 * Structural JWK shape shared by the two in-tree JWK types (`command-internal/go-jwt.ts`'s
 * `Jwk` and `shared/functions/serve.ts`'s `SigningKeyJwk`), so either can be passed to
 * {@link toPublicJwk} without conversion. Defined locally since `shared/` cannot import from
 * the command tree.
 */
export interface JwkLike {
  readonly kty: string;
  readonly kid?: string;
  readonly use?: string;
  readonly key_ops?: ReadonlyArray<string>;
  readonly alg?: string;
  readonly ext?: boolean;
  readonly n?: string;
  readonly e?: string;
  readonly crv?: string;
  readonly x?: string;
  readonly y?: string;
}

/**
 * Filters `key_ops` down to `"verify"` entries, returning `undefined` — never `[]` — when none
 * remain, so the published JWK omits the field instead of serializing an empty array. A plain
 * `.filter(...)` doesn't do this: it only returns `undefined` when `key_ops` itself was already
 * `undefined`.
 */
function publicKeyOps(
  keyOps: ReadonlyArray<string> | undefined,
): ReadonlyArray<string> | undefined {
  const verifyOps = keyOps?.filter((operation) => operation === "verify");
  return verifyOps !== undefined && verifyOps.length > 0 ? verifyOps : undefined;
}

/**
 * Strips private key material (`d`/`p`/`q`/`dp`/`dq`/`qi`) from a signing key before it's
 * published in a JWKS, and filters `key_ops` down to `"verify"` entries only. Field order in
 * the returned object is fixed (`kty, kid, use, key_ops, alg, ext, n, e` for RSA / `..., crv,
 * x, y` for EC) since `JSON.stringify` serializes keys in declaration order and that order is
 * part of the published output's byte contract.
 */
export function toPublicJwk(key: JwkLike): JwkLike {
  if (key.kty === "RSA") {
    return {
      kty: "RSA",
      kid: key.kid,
      use: key.use,
      key_ops: publicKeyOps(key.key_ops),
      alg: key.alg,
      ext: key.ext,
      n: key.n,
      e: key.e,
    };
  }

  return {
    kty: "EC",
    kid: key.kid,
    use: key.use,
    key_ops: publicKeyOps(key.key_ops),
    alg: key.alg,
    ext: key.ext,
    crv: key.crv,
    x: key.x,
    y: key.y,
  };
}

/**
 * One `[auth.third_party.<provider>]` section, structurally matching `@supabase/config`'s
 * `CliConfig["auth"]["third_party"]` so both `shared/functions/serve.ts`'s resolved auth
 * config and `command-internal/local-config-values.ts`'s env-override-resolved object satisfy
 * this shape without conversion.
 */
export interface ThirdPartyProvidersLike {
  readonly firebase: { readonly enabled: boolean; readonly project_id?: string };
  readonly auth0: {
    readonly enabled: boolean;
    readonly tenant?: string;
    readonly tenant_region?: string;
  };
  readonly aws_cognito: {
    readonly enabled: boolean;
    readonly user_pool_id?: string;
    readonly user_pool_region?: string;
  };
  readonly clerk: { readonly enabled: boolean; readonly domain?: string };
  readonly workos: { readonly enabled: boolean; readonly issuer_url?: string };
}

const clerkDomainPattern = /^(clerk([.][a-z0-9-]+){2,}|([a-z0-9-]+[.])+clerk[.]accounts[.]dev)$/;

/**
 * Rejects more than one enabled third-party provider, validates the enabled provider's
 * required field(s), then builds its OIDC issuer URL. Throws a plain `Error` with the
 * established message text on a validation failure; returns `undefined` when no provider is
 * enabled.
 */
export function resolveThirdPartyIssuerUrl(
  thirdParty: ThirdPartyProvidersLike,
): string | undefined {
  const enabledProviders = [
    thirdParty.firebase.enabled ? "firebase" : undefined,
    thirdParty.auth0.enabled ? "auth0" : undefined,
    thirdParty.aws_cognito.enabled ? "aws_cognito" : undefined,
    thirdParty.clerk.enabled ? "clerk" : undefined,
    thirdParty.workos.enabled ? "workos" : undefined,
  ].filter((value): value is NonNullable<typeof value> => value !== undefined);

  if (enabledProviders.length > 1) {
    throw new Error(
      "Invalid config: Only one third_party provider allowed to be enabled at a time.",
    );
  }

  if (thirdParty.firebase.enabled) {
    if ((thirdParty.firebase.project_id ?? "").length === 0) {
      throw new Error(
        "Invalid config: auth.third_party.firebase is enabled but without a project_id.",
      );
    }
    return `https://securetoken.google.com/${thirdParty.firebase.project_id}`;
  }

  if (thirdParty.auth0.enabled) {
    if ((thirdParty.auth0.tenant ?? "").length === 0) {
      throw new Error("Invalid config: auth.third_party.auth0 is enabled but without a tenant.");
    }
    return thirdParty.auth0.tenant_region
      ? `https://${thirdParty.auth0.tenant}.${thirdParty.auth0.tenant_region}.auth0.com`
      : `https://${thirdParty.auth0.tenant}.auth0.com`;
  }

  if (thirdParty.aws_cognito.enabled) {
    if ((thirdParty.aws_cognito.user_pool_id ?? "").length === 0) {
      throw new Error(
        "Invalid config: auth.third_party.cognito is enabled but without a user_pool_id.",
      );
    }
    if (
      thirdParty.aws_cognito.user_pool_region === undefined ||
      thirdParty.aws_cognito.user_pool_region.length === 0
    ) {
      throw new Error(
        "Invalid config: auth.third_party.cognito is enabled but without a user_pool_region.",
      );
    }
    return `https://cognito-idp.${thirdParty.aws_cognito.user_pool_region}.amazonaws.com/${thirdParty.aws_cognito.user_pool_id}`;
  }

  if (thirdParty.clerk.enabled) {
    const domain = thirdParty.clerk.domain;
    if (domain === undefined || domain.length === 0) {
      throw new Error("Invalid config: auth.third_party.clerk is enabled but without a domain.");
    }
    if (!clerkDomainPattern.test(domain)) {
      throw new Error(
        "Invalid config: auth.third_party.clerk has invalid domain, it usually is like clerk.example.com or example.clerk.accounts.dev. Check https://clerk.com/setup/supabase on how to find the correct value.",
      );
    }
    return `https://${domain}`;
  }

  if (thirdParty.workos.enabled) {
    if ((thirdParty.workos.issuer_url ?? "").length === 0) {
      throw new Error(
        "Invalid config: auth.third_party.workos is enabled but without a issuer_url.",
      );
    }
    return thirdParty.workos.issuer_url;
  }

  return undefined;
}

/**
 * Builds the OIDC issuer URL for whichever third-party provider is enabled, with no
 * validation: the first enabled provider (firebase, auth0, aws_cognito, clerk, workos, in that
 * order) wins, and a missing required field produces a URL with an empty segment rather than
 * throwing. Used where {@link resolveThirdPartyIssuerUrl}'s "at most one enabled" and
 * required-field checks don't apply.
 */
export function thirdPartyIssuerUrlUnchecked(
  thirdParty: ThirdPartyProvidersLike,
): string | undefined {
  if (thirdParty.firebase.enabled) {
    return `https://securetoken.google.com/${thirdParty.firebase.project_id ?? ""}`;
  }
  if (thirdParty.auth0.enabled) {
    return thirdParty.auth0.tenant_region
      ? `https://${thirdParty.auth0.tenant ?? ""}.${thirdParty.auth0.tenant_region}.auth0.com`
      : `https://${thirdParty.auth0.tenant ?? ""}.auth0.com`;
  }
  if (thirdParty.aws_cognito.enabled) {
    return `https://cognito-idp.${thirdParty.aws_cognito.user_pool_region ?? ""}.amazonaws.com/${thirdParty.aws_cognito.user_pool_id ?? ""}`;
  }
  if (thirdParty.clerk.enabled) {
    return `https://${thirdParty.clerk.domain ?? ""}`;
  }
  if (thirdParty.workos.enabled) {
    return thirdParty.workos.issuer_url;
  }
  return undefined;
}

/** Failure to discover or retrieve a provider's public signing keys. */
export class RemoteJwksError extends Data.TaggedError("RemoteJwksError")<{
  readonly message: string;
  readonly reason: "network" | "response" | "timeout";
  readonly cause?: unknown;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return this.reason === "response" ? actionability.apiStatus : actionability.externalNetwork;
  }
}

const discoverySchema = Schema.Struct({ jwks_uri: Schema.NonEmptyString });
const jwksSchema = Schema.Struct({ keys: Schema.NonEmptyArray(Schema.Unknown) });

const readRemoteDocument = Effect.fnUntraced(function* <A>(
  url: string,
  schema: Schema.Decoder<A>,
  invalidMessage: string,
) {
  return yield* Effect.gen(function* () {
    const client = HttpClient.withScope(yield* HttpClient.HttpClient);
    const response = yield* client.get(url).pipe(
      Effect.mapError(
        (cause) =>
          new RemoteJwksError({
            message: `Failed to fetch ${url}`,
            reason: "network",
            cause,
          }),
      ),
    );
    if (response.status < 200 || response.status >= 300) {
      return yield* new RemoteJwksError({ message: `Failed to fetch ${url}`, reason: "response" });
    }
    return yield* HttpClientResponse.schemaBodyJson(schema)(response).pipe(
      Effect.mapError(
        (cause) =>
          new RemoteJwksError({
            message: invalidMessage,
            reason: "response",
            cause,
          }),
      ),
    );
  }).pipe(
    Effect.scoped,
    Effect.timeoutOrElse({
      duration: remoteJwksTimeoutMs,
      orElse: () =>
        Effect.fail(
          new RemoteJwksError({
            message: `Timed out fetching ${url}`,
            reason: "timeout",
          }),
        ),
    }),
  );
});

/** Resolves remote signing keys through OIDC discovery, bounding each complete response read. */
export const resolveRemoteJwks = Effect.fnUntraced(function* (issuerUrl: string) {
  const discoveryUrl = `${issuerUrl}/.well-known/openid-configuration`;
  const discovery = yield* readRemoteDocument(
    discoveryUrl,
    discoverySchema,
    `auth.third_party: OIDC configuration at URL "${discoveryUrl}" does not expose a jwks_uri property`,
  );
  const jwks = yield* readRemoteDocument(
    discovery.jwks_uri,
    jwksSchema,
    `auth.third_party: JWKS at URL "${discovery.jwks_uri}" as discovered from "${discoveryUrl}" does not contain any JWK keys`,
  );
  return jwks.keys;
});
