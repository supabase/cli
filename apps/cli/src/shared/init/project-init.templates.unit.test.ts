import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { applyConfigEdits, type ConfigEdit } from "@supabase/config/internal";
import {
  INIT_GITIGNORE_TEMPLATE,
  INTELLIJ_DENO_TEMPLATE,
  VSCODE_EXTENSIONS_TEMPLATE,
  VSCODE_SETTINGS_TEMPLATE,
  renderCliConfigTemplate,
} from "./project-init.templates.ts";

const here = dirname(fileURLToPath(import.meta.url));
const goCliRoot = join(here, "../../../../cli-go");
// Vendored copies of Go's `internal/init/templates/` scaffold files (deleted in
// CLI-1970; last present at commit 7b469f5b3). The dotted file names are
// de-dotted so git/tooling don't interpret the fixtures themselves.
const goTemplatesFixtureDir = join(here, "testdata/go-templates");

function normalizeNewlines(text: string): string {
  return text.replace(/\r\n/g, "\n");
}

function readGoTemplate(...segments: ReadonlyArray<string>): string {
  return normalizeNewlines(readFileSync(join(goCliRoot, ...segments), "utf8"));
}

function readVendoredTemplate(name: string): string {
  return normalizeNewlines(readFileSync(join(goTemplatesFixtureDir, name), "utf8"));
}

// Go renders its config.toml scaffold through text/template (config.Eject), so an action
// containing a backtick raw string — {{ (backtick){{ .Code }}(backtick) }} in the template
// source — is rendered to the literal string it quotes: {{ .Code }} in the ejected file.
// This is the only text/template construct emulated here beyond the substituted fields;
// the "models every template action" test below fails loudly if the Go scaffold ever
// gains a construct this suite does not resolve.
function resolveGoTemplateEscapes(template: string): string {
  return template.replace(/\{\{\s*`([^`]*)`\s*\}\}/g, "$1");
}

// Emulates what Go's config.Eject writes to disk for a fresh `supabase init` project.
function renderExpectedGoEject(): string {
  return (
    resolveGoTemplateEscapes(readGoTemplate("pkg", "config", "templates", "config.toml"))
      .replace("{{ .ProjectId }}", "demo-project")
      .replace("{{ .Experimental.OrioleDBVersion }}", "15.1.0.150")
      // supabase init always opts new projects into pg-delta; the Go template renders
      // this from a flag set only on the init path (false when deriving defaults).
      .replace("{{ .Experimental.PgDeltaInitEnabled }}", "true")
  );
}

// The residual Go scaffold still describes `auto_expose_new_tables` as unset-means-revoked and
// deprecated. Platform projects never stopped auto-exposing new entities, so the native template
// documents unset-means-exposed with `false` as the opt-out instead.
const GO_AUTO_EXPOSE_COMMENT = `# without explicit GRANTs. When unset, new entities are NOT auto-exposed, matching the new cloud
# default. Set to \`true\` to keep the legacy behaviour of auto-exposing new entities; this is
# deprecated and the field is removed on 2026-10-30 once the always-revoked behaviour is permanent.
# auto_expose_new_tables = true`;

const NATIVE_AUTO_EXPOSE_COMMENT = `# without explicit GRANTs, matching the cloud default. Set to \`false\` to require explicit GRANTs
# instead. Left unset, a fresh project falls back to \`true\`.
# auto_expose_new_tables = true`;

function renderExpectedNativeEject(): string {
  return renderExpectedGoEject()
    .replace(
      '# content_path = "./templates/password_changed_notification.html"',
      '# content_path = "./supabase/templates/password_changed_notification.html"',
    )
    .replace(GO_AUTO_EXPOSE_COMMENT, NATIVE_AUTO_EXPOSE_COMMENT);
}

describe("project init templates", () => {
  it("renders config.toml with the native notification content_path base", () => {
    expect(normalizeNewlines(renderCliConfigTemplate("demo-project", true))).toBe(
      renderExpectedNativeEject(),
    );
  });

  it("models every template action in the Go scaffold, so parity cannot silently drift", () => {
    // After escape resolution and field substitution, the only {{ ... }} occurrences left
    // must be the GoTrue OTP placeholders quoted by the backtick escapes. Anything else
    // means the Go template gained a construct this suite does not emulate yet — update
    // resolveGoTemplateEscapes/renderExpectedGoEject to match config.Eject before shipping.
    const unresolvedActions = renderExpectedGoEject().match(/\{\{[^}]*\}\}/g) ?? [];
    expect(new Set(unresolvedActions)).toEqual(new Set(["{{ .Code }}"]));
  });

  it("renders the SMS and MFA phone OTP templates as GoTrue templates, not raw Go escapes", () => {
    const rendered = renderCliConfigTemplate("demo-project", false);
    const otpTemplateLines = rendered.split("\n").filter((line) => line.startsWith("template = "));
    expect(otpTemplateLines).toEqual([
      'template = "Your code is {{ .Code }}"',
      'template = "Your code is {{ .Code }}"',
    ]);
  });

  it("enables pg-delta by default in the generated config", () => {
    const rendered = renderCliConfigTemplate("demo-project", false);
    expect(rendered).toContain("[experimental.pgdelta]\nenabled = true");
  });

  it("matches the Go .gitignore scaffold", () => {
    expect(INIT_GITIGNORE_TEMPLATE).toBe(readVendoredTemplate("gitignore"));
  });

  it("matches the Go VS Code extensions scaffold", () => {
    expect(VSCODE_EXTENSIONS_TEMPLATE).toBe(readVendoredTemplate("vscode-extensions.json.golden"));
  });

  it("matches the Go VS Code settings scaffold", () => {
    expect(VSCODE_SETTINGS_TEMPLATE).toBe(readVendoredTemplate("vscode-settings.json.golden"));
  });

  it("matches the Go IntelliJ scaffold", () => {
    expect(INTELLIJ_DENO_TEMPLATE).toBe(readVendoredTemplate("idea-deno.xml"));
  });
});

// ---------------------------------------------------------------------------
// `config pull` (CLI-2064) surgical-editor round trip: `applyConfigEdits` (`@supabase/config`)
// must edit the scaffold this module renders exactly as intended, and nothing else — line-level
// diffing is what actually proves that, rather than trusting the editor's own report of what it
// touched.
// ---------------------------------------------------------------------------

interface DiffOp {
  readonly kind: "equal" | "removed" | "added";
  readonly line: string;
}

function computeLcsLengths(
  a: ReadonlyArray<string>,
  b: ReadonlyArray<string>,
): Array<Array<number>> {
  const dp: Array<Array<number>> = Array.from({ length: a.length + 1 }, () =>
    Array.from({ length: b.length + 1 }, () => 0),
  );
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      const diag = dp[i + 1]?.[j + 1] ?? 0;
      const down = dp[i + 1]?.[j] ?? 0;
      const right = dp[i]?.[j + 1] ?? 0;
      const row = dp[i];
      if (row !== undefined) {
        row[j] = a[i] === b[j] ? diag + 1 : Math.max(down, right);
      }
    }
  }
  return dp;
}

