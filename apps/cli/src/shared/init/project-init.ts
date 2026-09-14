import { Effect, FileSystem, Path, Schema } from "effect";
import { promptYesNo } from "../../command-internal/prompt-yes-no.ts";
import { Output } from "../output/output.service.ts";
import { Tty } from "../runtime/tty.service.ts";
import {
  INIT_GITIGNORE_TEMPLATE,
  INTELLIJ_DENO_TEMPLATE,
  VSCODE_EXTENSIONS_TEMPLATE,
  VSCODE_SETTINGS_TEMPLATE,
  renderCliConfigTemplate,
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

// Strips line and block comments and trailing commas while preserving
// string contents, so an existing JSONC settings file parses correctly.
function stripJsonComments(contents: string): string {
  const src = contents.replace(/^\uFEFF/, "");
  const out: Array<string> = [];
  let pendingCommaIndex = -1;
  let i = 0;
  while (i < src.length) {
    const char = src.charAt(i);

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

    if (char === "/" && src.charAt(i + 1) === "/") {
      i += 2;
      while (i < src.length && src.charAt(i) !== "\n") {
        i++;
      }
      continue;
    }

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

// Parses a settings file through a Schema boundary so malformed JSON surfaces
// as a typed `InitParseSettingsError` (never a fiber defect) and a
// non-object document is rejected.
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
   * Auto-confirms the interactive IDE-settings prompts: with `--yes`/
   * `SUPABASE_YES`, `init -i` echoes the accepted VS Code prompt to stderr
   * and writes the settings instead of blocking on a TTY. Callers without a
   * `--yes` flag pass `false`.
   */
  readonly yes: boolean;
  readonly withVscodeSettings: boolean;
  readonly withIntellijSettings: boolean;
}

// Files/directories are pinned to 0644/0755 explicitly rather than relying
// on Node's umask-masked defaults, which only coincide under the common 022.
const INIT_FILE_MODE = 0o644;
const INIT_DIR_MODE = 0o755;

function writeJsonFile(pathname: string, contents: Record<string, unknown>) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    yield* fs.writeFileString(pathname, `${JSON.stringify(contents, null, 2)}\n`, {
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

// `--yes`/`SUPABASE_YES` auto-accepts the VS Code prompt without reaching IntelliJ.
const promptForIdeSettings = Effect.fnUntraced(function* (cwd: string, yes: boolean) {
  const output = yield* Output;

  if (yield* promptYesNo(output, yes, "Generate VS Code settings for Deno?", true)) {
    yield* writeVscodeConfig(cwd);
    return;
  }

  if (yield* promptYesNo(output, yes, "Generate IntelliJ IDEA settings for Deno?", false)) {
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
    // Always prepends a line break before appending, even to an empty file,
    // producing a leading blank line in that case.
    yield* fs.writeFileString(gitignorePath, `${existing}\n${INIT_GITIGNORE_TEMPLATE}`);
    return;
  }

  // No mode here: the file already exists, and `writeFileString`'s mode only
  // applies at creation.
  yield* fs.writeFileString(gitignorePath, INIT_GITIGNORE_TEMPLATE, { mode: INIT_FILE_MODE });
});

/**
 * Scaffolds the local project files (config.toml, .gitignore, optional IDE
 * settings). This owns the mechanical filesystem work only — it does not
 * decide how an already-initialized project is reported. When
 * `config.toml` already exists and `force` is not set it short-circuits
 * with `created: false` and writes nothing, leaving the caller free to
 * treat that as a hard error or a graceful no-op.
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
    renderCliConfigTemplate(projectId, options.useOrioledb),
    { mode: INIT_FILE_MODE },
  );
  yield* ensureSupabaseGitignore(options.cwd);

  // Requires text mode (json/stream-json stay payload-only and never scaffold
  // IDE settings as an undisclosed side effect) and an interactive stdout,
  // since clack renders its prompt UI there. `yes` lifts the stdout
  // requirement: no prompt renders when the answer is auto-confirmed, so
  // `init -i --yes` with a piped stdout still writes the VS Code settings.
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
