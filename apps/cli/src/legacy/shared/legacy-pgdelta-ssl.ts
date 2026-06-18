import { Effect, type FileSystem, type Path } from "effect";

import { LegacyPgDeltaSslProbe } from "./legacy-pgdelta-ssl-probe.service.ts";

/**
 * pg-delta SSL handling for remote Postgres endpoints. Ported from Go's
 * `internal/gen/types/pgdelta_conn.go` + `types.go`. pg-delta (Deno) disables
 * TLS when `sslmode` is absent and only reads `PGDELTA_*_SSLROOTCERT` for
 * verify-ca/verify-full, so a TLS-requiring endpoint needs a CA bundle written
 * into the workspace and the URL rewritten to `sslmode=verify-ca`.
 *
 * Mirroring Go's `pgDeltaRootCA`, the decision runs for EVERY postgres URL (not
 * just Supabase hosts): a live `SSLRequest` probe (`isRequireSSL`) determines
 * whether the server speaks TLS; if it does, the bundle is injected. Supabase-hosted
 * URLs additionally get the bundle as a fallback even if the probe reports no TLS.
 * Only a non-URL ref (a catalog-file path) or a server that refuses TLS (e.g. a
 * plain local DB) passes through unchanged.
 */

const PG_DELTA_CA_BUNDLE_DIR_SEGMENTS = ["supabase", ".temp", "pgdelta"] as const;