/** Line-level Myers-style diff (LCS-backed): every line of `a` and `b` is classified as
 * `equal`, `removed` (only in `a`), or `added` (only in `b`), in document order. */
function diffLines(a: ReadonlyArray<string>, b: ReadonlyArray<string>): ReadonlyArray<DiffOp> {
  const dp = computeLcsLengths(a, b);
  const ops: Array<DiffOp> = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    const lineA = a[i];
    const lineB = b[j];
    if (lineA !== undefined && lineB !== undefined && lineA === lineB) {
      ops.push({ kind: "equal", line: lineA });
      i++;
      j++;
      continue;
    }
    const down = dp[i + 1]?.[j] ?? 0;
    const right = dp[i]?.[j + 1] ?? 0;
    if (down >= right) {
      ops.push({ kind: "removed", line: lineA ?? "" });
      i++;
    } else {
      ops.push({ kind: "added", line: lineB ?? "" });
      j++;
    }
  }
  while (i < a.length) {
    ops.push({ kind: "removed", line: a[i] ?? "" });
    i++;
  }
  while (j < b.length) {
    ops.push({ kind: "added", line: b[j] ?? "" });
    j++;
  }
  return ops;
}

describe("config pull surgical editor round trip over the rendered scaffold", () => {
  it("applies a replace, an insert into an existing table, and a new [remotes.staging] block, touching only those lines", () => {
    const source = renderCliConfigTemplate("demo", false);
    const edits: ReadonlyArray<ConfigEdit> = [
      // Replace: an already-declared scalar.
      { path: ["api", "max_rows"], value: 500 },
      // Insert: a new key into an existing table ([realtime] only declares `enabled`; the
      // header's own example is commented out, so this isn't already declared).
      { path: ["realtime", "max_header_length"], value: 8192 },
      // Insert: a brand new [remotes.staging] block, created at EOF.
      { path: ["remotes", "staging", "project_id"], value: "bbbbbbbbbbbbbbbbbbbb" },
    ];

    const outcome = applyConfigEdits(source, "toml", edits);
    if (outcome.kind !== "applied") {
      throw new Error(
        `expected the edits to apply, got a refusal: ${JSON.stringify(outcome.refusal)}`,
      );
    }

    const ops = diffLines(source.split("\n"), outcome.text.split("\n"));
    // The trailing blank line the block insertion adds can be aligned by the LCS against the
    // file's pre-existing final blank, so blank lines are excluded here; their exact placement
    // is pinned byte-for-byte by the tail assertion below instead.
    const changed = ops.filter((op) => op.kind !== "equal" && op.line !== "");

    expect(changed).toEqual([
      { kind: "removed", line: "max_rows = 1000" },
      { kind: "added", line: "max_rows = 500" },
      { kind: "added", line: "max_header_length = 8192" },
      { kind: "added", line: "[remotes.staging]" },
      { kind: "added", line: 'project_id = "bbbbbbbbbbbbbbbbbbbb"' },
    ]);
    expect(
      outcome.text.endsWith('\n\n[remotes.staging]\nproject_id = "bbbbbbbbbbbbbbbbbbbb"\n'),
    ).toBe(true);
    expect(
      outcome.text.endsWith('\n\n\n[remotes.staging]\nproject_id = "bbbbbbbbbbbbbbbbbbbb"\n'),
    ).toBe(false);
    expect(outcome.applied).toEqual([
      { path: ["api", "max_rows"], action: "replaced", createdTables: [] },
      { path: ["realtime", "max_header_length"], action: "inserted", createdTables: [] },
      {
        path: ["remotes", "staging", "project_id"],
        action: "inserted",
        createdTables: [["remotes", "staging"]],
      },
    ]);
  });
});
