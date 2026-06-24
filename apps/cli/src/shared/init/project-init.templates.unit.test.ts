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

describe("project init templates", () => {
  it("renders config.toml with the same content as the Go scaffold", () => {
    const expected = readGoTemplate("pkg", "config", "templates", "config.toml")
      .replace("{{ .ProjectId }}", "demo-project")
      .replace("{{ .Experimental.OrioleDBVersion }}", "15.1.0.150")
      // supabase init always opts new projects into pg-delta; the Go template renders
      // this from a flag set only on the init path (false when deriving defaults).
      .replace("{{ .Experimental.PgDeltaInitEnabled }}", "true");

    expect(normalizeNewlines(renderProjectConfigTemplate("demo-project", true))).toBe(expected);
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