/** Concatenation of Go's embedded `caStaging + caProd + caSnap` bundles (verbatim). */
export const LEGACY_PG_DELTA_CA_BUNDLE =
  "-----BEGIN CERTIFICATE-----\nMIID1DCCArygAwIBAgIUbYRdq/8/uNq8G9stMCdOFSBgA2MwDQYJKoZIhvcNAQEL\nBQAwczELMAkGA1UEBhMCVVMxEDAOBgNVBAgMB0RlbHdhcmUxEzARBgNVBAcMCk5l\ndyBDYXN0bGUxFTATBgNVBAoMDFN1cGFiYXNlIEluYzEmMCQGA1UEAwwdU3VwYWJh\nc2UgU3RhZ2luZyBSb290IDIwMjEgQ0EwHhcNMjEwNDI4MTAzNjEzWhcNMzEwNDI2\nMTAzNjEzWjBzMQswCQYDVQQGEwJVUzEQMA4GA1UECAwHRGVsd2FyZTETMBEGA1UE\nBwwKTmV3IENhc3RsZTEVMBMGA1UECgwMU3VwYWJhc2UgSW5jMSYwJAYDVQQDDB1T\ndXBhYmFzZSBTdGFnaW5nIFJvb3QgMjAyMSBDQTCCASIwDQYJKoZIhvcNAQEBBQAD\nggEPADCCAQoCggEBAN0AKRE8a56O8LaZxiOAcHFUFnwiKUvPoXPq26Ifw+Nv+7zg\nN2V5WnMZbbw24q61Os60ZUn0XmbVtuIeJ+stPHsO7qxxuL+bmPR+qU5tkDrIOyEe\nYD/2u8/q6ssVv42k4XcXbhM6RVz7CkCDY0TiBm1bMtRZso3xB6E9wAjxDf43XfV5\nPAGs3JI+Zo/vyqCDlN0hHOrB/aBl01JXqQWI84Gia5ooucq4SjA1CyawBcQ2IAvG\nrXuy1BouY+xM3zRuNvtfFP6rb5Mta+jCYEMh1AZ8yP8sYUWAyhxX6k9EbOb009wQ\naZljbUCh/UglGWuBxdzePavx+zPjzWXB1NyVkpkCAwEAAaNgMF4wCwYDVR0PBAQD\nAgEGMB0GA1UdDgQWBBQFx+PHLf27iIo/PMfIfGqXF7Zb+DAfBgNVHSMEGDAWgBQF\nx+PHLf27iIo/PMfIfGqXF7Zb+DAPBgNVHRMBAf8EBTADAQH/MA0GCSqGSIb3DQEB\nCwUAA4IBAQB/xIiz5dDqzGXjqYqXZYx4iSfSxsVayeOPDMfmaiCfSMJEUG4cUiwG\nOvMPGztaUEYeip5SCvSKuAAjVkXyP7ahKR7t7lZ9mErVXyxSZoVLbOd578CuYiZk\nOgT17UjPv66WMzEKEr8wGpomTYWWfEkuqt8ENdiM1Z4LNFahdKj36+jm6/a+9R8K\n25VIL68DTaQpBxFWG6ixC1HRMHJ12lDhKsshIi099BVpkGibESlxPrQOdKKqBB/J\nvIX+/Hb+mS4H5zYMeK2wX0onp+GBcD6X9L1UJuXMVd+BRan8RFidXL5s3++xXjQq\nNzbc6lnA69urKffvcT07YwMsY/OmHzVa\n-----END CERTIFICATE-----\n-----BEGIN CERTIFICATE-----\nMIIDxDCCAqygAwIBAgIUbLxMod62P2ktCiAkxnKJwtE9VPYwDQYJKoZIhvcNAQEL\nBQAwazELMAkGA1UEBhMCVVMxEDAOBgNVBAgMB0RlbHdhcmUxEzARBgNVBAcMCk5l\ndyBDYXN0bGUxFTATBgNVBAoMDFN1cGFiYXNlIEluYzEeMBwGA1UEAwwVU3VwYWJh\nc2UgUm9vdCAyMDIxIENBMB4XDTIxMDQyODEwNTY1M1oXDTMxMDQyNjEwNTY1M1ow\nazELMAkGA1UEBhMCVVMxEDAOBgNVBAgMB0RlbHdhcmUxEzARBgNVBAcMCk5ldyBD\nYXN0bGUxFTATBgNVBAoMDFN1cGFiYXNlIEluYzEeMBwGA1UEAwwVU3VwYWJhc2Ug\nUm9vdCAyMDIxIENBMIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAqQXW\nQyHOB+qR2GJobCq/CBmQ40G0oDmCC3mzVnn8sv4XNeWtE5XcEL0uVih7Jo4Dkx1Q\nDmGHBH1zDfgs2qXiLb6xpw/CKQPypZW1JssOTMIfQppNQ87K75Ya0p25Y3ePS2t2\nGtvHxNjUV6kjOZjEn2yWEcBdpOVCUYBVFBNMB4YBHkNRDa/+S4uywAoaTWnCJLUi\ncvTlHmMw6xSQQn1UfRQHk50DMCEJ7Cy1RxrZJrkXXRP3LqQL2ijJ6F4yMfh+Gyb4\nO4XajoVj/+R4GwywKYrrS8PrSNtwxr5StlQO8zIQUSMiq26wM8mgELFlS/32Uclt\nNaQ1xBRizkzpZct9DwIDAQABo2AwXjALBgNVHQ8EBAMCAQYwHQYDVR0OBBYEFKjX\nuXY32CztkhImng4yJNUtaUYsMB8GA1UdIwQYMBaAFKjXuXY32CztkhImng4yJNUt\naUYsMA8GA1UdEwEB/wQFMAMBAf8wDQYJKoZIhvcNAQELBQADggEBAB8spzNn+4VU\ntVxbdMaX+39Z50sc7uATmus16jmmHjhIHz+l/9GlJ5KqAMOx26mPZgfzG7oneL2b\nVW+WgYUkTT3XEPFWnTp2RJwQao8/tYPXWEJDc0WVQHrpmnWOFKU/d3MqBgBm5y+6\njB81TU/RG2rVerPDWP+1MMcNNy0491CTL5XQZ7JfDJJ9CCmXSdtTl4uUQnSuv/Qx\nCea13BX2ZgJc7Au30vihLhub52De4P/4gonKsNHYdbWjg7OWKwNv/zitGDVDB9Y2\nCMTyZKG3XEu5Ghl1LEnI3QmEKsqaCLv12BnVjbkSeZsMnevJPs1Ye6TjjJwdik5P\no/bKiIz+Fq8=\n-----END CERTIFICATE-----\n-----BEGIN CERTIFICATE-----\nMIIDxzCCAq+gAwIBAgIUeX+gpfmsRW9asFkRvjyXjHxbfgcwDQYJKoZIhvcNAQEL\nBQAwazELMAkGA1UEBhMCVVMxEDAOBgNVBAgMB0RlbHdhcmUxEzARBgNVBAcMCk5l\ndyBDYXN0bGUxFTATBgNVBAoMDFN1cGFiYXNlIEluYzEeMBwGA1UEAwwVU3VwYWJh\nc2UgUm9vdCAyMDIxIENBMB4XDTI1MDkwMzA4MDEyNVoXDTM1MDkwMTA4MDEyNVow\nazELMAkGA1UEBhMCVVMxEDAOBgNVBAgMB0RlbHdhcmUxEzARBgNVBAcMCk5ldyBD\nYXN0bGUxFTATBgNVBAoMDFN1cGFiYXNlIEluYzEeMBwGA1UEAwwVU3VwYWJhc2Ug\nUm9vdCAyMDIxIENBMIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA5Ve7\ni9UAmc7luUilELPtqzEk8nGHxg7nY0aCStr625M7+K4OPO6RUllTsHh47k1jWyzm\nLXLlyYwCsYCjQp+3vn06H+F/HRUxBt6CK2B7bNng230exTunk0xFvfkX6YgHR7B3\n1B7L25Rq3PhuRFPV4hnGYRam2XBZC4UNPqoAgrhV0HOYzXXAVoTr2yaBTMnB331Z\nRwOmINh7eqTCk/JRZbb6vfZOhZRAVAe9AoRLoG8aKwmeoLGwlu0UuFx6z3E+6bmA\nfSNa8Lx02GEoCdPLw9IRKUFq/SgBpQUKm44H1fDwTjH2CMM0N4p0mL/6wXnNeHvt\nC40MmKZ0RcVmHE5wBwIDAQABo2MwYTAdBgNVHQ4EFgQUjvEE541toZcwtXQlZlcB\nYOBRTnowHwYDVR0jBBgwFoAUjvEE541toZcwtXQlZlcBYOBRTnowDwYDVR0TAQH/\nBAUwAwEB/zAOBgNVHQ8BAf8EBAMCAYYwDQYJKoZIhvcNAQELBQADggEBACD5IcGP\nXKvS9qg0CgEQPFqYavt5c7P+0xxFgiZe+xoG8fUw58yNeK2APtgGPRpxEOGfAlNx\nz9HDt4gcyHEE00B3qAVDm49pqNxioFWzNqU2LGfM/HL1QmN6urR7hCOkVCJddvOc\nFhFX4nZDuRfaBboDvS5HlK3Pzxddp9hvrJi2bemr8HLqYc3HzmVckgPGSLML6t+h\n4LRCXSlQsDgQ1LZ4KHsl4cq7K51N6FOXQBLB5q4lMKhs0VUhCT8Pdsj12+84laCV\nc22q6p2mdT9SaernCSRnWazXWisgpjv3H7Ex4S1DCYjJIwn3PUToGFv1r8YRN2/S\nO19yVSxxCIf64Sg=\n-----END CERTIFICATE-----\n";

