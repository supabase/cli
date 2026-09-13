import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  BUCKET_NAME_PATTERN,
  CLERK_DOMAIN_PATTERN,
  FUNCTION_SLUG_PATTERN,
  HOOK_SECRET_PATTERN,
  PROJECT_REF_PATTERN,
  ConfigValidateError,
  type AuthInput,
  type ConfigValidationInput,
  parseGoBool,
  resolveEmailTemplateContentPath,
  validateResolvedConfig,
} from "./config-validate.ts";

describe("parseGoBool", () => {
  it("accepts Go's strconv.ParseBool true forms", () => {
    for (const value of ["1", "t", "T", "TRUE", "true", "True"]) {
      expect(parseGoBool(value)).toBe(true);
    }
  });

  it("accepts Go's strconv.ParseBool false forms, including the empty string", () => {
    for (const value of ["0", "f", "F", "FALSE", "false", "False", ""]) {
      expect(parseGoBool(value)).toBe(false);
    }
  });

  it("returns undefined for a value outside Go's strconv.ParseBool acceptance set", () => {
    expect(parseGoBool("yes")).toBeUndefined();
    expect(parseGoBool("2")).toBeUndefined();
  });
});

describe("PROJECT_REF_PATTERN", () => {
  it("matches a valid 20-character lowercase project ref", () => {
    expect(PROJECT_REF_PATTERN.test("abcdefghijklmnopqrst")).toBe(true);
  });

  it("rejects refs of the wrong length or case", () => {
    expect(PROJECT_REF_PATTERN.test("short")).toBe(false);
    expect(PROJECT_REF_PATTERN.test("ABCDEFGHIJKLMNOPQRST")).toBe(false);
  });
});

describe("BUCKET_NAME_PATTERN", () => {
  it("matches Go-legal bucket name characters", () => {
    expect(BUCKET_NAME_PATTERN.test("my-bucket.1")).toBe(true);
  });

  it("rejects characters outside Go's bucketNamePattern", () => {
    expect(BUCKET_NAME_PATTERN.test("bad#name")).toBe(false);
    expect(BUCKET_NAME_PATTERN.test("bad/name")).toBe(false);
  });
});

describe("FUNCTION_SLUG_PATTERN", () => {
  it("matches a valid function slug (letters, digits, _ and -)", () => {
    expect(FUNCTION_SLUG_PATTERN.test("my-function")).toBe(true);
    expect(FUNCTION_SLUG_PATTERN.test("function_1")).toBe(true);
  });

  it("rejects a slug that doesn't start with a letter", () => {
    expect(FUNCTION_SLUG_PATTERN.test("123")).toBe(false);
    expect(FUNCTION_SLUG_PATTERN.test("1bad")).toBe(false);
  });
});

describe("HOOK_SECRET_PATTERN", () => {
  it("matches a valid v1,whsec_ secret", () => {
    expect(HOOK_SECRET_PATTERN.test(`v1,whsec_${"a".repeat(32)}`)).toBe(true);
  });

  it("rejects a secret that doesn't match Go's hookSecretPattern", () => {
    expect(HOOK_SECRET_PATTERN.test("not-a-valid-secret")).toBe(false);
  });
});

describe("CLERK_DOMAIN_PATTERN", () => {
  it("matches a valid clerk.example.com domain", () => {
    expect(CLERK_DOMAIN_PATTERN.test("clerk.example.com")).toBe(true);
  });

  it("matches a valid <slug>.clerk.accounts.dev domain", () => {
    expect(CLERK_DOMAIN_PATTERN.test("example.clerk.accounts.dev")).toBe(true);
  });

  it("rejects a domain that doesn't match Go's clerkDomainPattern", () => {
    expect(CLERK_DOMAIN_PATTERN.test("not-a-clerk-domain")).toBe(false);
  });
});

