import { describe, expect, it } from "vitest";
import { V1GetAuthServiceConfigOutput } from "@supabase/api/effect";
import {
  projectConfigMappingRows,
  unmappedSecretApiPaths,
  type ProjectConfigMappingRow,
} from "@supabase/config/internal";

/**
 * Contract-derived auth guard: closes two gaps `@supabase/config`'s own
 * `registry-integrity.unit.test.ts` can't close by itself. That file's `apiPath` check resolves
 * every auth row against an open `Record<string, Json>` field, so it's structurally vacuous and
 * can't catch a renamed or retired GoTrue key. And nothing in `@supabase/config` walks the
 * generated auth-config contract's full key set looking for a secret-shaped key with no registry
 * row at all — the gap that let several HMAC-digest fields leak through `unmappedApiFields`.
 *
 * This guard lives in `apps/cli`, which can import both `@supabase/config` and the generated API
 * client, unlike `packages/config` itself (which must stay decoupled to publish independently).
 * It reads `projectConfigMappingRows`/`unmappedSecretApiPaths` from `@supabase/config/internal`
 * for that reason. `V1GetAuthServiceConfigOutput` (not the v2 project-config resource) is the
 * authority: it's the generated schema with the real, flat GoTrue key set every auth row targets.
 */

const generatedAuthKeys: ReadonlySet<string> = new Set(
  Object.keys(V1GetAuthServiceConfigOutput.fields),
);

const authRows: ReadonlyArray<ProjectConfigMappingRow> = projectConfigMappingRows.filter(
  (row) => row.apiPath[0] === "auth",
);

describe("registry auth rows resolve against the generated v1 auth-config contract", () => {
  it("has a non-trivial generated key set and a non-trivial set of auth rows to check", () => {
    // Guards both loops below against passing vacuously if either import is ever broken.
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

    // A transform reads every path it declares in `alsoConsumes` — a renamed or removed
    // generated key there would leave it silently reading a stale key while the primary check
    // above stays green.
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
 * Key-name suffixes that mark a GoTrue key as secret-shaped. Kept in sync with
 * `registry-auth.ts`'s `unmappedSecretApiPaths` docstring, which names the same six suffixes.
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
 * `sms_vonage_api_key` is `_api_key`-shaped but genuinely not a secret: `packages/config/src/
 * auth/sms.ts`'s `vonage.api_key` field has no `secret()` wrapper, unlike its sibling
 * `vonage.api_secret`. It already has an ordinary `stringRow`, so it's excluded from
 * `unmappedSecretApiPaths` and allowlisted here instead of being treated as an orphan.
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
