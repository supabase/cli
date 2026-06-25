import { Effect, FileSystem, Path, Schema } from "effect";
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
  readonly withVscodeSettings: boolean;
  readonly withIntellijSettings: boolean;
}

function writeJsonFile(pathname: string, contents: Record<string, unknown>) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    yield* fs.writeFileString(pathname, `${JSON.stringify(contents, null, 2)}\n`);
  });
}

function updateJsonFile(pathname: string, template: string) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;

    if (!(yield* fs.exists(pathname))) {
      yield* fs.writeFileString(pathname, template);
      return;
    }

    const existing = yield* fs.readFileString(pathname);
    if (existing.trim().length === 0) {
      yield* fs.writeFileString(pathname, template);
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

  yield* fs.makeDirectory(vscodeDir, { recursive: true });
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

  yield* fs.makeDirectory(intellijDir, { recursive: true });
  yield* fs.writeFileString(denoPath, INTELLIJ_DENO_TEMPLATE);

  if (options?.announce ?? true) {
    yield* output.raw("Generated IntelliJ settings in .idea/deno.xml.\n");
    yield* output.raw(
      "Please install the Deno plugin for IntelliJ: https://plugins.jetbrains.com/plugin/14382-deno\n",
    );
  }
});

const promptForIdeSettings = Effect.fnUntraced(function* (cwd: string) {
  const output = yield* Output;

  if (yield* output.promptConfirm("Generate VS Code settings for Deno?", { defaultValue: true })) {
    yield* writeVscodeConfig(cwd);
    return;
  }

  if (
    yield* output.promptConfirm("Generate IntelliJ IDEA settings for Deno?", {
      defaultValue: false,
    })
  ) {
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
    const prefix = existing.length > 0 ? "\n" : "";
    yield* fs.writeFileString(gitignorePath, `${existing}${prefix}${INIT_GITIGNORE_TEMPLATE}`);
    return;
  }

  yield* fs.writeFileString(gitignorePath, INIT_GITIGNORE_TEMPLATE);
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

  yield* fs.makeDirectory(supabaseDir, { recursive: true });
  yield* fs.writeFileString(
    configTomlPath,
    renderProjectConfigTemplate(projectId, options.useOrioledb),
  );
  yield* ensureSupabaseGitignore(options.cwd);

  const effectiveInteractive = options.interactive && tty.stdinIsTty && output.interactive;
  if (effectiveInteractive) {
    yield* promptForIdeSettings(options.cwd);
  }
  if (options.withVscodeSettings) {
    yield* writeVscodeConfig(options.cwd);
  }
  if (options.withIntellijSettings) {
    yield* writeIntelliJConfig(options.cwd);
  }

  return { created: true, configPath: configTomlPath };
});
