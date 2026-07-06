import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ProjectEnvironment } from "@supabase/config";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { legacyResolveProjectEnvironmentValues } from "./legacy-project-environment.ts";

let root: string;
let supabaseDir: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "supabase-legacy-project-env-"));
  supabaseDir = join(root, "supabase");
  mkdirSync(supabaseDir, { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  delete process.env["SUPABASE_ENV"];
});

function fakeProjectEnv(
  values: Record<string, string> = {},
  sources: Record<string, "ambient" | ".env" | ".env.local"> = {},
): ProjectEnvironment {
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
    // Default every given value to "ambient" unless the caller says otherwise —
    // matches how most tests use this helper (representing an already-resolved,
    // highest-precedence value) without forcing every call site to spell it out.
    sources: Object.fromEntries(Object.keys(values).map((key) => [key, sources[key] ?? "ambient"])),
  };
}

describe("legacyResolveProjectEnvironmentValues", () => {
  it("returns undefined when no project was found", () => {
    expect(legacyResolveProjectEnvironmentValues(null)).toBeUndefined();
  });

  it("returns just the already-loaded values when no extra dotenv files exist", () => {
    const projectEnv = fakeProjectEnv({ SUPABASE_PROJECT_ID: "from-loader" });
    expect(legacyResolveProjectEnvironmentValues(projectEnv)).toEqual({
      SUPABASE_PROJECT_ID: "from-loader",
    });
  });

  it("fills in a value from a project-root .env file Go's loadNestedEnv would load", () => {
    writeFileSync(join(root, ".env"), "SUPABASE_PROJECT_ID=root-env-project\n");
    const merged = legacyResolveProjectEnvironmentValues(fakeProjectEnv());
    expect(merged?.["SUPABASE_PROJECT_ID"]).toBe("root-env-project");
  });

  it("prefers a supabase/-dir dotenv file over the same key in a project-root file", () => {
    writeFileSync(join(supabaseDir, ".env"), "SUPABASE_PROJECT_ID=supabase-dir-project\n");
    writeFileSync(join(root, ".env"), "SUPABASE_PROJECT_ID=root-dir-project\n");
    const merged = legacyResolveProjectEnvironmentValues(fakeProjectEnv());
    expect(merged?.["SUPABASE_PROJECT_ID"]).toBe("supabase-dir-project");
  });

  it("lets already-resolved projectEnv.values win over anything discovered locally", () => {
    // `projectEnv.values` already reflects loadProjectEnvironment's correct
    // ambient-wins-over-supabase/.env(.local) result; a redundant root .env
    // entry for the same key must never override it.
    writeFileSync(join(root, ".env"), "SUPABASE_PROJECT_ID=root-env-project\n");
    const projectEnv = fakeProjectEnv({ SUPABASE_PROJECT_ID: "ambient-project" });
    const merged = legacyResolveProjectEnvironmentValues(projectEnv);
    expect(merged?.["SUPABASE_PROJECT_ID"]).toBe("ambient-project");
  });

  it("defaults SUPABASE_ENV to development when unset", () => {
    writeFileSync(join(root, ".env.development"), "SUPABASE_PROJECT_ID=dev-project\n");
    const merged = legacyResolveProjectEnvironmentValues(fakeProjectEnv());
    expect(merged?.["SUPABASE_PROJECT_ID"]).toBe("dev-project");
  });

  it("selects the SUPABASE_ENV-named file over the bare .env file", () => {
    process.env["SUPABASE_ENV"] = "production";
    writeFileSync(join(root, ".env"), "SUPABASE_PROJECT_ID=bare-env-project\n");
    writeFileSync(join(root, ".env.production"), "SUPABASE_PROJECT_ID=prod-project\n");
    const merged = legacyResolveProjectEnvironmentValues(fakeProjectEnv());
    expect(merged?.["SUPABASE_PROJECT_ID"]).toBe("prod-project");
  });

  it("prefers the .local variant of the SUPABASE_ENV file over the non-local one", () => {
    process.env["SUPABASE_ENV"] = "production";
    writeFileSync(join(root, ".env.production"), "SUPABASE_PROJECT_ID=prod-project\n");
    writeFileSync(join(root, ".env.production.local"), "SUPABASE_PROJECT_ID=prod-local-project\n");
    const merged = legacyResolveProjectEnvironmentValues(fakeProjectEnv());
    expect(merged?.["SUPABASE_PROJECT_ID"]).toBe("prod-local-project");
  });

  it("skips .env.local when SUPABASE_ENV=test, matching Go's loadDefaultEnv", () => {
    process.env["SUPABASE_ENV"] = "test";
    writeFileSync(join(root, ".env.local"), "SUPABASE_PROJECT_ID=local-project\n");
    writeFileSync(join(root, ".env.test"), "SUPABASE_PROJECT_ID=test-project\n");
    const merged = legacyResolveProjectEnvironmentValues(fakeProjectEnv());
    expect(merged?.["SUPABASE_PROJECT_ID"]).toBe("test-project");
  });

  it("strips quotes the same way the shared dotenv parser does", () => {
    writeFileSync(join(root, ".env"), 'SUPABASE_AUTH_JWT_SECRET="a quoted value"\n');
    const merged = legacyResolveProjectEnvironmentValues(fakeProjectEnv());
    expect(merged?.["SUPABASE_AUTH_JWT_SECRET"]).toBe("a quoted value");
  });

  it("ignores blank lines and comments", () => {
    writeFileSync(root + "/.env", "\n# a comment\nSUPABASE_PROJECT_ID=commented-project\n");
    const merged = legacyResolveProjectEnvironmentValues(fakeProjectEnv());
    expect(merged?.["SUPABASE_PROJECT_ID"]).toBe("commented-project");
  });

  it("preserves a literal # in an unquoted value with no leading whitespace, matching godotenv", () => {
    // godotenv only starts an inline comment at a `#` preceded by whitespace
    // (`godotenv@v1.5.1/parser.go:144-153`); `foo#bar` keeps the `#` verbatim.
    writeFileSync(root + "/.env", "SUPABASE_AUTH_JWT_SECRET=long#secret\n");
    const merged = legacyResolveProjectEnvironmentValues(fakeProjectEnv());
    expect(merged?.["SUPABASE_AUTH_JWT_SECRET"]).toBe("long#secret");
  });

  it("still truncates an unquoted value at a whitespace-preceded inline comment", () => {
    writeFileSync(root + "/.env", "SUPABASE_PROJECT_ID=54323 # local\n");
    const merged = legacyResolveProjectEnvironmentValues(fakeProjectEnv());
    expect(merged?.["SUPABASE_PROJECT_ID"]).toBe("54323");
  });

  it("strips a trailing comment after a quoted value, matching godotenv", () => {
    // godotenv's `extractVarValue` locates the quoted span by scanning forward for the
    // closing quote (`godotenv@v1.5.1/parser.go:160-180`) and discards anything after
    // it as a comment — the value is `demo`, not the literal `"demo"` a check that
    // requires the whole trimmed remainder to end with a quote would produce.
    writeFileSync(root + "/.env", 'SUPABASE_PROJECT_ID="demo" # local\n');
    const merged = legacyResolveProjectEnvironmentValues(fakeProjectEnv());
    expect(merged?.["SUPABASE_PROJECT_ID"]).toBe("demo");
  });

  it("accepts a colon-separated assignment, matching godotenv's YAML-style key/value form", () => {
    // godotenv's `locateKeyName` treats `=` and `:` as interchangeable separators
    // (`godotenv@v1.5.1/parser.go:90-95`), and the repo's other dotenv parser
    // (`packages/config/src/project.ts`'s `parseDotEnv`) already accepts both.
    writeFileSync(root + "/.env", "SUPABASE_PROJECT_ID: colon-project\n");
    const merged = legacyResolveProjectEnvironmentValues(fakeProjectEnv());
    expect(merged?.["SUPABASE_PROJECT_ID"]).toBe("colon-project");
  });

  it("prefers an env-specific file over a same-key value projectEnv.values sourced from a bare .env file", () => {
    // `projectEnv.values` has no notion of SUPABASE_ENV-selected filenames, so
    // a key it resolved from a plain supabase/.env file is NOT necessarily
    // higher Go precedence than a same-named key from `.env.<env>.local` —
    // only an "ambient" source outranks the file precedence computed locally.
    process.env["SUPABASE_ENV"] = "development";
    writeFileSync(
      join(supabaseDir, ".env.development.local"),
      "SUPABASE_PROJECT_ID=env-specific-project\n",
    );
    const projectEnv = fakeProjectEnv(
      { SUPABASE_PROJECT_ID: "bare-dotenv-project" },
      { SUPABASE_PROJECT_ID: ".env" },
    );
    const merged = legacyResolveProjectEnvironmentValues(projectEnv);
    expect(merged?.["SUPABASE_PROJECT_ID"]).toBe("env-specific-project");
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
    const merged = legacyResolveProjectEnvironmentValues(projectEnv);
    expect(merged?.["SUPABASE_PROJECT_ID"]).toBe("ambient-project");
  });

  it("throws on a malformed line, matching Go's loadEnvIfExists propagating godotenv's parse error", () => {
    writeFileSync(join(root, ".env"), "not a valid line\n");
    expect(() => legacyResolveProjectEnvironmentValues(fakeProjectEnv())).toThrow(
      /failed to parse environment file/,
    );
  });

  it("expands an unquoted $VAR reference to an earlier value in the same file", () => {
    // godotenv expands unquoted/double-quoted references while loading
    // (`godotenv@v1.5.1/parser.go:157`), so a later key can reuse an earlier one.
    writeFileSync(join(root, ".env"), "BASE=demo\nSUPABASE_PROJECT_ID=$BASE\n");
    const merged = legacyResolveProjectEnvironmentValues(fakeProjectEnv());
    expect(merged?.["SUPABASE_PROJECT_ID"]).toBe("demo");
  });

  it("expands a braced ${VAR} reference in a double-quoted value", () => {
    writeFileSync(join(root, ".env"), 'SECRET=shh\nSUPABASE_AUTH_JWT_SECRET="${SECRET}"\n');
    const merged = legacyResolveProjectEnvironmentValues(fakeProjectEnv());
    expect(merged?.["SUPABASE_AUTH_JWT_SECRET"]).toBe("shh");
  });

  it("does not expand variable references inside single-quoted values", () => {
    // godotenv never calls expandVariables for single-quoted values
    // (`parser.go:172-173`) — they stay byte-literal.
    writeFileSync(join(root, ".env"), "BASE=demo\nSUPABASE_PROJECT_ID='$BASE'\n");
    const merged = legacyResolveProjectEnvironmentValues(fakeProjectEnv());
    expect(merged?.["SUPABASE_PROJECT_ID"]).toBe("$BASE");
  });

  it("expands an unresolved reference to an empty string, matching Go's map zero-value", () => {
    writeFileSync(join(root, ".env"), "SUPABASE_PROJECT_ID=$NOPE\n");
    const merged = legacyResolveProjectEnvironmentValues(fakeProjectEnv());
    expect(merged?.["SUPABASE_PROJECT_ID"]).toBe("");
  });
});
