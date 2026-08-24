import { Effect, FileSystem, Formatter, Path, Schema } from "effect";
import { legacyPromptYesNo } from "../legacy/legacy-prompt-yes-no.ts";
import { Output } from "../output/output.service.ts";
import { Tty } from "../runtime/tty.service.ts";
import {
  INIT_GITIGNORE_TEMPLATE,
  INTELLIJ_DENO_TEMPLATE,
  VSCODE_EXTENSIONS_TEMPLATE,
  VSCODE_SETTINGS_TEMPLATE,
  renderProjectConfigTemplate,
} from "./project-init.templates.ts";
import { InitParseSettingsError } from "./project-init.errors.ts";

const invalidProjectId = /[^a-zA-Z0-9_.-]+/g;
const maxProjectIdLength = 40;

function truncateText(text: string, maxLength: number): string {
  return text.length > maxLength ? text.slice(0, maxLength) : text;
}

function sanitizeProjectId(src: string): string {
  const sanitized = src.replaceAll(invalidProjectId, "_").replace(/^[_.-]+/, "");
  return truncateText(sanitized, maxProjectIdLength);
}

// Mirrors Go's `jsonc.ToJSONInPlace` (github.com/tidwall/jsonc): strips line and
// block comments and trailing commas while preserving string contents, so an
// existing JSONC settings file parses exactly as it does in the Go CLI.
function stripJsonComments(contents: string): string {
  const src = contents.replace(/^\uFEFF/, "");
  const out: Array<string> = [];
  let pendingCommaIndex = -1;
  let i = 0;
  while (i < src.length) {
    const char = src.charAt(i);

    // String literal \u2014 copy verbatim, honoring escape sequences.
    if (char === '"') {
      pendingCommaIndex = -1;
      out.push(char);
      i++;
      while (i < src.length) {
        const stringChar = src.charAt(i);
        out.push(stringChar);
        i++;
        if (stringChar === "\\") {
          if (i < src.length) {
            out.push(src.charAt(i));
            i++;
          }
        } else if (stringChar === '"') {
          break;
        }
      }
      continue;
    }

    // Line comment.
    if (char === "/" && src.charAt(i + 1) === "/") {
      i += 2;
      while (i < src.length && src.charAt(i) !== "\n") {
        i++;
      }
      continue;
    }

    // Block comment.
    if (char === "/" && src.charAt(i + 1) === "*") {
      i += 2;
      while (i < src.length && !(src.charAt(i) === "*" && src.charAt(i + 1) === "/")) {
        i++;
      }
      i += 2;
      continue;
    }

    // A comma is "trailing" if the next significant token is a closing brace or
    // bracket; drop it in that case to match jsonc's trailing-comma handling.
    if (char === ",") {
      pendingCommaIndex = out.length;
      out.push(char);
      i++;
      continue;
    }

    if (char === "}" || char === "]") {
      if (pendingCommaIndex >= 0) {
        out[pendingCommaIndex] = "";
        pendingCommaIndex = -1;
      }
      out.push(char);
      i++;
      continue;
    }

    if (char === " " || char === "\t" || char === "\n" || char === "\r") {
      out.push(char);
      i++;
      continue;
    }

    pendingCommaIndex = -1;
    out.push(char);
    i++;
  }
  return out.join("");
}

const decodeJsonObject = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
);

// Parses a settings file through a Schema boundary so malformed JSON surfaces as
// a typed `InitParseSettingsError` (recoverable, never a fiber defect) and a
// non-object document is rejected \u2014 matching Go's `json.Decoder` into a map.
function parseJsonObject(pathname: string, contents: string) {
  return decodeJsonObject(stripJsonComments(contents)).pipe(
    Effect.mapError(
      (error) =>
        new InitParseSettingsError({
          detail: `Could not parse JSON in ${pathname}: ${error.message}`,
          suggestion: `Fix or remove ${pathname}, then rerun \`supabase init\`.`,
        }),
    ),
  );
}

