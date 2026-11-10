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
        path: ["api", "prot"],
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
        path: ["api", "port"],
        location: { line: 5, column: 8, endColumn: 9, exact: true },
      }),
    ]);

    expect(text).toContain("  > 5 │ port = ****");
    expect(text).not.toContain("hunter2");
  });

  it("shows the located value only when it is the only value on its line", () => {
    const text = render([
      problem({
        path: ["api", "cfg", "n"],
        showValue: true,
        location: { line: 6, column: 32, endColumn: 37, exact: true },
      }),
    ]);

    expect(text).toContain("cfg = { token = ****, n = **** }");
    expect(text).not.toContain("hunter2");
  });

  it("shows a located scalar that is alone on its line", () => {
    const text = render(
      [
        problem({
          path: ["api", "max_rows"],
          showValue: true,
          location: { line: 2, column: 12, endColumn: 18, exact: true },
        }),
      ],
      { source: '[api]\nmax_rows = "lots"' },
    );

    expect(text).toContain('max_rows = "lots"');
  });

  it("shows a known non-secret key's value on the context line", () => {
    const text = render([
      problem({
        path: ["api", "cfg"],
        location: { line: 6, column: 1, endColumn: 4, exact: true },
      }),
    ]);

    expect(text).toContain("5 │ port = 5");
  });

  it("masks a secret on the context line", () => {
    const text = render([
      problem({
        path: ["api", "port"],
        location: { line: 5, column: 1, endColumn: 5, exact: true },
      }),
    ]);

    expect(text).toContain("4 │ secret = ****");
    expect(text).not.toContain("hunter2");
  });

  it("masks an unknown key's value on the context line", () => {
    const text = render([
      problem({
        path: ["api", "secret"],
        location: { line: 4, column: 1, endColumn: 7, exact: true },
      }),
    ]);

    expect(text).toContain("3 │ prot = ****");
  });

  describe("multi-line secrets", () => {
    const SECRET_SOURCE = [
      "[auth.hook.send_email]",
      'secrets = """',
      "  # hunter2-do-not-print",
      '  c2VjcmV0cGFzc3dvcmQ=="""',
      "bogus = 1",
    ].join("\n");

    it("masks comment-looking and padded-base64 continuation lines on the problem's range", () => {
      const text = render(
        [
          problem({
            path: ["auth", "hook", "send_email", "secrets"],
            location: { line: 2, column: 11, endLine: 4, endColumn: 29, exact: true },
          }),
        ],
        { source: SECRET_SOURCE },
      );

      expect(text).not.toContain("hunter2");
      expect(text).not.toContain("c2Vj");
      expect(text).not.toContain("==");
      expect(text).toContain("secrets = ****");
    });

    it("masks the closing line of a multi-line secret used as the context line", () => {
      const text = render(
        [
          problem({
            path: ["auth", "hook", "send_email", "bogus"],
            location: { line: 5, column: 1, exact: true },
          }),
        ],
        { source: SECRET_SOURCE },
      );

      expect(text).not.toContain("c2Vj");
      expect(text).not.toContain("==");
    });

    it("masks every line of a multi-line array of secrets in JSON", () => {
      const text = render(
        [problem({ path: ["x"], location: { line: 2, column: 3, exact: true } })],
        {
          format: "json",
          source: '{\n  "secrets": [\n    "hunter2",\n    // note\n    "other"\n  ]\n}',
        },
      );

      expect(text).not.toContain("hunter2");
      expect(text).not.toContain("other");
    });

    it("masks every non-blank line when the source cannot be parsed", () => {
      const text = render(
        [problem({ code: "syntax", location: { line: 3, column: 1, exact: true } })],
        { source: 'secrets = """\n# hunter2-do-not-print\nhost = "x' },
      );

      expect(text).not.toContain("hunter2");
      expect(text).not.toContain("host");
    });
  });

  describe("shown values", () => {
    it("masks the nested values of an inline table at a shown location", () => {
      const source = '[api]\nmax_rows = { secret = "hunter2" }';
      const text = render(
        [
          problem({
            path: ["api", "max_rows"],
            showValue: true,
            location: { line: 2, column: 12, endColumn: 39, exact: true },
          }),
        ],
        { source },
      );

      expect(text).not.toContain("hunter2");
    });

    it("masks a table nested in a shown array", () => {
      const source = '[api]\nschemas = ["a", { secret = "hunter2" }]';
      const text = render(
        [
          problem({
            path: ["api", "schemas"],
            showValue: true,
            location: { line: 2, column: 11, endColumn: 44, exact: true },
          }),
        ],
        { source },
      );

      expect(text).not.toContain("hunter2");
    });

    it("masks a flat array even at a shown location", () => {
      const source = '[api]\nschemas = ["a", "b"]';
      const text = render(
        [
          problem({
            path: ["api", "schemas"],
            showValue: true,
            location: { line: 2, column: 11, endColumn: 21, exact: true },
          }),
        ],
        { source },
      );

      expect(text).toContain("schemas = ****");
    });

    const URL_SOURCE = [
      "[studio]",
      'api_url = "https://user:pw-secret@host.test/x?token=tok-secret#top"',
      'port = "bad"',
    ].join("\n");

    it("redacts credentials and the query string of a shown problem value", () => {
      const text = render(
        [
          problem({
            path: ["studio", "api_url"],
            showValue: true,
            location: {
              line: 2,
              column: 11,
              endColumn: (URL_SOURCE.split("\n")[1]?.length ?? 0) + 1,
              exact: true,
            },
          }),
        ],
        { source: URL_SOURCE },
      );

      expect(text).toContain('api_url = "https://****@host.test/x?****#top"');
      expect(text).not.toContain("pw-secret");
      expect(text).not.toContain("tok-secret");
    });

    it("redacts a public URL on the context line", () => {
      const text = render(
        [
          problem({
            path: ["studio", "port"],
            location: { line: 3, column: 8, endColumn: 13, exact: true },
          }),
        ],
        { source: URL_SOURCE },
      );

      expect(text).toContain('api_url = "https://****@host.test/x?****#top"');
      expect(text).not.toContain("pw-secret");
      expect(text).not.toContain("tok-secret");
    });
  });

  it("keeps the caret inside a windowed long value", () => {
    const source = `[api]\nschemas = "${"x".repeat(300)}"`;
    const text = render(
      [
        problem({
          path: ["api", "schemas"],
          showValue: true,
          location: { line: 2, column: 11, endColumn: 313, exact: true },
        }),
      ],
      { source },
    );
    const carets = text.split("\n").find((line) => line.includes("^")) ?? "";
    const frame = text.split("\n").find((line) => line.startsWith("  > 2")) ?? "";

    expect(carets.trimEnd().length).toBeLessThanOrEqual(frame.length);
  });

  it("labels remote problems and lists checked and skipped remotes", () => {
    const text = render([problem({ path: ["db", "port"], remote: "staging" })], {
      remotes: ["staging"],
      skippedRemotes: [{ name: "prod", reason: "no project id" }],
    });

    expect(text).toContain("[remote: staging]");
    expect(text).toContain("Checked remotes: staging");
    expect(text).toContain("Skipped remotes: prod (no project id)");
  });

  it("reports a valid file with a warning count", () => {
    const text = render([
      problem({ code: "deprecated_key", severity: "warning", path: ["api", "x"] }),
    ]);

    expect(text).toContain("✓ supabase/config.toml is valid · 1 warning");
  });

  it("says where a stopped run ended and what to do next", () => {
    const text = render([problem({ code: "syntax" })], { stoppedAt: "syntax" });

    expect(text).toContain(
      "Stopped after the syntax check. Fix this and run supabase config validate again",
    );
  });

  it("neutralises control characters in a problem subject", () => {
    const text = render([problem({ path: ["a\u001b[31mb"] })]);

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
            path: ["db", "port"],
            remote: "staging",
            help: "use a port",
            location: { line: 5, column: 8, endLine: 5, endColumn: 9, exact: true },
          }),
          problem({ code: "deprecated_key", severity: "warning", path: ["api", "x"] }),
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
