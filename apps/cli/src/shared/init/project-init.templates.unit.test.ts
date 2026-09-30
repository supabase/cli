import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Effect, FileSystem, Path } from "effect";
import { applyConfigEdits, type ConfigEdit } from "@supabase/config/internal";
import {
  INIT_GITIGNORE_TEMPLATE,
  INTELLIJ_DENO_TEMPLATE,
  VSCODE_EXTENSIONS_TEMPLATE,
  VSCODE_SETTINGS_TEMPLATE,
  renderCliConfigTemplate,
} from "./project-init.templates.ts";

function normalizeNewlines(text: string): string {
  return text.replace(/\r\n/g, "\n");
}

// Vendored copies of the Go CLI's init-template scaffold files. Dotted file
// names are de-dotted so git/tooling don't interpret the fixtures themselves.
const readVendoredTemplate = Effect.fnUntraced(function* (name: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const contents = yield* fs.readFileString(
    path.join(import.meta.dirname, "testdata/go-templates", name),
  );
  return normalizeNewlines(contents);
});

// Go's config.toml scaffold renders through text/template (`config.Eject`), so
// an action wrapping a backtick raw string — {{ `{{ .Code }}` }} in the
// source — is rendered to the literal string it quotes: `{{ .Code }}` in the
// ejected file. This is the only text/template construct emulated here; the
// "models every template action" test below fails loudly if that ever changes.
function resolveGoTemplateEscapes(template: string): string {
  return template.replace(/\{\{\s*`([^`]*)`\s*\}\}/g, "$1");
}

// Emulates what Go's config.Eject writes to disk for a fresh `supabase init` project.
const renderExpectedGoEject = readVendoredTemplate("config.toml").pipe(
  Effect.map((template) =>
    resolveGoTemplateEscapes(template)
      .replace("{{ .ProjectId }}", "demo-project")
      .replace("{{ .Experimental.OrioleDBVersion }}", "15.1.0.150")
      // supabase init always opts new projects into pg-delta; the Go template
      // renders this from a flag only set on the init path.
      .replace("{{ .Experimental.PgDeltaInitEnabled }}", "true"),
  ),
);

// The Go scaffold still describes `auto_expose_new_tables` as unset-means-
// revoked and deprecated; the native template documents unset-means-exposed
// instead, since platform projects never stopped auto-exposing new entities.
const GO_AUTO_EXPOSE_COMMENT = `# without explicit GRANTs. When unset, new entities are NOT auto-exposed, matching the new cloud
# default. Set to \`true\` to keep the legacy behaviour of auto-exposing new entities; this is
# deprecated and the field is removed on 2026-10-30 once the always-revoked behaviour is permanent.
# auto_expose_new_tables = true`;

const NATIVE_AUTO_EXPOSE_COMMENT = `# without explicit GRANTs, matching the cloud default. Set to \`false\` to require explicit GRANTs
# instead. Left unset, a fresh project falls back to \`true\`.
# auto_expose_new_tables = true`;

const renderExpectedNativeEject = renderExpectedGoEject.pipe(
  Effect.map((eject) =>
    eject
      .replace(
        '# content_path = "./templates/password_changed_notification.html"',
        '# content_path = "./supabase/templates/password_changed_notification.html"',
      )
      .replace(GO_AUTO_EXPOSE_COMMENT, NATIVE_AUTO_EXPOSE_COMMENT),
  ),
);

describe("project init templates", () => {
  it.effect("renders config.toml with the native notification content_path base", () =>
    Effect.gen(function* () {
      expect(normalizeNewlines(renderCliConfigTemplate("demo-project", true))).toBe(
        yield* renderExpectedNativeEject,
      );
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.effect(
    "models every template action in the Go scaffold, so parity cannot silently drift",
    () =>
      Effect.gen(function* () {
        // Anything beyond the GoTrue OTP placeholder means the Go template gained
        // a construct this suite doesn't emulate; update `resolveGoTemplateEscapes`
        // to match before shipping.
        const unresolvedActions = (yield* renderExpectedGoEject).match(/\{\{[^}]*\}\}/g) ?? [];
        expect(new Set(unresolvedActions)).toEqual(new Set(["{{ .Code }}"]));
      }).pipe(Effect.provide(BunServices.layer)),
  );

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

  it("opts the experimental stack template into stack=true without default listener ports", () => {
    const rendered = renderCliConfigTemplate("demo-project", false, true);
    expect(rendered).toMatch(
      /\[experimental\]\n# Use the new local stack backend for start, stop, and status, and for --local targets of db, migration, test db, gen types, inspect, and pull.\nstack = true\n/,
    );
    expect(rendered).toContain("# smtp_port = 54325");
    expect(rendered).toContain("[experimental.pgdelta]\nenabled = true");
    expect(rendered).not.toMatch(/^port = 54321$/m);
    expect(rendered).not.toMatch(/^port = 54322$/m);
    expect(rendered).not.toMatch(/^shadow_port = 54320$/m);
    expect(rendered).not.toMatch(/^port = 54329$/m);
    expect(rendered).not.toMatch(/^port = 54323$/m);
    expect(rendered).not.toMatch(/^port = 54324$/m);
    expect(rendered).not.toMatch(/^inspector_port = 8083$/m);
    expect(rendered).not.toMatch(/^port = 54327$/m);
  });

  it.effect("matches the Go .gitignore scaffold", () =>
    Effect.gen(function* () {
      expect(INIT_GITIGNORE_TEMPLATE).toBe(yield* readVendoredTemplate("gitignore"));
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.effect("matches the Go VS Code extensions scaffold", () =>
    Effect.gen(function* () {
      expect(VSCODE_EXTENSIONS_TEMPLATE).toBe(
        yield* readVendoredTemplate("vscode-extensions.json.golden"),
      );
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.effect("matches the Go VS Code settings scaffold", () =>
    Effect.gen(function* () {
      expect(VSCODE_SETTINGS_TEMPLATE).toBe(
        yield* readVendoredTemplate("vscode-settings.json.golden"),
      );
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.effect("matches the Go IntelliJ scaffold", () =>
    Effect.gen(function* () {
      expect(INTELLIJ_DENO_TEMPLATE).toBe(yield* readVendoredTemplate("idea-deno.xml"));
    }).pipe(Effect.provide(BunServices.layer)),
  );
});

// `applyConfigEdits` must edit the scaffold exactly as intended and nothing
// else; line-level diffing proves that, rather than trusting the editor's
// own report of what it touched.

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
    // Blank lines are excluded: the block insertion's trailing blank can align
    // with the file's pre-existing final blank via LCS. The tail assertions
    // below pin blank-line placement byte-for-byte instead.
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
