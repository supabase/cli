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

function fakeProjectEnv(values: Record<string, string> = {}): ProjectEnvironment {
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
    sources: {},
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
});
