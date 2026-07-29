import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  INIT_GITIGNORE_TEMPLATE,
  INTELLIJ_DENO_TEMPLATE,
  VSCODE_EXTENSIONS_TEMPLATE,
  VSCODE_SETTINGS_TEMPLATE,
  renderProjectConfigTemplate,
} from "./project-init.templates.ts";

const here = dirname(fileURLToPath(import.meta.url));
const goCliRoot = join(here, "../../../../cli-go");

function normalizeNewlines(text: string): string {
  return text.replace(/\r\n/g, "\n");
}

function readGoTemplate(...segments: ReadonlyArray<string>): string {
  return normalizeNewlines(readFileSync(join(goCliRoot, ...segments), "utf8"));
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

describe("project init templates", () => {
  it("renders config.toml with the same content as the Go CLI ejects", () => {
    expect(normalizeNewlines(renderProjectConfigTemplate("demo-project", true))).toBe(
      renderExpectedGoEject(),
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
    const rendered = renderProjectConfigTemplate("demo-project", false);
    const otpTemplateLines = rendered.split("\n").filter((line) => line.startsWith("template = "));
    expect(otpTemplateLines).toEqual([
      'template = "Your code is {{ .Code }}"',
      'template = "Your code is {{ .Code }}"',
    ]);
  });

  it("enables pg-delta by default in the generated config", () => {
    const rendered = renderProjectConfigTemplate("demo-project", false);
    expect(rendered).toContain("[experimental.pgdelta]\nenabled = true");
  });

  it("matches the Go .gitignore scaffold", () => {
    expect(INIT_GITIGNORE_TEMPLATE).toBe(
      readGoTemplate("internal", "init", "templates", ".gitignore"),
    );
  });

  it("matches the Go VS Code extensions scaffold", () => {
    expect(VSCODE_EXTENSIONS_TEMPLATE).toBe(
      readGoTemplate("internal", "init", "templates", ".vscode", "extensions.json"),
    );
  });

  it("matches the Go VS Code settings scaffold", () => {
    expect(VSCODE_SETTINGS_TEMPLATE).toBe(
      readGoTemplate("internal", "init", "templates", ".vscode", "settings.json"),
    );
  });

  it("matches the Go IntelliJ scaffold", () => {
    expect(INTELLIJ_DENO_TEMPLATE).toBe(
      readGoTemplate("internal", "init", "templates", ".idea", "deno.xml"),
    );
  });
});
