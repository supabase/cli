import { describe, expect, test } from "vitest";

import { runSupabase } from "../../../tests/helpers/cli.ts";

describe("platform command help examples", () => {
  test("explains binary body usage with --body-file", async () => {
    const { stdout, exitCode } = await runSupabase([
      "platform",
      "projects",
      "functions",
      "create",
      "--help",
    ]);

    expect(exitCode).toBe(0);
    expect(stdout).toContain(
      "Provide request body bytes with `--body-file <path>` or `--body -` for stdin.",
    );
    expect(stdout).toContain("Request body as inline non-object content, or - for stdin");
    expect(stdout).toContain("Read raw bytes from a file.");
    expect(stdout).toContain(
      'supabase platform projects functions create --params \'{"ref":"project-ref"}\' --body-file ./body.bin',
    );
    expect(stdout).toContain(
      'cat ./body.bin | supabase platform projects functions create --params \'{"ref":"project-ref"}\' --body -',
    );
  });

  test("explains multipart binary fields with --upload", async () => {
    const { stdout, exitCode } = await runSupabase([
      "platform",
      "projects",
      "functions",
      "deploy",
      "--help",
    ]);

    expect(exitCode).toBe(0);
    expect(stdout).toContain("Provide structured multipart fields with `--json`.");
    expect(stdout).toContain(
      "Provide binary multipart fields with `--upload field=path` or `--upload field=-`.",
    );
    expect(stdout).toContain(
      "Pass structured multipart fields with `--json` and binary parts with `--upload`.",
    );
    expect(stdout).toContain("--upload file=./file-1.bin");
  });

  test("keeps urlencoded help text focused on form content", async () => {
    const { stdout, exitCode } = await runSupabase([
      "platform",
      "oauth",
      "token",
      "exchange",
      "--help",
    ]);

    expect(exitCode).toBe(0);
    expect(stdout).toContain(
      "Provide request body fields with `--json`. The CLI serializes them as urlencoded form data.",
    );
    expect(stdout).not.toContain("Provide request body bytes with `--body-file <path>`");
  });

  test("shows generated params-only examples", async () => {
    const { stdout, exitCode } = await runSupabase(["platform", "branches", "delete", "--help"]);

    expect(exitCode).toBe(0);
    expect(stdout).toContain("Pass the required path, query, or header input with `--params`.");
    expect(stdout).toContain(
      `supabase platform branches delete --params '{"branch_id_or_ref":"branch-ref"}'`,
    );
  });

  test("shows generated no-input examples", async () => {
    const { stdout, exitCode } = await runSupabase(["platform", "projects", "list", "--help"]);

    expect(exitCode).toBe(0);
    expect(stdout).toContain("Run the command with no additional input.");
    expect(stdout).toContain("supabase platform projects list");
  });
});