/** Source/target distinct CA filenames (Go's `caBundleFilename`). */
export const LEGACY_PG_DELTA_SOURCE_SSL_ENV = "PGDELTA_SOURCE_SSLROOTCERT";
export const LEGACY_PG_DELTA_TARGET_SSL_ENV = "PGDELTA_TARGET_SSLROOTCERT";

const caBundleFilename = (sslRootCertEnv: string): string =>
  sslRootCertEnv === LEGACY_PG_DELTA_SOURCE_SSL_ENV
    ? "pgdelta-source-ca.crt"
    : sslRootCertEnv === LEGACY_PG_DELTA_TARGET_SSL_ENV
      ? "pgdelta-target-ca.crt"
      : "pgdelta-ca.crt";

/** Mirrors Go's `isPostgresURL`. */
const legacyIsPostgresUrl = (ref: string): boolean =>
  ref.startsWith("postgres://") || ref.startsWith("postgresql://");

/** Mirrors Go's `isSupabaseHostedPostgresURL`. */
export function legacyIsSupabaseHostedPostgresUrl(dbUrl: string): boolean {
  let host: string;
  try {
    host = new URL(dbUrl).hostname.toLowerCase();
  } catch {
    return false;
  }
  return (
    host.endsWith(".supabase.co") ||
    host === "pooler.supabase.com" ||
    host.endsWith(".pooler.supabase.com")
  );
}

