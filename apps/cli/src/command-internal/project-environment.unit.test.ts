import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { CliProjectEnvironment } from "@supabase/config";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { resolveProjectEnvironmentValues } from "./project-environment.ts";

let root: string;
let supabaseDir: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "supabase-project-env-"));
  supabaseDir = join(root, "supabase");
  mkdirSync(supabaseDir, { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  delete process.env["SUPABASE_ENV"];
  delete process.env["SUPABASE_PROJECT_ID"];
});

function fakeProjectEnv(
  values: Record<string, string> = {},
  sources: Record<string, "ambient" | ".env" | ".env.local"> = {},
): CliProjectEnvironment {
  return {
    paths: {
      projectRoot: root,
      supabaseDir,
      configPath: join(supabaseDir, "config.toml"),
      envPath: join(supabaseDir, ".env"),
      envLocalPath: join(supabaseDir, ".env.local"),
    },
    values,
    loadedPaths: [],
    // Defaults each value's source to "ambient" so callers don't need to spell it out.
    sources: Object.fromEntries(Object.keys(values).map((key) => [key, sources[key] ?? "ambient"])),
  };
}

describe("resolveProjectEnvironmentValues", () => {
  it("returns just the already-loaded values when no extra dotenv files exist", () => {
    const projectEnv = fakeProjectEnv({ SUPABASE_PROJECT_ID: "from-loader" });
    expect(resolveProjectEnvironmentValues(projectEnv, root)).toEqual({
      SUPABASE_PROJECT_ID: "from-loader",
    });
  });

  it("fills in a value from a project-root .env file Go's loadNestedEnv would load", () => {
    writeFileSync(join(root, ".env"), "SUPABASE_PROJECT_ID=root-env-project\n");
    const merged = resolveProjectEnvironmentValues(fakeProjectEnv(), root);
    expect(merged["SUPABASE_PROJECT_ID"]).toBe("root-env-project");
  });

  it("prefers a supabase/-dir dotenv file over the same key in a project-root file", () => {
    writeFileSync(join(supabaseDir, ".env"), "SUPABASE_PROJECT_ID=supabase-dir-project\n");
    writeFileSync(join(root, ".env"), "SUPABASE_PROJECT_ID=root-dir-project\n");
    const merged = resolveProjectEnvironmentValues(fakeProjectEnv(), root);
    expect(merged["SUPABASE_PROJECT_ID"]).toBe("supabase-dir-project");
  });

  it("lets already-resolved projectEnv.values win over anything discovered locally", () => {
    writeFileSync(join(root, ".env"), "SUPABASE_PROJECT_ID=root-env-project\n");
    const projectEnv = fakeProjectEnv({ SUPABASE_PROJECT_ID: "ambient-project" });
    const merged = resolveProjectEnvironmentValues(projectEnv, root);
    expect(merged["SUPABASE_PROJECT_ID"]).toBe("ambient-project");
  });

  it("defaults SUPABASE_ENV to development when unset", () => {
    writeFileSync(join(root, ".env.development"), "SUPABASE_PROJECT_ID=dev-project\n");
    const merged = resolveProjectEnvironmentValues(fakeProjectEnv(), root);
    expect(merged["SUPABASE_PROJECT_ID"]).toBe("dev-project");
  });

  it("selects the SUPABASE_ENV-named file over the bare .env file", () => {
    process.env["SUPABASE_ENV"] = "production";
    writeFileSync(join(root, ".env"), "SUPABASE_PROJECT_ID=bare-env-project\n");
    writeFileSync(join(root, ".env.production"), "SUPABASE_PROJECT_ID=prod-project\n");
    const merged = resolveProjectEnvironmentValues(fakeProjectEnv(), root);
    expect(merged["SUPABASE_PROJECT_ID"]).toBe("prod-project");
  });

  it("prefers the .local variant of the SUPABASE_ENV file over the non-local one", () => {
    process.env["SUPABASE_ENV"] = "production";
    writeFileSync(join(root, ".env.production"), "SUPABASE_PROJECT_ID=prod-project\n");
    writeFileSync(join(root, ".env.production.local"), "SUPABASE_PROJECT_ID=prod-local-project\n");
    const merged = resolveProjectEnvironmentValues(fakeProjectEnv(), root);
    expect(merged["SUPABASE_PROJECT_ID"]).toBe("prod-local-project");
  });

  it("skips .env.local when SUPABASE_ENV=test, matching Go's loadDefaultEnv", () => {
    process.env["SUPABASE_ENV"] = "test";
    writeFileSync(join(root, ".env.local"), "SUPABASE_PROJECT_ID=local-project\n");
    writeFileSync(join(root, ".env.test"), "SUPABASE_PROJECT_ID=test-project\n");
    const merged = resolveProjectEnvironmentValues(fakeProjectEnv(), root);
    expect(merged["SUPABASE_PROJECT_ID"]).toBe("test-project");
  });

  it("strips quotes the same way the shared dotenv parser does", () => {
    writeFileSync(join(root, ".env"), 'SUPABASE_AUTH_JWT_SECRET="a quoted value"\n');
    const merged = resolveProjectEnvironmentValues(fakeProjectEnv(), root);
    expect(merged["SUPABASE_AUTH_JWT_SECRET"]).toBe("a quoted value");
  });

  it("ignores blank lines and comments", () => {
    writeFileSync(root + "/.env", "\n# a comment\nSUPABASE_PROJECT_ID=commented-project\n");
    const merged = resolveProjectEnvironmentValues(fakeProjectEnv(), root);
    expect(merged["SUPABASE_PROJECT_ID"]).toBe("commented-project");
  });

  it("preserves a literal # in an unquoted value with no leading whitespace, matching godotenv", () => {
    writeFileSync(root + "/.env", "SUPABASE_AUTH_JWT_SECRET=long#secret\n");
    const merged = resolveProjectEnvironmentValues(fakeProjectEnv(), root);
    expect(merged["SUPABASE_AUTH_JWT_SECRET"]).toBe("long#secret");
  });

  it("still truncates an unquoted value at a whitespace-preceded inline comment", () => {
    writeFileSync(root + "/.env", "SUPABASE_PROJECT_ID=54323 # local\n");
    const merged = resolveProjectEnvironmentValues(fakeProjectEnv(), root);
    expect(merged["SUPABASE_PROJECT_ID"]).toBe("54323");
  });

  it("strips a trailing comment after a quoted value, matching godotenv", () => {
    writeFileSync(root + "/.env", 'SUPABASE_PROJECT_ID="demo" # local\n');
    const merged = resolveProjectEnvironmentValues(fakeProjectEnv(), root);
    expect(merged["SUPABASE_PROJECT_ID"]).toBe("demo");
  });

  it("accepts a colon-separated assignment, matching godotenv's YAML-style key/value form", () => {
    writeFileSync(root + "/.env", "SUPABASE_PROJECT_ID: colon-project\n");
    const merged = resolveProjectEnvironmentValues(fakeProjectEnv(), root);
    expect(merged["SUPABASE_PROJECT_ID"]).toBe("colon-project");
  });

  it("prefers an env-specific file over a same-key value projectEnv.values sourced from a bare .env file", () => {
    // Only an "ambient" source outranks the file precedence computed locally.
    process.env["SUPABASE_ENV"] = "development";
    writeFileSync(
      join(supabaseDir, ".env.development.local"),
      "SUPABASE_PROJECT_ID=env-specific-project\n",
    );
    const projectEnv = fakeProjectEnv(
      { SUPABASE_PROJECT_ID: "bare-dotenv-project" },
      { SUPABASE_PROJECT_ID: ".env" },
    );
    const merged = resolveProjectEnvironmentValues(projectEnv, root);
    expect(merged["SUPABASE_PROJECT_ID"]).toBe("env-specific-project");
  });

  it("still lets a truly ambient-sourced value win over any file", () => {
    process.env["SUPABASE_ENV"] = "development";
    writeFileSync(
      join(supabaseDir, ".env.development.local"),
      "SUPABASE_PROJECT_ID=env-specific-project\n",
    );
    const projectEnv = fakeProjectEnv(
      { SUPABASE_PROJECT_ID: "ambient-project" },
      { SUPABASE_PROJECT_ID: "ambient" },
    );
    const merged = resolveProjectEnvironmentValues(projectEnv, root);
    expect(merged["SUPABASE_PROJECT_ID"]).toBe("ambient-project");
  });

  it("throws on a malformed line, matching Go's loadEnvIfExists propagating godotenv's parse error", () => {
    writeFileSync(join(root, ".env"), "not a valid line\n");
    expect(() => resolveProjectEnvironmentValues(fakeProjectEnv(), root)).toThrow(
      /failed to parse environment file/,
    );
  });

  it("expands an unquoted $VAR reference to an earlier value in the same file", () => {
    writeFileSync(join(root, ".env"), "BASE=demo\nSUPABASE_PROJECT_ID=$BASE\n");
    const merged = resolveProjectEnvironmentValues(fakeProjectEnv(), root);
    expect(merged["SUPABASE_PROJECT_ID"]).toBe("demo");
  });

  it("expands a braced ${VAR} reference in a double-quoted value", () => {
    writeFileSync(join(root, ".env"), 'SECRET=shh\nSUPABASE_AUTH_JWT_SECRET="${SECRET}"\n');
    const merged = resolveProjectEnvironmentValues(fakeProjectEnv(), root);
    expect(merged["SUPABASE_AUTH_JWT_SECRET"]).toBe("shh");
  });

  it("does not expand variable references inside single-quoted values", () => {
    writeFileSync(join(root, ".env"), "BASE=demo\nSUPABASE_PROJECT_ID='$BASE'\n");
    const merged = resolveProjectEnvironmentValues(fakeProjectEnv(), root);
    expect(merged["SUPABASE_PROJECT_ID"]).toBe("$BASE");
  });

  it("expands an unresolved bare reference to an empty string, matching Go's map zero-value", () => {
    writeFileSync(join(root, ".env"), "SUPABASE_PROJECT_ID=$NOPE\n");
    const merged = resolveProjectEnvironmentValues(fakeProjectEnv(), root);
    expect(merged["SUPABASE_PROJECT_ID"]).toBe("");
  });

  it("expands an unresolved braced reference to an empty string, matching Go's map zero-value", () => {
    writeFileSync(join(root, ".env"), 'SUPABASE_AUTH_JWT_SECRET="${NOPE}"\n');
    const merged = resolveProjectEnvironmentValues(fakeProjectEnv(), root);
    expect(merged["SUPABASE_AUTH_JWT_SECRET"]).toBe("");
  });

  it("preserves a backslash-escaped $VAR reference as a literal, matching godotenv's escape rule", () => {
    writeFileSync(join(root, ".env"), "BASE=demo\nSUPABASE_PROJECT_ID=demo\\$BASE\n");
    const merged = resolveProjectEnvironmentValues(fakeProjectEnv(), root);
    expect(merged["SUPABASE_PROJECT_ID"]).toBe("demo$BASE");
  });

  it("preserves a backslash-escaped ${VAR} reference in a double-quoted value", () => {
    writeFileSync(join(root, ".env"), 'BASE=demo\nSUPABASE_PROJECT_ID="demo\\${BASE}"\n');
    const merged = resolveProjectEnvironmentValues(fakeProjectEnv(), root);
    expect(merged["SUPABASE_PROJECT_ID"]).toBe("demo${BASE}");
  });

  it("treats a bare trailing $ with no variable name as a literal", () => {
    writeFileSync(join(root, ".env"), "SUPABASE_PROJECT_ID=demo$\n");
    const merged = resolveProjectEnvironmentValues(fakeProjectEnv(), root);
    expect(merged["SUPABASE_PROJECT_ID"]).toBe("demo$");
  });

  it("preserves a multiline quoted value alongside an unrelated SUPABASE_* key (godotenv parity)", () => {
    // A quoted value spanning physical lines (e.g. a pasted PEM key) must not break
    // parsing of the rest of the file.
    const pem = "-----BEGIN PRIVATE KEY-----\nMIIBogIBAAJ\n-----END PRIVATE KEY-----";
    writeFileSync(
      join(root, ".env"),
      `PRIVATE_KEY="${pem}"\nSUPABASE_PROJECT_ID=multiline-safe-project\n`,
    );
    const merged = resolveProjectEnvironmentValues(fakeProjectEnv(), root);
    expect(merged["SUPABASE_PROJECT_ID"]).toBe("multiline-safe-project");
  });

  describe("when no project was found (projectEnv is null)", () => {
    // A missing config.toml must not skip dotenv loading; these cover the fallback
    // that derives `<workdir>/supabase` directly.

    it("still reads a supabase/-dir dotenv file directly under workdir", () => {
      writeFileSync(join(supabaseDir, ".env"), "SUPABASE_PROJECT_ID=fallback-project\n");
      const merged = resolveProjectEnvironmentValues(null, root);
      expect(merged["SUPABASE_PROJECT_ID"]).toBe("fallback-project");
    });

    it("still reads a project-root dotenv file directly under workdir", () => {
      writeFileSync(join(root, ".env"), "SUPABASE_PROJECT_ID=root-fallback-project\n");
      const merged = resolveProjectEnvironmentValues(null, root);
      expect(merged["SUPABASE_PROJECT_ID"]).toBe("root-fallback-project");
    });

    it("prefers the supabase/-dir file over the project-root file, same as the non-null case", () => {
      writeFileSync(join(supabaseDir, ".env"), "SUPABASE_PROJECT_ID=supabase-dir-project\n");
      writeFileSync(join(root, ".env"), "SUPABASE_PROJECT_ID=root-dir-project\n");
      const merged = resolveProjectEnvironmentValues(null, root);
      expect(merged["SUPABASE_PROJECT_ID"]).toBe("supabase-dir-project");
    });

    it("lets an ambient shell var win over a dotenv value, using process.env directly", () => {
      process.env["SUPABASE_PROJECT_ID"] = "ambient-fallback-project";
      writeFileSync(join(supabaseDir, ".env"), "SUPABASE_PROJECT_ID=dotenv-fallback-project\n");
      const merged = resolveProjectEnvironmentValues(null, root);
      expect(merged["SUPABASE_PROJECT_ID"]).toBe("ambient-fallback-project");
    });

    it("returns an empty object when workdir has no dotenv files and no ambient value", () => {
      const merged = resolveProjectEnvironmentValues(null, root);
      expect(merged["SUPABASE_PROJECT_ID"]).toBeUndefined();
    });
  });
});