// Direct coverage for the containment check shared by every caller (config push's
// loadAuthEmailContent, db-config.toml-read.ts, local-config-values.ts, start.handler.ts's
// pre-Docker pass), cheaper to pin here than to re-derive through every caller's own fixtures.
describe("resolveEmailTemplateContentPath", () => {
  let projectRoot = "";
  let outsideDir = "";

  afterEach(() => {
    if (projectRoot.length > 0) {
      rmSync(projectRoot, { recursive: true, force: true });
      projectRoot = "";
    }
    if (outsideDir.length > 0) {
      rmSync(outsideDir, { recursive: true, force: true });
      outsideDir = "";
    }
  });

  function setup(): string {
    projectRoot = mkdtempSync(join(tmpdir(), "config-validate-email-content-"));
    return projectRoot;
  }

  /** A real file outside `base`, so a containment test proves the escape check fires rather than a missing-file error. */
  function setupOutsideFile(): string {
    outsideDir = mkdtempSync(join(tmpdir(), "config-validate-email-content-outside-"));
    const outsideFile = join(outsideDir, "secret.html");
    writeFileSync(outsideFile, "<p>Outside</p>");
    return outsideFile;
  }

  function resolveContentPath(
    section: "template" | "notification",
    contentPath: string,
    base: string,
  ) {
    return resolveEmailTemplateContentPath({
      section,
      name: "invite",
      contentPath,
      contentPresent: false,
      base,
    });
  }

  it.each(["template", "notification"] as const)(
    "rejects an absolute %s content_path outside the project root",
    (section) => {
      const base = setup();
      const outsideFile = setupOutsideFile();

      expect(() => resolveContentPath(section, outsideFile, base)).toThrow(ConfigValidateError);
      expect(() => resolveContentPath(section, outsideFile, base)).toThrow(
        /resolves outside the project root/,
      );
    },
  );

  it.each(["template", "notification"] as const)(
    "rejects a relative %s content_path that escapes the project root via ..",
    (section) => {
      const base = setup();
      const outsideFile = setupOutsideFile();
      const escapePath = relative(base, outsideFile);

      expect(() => resolveContentPath(section, escapePath, base)).toThrow(
        /resolves outside the project root/,
      );
    },
  );

  it.each(["template", "notification"] as const)(
    "rejects a %s content_path that is an in-root symlink pointing outside the project root",
    (section) => {
      const base = setup();
      const outsideFile = setupOutsideFile();
      const symlinkPath = join(base, "evil.html");
      symlinkSync(outsideFile, symlinkPath);

      expect(() => resolveContentPath(section, "./evil.html", base)).toThrow(
        /resolves outside the project root/,
      );
    },
  );

  it("accepts an in-root sibling path whose name literally starts with two dots, distinct from a .. escape", () => {
    const base = setup();
    const dotDir = join(base, "..templates");
    mkdirSync(dotDir, { recursive: true });
    writeFileSync(join(dotDir, "invite.html"), "<h1>Invite</h1>");

    const resolved = resolveContentPath("template", "..templates/invite.html", base);

    expect(resolved).toBe(join(realpathSync(base), "..templates", "invite.html"));
  });

  it("accepts a content_path that resolves to exactly the project root", () => {
    const base = setup();

    const resolved = resolveContentPath("template", ".", base);

    expect(resolved).toBe(realpathSync(base));
  });

  it("resolves a missing in-root file behind a symlinked project root instead of raising the containment error", () => {
    const realDir = mkdtempSync(join(tmpdir(), "config-validate-email-content-real-"));
    const linkContainer = mkdtempSync(join(tmpdir(), "config-validate-email-content-link-"));
    const symlinkedRoot = join(linkContainer, "project-root");
    symlinkSync(realDir, symlinkedRoot, "dir");

    try {
      const resolved = resolveContentPath("template", "missing-invite.html", symlinkedRoot);
      expect(resolved).toBe(join(realpathSync(symlinkedRoot), "missing-invite.html"));
    } finally {
      rmSync(linkContainer, { recursive: true, force: true });
      rmSync(realDir, { recursive: true, force: true });
    }
  });

  it.each(["template", "notification"] as const)(
    "rejects a %s content_path that is an in-root dangling symlink pointing to a nonexistent target outside the project root",
    (section) => {
      const base = setup();
      outsideDir = mkdtempSync(join(tmpdir(), "config-validate-email-content-outside-"));
      const neverCreatedOutsideTarget = join(outsideDir, "never-created.html");
      const danglingSymlinkPath = join(base, "dangling.html");
      symlinkSync(neverCreatedOutsideTarget, danglingSymlinkPath);

      expect(() => resolveContentPath(section, "./dangling.html", base)).toThrow(
        ConfigValidateError,
      );
      expect(() => resolveContentPath(section, "./dangling.html", base)).toThrow(
        /resolves outside the project root/,
      );
    },
  );

  it.each(["template", "notification"] as const)(
    "rejects a %s content_path that is an in-root symlink whose outside target sits behind an unsearchable (EACCES) directory",
    (section) => {
      // Skipped when this environment doesn't enforce chmod 000 (e.g. running as root); the
      // dangling-symlink case above already covers the core regression without a permission trick.
      const base = setup();
      outsideDir = mkdtempSync(join(tmpdir(), "config-validate-email-content-outside-"));
      const unsearchableDir = join(outsideDir, "locked");
      mkdirSync(unsearchableDir);
      const target = join(unsearchableDir, "secret.html");
      writeFileSync(target, "<p>Locked</p>");
      chmodSync(unsearchableDir, 0o000);

      try {
        let permissionEnforced = true;
        try {
          readdirSync(unsearchableDir);
          permissionEnforced = false;
        } catch {
          // expected in a normal, unprivileged environment — confirms chmod 000 actually blocks access here.
        }
        if (!permissionEnforced) {
          return;
        }

        const symlinkPath = join(base, "unsearchable.html");
        symlinkSync(target, symlinkPath);

        expect(() => resolveContentPath(section, "./unsearchable.html", base)).toThrow(
          ConfigValidateError,
        );
        expect(() => resolveContentPath(section, "./unsearchable.html", base)).toThrow(
          /resolves outside the project root/,
        );
      } finally {
        chmodSync(unsearchableDir, 0o755);
      }
    },
  );

  it("accepts a genuinely in-root file behind an unsearchable (EACCES) directory, even when the project root itself is reached through a symlink", () => {
    const realDir = mkdtempSync(join(tmpdir(), "config-validate-email-content-real-"));
    const linkContainer = mkdtempSync(join(tmpdir(), "config-validate-email-content-link-"));
    const symlinkedRoot = join(linkContainer, "project-root");
    symlinkSync(realDir, symlinkedRoot, "dir");
    const lockedDir = join(realDir, "locked");
    mkdirSync(lockedDir);
    const target = join(lockedDir, "invite.html");
    writeFileSync(target, "<h1>Invite</h1>");
    chmodSync(lockedDir, 0o000);

    try {
      let permissionEnforced = true;
      try {
        readdirSync(lockedDir);
        permissionEnforced = false;
      } catch {
        // expected in a normal, unprivileged environment — confirms chmod 000 actually blocks access here.
      }
      if (!permissionEnforced) {
        return;
      }

      const resolved = resolveContentPath("template", "./locked/invite.html", symlinkedRoot);

      expect(resolved).toBe(join(realpathSync(symlinkedRoot), "locked", "invite.html"));
    } finally {
      chmodSync(lockedDir, 0o755);
      rmSync(linkContainer, { recursive: true, force: true });
      rmSync(realDir, { recursive: true, force: true });
    }
  });

  it.each(["template", "notification"] as const)(
    "rejects a %s content_path that is an in-root symlink pointing to an unstattable (ENAMETOOLONG) target name, without relying on directory permissions",
    (section) => {
      const base = setup();
      outsideDir = mkdtempSync(join(tmpdir(), "config-validate-email-content-outside-"));
      const tooLongName = `${"a".repeat(300)}.html`;
      const symlinkPath = join(base, "toolong.html");
      try {
        symlinkSync(join(outsideDir, tooLongName), symlinkPath);
      } catch {
        // Unprivileged symlink creation isn't unconditionally available (e.g. Windows without
        // Developer Mode/admin) — skip rather than fail an environment that can't set this up.
        return;
      }

      expect(() => resolveContentPath(section, "./toolong.html", base)).toThrow(
        ConfigValidateError,
      );
      expect(() => resolveContentPath(section, "./toolong.html", base)).toThrow(
        /resolves outside the project root/,
      );
    },
  );

  it.each(["template", "notification"] as const)(
    "rejects an in-root %s symlink loop instead of hanging or crashing",
    (section) => {
      // Reuses the symlinked-root fixture (rather than relying on incidental ambient-tmpdir
      // symlinks) so there's a guaranteed canonicalization gap between root and the loop path.
      const realDir = mkdtempSync(join(tmpdir(), "config-validate-email-content-real-"));
      const linkContainer = mkdtempSync(join(tmpdir(), "config-validate-email-content-link-"));
      const symlinkedRoot = join(linkContainer, "project-root");
      symlinkSync(realDir, symlinkedRoot, "dir");

      try {
        const loopA = join(symlinkedRoot, "loop-a.html");
        const loopB = join(symlinkedRoot, "loop-b.html");
        symlinkSync(loopB, loopA);
        symlinkSync(loopA, loopB);

        expect(() => resolveContentPath(section, "./loop-a.html", symlinkedRoot)).toThrow(
          ConfigValidateError,
        );
        expect(() => resolveContentPath(section, "./loop-a.html", symlinkedRoot)).toThrow(
          /resolves outside the project root/,
        );
      } finally {
        rmSync(linkContainer, { recursive: true, force: true });
        rmSync(realDir, { recursive: true, force: true });
      }
    },
  );

  it("never selects an unstattable notification legacy-fallback twin behind an unsearchable (EACCES) supabase/ directory", () => {
    const base = setup();
    const supabaseDir = join(base, "supabase");
    mkdirSync(supabaseDir);
    chmodSync(supabaseDir, 0o000);

    try {
      let permissionEnforced = true;
      try {
        readdirSync(supabaseDir);
        permissionEnforced = false;
      } catch {
        // expected in a normal, unprivileged environment — confirms chmod 000 actually blocks access here.
      }
      if (!permissionEnforced) {
        return;
      }

      const resolved = resolveContentPath("notification", "notification.html", base);

      // The result must be the root-resolved path, not the unverified legacy twin; this
      // function only resolves a path, it doesn't check that the file exists, so a non-throw
      // here is expected.
      expect(resolved).toBe(join(realpathSync(base), "notification.html"));
    } finally {
      chmodSync(supabaseDir, 0o755);
    }
  });
});

