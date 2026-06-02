import { Effect, FileSystem, Path } from "effect";
import { Output } from "../output/output.service.ts";
import { Tty } from "../runtime/tty.service.ts";
import {
  INIT_GITIGNORE_TEMPLATE,
  INTELLIJ_DENO_TEMPLATE,
  VSCODE_EXTENSIONS_TEMPLATE,
  VSCODE_SETTINGS_TEMPLATE,
  renderProjectConfigTemplate,
} from "./project-init.templates.ts";
import { InitAlreadyExistsError } from "./project-init.errors.ts";

const invalidProjectId = /[^a-zA-Z0-9_.-]+/g;
const maxProjectIdLength = 40;

function truncateText(text: string, maxLength: number): string {
  return text.length > maxLength ? text.slice(0, maxLength) : text;
}

function sanitizeProjectId(src: string): string {
  const sanitized = src.replaceAll(invalidProjectId, "_").replace(/^[_.-]+/, "");
  return truncateText(sanitized, maxProjectIdLength);
}

function stripJsonComments(contents: string): string {
  return contents
    .replace(/^\uFEFF/, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseJsonObject(contents: string): Record<string, unknown> {
  const parsed = JSON.parse(stripJsonComments(contents));
  return isObject(parsed) ? parsed : {};
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
      ...parseJsonObject(existing),
      ...parseJsonObject(template),
    };
    yield* writeJsonFile(pathname, merged);
  });
}

const writeVscodeConfig = Effect.fnUntraced(function* (cwd: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const output = yield* Output;

  const vscodeDir = path.join(cwd, ".vscode");
  const extensionsPath = path.join(vscodeDir, "extensions.json");
  const settingsPath = path.join(vscodeDir, "settings.json");

  yield* fs.makeDirectory(vscodeDir, { recursive: true });
  yield* updateJsonFile(extensionsPath, VSCODE_EXTENSIONS_TEMPLATE);
  yield* updateJsonFile(settingsPath, VSCODE_SETTINGS_TEMPLATE);

  yield* output.raw("Generated VS Code settings in .vscode/settings.json.\n");
  yield* output.raw(
    "Please install the Deno extension for VS Code: https://marketplace.visualstudio.com/items?itemName=denoland.vscode-deno\n",
  );
});

const writeIntelliJConfig = Effect.fnUntraced(function* (cwd: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const output = yield* Output;

  const intellijDir = path.join(cwd, ".idea");
  const denoPath = path.join(intellijDir, "deno.xml");

  yield* fs.makeDirectory(intellijDir, { recursive: true });
  yield* fs.writeFileString(denoPath, INTELLIJ_DENO_TEMPLATE);

  yield* output.raw("Generated IntelliJ settings in .idea/deno.xml.\n");
  yield* output.raw(
    "Please install the Deno plugin for IntelliJ: https://plugins.jetbrains.com/plugin/14382-deno\n",
  );
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

export const initProject = Effect.fnUntraced(function* (options: ProjectInitOptions) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const tty = yield* Tty;
  const output = yield* Output;

  const supabaseDir = path.join(options.cwd, "supabase");
  const configTomlPath = path.join(supabaseDir, "config.toml");
  const existingToml = yield* fs.exists(configTomlPath);

  if (existingToml && !options.force) {
    return yield* Effect.fail(
      new InitAlreadyExistsError({
        detail: `Config already exists at ${configTomlPath}.`,
        suggestion: "Run `supabase init --force` to overwrite the existing config.",
      }),
    );
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

  return {
    configPath: configTomlPath,
  } as const;
});
