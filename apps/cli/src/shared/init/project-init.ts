import { Effect, FileSystem, Path, Predicate, Schema } from "effect";
import { parseJsonc } from "@supabase/config/internal";
import { promptYesNo } from "../../command-internal/prompt-yes-no.ts";
import { sanitizeProjectId } from "../config/project-id.ts";
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

const decodeJsonObject = Schema.decodeUnknownEffect(Schema.Record(Schema.String, Schema.Unknown));

const encodePrettyJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown, { space: 2 }));

// Parses a settings file through a Schema boundary so malformed JSON surfaces
// as a typed `InitParseSettingsError` (never a fiber defect) and a
// non-object document is rejected.
function parseJsonObject(pathname: string, contents: string) {
  const parseFailure = (reason: string) =>
    new InitParseSettingsError({
      detail: `Could not parse JSON in ${pathname}: ${reason}`,
      suggestion: `Fix or remove ${pathname}, then rerun \`supabase init\`.`,
    });
  return Effect.try({
    try: () => parseJsonc(contents),
    catch: (error) => parseFailure(error instanceof Error ? error.message : String(error)),
  }).pipe(
    Effect.flatMap((value) =>
      decodeJsonObject(value).pipe(Effect.mapError((error) => parseFailure(error.message))),
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
  /** Persist `experimental.stack` and omit default stack listener ports. */
  readonly experimentalStack?: boolean;
}

// Files/directories are pinned to 0644/0755 explicitly rather than relying
// on Node's umask-masked defaults, which only coincide under the common 022.
const INIT_FILE_MODE = 0o644;
const INIT_DIR_MODE = 0o755;

function writeJsonFile(pathname: string, contents: Record<string, unknown>) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    // `contents` was just decoded from JSON, so encoding it back cannot fail.
    const json = yield* encodePrettyJson(contents).pipe(Effect.orDie);
    yield* fs.writeFileString(pathname, `${json}\n`, { mode: INIT_FILE_MODE });
  });
}

function mergeJsonObjects(
  existing: Readonly<Record<string, unknown>>,
  template: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...existing };
  for (const [key, value] of Object.entries(template)) {
    const current = merged[key];
    merged[key] =
      Predicate.isObject(current) && Predicate.isObject(value)
        ? mergeJsonObjects(current, value)
        : value;
  }
  return merged;
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

    const merged = mergeJsonObjects(
      yield* parseJsonObject(pathname, existing),
      yield* parseJsonObject(pathname, template),
    );
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
 * decide how an already-initialized project is reported. When a
 * `config.json`, `config.jsonc` or `config.toml` already exists and `force` is
 * not set it short-circuits with `created: false` and the existing file's path,
 * leaving the caller free to treat that as a hard error or a graceful no-op.
 * With `force`, the JSON files are removed once the fresh `config.toml` is
 * written, so it is the one the loader reads.
 */
export const initProject = Effect.fnUntraced(function* (options: ProjectInitOptions) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const tty = yield* Tty;
  const output = yield* Output;

  const supabaseDir = path.join(options.cwd, "supabase");
  const configTomlPath = path.join(supabaseDir, "config.toml");
  const jsonConfigPaths = ["config.json", "config.jsonc"].map((name) =>
    path.join(supabaseDir, name),
  );

  if (!options.force) {
    for (const candidate of [...jsonConfigPaths, configTomlPath]) {
      if (yield* fs.exists(candidate)) {
        return { created: false, configPath: candidate };
      }
    }
  }

  const projectId = sanitizeProjectId(path.basename(options.cwd)) || "supabase";

  yield* fs.makeDirectory(supabaseDir, { recursive: true, mode: INIT_DIR_MODE });
  yield* fs.writeFileString(
    configTomlPath,
    renderCliConfigTemplate(projectId, options.useOrioledb, options.experimentalStack === true),
    { mode: INIT_FILE_MODE },
  );
  for (const jsonConfigPath of jsonConfigPaths) {
    yield* fs.remove(jsonConfigPath, { force: true });
  }
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
