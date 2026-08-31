import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
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