export interface ProjectInitOptions {
  readonly cwd: string;
  readonly force: boolean;
  readonly useOrioledb: boolean;
  readonly interactive: boolean;
  /**
   * Auto-confirms the interactive IDE-settings prompts, mirroring Go's
   * `viper.GetBool("YES")` branch inside `PromptYesNo` (`console.go:70-72`):
   * with `--yes`/`SUPABASE_YES`, `init -i` echoes the accepted VS Code prompt
   * to stderr and writes the settings instead of blocking on a TTY (CLI-1974).
   * The next shell exposes no `--yes` on init and always passes `false`.
   */
  readonly yes: boolean;
  readonly withVscodeSettings: boolean;
  readonly withIntellijSettings: boolean;
}

// Go pins every init-scaffolded file to 0644 and every directory to 0755
// (`internal/init/init.go:89,121,138,151,166` via `utils.WriteFile`/
// `MkdirIfNotExistFS`, `internal/utils/misc.go:273,281-284`; config.toml at
// `internal/utils/config.go:234,243`). Node's umask-masked defaults coincide
// under the common `022`, but pin explicitly to match Go under any umask.
const INIT_FILE_MODE = 0o644;
const INIT_DIR_MODE = 0o755;

function writeJsonFile(pathname: string, contents: Record<string, unknown>) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    yield* fs.writeFileString(pathname, `${Formatter.formatJson(contents, { space: 2 })}\n`, {
      mode: INIT_FILE_MODE,
    });
  });
}

function updateJsonFile(pathname: string, template: string) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;

    if (!(yield* fs.exists(pathname))) {
      yield* fs.writeFileString(pathname, template, { mode: INIT_FILE_MODE });
      return;
    }

    const existing = yield* fs.readFileString(pathname);
    if (existing.trim().length === 0) {
      yield* fs.writeFileString(pathname, template, { mode: INIT_FILE_MODE });
      return;
    }

    const merged = {
      ...(yield* parseJsonObject(pathname, existing)),
      ...(yield* parseJsonObject(pathname, template)),
    };
    yield* writeJsonFile(pathname, merged);
  });
}

export const writeVscodeConfig = Effect.fnUntraced(function* (
  cwd: string,
  options?: { readonly announce?: boolean },
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const output = yield* Output;

  const vscodeDir = path.join(cwd, ".vscode");
  const extensionsPath = path.join(vscodeDir, "extensions.json");
  const settingsPath = path.join(vscodeDir, "settings.json");

  yield* fs.makeDirectory(vscodeDir, { recursive: true, mode: INIT_DIR_MODE });
  yield* updateJsonFile(extensionsPath, VSCODE_EXTENSIONS_TEMPLATE);
  yield* updateJsonFile(settingsPath, VSCODE_SETTINGS_TEMPLATE);

  if (options?.announce ?? true) {
    yield* output.raw("Generated VS Code settings in .vscode/settings.json.\n");
    yield* output.raw(
      "Please install the Deno extension for VS Code: https://marketplace.visualstudio.com/items?itemName=denoland.vscode-deno\n",
    );
  }
});

export const writeIntelliJConfig = Effect.fnUntraced(function* (
  cwd: string,
  options?: { readonly announce?: boolean },
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const output = yield* Output;

  const intellijDir = path.join(cwd, ".idea");
  const denoPath = path.join(intellijDir, "deno.xml");

  yield* fs.makeDirectory(intellijDir, { recursive: true, mode: INIT_DIR_MODE });
  yield* fs.writeFileString(denoPath, INTELLIJ_DENO_TEMPLATE, { mode: INIT_FILE_MODE });

  if (options?.announce ?? true) {
    yield* output.raw("Generated IntelliJ settings in .idea/deno.xml.\n");
    yield* output.raw(
      "Please install the Deno plugin for IntelliJ: https://plugins.jetbrains.com/plugin/14382-deno\n",
    );
  }
});

// Mirrors Go's `PromptForIDESettings` (`apps/cli-go/internal/init/init.go:61-75`,
// deleted in CLI-1970; last present at commit 7b469f5b3):
// both questions go through `PromptYesNo`, so `--yes`/`SUPABASE_YES` auto-accepts
// the VS Code prompt with the `[Y/n] y` stderr echo and never reaches the
// IntelliJ one — Go returns after writing the VS Code settings (CLI-1974).
const promptForIdeSettings = Effect.fnUntraced(function* (cwd: string, yes: boolean) {
  const output = yield* Output;

  if (yield* legacyPromptYesNo(output, yes, "Generate VS Code settings for Deno?", true)) {
    yield* writeVscodeConfig(cwd);
    return;
  }

  if (yield* legacyPromptYesNo(output, yes, "Generate IntelliJ IDEA settings for Deno?", false)) {
    yield* writeIntelliJConfig(cwd);
  }
});

