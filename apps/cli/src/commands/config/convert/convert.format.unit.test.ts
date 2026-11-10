import { CliConfigConvertError } from "@supabase/config/internal";
import { describe, expect, it } from "vitest";

import { convertReport, PLAIN_REPORT_STYLE, refusalMessage } from "./convert.format.ts";

describe("convert format", () => {
  it("includes the line in refusals only when known", () => {
    const base = { reason: "parse_error", detail: "bad" } as const;
    expect(refusalMessage(new CliConfigConvertError({ ...base, sourceLine: 3 }))).toBe(
      "cannot convert supabase/config.toml at line 3: bad. supabase/config.toml was not changed.",
    );
    expect(refusalMessage(new CliConfigConvertError(base))).toBe(
      "cannot convert supabase/config.toml: bad. supabase/config.toml was not changed.",
    );
  });

  it("lists relocated comments and a VS Code failure in the report", () => {
    const report = convertReport({
      dryRun: true,
      moved: [
        { line: 3, text: "# a", anchor: ["api", "schemas"] },
        { line: 7, text: "# b", anchor: ["auth", "x"] },
      ],
      vscodeUpdated: false,
      vscodeFailure: "Could not parse JSON in .vscode/settings.json: bad",
    });

    expect(report).toContain(
      [
        "  ℹ 2 comments relocated",
        "    Comments inside multi-line values move to the line above their key.",
        "    line 3 → api.schemas  # a",
        "    line 7 → auth.x  # b",
        "",
        "  ⚠ Could not update .vscode/settings.json",
        "    Could not parse JSON in .vscode/settings.json: bad.",
        '    Add "https://supabase.com/schemas/": true under "json.schemaDownload.trustedDomains" to trust the config schema.',
      ].join("\n"),
    );
  });

  it("styles headings, markers and paths through the given style", () => {
    const tag = (name: string) => (text: string) => `<${name}>${text}</${name}>`;
    const report = convertReport(
      { dryRun: false, moved: [], vscodeUpdated: false, vscodeFailure: undefined },
      { ...PLAIN_REPORT_STYLE, green: tag("g"), red: tag("r"), code: tag("c"), bold: tag("b") },
    );

    expect(report.split("\n").slice(0, 5)).toEqual([
      "<g>✓</g> <b>Converted supabase/config.toml to supabase/config.jsonc</b>",
      "",
      "  <b>Changes</b>",
      "    <g>+</g> Created  <c>supabase/config.jsonc</c>",
      "    <r>-</r> Deleted  <c>supabase/config.toml</c>",
    ]);
  });
});
