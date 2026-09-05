/**
 * Closed mapping for the third-party issuer rules used by Auth.ResolveJWKS.
 *
 * This module is deliberately pure: network discovery and JWKS retrieval are
 * owned by the runtime owner, while validation and issuer construction remain
 * deterministic and testable during compilation.
 */

type ThirdPartyProviderName = "firebase" | "auth0" | "aws_cognito" | "clerk" | "workos";

interface ThirdPartyIssuer {
  readonly provider: ThirdPartyProviderName;
  readonly issuer: string;
}

interface ThirdPartyIssuerError {
  readonly provider?: ThirdPartyProviderName;
  readonly message: string;
}

export type ThirdPartyIssuerResult =
  | { readonly ok: true; readonly value?: ThirdPartyIssuer }
  | ({ readonly ok: false } & ThirdPartyIssuerError);

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const text = (value: unknown): string => (typeof value === "string" ? value.trim() : "");

const enabled = (value: unknown): boolean => isRecord(value) && value.enabled === true;

/** Applies Auth.ResolveJWKS' issuerURL and validation rules. */
export const resolveThirdPartyIssuer = (settings: unknown): ThirdPartyIssuerResult => {
  if (!isRecord(settings)) return { ok: true };
  const thirdParty = isRecord(settings.third_party) ? settings.third_party : settings;
  const candidates: Array<{ readonly provider: ThirdPartyProviderName; readonly value: unknown }> =
    [];
  for (const candidate of [
    { provider: "firebase" as const, value: thirdParty.firebase },
    { provider: "auth0" as const, value: thirdParty.auth0 },
    { provider: "aws_cognito" as const, value: thirdParty.aws_cognito },
    { provider: "clerk" as const, value: thirdParty.clerk },
    { provider: "workos" as const, value: thirdParty.workos },
  ])
    if (enabled(candidate.value)) candidates.push(candidate);
  if (candidates.length > 1)
    return {
      ok: false,
      message: "Only one auth.third_party provider may be enabled at a time",
    };
  const candidate = candidates[0];
  if (candidate === undefined) return { ok: true };
  const value = isRecord(candidate.value) ? candidate.value : {};
  switch (candidate.provider) {
    case "firebase": {
      const projectId = text(value.project_id);
      return projectId.length === 0
        ? { ok: false, provider: candidate.provider, message: "Firebase project_id is required" }
        : {
            ok: true,
            value: {
              provider: candidate.provider,
              issuer: `https://securetoken.google.com/${projectId}`,
            },
          };
    }
    case "auth0": {
      const tenant = text(value.tenant);
      if (tenant.length === 0)
        return { ok: false, provider: candidate.provider, message: "Auth0 tenant is required" };
      const region = text(value.tenant_region);
      return {
        ok: true,
        value: {
          provider: candidate.provider,
          issuer: `https://${tenant}.${region.length > 0 ? `${region}.` : ""}auth0.com`,
        },
      };
    }
    case "aws_cognito": {
      const userPoolId = text(value.user_pool_id);
      const region = text(value.user_pool_region);
      if (userPoolId.length === 0)
        return {
          ok: false,
          provider: candidate.provider,
          message: "AWS Cognito user_pool_id is required",
        };
      if (region.length === 0)
        return {
          ok: false,
          provider: candidate.provider,
          message: "AWS Cognito user_pool_region is required",
        };
      return {
        ok: true,
        value: {
          provider: candidate.provider,
          issuer: `https://cognito-idp.${region}.amazonaws.com/${userPoolId}`,
        },
      };
    }
    case "clerk": {
      const domain = text(value.domain);
      if (domain.length === 0)
        return { ok: false, provider: candidate.provider, message: "Clerk domain is required" };
      if (!/^(?:clerk(?:\.[a-z0-9-]+){2,}|(?:[a-z0-9-]+\.)+clerk\.accounts\.dev)$/u.test(domain))
        return {
          ok: false,
          provider: candidate.provider,
          message: "Clerk domain has an invalid format",
        };
      return { ok: true, value: { provider: candidate.provider, issuer: `https://${domain}` } };
    }
    case "workos": {
      const issuer = text(value.issuer_url);
      return issuer.length === 0
        ? { ok: false, provider: candidate.provider, message: "WorkOS issuer_url is required" }
        : { ok: true, value: { provider: candidate.provider, issuer } };
    }
  }
};
