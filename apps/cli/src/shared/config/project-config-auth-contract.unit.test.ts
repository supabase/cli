import { describe, expect, it } from "vitest";
import { V1GetAuthServiceConfigOutput } from "@supabase/api/effect";
import {
  projectConfigMappingRows,
  unmappedSecretApiPaths,
  type ProjectConfigMappingRow,
} from "@supabase/config/internal";

/**
 * Contract-derived auth guard (CLI-2230's residual review): closes two gaps
 * `@supabase/config`'s own `registry-integrity.unit.test.ts` cannot close by
 * itself.
 *
 * 1. That file's `apiPath` check resolves every auth row against
 *    `ProjectConfigApiAttributesSchema`'s `auth: Schema.Record(Schema.String,
 *    Schema.Json)` field — an OPEN record, so ANY second path segment
 *    resolves through its index signature whether or not GoTrue actually has
 *    a key by that name. That check is structurally vacuous for all 189 auth
 *    rows; it cannot catch a renamed, retired, or invented GoTrue key.
 * 2. Nothing in `@supabase/config` walks the generated Management API v1
 *    auth-config contract's full key set looking for a secret-shaped key with
 *    no registry row at all — the exact gap that let `external_slack_secret`,
 *    `hook_after_user_created_secrets`, and `nimbus_oauth_client_secret` leak
 *    HMAC digests through `unmappedApiFields` until this pass.
 *
 * `packages/config` cannot import `packages/api`'s generated client (the
 * package must stay decoupled so it can publish to npm independently), so
 * this guard lives in `apps/cli`, which can import both. It needs `@supabase/
 * config`'s row data and orphan-secret list at runtime, which is why
 * `projectConfigMappingRows`/`unmappedSecretApiPaths` are exported from
 * `@supabase/config/internal` (`packages/config/src/internal.ts`) —
 * otherwise-internal registry data, exposed solely so this cross-package
 * guard (and `apps/cli`'s own contract tests) can walk it.
 *
 * `V1GetAuthServiceConfigOutput` (not the v2 project-config resource) is the
 * authority here: it is the generated schema whose field names are the real,
 * flat GoTrue key set every auth row's `apiPath` targets — the same contract
 * `registry-auth.ts`'s `unmappedSecretApiPaths` docstring now cites in place
 * of the legacy hand-mined `auth.sync.ts` interface, which never carried
 * `external_slack_*`/`nimbus_oauth_*` at all.
 */

const generatedAuthKeys: ReadonlySet<string> = new Set(
  Object.keys(V1GetAuthServiceConfigOutput.fields),
);

const authRows: ReadonlyArray<ProjectConfigMappingRow> = projectConfigMappingRows.filter(
  (row) => row.apiPath[0] === "auth",
);

describe("registry auth rows resolve against the generated v1 auth-config contract", () => {
  it("has a non-trivial generated key set and a non-trivial set of auth rows to check", () => {
    // Guards both loops below against passing vacuously if either import is
    // ever broken.
    expect(generatedAuthKeys.size).toBeGreaterThan(100);
    expect(authRows.length).toBeGreaterThan(100);
  });

  for (const row of authRows) {
    const apiKey = row.apiPath[1];
    const label = `${row.apiPath.join(".")} (configPath ${row.configPath.join(".")})`;

    it(`"${label}" names a real V1GetAuthServiceConfigOutput key`, () => {
      expect(apiKey).toBeDefined();
      expect(generatedAuthKeys.has(apiKey as string)).toBe(true);
    });

    // A transform reads every path it declares in `alsoConsumes` (e.g. the
    // Apple/Google `external_*_additional_client_ids` fold) — a renamed or
    // removed generated key there would leave the transform silently reading
    // a stale key while the primary-apiPath check above stays green.
    for (const alsoPath of row.alsoConsumes ?? []) {
      if (alsoPath[0] !== "auth") continue;
      const alsoKey = alsoPath[1];
      it(`alsoConsumes "${alsoPath.join(".")}" (configPath ${row.configPath.join(".")}) names a real V1GetAuthServiceConfigOutput key`, () => {
        expect(alsoKey).toBeDefined();
        expect(generatedAuthKeys.has(alsoKey as string)).toBe(true);
      });
    }
  }
});

/**
 * Key names shaped like a secret per CLI-2230's finding: any of these
 * suffixes on an otherwise-plain GoTrue key name. Kept in sync with
 * `registry-auth.ts`'s `unmappedSecretApiPaths` docstring, which names the
 * same six suffixes.
 */
const SECRET_SHAPE_SUFFIXES = [
  "_secret",
  "_secrets",
  "_auth_token",
  "_api_secret",
  "_access_key",
  "_api_key",
] as const;

function isSecretShaped(key: string): boolean {
  return SECRET_SHAPE_SUFFIXES.some((suffix) => key.endsWith(suffix));
}

/**
 * `sms_vonage_api_key` is `_api_key`-shaped but genuinely not `x-secret` on
 * the config side: `packages/config/src/auth/sms.ts`'s `vonage.api_key`
 * field is a plain `Schema.String.annotate(...)`, with no `secret()` wrapper
 * — unlike its sibling `vonage.api_secret`, which has one. It already has an
 * ordinary `stringRow` (`registry-auth.ts`'s `smsCredentialRows`), so it is
 * deliberately excluded from `unmappedSecretApiPaths` and allowlisted here
 * instead of being treated as an orphan.
 */
const NON_SECRET_ALLOWLIST: ReadonlySet<string> = new Set(["sms_vonage_api_key"]);

const secretRowAuthKeys: ReadonlySet<string> = new Set(
  authRows
    .filter((row) => row.isSecret === true)
    .map((row) => row.apiPath[1])
    .filter((key): key is string => key !== undefined),
);

const unmappedSecretAuthKeys: ReadonlySet<string> = new Set(
  unmappedSecretApiPaths
    .filter((path) => path[0] === "auth")
    .map((path) => path[1])
    .filter((key): key is string => key !== undefined),
);

describe("every secret-shaped generated auth key is accounted for", () => {
  const secretShapedGeneratedKeys = [...generatedAuthKeys].filter(isSecretShaped);

  it("has a non-trivial set of secret-shaped generated keys to check", () => {
    expect(secretShapedGeneratedKeys.length).toBeGreaterThan(0);
  });

  for (const key of secretShapedGeneratedKeys) {
    it(`"${key}" is an isSecret row, an unmappedSecretApiPaths entry, or an explicit non-secret allowlist entry`, () => {
      const accounted =
        secretRowAuthKeys.has(key) ||
        unmappedSecretAuthKeys.has(key) ||
        NON_SECRET_ALLOWLIST.has(key);
      expect(accounted).toBe(true);
    });
  }
});
