import { describe, expect, it } from "vitest";
import { Schema } from "effect";
import { AUTH_HOOK_NAMES, CliConfigSchema, fromConfigDocument } from "@supabase/config";
import {
  legacyPresenceIn,
  type LegacyConfigPushPresence,
} from "../../legacy/commands/config/push/push.raw-presence.ts";

/**
 * Cross-check between `@supabase/config`'s raw-presence mask
 * (`fromConfigDocument`'s `CliConfigWithRawPresence` form, `project-
 * config.ts`'s `applyRawPresenceMask`) and the legacy push pipeline's own
 * presence gate (`legacyPresenceIn`) — human review round on PR #6339,
 * thread 1. `@supabase/config` cannot import `apps/cli`'s legacy push code
 * (the package must stay decoupled), so it re-implements the same gates
 * independently; this test lives here, where both sides are importable, and
 * fails loudly the moment the two drift instead of silently disagreeing in
 * production. Stopgap until CLI-2267 lands a shared fixture set both sides
 * can consume directly.
 *
 * Made EXHAUSTIVE against additions (engineer review round on PR #6339,
 * item 8) two ways: `TOP_LEVEL_PRESENCE_PATHS` below is a `Record` typed
 * over every non-`auth` `LegacyConfigPushPresence` key, so a new top-level
 * presence field fails THIS FILE's own typecheck the moment it's added,
 * before it could silently go unchecked at runtime; and `crossCheck` below
 * additionally asserts the full runtime key sets of `presence` and
 * `presence.auth` match what this file knows about, and that
 * `AUTH_HOOK_NAMES` (`@supabase/config`) matches the hook keys
 * `legacyPresenceIn` actually reports — so a 7th hook, or any other
 * presence field, added on only one side fails here even if the type-level
 * guard is somehow bypassed.
 */

const decodeCliConfig = Schema.decodeUnknownSync(CliConfigSchema);

const TOP_LEVEL_PRESENCE_PATHS: Record<
  Exclude<keyof LegacyConfigPushPresence, "auth">,
  ReadonlyArray<string>
> = {
  sslEnforcement: ["db", "ssl_enforcement"],
  imageTransformation: ["storage", "image_transformation"],
  s3Protocol: ["storage", "s3_protocol"],
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readPath(value: unknown, path: ReadonlyArray<string>): unknown {
  let current = value;
  for (const segment of path) {
    if (!isRecord(current)) {
      return undefined;
    }
    current = current[segment];
  }
  return current;
}

function hasOwnAtPath(value: unknown, path: ReadonlyArray<string>): boolean {
  const leafKey = path[path.length - 1];
  const parent = readPath(value, path.slice(0, -1));
  return leafKey !== undefined && isRecord(parent) && Object.hasOwn(parent, leafKey);
}

function crossCheck(document: Record<string, unknown>): void {
  const presence = legacyPresenceIn(document);
  const config = decodeCliConfig(document);
  const projected = fromConfigDocument({ config, document });

  // Exhaustive against a new top-level presence field: fails if `presence`
  // ever reports a key this file's TOP_LEVEL_PRESENCE_PATHS/"auth" pair
  // doesn't already know about.
  expect(Object.keys(presence).sort()).toEqual(
    [...Object.keys(TOP_LEVEL_PRESENCE_PATHS), "auth"].sort(),
  );
  expect(hasOwnAtPath(projected, TOP_LEVEL_PRESENCE_PATHS.sslEnforcement)).toBe(
    presence.sslEnforcement,
  );
  expect(hasOwnAtPath(projected, TOP_LEVEL_PRESENCE_PATHS.imageTransformation)).toBe(
    presence.imageTransformation,
  );
  expect(hasOwnAtPath(projected, TOP_LEVEL_PRESENCE_PATHS.s3Protocol)).toBe(presence.s3Protocol);

  // Exhaustive against a new AuthPresence field the same way.
  expect(Object.keys(presence.auth).sort()).toEqual(
    ["captcha", "externalProviders", "hooks", "smtp"].sort(),
  );
  expect(hasOwnAtPath(projected, ["auth", "captcha"])).toBe(presence.auth.captcha);
  expect(hasOwnAtPath(projected, ["auth", "email", "smtp"])).toBe(presence.auth.smtp);

  // Exhaustive against a hook added on only ONE side — a 7th hook in
  // `AuthPresence.hooks` with no `AUTH_HOOK_NAMES` entry (or vice versa)
  // fails this comparison.
  expect([...AUTH_HOOK_NAMES].sort()).toEqual(Object.keys(presence.auth.hooks).sort());
  for (const [name, present] of Object.entries(presence.auth.hooks)) {
    expect(hasOwnAtPath(projected, ["auth", "hook", name])).toBe(present);
  }

  const projectedExternal = readPath(projected, ["auth", "external"]);
  const projectedProviderNames = isRecord(projectedExternal) ? Object.keys(projectedExternal) : [];
  // `apple` is always sent regardless of raw presence (authSubsetFromConfig,
  // auth.sync.ts:1075-1084) — never itself part of `externalProviders`.
  expect(presence.auth.externalProviders).not.toContain("apple");
  expect(projectedProviderNames.sort()).toEqual(
    [...presence.auth.externalProviders, "apple"].sort(),
  );
}

describe("fromConfigDocument's raw-presence mask agrees with legacyPresenceIn", () => {
  it("omits exactly the subtrees legacyPresenceIn reports absent, and always keeps apple", () => {
    crossCheck({
      auth: {
        external: { google: { enabled: true, client_id: "google-client-id" } },
        hook: { send_email: { enabled: true, uri: "https://example.com/hook" } },
        // captcha and email.smtp are intentionally absent from this fixture.
      },
      // db.ssl_enforcement, storage.image_transformation, storage.s3_protocol
      // are intentionally absent from this fixture.
    });
  });

  it("agrees when the sections ARE raw-present too", () => {
    crossCheck({
      db: { ssl_enforcement: { enabled: true } },
      storage: {
        image_transformation: { enabled: true },
        s3_protocol: { enabled: false },
      },
      auth: {
        captcha: { enabled: true, provider: "hcaptcha", secret: "s" },
        email: {
          smtp: {
            enabled: true,
            host: "smtp.example.com",
            port: 587,
            user: "smtp-user",
            pass: "smtp-secret",
            admin_email: "admin@example.com",
          },
        },
        hook: {
          mfa_verification_attempt: { enabled: true, uri: "https://example.com/mfa" },
        },
      },
    });
  });
});