/** Mirrors Go's `ensurePgDeltaSSL`: force `sslmode=verify-ca` (unless already verify-*) + `sslrootcert`. */
export function legacyEnsurePgDeltaSsl(dbUrl: string, sslRootCertPath: string): string {
  let parsed: URL;
  try {
    parsed = new URL(dbUrl);
  } catch {
    return dbUrl;
  }
  const sslmode = parsed.searchParams.get("sslmode");
  if (sslmode !== "verify-ca" && sslmode !== "verify-full") {
    parsed.searchParams.set("sslmode", "verify-ca");
  }
  if (sslRootCertPath.length > 0) parsed.searchParams.set("sslrootcert", sslRootCertPath);
  return parsed.toString();
}

/**
 * Mirrors Go's `pgDeltaRootCA` (`internal/gen/types/pgdelta_conn.go:37`): probe the
 * endpoint for TLS (`GetRootCA` → `isRequireSSL`); if it speaks TLS, the embedded
 * bundle is needed. A Supabase-hosted URL gets the bundle regardless (fallback for
 * when the probe is skipped or reports no TLS). Otherwise no bundle.
 */
const legacyPgDeltaNeedsRootCa = Effect.fnUntraced(function* (ref: string) {
  const probe = yield* LegacyPgDeltaSslProbe;
  const requireSsl = yield* probe.requireSsl(ref);
  return requireSsl || legacyIsSupabaseHostedPostgresUrl(ref);
});

/**
 * Prepares a SOURCE/TARGET ref + its SSL env for pg-delta. Catalog-file refs pass
 * through unchanged; a postgres URL is probed for TLS (Go's `pgDeltaRootCA`) and,
 * when TLS is required (or it is a Supabase-hosted host), gets the embedded CA bundle
 * written under `supabase/.temp/pgdelta/` and the URL rewritten to `sslmode=verify-ca`.
 * Mirrors Go's `PreparePgDeltaPostgresRef`.
 */
export const legacyPreparePgDeltaRef = Effect.fnUntraced(function* (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  cwd: string,
  ref: string,
  sslRootCertEnv: string,
) {
  // Go only short-circuits on a non-postgres ref (`if !isPostgresURL(ref)`); a
  // catalog-file path needs no SSL handling.
  if (!legacyIsPostgresUrl(ref)) {
    return { ref, sslEnv: {} as Record<string, string> };
  }
  if (!(yield* legacyPgDeltaNeedsRootCa(ref))) {
    return { ref, sslEnv: {} as Record<string, string> };
  }
  const relPath = path.join(...PG_DELTA_CA_BUNDLE_DIR_SEGMENTS, caBundleFilename(sslRootCertEnv));
  const absPath = path.join(cwd, relPath);
  yield* fs.makeDirectory(path.dirname(absPath), { recursive: true }).pipe(Effect.ignore);
  yield* fs.writeFileString(absPath, LEGACY_PG_DELTA_CA_BUNDLE);
  const containerCertPath = `/workspace/${relPath.split("\\").join("/")}`;
  return {
    ref: legacyEnsurePgDeltaSsl(ref, containerCertPath),
    sslEnv: { [sslRootCertEnv]: LEGACY_PG_DELTA_CA_BUNDLE } as Record<string, string>,
  };
});
