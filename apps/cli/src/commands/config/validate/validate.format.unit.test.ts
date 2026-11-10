import { describe, expect, it } from "vitest";

import {
  PLAIN_REPORT_STYLE,
  type ValidateReport,
  validateJsonPayload,
  validateReport,
  validateSummaryMessage,
} from "./validate.format.ts";
import type { ConfigProblem } from "./validate.model.ts";

const SOURCE = [
  'project_id = "demo"',
  "[api]",
  "prot = 1",
  'secret = "hunter2"',
  "port = 5",
  'cfg = { token = "hunter2", n = "bad" }',
].join("\n");

const problem = (fields: Partial<ConfigProblem>): ConfigProblem => ({
  code: "invalid_type",
  severity: "error",
  reason: "bad",
  showValue: false,
  ...fields,
});

const report = (problems: ReadonlyArray<ConfigProblem>, extra: Partial<ValidateReport> = {}) =>
  ({
    file: "supabase/config.toml",
    format: "toml",
    source: SOURCE,
    remotes: [],
    skippedRemotes: [],
    problems,
    ...extra,
  }) satisfies ValidateReport;

const render = (problems: ReadonlyArray<ConfigProblem>, extra: Partial<ValidateReport> = {}) =>
  validateReport(report(problems, extra), PLAIN_REPORT_STYLE);

describe("validateReport", () => {
  it("draws a frame with the previous line, a caret under the span and the help line", () => {
    const text = render([
      problem({
        code: "unknown_key",
        path: "api.prot",
        reason: "unknown key",
        help: "did you mean `port`?",
        location: { line: 3, column: 1, endColumn: 5, exact: true },
      }),
    ]);

    expect(text).toBe(
      [
        "  ✗ api.prot  unknown key",
        "    supabase/config.toml:3:1",
        "    2 │ [api]",
        "  > 3 │ prot = ****",
        "      │ ^^^^",
        "    help: did you mean `port`?",
        "",
        "✗ 1 error in supabase/config.toml",
        "",
      ].join("\n"),
    );
  });

  it("masks every configured value by default, including the context line", () => {
    const text = render([
      problem({
        path: "api.port",
        location: { line: 5, column: 8, endColumn: 9, exact: true },
      }),
    ]);

    expect(text).toContain("  > 5 │ port = ****");
    expect(text).not.toContain("hunter2");
  });

  it("shows the located value only when the problem allows it, still masking siblings on the line", () => {
    const text = render([
      problem({
        path: "api.cfg.n",
        showValue: true,
        location: { line: 6, column: 32, endColumn: 37, exact: true },
      }),
    ]);

    expect(text).toContain('cfg = { token = ****, n = "bad" }');
    expect(text).not.toContain("hunter2");
  });

  it("shows a known non-secret key's value on the context line", () => {
    const text = render([
      problem({
        path: "api.cfg",
        location: { line: 6, column: 1, endColumn: 4, exact: true },
      }),
    ]);

    expect(text).toContain("5 │ port = 5");
  });

  it("masks a secret on the context line", () => {
    const text = render([
      problem({
        path: "api.port",
        location: { line: 5, column: 1, endColumn: 5, exact: true },
      }),
    ]);

    expect(text).toContain("4 │ secret = ****");
    expect(text).not.toContain("hunter2");
  });

  it("masks an unknown key's value on the context line", () => {
    const text = render([
      problem({
        path: "api.secret",
        location: { line: 4, column: 1, endColumn: 7, exact: true },
      }),
    ]);

    expect(text).toContain("3 │ prot = ****");
  });

  it("labels remote problems and lists checked and skipped remotes", () => {
    const text = render([problem({ path: "db.port", remote: "staging" })], {
      remotes: ["staging"],
      skippedRemotes: [{ name: "prod", reason: "no project id" }],
    });

    expect(text).toContain("[remote: staging]");
    expect(text).toContain("Checked remotes: staging");
    expect(text).toContain("Skipped remotes: prod (no project id)");
  });

  it("reports a valid file with a warning count", () => {
    const text = render([problem({ code: "deprecated_key", severity: "warning", path: "api.x" })]);

    expect(text).toContain("✓ supabase/config.toml is valid · 1 warning");
  });

  it("says where a stopped run ended and what to do next", () => {
    const text = render([problem({ code: "syntax" })], { stoppedAt: "syntax" });

    expect(text).toContain(
      "Stopped after the syntax check. Fix this and run supabase config validate again",
    );
  });

  it("neutralises control characters in a problem subject", () => {
    const text = render([problem({ path: "a\u001b[31mb" })]);

    expect(text).not.toContain("\u001b");
  });
});

describe("validateSummaryMessage", () => {
  it("counts only errors", () => {
    expect(validateSummaryMessage(report([]))).toBe("supabase/config.toml is valid");
    expect(
      validateSummaryMessage(report([problem({}), problem({}), problem({ severity: "warning" })])),
    ).toBe("supabase/config.toml has 2 problems");
  });
});

describe("validateJsonPayload", () => {
  it("carries keys, codes and positions but no source text", () => {
    const payload = validateJsonPayload(
      report(
        [
          problem({
            path: "db.port",
            remote: "staging",
            help: "use a port",
            location: { line: 5, column: 8, endLine: 5, endColumn: 9, exact: true },
          }),
          problem({ code: "deprecated_key", severity: "warning", path: "api.x" }),
        ],
        { remotes: ["staging"] },
      ),
    );

    expect(payload).toEqual({
      schema_version: 1,
      valid: false,
      complete: true,
      file: "supabase/config.toml",
      format: "toml",
      remotes: ["staging"],
      errors: [
        {
          code: "invalid_type",
          severity: "error",
          key: "remotes.staging.db.port",
          path: "db.port",
          remote: "staging",
          reason: "bad",
          help: "use a port",
          line: 5,
          column: 8,
          end_line: 5,
          end_column: 9,
        },
      ],
      warnings: [
        { code: "deprecated_key", severity: "warning", key: "api.x", path: "api.x", reason: "bad" },
      ],
    });
    expect(JSON.stringify(payload)).not.toContain("hunter2");
  });

  it("marks a stopped run incomplete", () => {
    const payload = validateJsonPayload(
      report([problem({ code: "syntax" })], { stoppedAt: "syntax" }),
    );

    expect(payload).toMatchObject({ valid: false, complete: false, stopped_at: "syntax" });
  });
});