const isInGitRepo = Effect.fnUntraced(function* (cwd: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  for (let current = cwd; ; current = path.dirname(current)) {
    if (yield* fs.exists(path.join(current, ".git"))) {
      return true;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return false;
    }
  }
});

const ensureSupabaseGitignore = Effect.fnUntraced(function* (cwd: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  if (!(yield* isInGitRepo(cwd))) {
    return;
  }

  const gitignorePath = path.join(cwd, "supabase", ".gitignore");

  if (yield* fs.exists(gitignorePath)) {
    const existing = yield* fs.readFileString(gitignorePath);
    if (existing.includes(INIT_GITIGNORE_TEMPLATE)) {
      return;
    }
    // Go always prepends a line break when appending to an existing file, even
    // an empty one (`apps/cli-go/internal/init/init.go:80-96`, deleted in
    // CLI-1970; last present at commit 7b469f5b3: the `err == nil`
    // branch of `FileContainsBytes` covers empty files too).
    yield* fs.writeFileString(gitignorePath, `${existing}\n${INIT_GITIGNORE_TEMPLATE}`);
    return;
  }

  // The append branch above deliberately passes no mode: the file already
  // exists there, and `writeFile`'s mode only applies at creation (as does
  // Go's `OpenFile(..., os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0644)`).
  yield* fs.writeFileString(gitignorePath, INIT_GITIGNORE_TEMPLATE, { mode: INIT_FILE_MODE });
});

/**
 * Scaffolds the local project files (config.toml, .gitignore, optional IDE
 * settings). This owns the mechanical filesystem work only — it does not decide
 * how an already-initialized project is reported. When `config.toml` already
 * exists and `force` is not set it short-circuits with `created: false` and
 * writes nothing, leaving each shell free to treat that as a hard error (legacy
 * Go parity) or a graceful no-op (next).
 */
export const initProject = Effect.fnUntraced(function* (options: ProjectInitOptions) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const tty = yield* Tty;
  const output = yield* Output;

  const supabaseDir = path.join(options.cwd, "supabase");
  const configTomlPath = path.join(supabaseDir, "config.toml");
  const existingToml = yield* fs.exists(configTomlPath);

  if (existingToml && !options.force) {
    return { created: false, configPath: configTomlPath };
  }

  const projectId = sanitizeProjectId(path.basename(options.cwd)) || "supabase";

  yield* fs.makeDirectory(supabaseDir, { recursive: true, mode: INIT_DIR_MODE });
  yield* fs.writeFileString(
    configTomlPath,
    renderProjectConfigTemplate(projectId, options.useOrioledb),
    { mode: INIT_FILE_MODE },
  );
  yield* ensureSupabaseGitignore(options.cwd);

  // Go gates the IDE prompts on `-i` plus a TTY stdin only (`cmd/init.go:40`).
  // TS additionally requires text mode (json/stream-json runs stay payload-only
  // and never scaffold IDE settings as an undisclosed side effect) and — because
  // clack renders its prompt UI on stdout, unlike Go's stderr prompts — an
  // interactive stdout. `yes` lifts the stdout requirement: no clack prompt is
  // rendered when the answer is auto-confirmed (the `[Y/n] y` echo goes to
  // stderr), so `init -i --yes` with a piped stdout writes the VS Code settings
  // exactly like Go (CLI-1974).
  const effectiveInteractive =
    options.interactive &&
    tty.stdinIsTty &&
    output.format === "text" &&
    (output.interactive || options.yes);
  if (effectiveInteractive) {
    yield* promptForIdeSettings(options.cwd, options.yes);
  }
  if (options.withVscodeSettings) {
    yield* writeVscodeConfig(options.cwd);
  }
  if (options.withIntellijSettings) {
    yield* writeIntelliJConfig(options.cwd);
  }

  return { created: true, configPath: configTomlPath };
});
