const remoteJwksTimeoutMs = 10_000;

/**
 * Structural JWK shape shared by both shells' own JWK types
 * (`legacy/shared/legacy-go-jwt.ts`'s `LegacyJwk` and `shared/functions/serve.ts`'s
 * `SigningKeyJwk`) so either can be passed to {@link toPublicJwk} without conversion. Defined
 * locally rather than importing `LegacyJwk` because `shared/` cannot import from `legacy/` (see
 * `apps/cli/CLAUDE.md`'s isolation rules) — both existing types already satisfy this shape
 * structurally, so no explicit relationship is needed.
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
 * Go's `(j JWK) ToPublicJWK()` (`apps/cli-go/pkg/config/auth.go:111-145`): strips private key
 * material (`d`/`p`/`q`/`dp`/`dq`/`qi`) from a signing key before it's published in a JWKS, and
 * filters `key_ops` down to `"verify"` entries only (Go never republishes `"sign"`). Field order
 * in the returned object matches Go's `JWK` struct declaration order (`kty, kid, use, key_ops,
 * alg, ext, n, e` for RSA / `..., crv, x, y` for EC), since both Go's `encoding/json` and JS
 * `JSON.stringify` serialize object keys in insertion/declaration order.
 */
export function toPublicJwk(key: JwkLike): JwkLike {
  if (key.kty === "RSA") {
    return {
      kty: "RSA",
      kid: key.kid,
      use: key.use,
      key_ops: key.key_ops?.filter((operation) => operation === "verify"),
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
    key_ops: key.key_ops?.filter((operation) => operation === "verify"),
    alg: key.alg,
    ext: key.ext,
    crv: key.crv,
    x: key.x,
    y: key.y,
  };
}

/**
 * One `[auth.third_party.<provider>]` section, structurally matching `@supabase/config`'s
 * `ProjectConfig["auth"]["third_party"]` — both `shared/functions/serve.ts`'s
 * `PlainServeAuthConfig["third_party"]` (itself typed as `ProjectConfig["auth"]["third_party"]`)
 * and `legacy/shared/legacy-local-config-values.ts`'s env-override-resolved third-party object
 * satisfy this shape without conversion.
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
 * Go's `(tpa *thirdParty) validate()` + `(tpa *thirdParty) IssuerURL()`
 * (`apps/cli-go/pkg/config/config.go:1635-1707`): rejects more than one enabled provider,
 * validates the enabled provider's required field(s), then builds its OIDC issuer URL. Throws a
 * plain `Error` with Go's exact message text on a validation failure; returns `undefined` when no
 * provider is enabled.
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
 * Go's `(tpa *thirdParty) IssuerURL()` ALONE (`apps/cli-go/pkg/config/config.go:1685-1707`, each
 * provider's own unconditional `issuerURL()` at `config.go:1556-1636`) — no validation at all. Go's
 * `Auth.ThirdParty.validate()` (the "at most one enabled" + required-field checks
 * {@link resolveThirdPartyIssuerUrl} above performs) only runs inside `Config.Validate`'s `if
 * c.Auth.Enabled` block (`config.go:1087-1153`), but `ResolveJWKS`/`IssuerURL()` is called
 * unconditionally (`internal/start/start.go:274`) regardless of `auth.enabled`. So when auth is
 * disabled, only this unchecked, fixed-priority string builder applies: the first enabled
 * provider (firebase, auth0, aws_cognito, clerk, workos, in that order) wins, with no "more than
 * one enabled" rejection and no required-field check — a missing required field for the winning
 * provider just produces a URL with an empty segment, matching Go's own unchecked string
 * interpolation (`fmt.Sprintf` never errors on an empty string argument).
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

/**
 * Go's OIDC-discovery + remote-JWKS fetch inside `(a *auth) ResolveJWKS`
 * (`apps/cli-go/pkg/config/config.go:1730-1774`): resolves `<issuerUrl>/.well-known/
 * openid-configuration`'s `jwks_uri`, then fetches that URI's `keys` array. Throws/rejects on any
 * failure rather than swallowing it — Go's `start` treats a failure here as a hard,
 * command-failing error (`internal/start/start.go:274-277`); `shared/functions/serve.ts`'s own
 * caller-side leniency (continuing with zero remote keys) is a `functions serve`-only choice made
 * at the call site, not part of this function's contract.
 */
export async function resolveRemoteJwks(issuerUrl: string): Promise<ReadonlyArray<unknown>> {
  const discoveryResponse = await fetch(`${issuerUrl}/.well-known/openid-configuration`, {
    signal: AbortSignal.timeout(remoteJwksTimeoutMs),
  });
  if (!discoveryResponse.ok) {
    throw new Error(`Failed to fetch ${issuerUrl}/.well-known/openid-configuration`);
  }

  const discovery = (await discoveryResponse.json()) as { jwks_uri?: string };
  if (typeof discovery.jwks_uri !== "string" || discovery.jwks_uri.length === 0) {
    throw new Error(
      `auth.third_party: OIDC configuration at URL "${issuerUrl}/.well-known/openid-configuration" does not expose a jwks_uri property`,
    );
  }

  const jwksResponse = await fetch(discovery.jwks_uri, {
    signal: AbortSignal.timeout(remoteJwksTimeoutMs),
  });
  if (!jwksResponse.ok) {
    throw new Error(`Failed to fetch ${discovery.jwks_uri}`);
  }

  const jwks = (await jwksResponse.json()) as { keys?: ReadonlyArray<unknown> };
  if (!Array.isArray(jwks.keys) || jwks.keys.length === 0) {
    throw new Error(
      `auth.third_party: JWKS at URL "${discovery.jwks_uri}" as discovered from "${issuerUrl}/.well-known/openid-configuration" does not contain any JWK keys`,
    );
  }

  return jwks.keys;
}
