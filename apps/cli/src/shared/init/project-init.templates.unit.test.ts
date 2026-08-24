import { fileURLToPath } from "node:url";
import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Effect, FileSystem, Path } from "effect";
import {
  INIT_GITIGNORE_TEMPLATE,
  INTELLIJ_DENO_TEMPLATE,
  VSCODE_EXTENSIONS_TEMPLATE,
  VSCODE_SETTINGS_TEMPLATE,
  renderProjectConfigTemplate,
} from "./project-init.templates.ts";

const paths = Effect.runSync(
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const here = path.dirname(fileURLToPath(import.meta.url));
    return {
      goCliRoot: path.join(here, "../../../../cli-go"),
      goTemplatesFixtureDir: path.join(here, "testdata/go-templates"),
    };
  }).pipe(Effect.provide(BunServices.layer)),
);
const { goCliRoot, goTemplatesFixtureDir } = paths;
// Vendored copies of Go's `internal/init/templates/` scaffold files (deleted in
// CLI-1970; last present at commit 7b469f5b3). The dotted file names are
// de-dotted so git/tooling don't interpret the fixtures themselves.
const readUtf8 = (filePath: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    return yield* fs.readFileString(filePath);
  });

function normalizeNewlines(text: string): string {
  return text.replace(/\r\n/g, "\n");
}

function readGoTemplate(...segments: ReadonlyArray<string>) {
  return Effect.gen(function* () {
    const path = yield* Path.Path;
    return normalizeNewlines(yield* readUtf8(path.join(goCliRoot, ...segments)));
  });
}

function readVendoredTemplate(name: string) {
  return Effect.gen(function* () {
    const path = yield* Path.Path;
    return normalizeNewlines(yield* readUtf8(path.join(goTemplatesFixtureDir, name)));
  });
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
function renderExpectedGoEject() {
  return readGoTemplate("pkg", "config", "templates", "config.toml").pipe(
    Effect.map((template) =>
      resolveGoTemplateEscapes(template)
        .replace("{{ .ProjectId }}", "demo-project")
        .replace("{{ .Experimental.OrioleDBVersion }}", "15.1.0.150")
        // supabase init always opts new projects into pg-delta; the Go template renders
        // this from a flag set only on the init path (false when deriving defaults).
        .replace("{{ .Experimental.PgDeltaInitEnabled }}", "true"),
    ),
  );
}

function renderExpectedNativeEject() {
  return renderExpectedGoEject().pipe(
    Effect.map((template) =>
      template.replace(
        '# content_path = "./templates/password_changed_notification.html"',
        '# content_path = "./supabase/templates/password_changed_notification.html"',
      ),
    ),
  );
}

describe("project init templates", () => {
  it.effect("renders config.toml with the native notification content_path base", () =>
    Effect.gen(function* () {
      expect(normalizeNewlines(renderProjectConfigTemplate("demo-project", true))).toBe(
        yield* renderExpectedNativeEject(),
      );
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.effect(
    "models every template action in the Go scaffold, so parity cannot silently drift",
    () =>
      Effect.gen(function* () {
        // After escape resolution and field substitution, the only {{ ... }} occurrences left
        // must be the GoTrue OTP placeholders quoted by the backtick escapes. Anything else
        // means the Go template gained a construct this suite does not emulate yet — update
        // resolveGoTemplateEscapes/renderExpectedGoEject to match config.Eject before shipping.
        const unresolvedActions = (yield* renderExpectedGoEject()).match(/\{\{[^}]*\}\}/g) ?? [];
        expect(new Set(unresolvedActions)).toEqual(new Set(["{{ .Code }}"]));
      }).pipe(Effect.provide(BunServices.layer)),
  );

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
