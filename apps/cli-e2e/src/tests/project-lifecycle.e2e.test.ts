import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, inject, test } from "vitest";
import { createHarness, exec, makeTempDir } from "@supabase/cli-test-helpers";
import { ACCESS_TOKEN, isRecording, PROJECT_REF, TARGET } from "./env.ts";
import { testBehaviour, testParity } from "./test-context.ts";

describe("init", () => {
  testBehaviour("creates supabase/config.toml and exits zero", async ({ run, workspace }) => {
    const result = await run(["init"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Finished supabase init");
    expect(existsSync(join(workspace.path, "supabase", "config.toml"))).toBe(true);
  });

  testBehaviour(
    "exits non-zero if config.toml already exists without --force",
    async ({ run, workspace }) => {
      mkdirSync(join(workspace.path, "supabase"), { recursive: true });
      writeFileSync(join(workspace.path, "supabase", "config.toml"), "# existing config\n");
      const result = await run(["init"]);
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("force");
    },
  );

  testBehaviour("exits zero with --force when config.toml exists", async ({ run, workspace }) => {
    mkdirSync(join(workspace.path, "supabase"), { recursive: true });
    writeFileSync(join(workspace.path, "supabase", "config.toml"), "# existing config\n");
    const result = await run(["init", "--force"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Finished supabase init");
    expect(existsSync(join(workspace.path, "supabase", "config.toml"))).toBe(true);
  });

  testBehaviour(
    "creates VS Code settings with --with-vscode-settings",
    async ({ run, workspace }) => {
      const result = await run(["init", "--with-vscode-settings"]);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("Generated VS Code settings");
      expect(existsSync(join(workspace.path, ".vscode", "settings.json"))).toBe(true);
    },
  );

  testBehaviour(
    "creates IntelliJ settings with --with-intellij-settings",
    async ({ run, workspace }) => {
      const result = await run(["init", "--with-intellij-settings"]);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("Generated IntelliJ settings");
      expect(existsSync(join(workspace.path, ".idea", "deno.xml"))).toBe(true);
    },
  );

  testBehaviour("includes debug output with --debug", async ({ run }) => {
    const result = await run(["init", "--debug"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Finished supabase init");
  });

  // testParity is intentionally omitted for init: the command uses os.Getwd()
  // basename as project_id when none is set, producing non-identical config.toml
  // content across the two isolated parity temp dirs (go vs ts-legacy).
});

describe("link", () => {
  // Not using testBehaviour here because the testBehaviour `run` fixture always
  // injects SUPABASE_PROJECT_ID, which the new Go CLI accepts as a substitute for
  // --project-ref in non-TTY mode, bypassing the required-flag check. A raw test
  // lets us omit projectId so the CLI correctly requires the --project-ref flag.
  test("exits non-zero without --project-ref in non-TTY", async () => {
    const serverUrl = inject("replayServerUrl") as string;
    const dir = makeTempDir("cli-e2e-link-no-ref-");
    using _ = dir;
    const harness = createHarness(TARGET, {
      apiUrl: serverUrl,
      accessToken: ACCESS_TOKEN,
      cwd: dir.path,
    });
    const result = await exec(harness, ["link"]);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("project-ref");
  });

  // The testBehaviour run fixture always injects SUPABASE_PROJECT_ID, which the
  // new Go CLI accepts in place of --project-ref, bypassing the required-flag
  // check. Link therefore proceeds to the API and succeeds.
  testBehaviour("links when only SUPABASE_PROJECT_ID is set in non-TTY", async ({ run }) => {
    const result = await run(["link"]);
    expect(result.exitCode).toBe(0);
  });

  testBehaviour("exits non-zero on 401", async ({ run, apiUrl }) => {
    await fetch(`${apiUrl}/_ctrl/error-all`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: 401, body: { message: "Invalid token" } }),
    });
    const result = await run(["link", "--project-ref", PROJECT_REF]);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("Invalid token");
  });

  testBehaviour("exits non-zero on 403", async ({ run, apiUrl }) => {
    await fetch(`${apiUrl}/_ctrl/error-all`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: 403, body: { message: "Forbidden" } }),
    });
    const result = await run(["link", "--project-ref", PROJECT_REF]);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("Forbidden");
  });

  testBehaviour("exits non-zero on 500", async ({ run, apiUrl }) => {
    await fetch(`${apiUrl}/_ctrl/error-all`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: 500, body: { message: "Internal Server Error" } }),
    });
    const result = await run(["link", "--project-ref", PROJECT_REF]);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("Internal Server Error");
  });

  // link makes concurrent Management API calls after the initial project-status and
  // api-keys calls. The concurrent service calls fail silently (non-fatal). Only
  // the first two sequential calls need fixture entries.
  testBehaviour.skipIf(isRecording)(
    "links project successfully",
    async ({ run, projectRef, workspace }) => {
      const result = await run(["link", "--project-ref", projectRef]);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("Finished supabase link");
      expect(existsSync(join(workspace.path, "supabase", ".temp", "project-ref"))).toBe(true);
    },
  );

  testBehaviour.skipIf(isRecording)(
    "--skip-pooler uses direct connection",
    async ({ run, projectRef, workspace }) => {
      const result = await run(["link", "--project-ref", projectRef, "--skip-pooler"]);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("Finished supabase link");
      expect(existsSync(join(workspace.path, "supabase", ".temp", "project-ref"))).toBe(true);
    },
  );

  testParity(["link", "--project-ref", PROJECT_REF], { failureType: "NON_AUTH" });
});

describe("unlink", () => {
  testBehaviour("exits non-zero when project not linked", async ({ run }) => {
    const result = await run(["unlink"]);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("supabase link");
  });

  // The success path (pre-populate project-ref → unlink succeeds) is omitted: the
  // ts-legacy unlink handler is a Phase 0 proxy to the Go binary, which attempts
  // a system keyring delete on exit. On Linux CI (no D-Bus session bus) the
  // keyring call returns an unhandled error and the binary exits 1. The error path
  // above already gives meaningful coverage for a proxy command.

  testParity(["unlink"]);
});