/**
 * A trivially-passing full input. Every test below spreads/overrides only the field(s) its
 * check cares about, matching the fixture-building style of `local-config-values.unit.
 * test.ts`'s own `baseConfig()` helper.
 */
function minimalInput(overrides: Partial<ConfigValidationInput> = {}): ConfigValidationInput {
  return {
    db: { port: 5432, majorVersion: 17 },
    storageBucketNames: [],
    functionSlugs: [],
    edgeRuntimeDenoVersion: 2,
    analytics: {
      enabled: false,
      backend: undefined,
      gcpProjectId: "",
      gcpProjectNumber: "",
      gcpJwtPath: "",
    },
    experimental: { pgdeltaFormatOptions: "" },
    ...overrides,
  };
}

/** A trivially-passing `[auth]` section — auth enabled, nothing else configured. */
function minimalAuthInput(overrides: Partial<AuthInput> = {}): AuthInput {
  return {
    siteUrl: "http://localhost:3000",
    hooks: [],
    mfa: [],
    thirdParty: [],
    ...overrides,
  };
}

// These describe blocks call `validateResolvedConfig` directly with a hand-built
// `ConfigValidationInput` — no `CliConfig`/schema decode, no env-override machinery, no file
// I/O, no `document` threading. Everything that still needs one of those (value derivation,
// env-override mechanics, the 3 I/O checks' actual file reads) stays in
// `local-config-values.unit.test.ts`.
describe("validateResolvedConfig", () => {
  // The env-override (SUPABASE_DB_MAJOR_VERSION) variant lives in local-config-values.unit.test.ts.
  describe("db.major_version", () => {
    it("rejects a configured major_version of 0", () => {
      expect(() =>
        validateResolvedConfig(minimalInput({ db: { port: 5432, majorVersion: 0 } })),
      ).toThrow("Missing required field in config: db.major_version");
    });

    it("rejects the unsupported Postgres 12.x major_version with Go's dedicated message", () => {
      expect(() =>
        validateResolvedConfig(minimalInput({ db: { port: 5432, majorVersion: 12 } })),
      ).toThrow("Postgres version 12.x is unsupported.");
    });

    it.each([13, 14, 15, 17])("accepts the supported major_version %d", (majorVersion) => {
      expect(() =>
        validateResolvedConfig(minimalInput({ db: { port: 5432, majorVersion } })),
      ).not.toThrow();
    });

    it("rejects an unsupported major_version with the generic invalid-value message", () => {
      expect(() =>
        validateResolvedConfig(minimalInput({ db: { port: 5432, majorVersion: 16 } })),
      ).toThrow("Failed reading config: Invalid db.major_version: 16.");
    });
  });

  describe("storage.buckets", () => {
    it("rejects a bucket name Go's ValidateBucketName refuses", () => {
      expect(() =>
        validateResolvedConfig(minimalInput({ storageBucketNames: ["bad/name"] })),
      ).toThrow("Invalid Bucket name: bad/name.");
    });

    it("does not throw for a valid bucket name", () => {
      expect(() =>
        validateResolvedConfig(minimalInput({ storageBucketNames: ["avatars.public"] })),
      ).not.toThrow();
    });

    it("does not throw when no buckets are configured", () => {
      expect(() => validateResolvedConfig(minimalInput())).not.toThrow();
    });
  });

  // The env-override (SUPABASE_EDGE_RUNTIME_DENO_VERSION) variant lives in
  // local-config-values.unit.test.ts.
  describe("edge_runtime.deno_version", () => {
    it("rejects a configured deno_version of 0", () => {
      expect(() => validateResolvedConfig(minimalInput({ edgeRuntimeDenoVersion: 0 }))).toThrow(
        "Missing required field in config: edge_runtime.deno_version",
      );
    });

    it.each([1, 2])("accepts the supported deno_version %d", (denoVersion) => {
      expect(() =>
        validateResolvedConfig(minimalInput({ edgeRuntimeDenoVersion: denoVersion })),
      ).not.toThrow();
    });

    it("rejects an unsupported deno_version with the generic invalid-value message", () => {
      expect(() => validateResolvedConfig(minimalInput({ edgeRuntimeDenoVersion: 3 }))).toThrow(
        "Failed reading config: Invalid edge_runtime.deno_version: 3.",
      );
    });

    it("rejects an invalid deno_version even when edge_runtime is disabled", () => {
      expect(() => validateResolvedConfig(minimalInput({ edgeRuntimeDenoVersion: 0 }))).toThrow(
        "Missing required field in config: edge_runtime.deno_version",
      );
    });
  });

  // The env-override (SUPABASE_ANALYTICS_*) variants live in local-config-values.unit.test.ts.
  describe("analytics (BigQuery backend required fields)", () => {
    it("rejects an enabled bigquery backend without gcp_project_id", () => {
      expect(() =>
        validateResolvedConfig(
          minimalInput({
            analytics: {
              enabled: true,
              backend: "bigquery",
              gcpProjectId: "",
              gcpProjectNumber: "",
              gcpJwtPath: "",
            },
          }),
        ),
      ).toThrow("Missing required field in config: analytics.gcp_project_id");
    });

    it("rejects an enabled bigquery backend without gcp_project_number", () => {
      expect(() =>
        validateResolvedConfig(
          minimalInput({
            analytics: {
              enabled: true,
              backend: "bigquery",
              gcpProjectId: "proj",
              gcpProjectNumber: "",
              gcpJwtPath: "",
            },
          }),
        ),
      ).toThrow("Missing required field in config: analytics.gcp_project_number");
    });

    it("rejects an enabled bigquery backend without gcp_jwt_path", () => {
      expect(() =>
        validateResolvedConfig(
          minimalInput({
            analytics: {
              enabled: true,
              backend: "bigquery",
              gcpProjectId: "proj",
              gcpProjectNumber: "123",
              gcpJwtPath: "",
            },
          }),
        ),
      ).toThrow(
        "Path to GCP Service Account Key must be provided in config, relative to config.toml: analytics.gcp_jwt_path",
      );
    });

    it("does not throw when an enabled bigquery backend has all three GCP fields", () => {
      expect(() =>
        validateResolvedConfig(
          minimalInput({
            analytics: {
              enabled: true,
              backend: "bigquery",
              gcpProjectId: "proj",
              gcpProjectNumber: "123",
              gcpJwtPath: "gcp.json",
            },
          }),
        ),
      ).not.toThrow();
    });

    it("does not throw for the postgres backend, however incomplete the GCP fields are", () => {
      expect(() =>
        validateResolvedConfig(
          minimalInput({
            analytics: {
              enabled: true,
              backend: "postgres",
              gcpProjectId: "",
              gcpProjectNumber: "",
              gcpJwtPath: "",
            },
          }),
        ),
      ).not.toThrow();
    });

    it("does not throw when analytics is disabled, however incomplete the GCP fields are", () => {
      expect(() =>
        validateResolvedConfig(
          minimalInput({
            analytics: {
              enabled: false,
              backend: "bigquery",
              gcpProjectId: "",
              gcpProjectNumber: "",
              gcpJwtPath: "",
            },
          }),
        ),
      ).not.toThrow();
    });
  });

  describe("experimental.*", () => {
    it("rejects a present [experimental.webhooks] section with enabled omitted", () => {
      expect(() =>
        validateResolvedConfig(
          minimalInput({ experimental: { webhooksPresent: true, pgdeltaFormatOptions: "" } }),
        ),
      ).toThrow(
        "Webhooks cannot be deactivated. [experimental.webhooks] enabled can either be true or left undefined",
      );
    });

    it("rejects a present [experimental.webhooks] section with enabled = false", () => {
      expect(() =>
        validateResolvedConfig(
          minimalInput({
            experimental: {
              webhooksPresent: true,
              webhooksEnabled: false,
              pgdeltaFormatOptions: "",
            },
          }),
        ),
      ).toThrow(
        "Webhooks cannot be deactivated. [experimental.webhooks] enabled can either be true or left undefined",
      );
    });

    it("does not throw when [experimental.webhooks] enabled = true", () => {
      expect(() =>
        validateResolvedConfig(
          minimalInput({
            experimental: {
              webhooksPresent: true,
              webhooksEnabled: true,
              pgdeltaFormatOptions: "",
            },
          }),
        ),
      ).not.toThrow();
    });

    it("does not throw when [experimental.webhooks] is absent entirely", () => {
      expect(() => validateResolvedConfig(minimalInput())).not.toThrow();
    });

    it("rejects invalid JSON in experimental.pgdelta.format_options", () => {
      expect(() =>
        validateResolvedConfig(
          minimalInput({ experimental: { pgdeltaFormatOptions: "{not json" } }),
        ),
      ).toThrow("Invalid config for experimental.pgdelta.format_options: must be valid JSON");
    });

    it("does not throw for valid JSON in experimental.pgdelta.format_options", () => {
      expect(() =>
        validateResolvedConfig(
          minimalInput({ experimental: { pgdeltaFormatOptions: '{"keywordCase":"upper"}' } }),
        ),
      ).not.toThrow();
    });

    it("does not throw when experimental.pgdelta.format_options is unset", () => {
      expect(() =>
        validateResolvedConfig(minimalInput({ experimental: { pgdeltaFormatOptions: "" } })),
      ).not.toThrow();
    });
  });

  // An absent `auth` section means auth is disabled, from this function's perspective. The
  // SUPABASE_AUTH_ENABLED/SUPABASE_AUTH_SITE_URL env-override variants live in
  // local-config-values.unit.test.ts.
  describe("auth.site_url", () => {
    it("rejects an explicit empty site_url when auth is enabled", () => {
      expect(() =>
        validateResolvedConfig(minimalInput({ auth: minimalAuthInput({ siteUrl: "" }) })),
      ).toThrow("Missing required field in config: auth.site_url");
    });

    it("does not throw when site_url is set and auth is enabled", () => {
      expect(() =>
        validateResolvedConfig(
          minimalInput({ auth: minimalAuthInput({ siteUrl: "http://localhost:3000" }) }),
        ),
      ).not.toThrow();
    });

    it("does not throw an explicit empty site_url when auth is disabled", () => {
      expect(() => validateResolvedConfig(minimalInput())).not.toThrow();
    });
  });

  describe("auth.captcha", () => {
    it("rejects an enabled captcha without a provider", () => {
      expect(() =>
        validateResolvedConfig(
          minimalInput({
            auth: minimalAuthInput({
              captcha: { enabled: true, provider: undefined, secret: undefined },
            }),
          }),
        ),
      ).toThrow("Missing required field in config: auth.captcha.provider");
    });

    it("rejects an enabled captcha with a provider but no secret", () => {
      expect(() =>
        validateResolvedConfig(
          minimalInput({
            auth: minimalAuthInput({
              captcha: { enabled: true, provider: "hcaptcha", secret: undefined },
            }),
          }),
        ),
      ).toThrow("Missing required field in config: auth.captcha.secret");
    });

    it("does not throw when an enabled captcha has both provider and secret", () => {
      expect(() =>
        validateResolvedConfig(
          minimalInput({
            auth: minimalAuthInput({
              captcha: { enabled: true, provider: "hcaptcha", secret: "shh" },
            }),
          }),
        ),
      ).not.toThrow();
    });

    it("does not throw when captcha is disabled, however incomplete", () => {
      expect(() =>
        validateResolvedConfig(
          minimalInput({
            auth: minimalAuthInput({
              captcha: { enabled: false, provider: undefined, secret: undefined },
            }),
          }),
        ),
      ).not.toThrow();
    });

    it("does not throw an enabled captcha without provider/secret when auth is disabled", () => {
      expect(() => validateResolvedConfig(minimalInput())).not.toThrow();
    });
  });

  describe("auth.passkey / auth.webauthn", () => {
    it("rejects passkey.enabled without an [auth.webauthn] section", () => {
      expect(() =>
        validateResolvedConfig(
          minimalInput({
            auth: minimalAuthInput({
              passkey: { webauthnPresent: false, rpId: undefined, rpOrigins: undefined },
            }),
          }),
        ),
      ).toThrow(
        "Missing required config section: auth.webauthn (required when auth.passkey.enabled is true)",
      );
    });

    it("rejects passkey.enabled with [auth.webauthn] missing rp_id", () => {
      expect(() =>
        validateResolvedConfig(
          minimalInput({
            auth: minimalAuthInput({
              passkey: {
                webauthnPresent: true,
                rpId: undefined,
                rpOrigins: ["http://localhost:3000"],
              },
            }),
          }),
        ),
      ).toThrow("Missing required field in config: auth.webauthn.rp_id");
    });

    it("rejects passkey.enabled with [auth.webauthn] missing rp_origins", () => {
      expect(() =>
        validateResolvedConfig(
          minimalInput({
            auth: minimalAuthInput({
              passkey: { webauthnPresent: true, rpId: "localhost", rpOrigins: undefined },
            }),
          }),
        ),
      ).toThrow("Missing required field in config: auth.webauthn.rp_origins");
    });

    it("does not throw when passkey.enabled has a complete [auth.webauthn] section", () => {
      expect(() =>
        validateResolvedConfig(
          minimalInput({
            auth: minimalAuthInput({
              passkey: {
                webauthnPresent: true,
                rpId: "localhost",
                rpOrigins: ["http://localhost:3000"],
              },
            }),
          }),
        ),
      ).not.toThrow();
    });

    it("does not throw when passkey is absent from the input", () => {
      expect(() =>
        validateResolvedConfig(minimalInput({ auth: minimalAuthInput({ passkey: undefined }) })),
      ).not.toThrow();
    });

    it("does not throw when auth carries no passkey data at all", () => {
      // Distinct from the previous test only in the original caller's derivation; both
      // collapse to `passkey: undefined` here.
      expect(() =>
        validateResolvedConfig(minimalInput({ auth: minimalAuthInput() })),
      ).not.toThrow();
    });

    it("does not throw an enabled passkey without webauthn when auth is disabled", () => {
      expect(() => validateResolvedConfig(minimalInput())).not.toThrow();
    });
  });

  describe("auth.email.smtp", () => {
    it("rejects a present [auth.email.smtp] table with no fields", () => {
      expect(() =>
        validateResolvedConfig(
          minimalInput({
            auth: minimalAuthInput({
              smtp: { enabled: true, host: "", port: 0, user: "", pass: "", adminEmail: "" },
            }),
          }),
        ),
      ).toThrow("Missing required field in config: auth.email.smtp.host");
    });

    it("rejects a present [auth.email.smtp] table missing port/user/pass/admin_email", () => {
      expect(() =>
        validateResolvedConfig(
          minimalInput({
            auth: minimalAuthInput({
              smtp: {
                enabled: true,
                host: "smtp.example.com",
                port: 0,
                user: "",
                pass: "",
                adminEmail: "",
              },
            }),
          }),
        ),
      ).toThrow("Missing required field in config: auth.email.smtp.port");
    });

    it("does not throw when [auth.email.smtp] explicitly sets enabled = false", () => {
      expect(() =>
        validateResolvedConfig(
          minimalInput({
            auth: minimalAuthInput({
              smtp: {
                enabled: false,
                host: "smtp.example.com",
                port: 0,
                user: "",
                pass: "",
                adminEmail: "",
              },
            }),
          }),
        ),
      ).not.toThrow();
    });

    it("does not throw when [auth.email.smtp] is a complete table", () => {
      expect(() =>
        validateResolvedConfig(
          minimalInput({
            auth: minimalAuthInput({
              smtp: {
                enabled: true,
                host: "smtp.example.com",
                port: 587,
                user: "user",
                pass: "pass",
                adminEmail: "admin@example.com",
              },
            }),
          }),
        ),
      ).not.toThrow();
    });

    it("does not throw when [auth.email.smtp] is absent from the input", () => {
      expect(() =>
        validateResolvedConfig(minimalInput({ auth: minimalAuthInput({ smtp: undefined }) })),
      ).not.toThrow();
    });

    it("does not throw when auth carries no smtp data at all", () => {
      // See the equivalent passkey note above — both collapse to `smtp: undefined` here.
      expect(() =>
        validateResolvedConfig(minimalInput({ auth: minimalAuthInput() })),
      ).not.toThrow();
    });

    it("does not throw a present but incomplete [auth.email.smtp] table when auth is disabled", () => {
      expect(() => validateResolvedConfig(minimalInput())).not.toThrow();
    });
  });

  describe("auth.hook.*", () => {
    it("rejects an enabled hook without a uri", () => {
      expect(() =>
        validateResolvedConfig(
          minimalInput({
            auth: minimalAuthInput({
              hooks: [{ type: "custom_access_token", uri: "", secrets: "" }],
            }),
          }),
        ),
      ).toThrow("Missing required field in config: auth.hook.custom_access_token.uri");
    });

    it("rejects an http(s) hook uri without secrets", () => {
      expect(() =>
        validateResolvedConfig(
          minimalInput({
            auth: minimalAuthInput({
              hooks: [
                { type: "custom_access_token", uri: "https://example.test/hook", secrets: "" },
              ],
            }),
          }),
        ),
      ).toThrow("Missing required field in config: auth.hook.custom_access_token.secrets");
    });

    it("rejects an http(s) hook secret that doesn't match Go's hookSecretPattern", () => {
      expect(() =>
        validateResolvedConfig(
          minimalInput({
            auth: minimalAuthInput({
              hooks: [
                {
                  type: "custom_access_token",
                  uri: "https://example.test/hook",
                  secrets: "not-a-valid-secret",
                },
              ],
            }),
          }),
        ),
      ).toThrow(
        'auth.hook.custom_access_token.secrets must be formatted as "v1,whsec_<base64_encoded_secret>"',
      );
    });

    it("does not throw for a valid http(s) hook secret", () => {
      expect(() =>
        validateResolvedConfig(
          minimalInput({
            auth: minimalAuthInput({
              hooks: [
                {
                  type: "custom_access_token",
                  uri: "https://example.test/hook",
                  secrets: `v1,whsec_${"a".repeat(32)}`,
                },
              ],
            }),
          }),
        ),
      ).not.toThrow();
    });

    it("rejects a pg-functions hook uri with secrets set", () => {
      expect(() =>
        validateResolvedConfig(
          minimalInput({
            auth: minimalAuthInput({
              hooks: [
                {
                  type: "custom_access_token",
                  uri: "pg-functions://postgres/public/hook",
                  secrets: `v1,whsec_${"a".repeat(32)}`,
                },
              ],
            }),
          }),
        ),
      ).toThrow("auth.hook.custom_access_token.secrets is unsupported for pg-functions URI");
    });

    it("does not throw for a pg-functions hook uri without secrets", () => {
      expect(() =>
        validateResolvedConfig(
          minimalInput({
            auth: minimalAuthInput({
              hooks: [
                {
                  type: "custom_access_token",
                  uri: "pg-functions://postgres/public/hook",
                  secrets: "",
                },
              ],
            }),
          }),
        ),
      ).not.toThrow();
    });

    it("rejects a hook uri with an unsupported scheme", () => {
      expect(() =>
        validateResolvedConfig(
          minimalInput({
            auth: minimalAuthInput({
              hooks: [{ type: "custom_access_token", uri: "ftp://example.test/hook", secrets: "" }],
            }),
          }),
        ),
      ).toThrow("auth.hook.custom_access_token.uri should be a HTTP, HTTPS, or pg-functions URI");
    });

    it("rejects a hook uri that fails Go's url.Parse (malformed IPv6 host)", () => {
      expect(() =>
        validateResolvedConfig(
          minimalInput({
            auth: minimalAuthInput({
              hooks: [{ type: "custom_access_token", uri: "http://[::1", secrets: "" }],
            }),
          }),
        ),
      ).toThrow("failed to parse template url:");
    });

    it("does not throw for a disabled hook, however incomplete", () => {
      // The caller pre-filters to enabled-only hooks, so a disabled hook is simply absent — an
      // empty array here.
      expect(() =>
        validateResolvedConfig(minimalInput({ auth: minimalAuthInput({ hooks: [] }) })),
      ).not.toThrow();
    });

    it("does not throw an enabled hook without a uri when auth is disabled", () => {
      expect(() => validateResolvedConfig(minimalInput())).not.toThrow();
    });
  });

  describe("auth.mfa.*", () => {
    it.each([
      ["totp", "auth.mfa.totp.enroll_enabled requires verify_enabled"],
      ["phone", "auth.mfa.phone.enroll_enabled requires verify_enabled"],
      ["web_authn", "auth.mfa.web_authn.enroll_enabled requires verify_enabled"],
    ] as const)("rejects %s enroll_enabled without verify_enabled", (label, message) => {
      expect(() =>
        validateResolvedConfig(
          minimalInput({
            auth: minimalAuthInput({
              mfa: [{ label, enrollEnabled: true, verifyEnabled: false }],
            }),
          }),
        ),
      ).toThrow(message);
    });

    it("does not throw when enroll_enabled and verify_enabled are both true", () => {
      expect(() =>
        validateResolvedConfig(
          minimalInput({
            auth: minimalAuthInput({
              mfa: [{ label: "totp", enrollEnabled: true, verifyEnabled: true }],
            }),
          }),
        ),
      ).not.toThrow();
    });

    it("does not throw an enroll_enabled MFA factor without verify_enabled when auth is disabled", () => {
      expect(() => validateResolvedConfig(minimalInput())).not.toThrow();
    });
  });

  describe("auth.third_party.*", () => {
    it("rejects firebase enabled without a project_id", () => {
      expect(() =>
        validateResolvedConfig(
          minimalInput({
            auth: minimalAuthInput({ thirdParty: [{ provider: "firebase", requiredField: "" }] }),
          }),
        ),
      ).toThrow("Invalid config: auth.third_party.firebase is enabled but without a project_id.");
    });

    it("rejects auth0 enabled without a tenant", () => {
      expect(() =>
        validateResolvedConfig(
          minimalInput({
            auth: minimalAuthInput({ thirdParty: [{ provider: "auth0", requiredField: "" }] }),
          }),
        ),
      ).toThrow("Invalid config: auth.third_party.auth0 is enabled but without a tenant.");
    });

    it("rejects aws_cognito enabled without a user_pool_id", () => {
      expect(() =>
        validateResolvedConfig(
          minimalInput({
            auth: minimalAuthInput({ thirdParty: [{ provider: "cognito", requiredField: "" }] }),
          }),
        ),
      ).toThrow("Invalid config: auth.third_party.cognito is enabled but without a user_pool_id.");
    });

    it("rejects aws_cognito enabled with a user_pool_id but no user_pool_region", () => {
      expect(() =>
        validateResolvedConfig(
          minimalInput({
            auth: minimalAuthInput({
              thirdParty: [
                { provider: "cognito", requiredField: "pool-1", cognitoUserPoolRegion: undefined },
              ],
            }),
          }),
        ),
      ).toThrow(
        "Invalid config: auth.third_party.cognito is enabled but without a user_pool_region.",
      );
    });

    it("rejects clerk enabled without a domain", () => {
      expect(() =>
        validateResolvedConfig(
          minimalInput({
            auth: minimalAuthInput({ thirdParty: [{ provider: "clerk", requiredField: "" }] }),
          }),
        ),
      ).toThrow("Invalid config: auth.third_party.clerk is enabled but without a domain.");
    });

    it("rejects clerk enabled with a domain that doesn't match Go's clerkDomainPattern", () => {
      expect(() =>
        validateResolvedConfig(
          minimalInput({
            auth: minimalAuthInput({
              thirdParty: [{ provider: "clerk", requiredField: "not-a-clerk-domain" }],
            }),
          }),
        ),
      ).toThrow("Invalid config: auth.third_party.clerk has invalid domain");
    });

    it("does not throw for a valid clerk.example.com domain", () => {
      expect(() =>
        validateResolvedConfig(
          minimalInput({
            auth: minimalAuthInput({
              thirdParty: [{ provider: "clerk", requiredField: "clerk.example.com" }],
            }),
          }),
        ),
      ).not.toThrow();
    });

    it("rejects workos enabled without an issuer_url", () => {
      expect(() =>
        validateResolvedConfig(
          minimalInput({
            auth: minimalAuthInput({ thirdParty: [{ provider: "workos", requiredField: "" }] }),
          }),
        ),
      ).toThrow("Invalid config: auth.third_party.workos is enabled but without a issuer_url.");
    });

    it("rejects more than one third_party provider enabled at once", () => {
      expect(() =>
        validateResolvedConfig(
          minimalInput({
            auth: minimalAuthInput({
              thirdParty: [
                { provider: "firebase", requiredField: "proj" },
                { provider: "auth0", requiredField: "tenant" },
              ],
            }),
          }),
        ),
      ).toThrow("Invalid config: Only one third_party provider allowed to be enabled at a time.");
    });

    it("does not throw when no third_party provider is enabled", () => {
      expect(() =>
        validateResolvedConfig(minimalInput({ auth: minimalAuthInput() })),
      ).not.toThrow();
    });

    it("does not throw an enabled third_party provider missing its required field when auth is disabled", () => {
      expect(() => validateResolvedConfig(minimalInput())).not.toThrow();
    });
  });

  describe("functions.*", () => {
    it("rejects a function slug Go's ValidateFunctionSlug refuses", () => {
      expect(() => validateResolvedConfig(minimalInput({ functionSlugs: ["1bad"] }))).toThrow(
        "Invalid Function name: 1bad.",
      );
    });

    it("does not throw for a valid function slug", () => {
      expect(() =>
        validateResolvedConfig(minimalInput({ functionSlugs: ["hello-world_v2"] })),
      ).not.toThrow();
    });

    it("does not throw when no functions are configured", () => {
      expect(() => validateResolvedConfig(minimalInput())).not.toThrow();
    });

    it("rejects an invalid function slug even when auth is disabled", () => {
      expect(() => validateResolvedConfig(minimalInput({ functionSlugs: ["1bad"] }))).toThrow(
        "Invalid Function name: 1bad.",
      );
    });
  });

  // The actual file reads and the disabled-skip/env-override tests stay in
  // local-config-values.unit.test.ts.
  describe("api.tls", () => {
    it("rejects cert_path set without key_path", () => {
      expect(() =>
        validateResolvedConfig(
          minimalInput({
            api: {
              enabled: true,
              port: 54321,
              tls: { enabled: true, certPath: "cert.pem", keyPath: undefined },
            },
          }),
        ),
      ).toThrow("Missing required field in config: api.tls.key_path");
    });

    it("rejects key_path set without cert_path", () => {
      expect(() =>
        validateResolvedConfig(
          minimalInput({
            api: {
              enabled: true,
              port: 54321,
              tls: { enabled: true, certPath: undefined, keyPath: "key.pem" },
            },
          }),
        ),
      ).toThrow("Missing required field in config: api.tls.cert_path");
    });
  });

  // Coverage for behavior only meaningfully testable at this shared layer (e.g. the captcha
  // enum), not moved from either caller's own suite.
  describe("Config.Validate divergence regression coverage", () => {
    it("throws the Go-parity missing-required message for db.major_version = 0 (regression for the D fix in 0c62a914)", () => {
      expect(() =>
        validateResolvedConfig({ ...minimalInput(), db: { port: 5432, majorVersion: 0 } }),
      ).toThrow("Missing required field in config: db.major_version");
    });

    it("throws Go's decode-time enum message for an invalid auth.captcha.provider, regardless of enabled", () => {
      // Unreachable through L's real flow: `@supabase/config`'s schema already narrows
      // `provider` to "hcaptcha" | "turnstile" | undefined, so an invalid value fails schema
      // decoding first. D's real TOML flow can reach this branch; its own suite covers that
      // separately. This test pins the shared function's own behavior directly.
      expect(() =>
        validateResolvedConfig(
          minimalInput({
            auth: minimalAuthInput({
              captcha: { enabled: false, provider: "not-a-real-provider", secret: undefined },
            }),
          }),
        ),
      ).toThrow(
        "failed to parse config: decoding failed due to the following error(s):\n\n'auth.captcha.provider' must be one of [hcaptcha turnstile]",
      );
    });
  });
});
