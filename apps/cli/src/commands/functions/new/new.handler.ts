import { loadCliConfig } from "@supabase/config/internal";
import { defaultPublishableKey } from "../../../shared/stack-constants.ts";
import { Effect, FileSystem, Option, Path } from "effect";

import {
  invalidFunctionSlugDetail,
  validateFunctionSlugMessage,
} from "../../../shared/functions/functions.shared.ts";
import { writeIntelliJConfig, writeVscodeConfig } from "../../../shared/init/project-init.ts";
import { resolveYes } from "../../../command-internal/global-flags.ts";
import { promptYesNo } from "../../../command-internal/prompt-yes-no.ts";
import { Output } from "../../../shared/output/output.service.ts";
import { Tty } from "../../../shared/runtime/tty.service.ts";
import { CommandSettings } from "../../../config/command-settings.service.ts";
import { bold } from "../../../command-internal/colors.ts";
import { shouldSearchAncestors } from "../../../command-internal/workdir-search.ts";
import { validateWorkdirIsDirectory } from "../../../command-internal/workdir-validation.ts";
import { TelemetryState } from "../../../telemetry/telemetry-state.service.ts";
import type { FunctionsNewFlags } from "./new.command.ts";
import {
  FunctionsNewFileExistsError,
  FunctionsNewInvalidSlugError,
  FunctionsNewWorkdirError,
  FunctionsNewWriteError,
  mapFunctionsNewWriteError,
} from "./new.errors.ts";
import {
  FUNCTIONS_NEW_DENO_JSON,
  FUNCTIONS_NEW_NPMRC,
  type FunctionsNewAuthMode,
  renderFunctionsNewConfig,
  renderFunctionsNewEntrypoint,
} from "./new.templates.ts";

const DEFAULT_LOCAL_API_PORT = 54321;

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Scans the raw TOML text rather than a parsed config map, since a malformed
// config.toml here is non-fatal and must still allow scaffolding.
function readDeclaredFunctionSlugs(contents: string): ReadonlySet<string> {
  const slugs = new Set<string>();
  const pattern = /^\s*\[functions\.([^\]\s]+)\]\s*$/gm;
  for (const match of contents.matchAll(pattern)) {
    const slug = match[1];
    if (slug !== undefined) {
      slugs.add(slug);
    }
  }
  return slugs;
}

function hasFunctionConfigDeclaration(contents: string, slug: string): boolean {
  const pattern = new RegExp(`^\\s*\\[functions\\.${escapeRegExp(slug)}\\]\\s*$`, "m");
  return pattern.test(contents);
}

const listExistingFunctionSlugs = Effect.fnUntraced(function* (workdir: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const slugs = new Set<string>();
  const functionsDir = path.join(workdir, "supabase", "functions");
  const hasFunctionsDir = yield* fs.exists(functionsDir).pipe(Effect.orElseSucceed(() => false));
  if (hasFunctionsDir) {
    const entries = yield* fs
      .readDirectory(functionsDir)
      .pipe(Effect.orElseSucceed(() => Array<string>()));
    for (const entry of entries) {
      const indexPath = path.join(functionsDir, entry, "index.ts");
      const exists = yield* fs.exists(indexPath).pipe(Effect.orElseSucceed(() => false));
      if (exists && validateFunctionSlugMessage(entry) === undefined) {
        slugs.add(entry);
      }
    }
  }

  const configPath = path.join(workdir, "supabase", "config.toml");
  const configContents = yield* fs.readFileString(configPath).pipe(Effect.option);
  if (Option.isSome(configContents)) {
    for (const slug of readDeclaredFunctionSlugs(configContents.value)) {
      slugs.add(slug);
    }
  }

  return slugs;
});

const resolveTemplateInputs = Effect.fnUntraced(function* (
  cliSettings: { readonly workdir: string; readonly explicitWorkdir: boolean },
  slug: string,
) {
  const loaded = yield* loadCliConfig(cliSettings.workdir, {
    goViperCompat: true,
    search: shouldSearchAncestors(cliSettings),
  }).pipe(Effect.orElseSucceed(() => null));
  const port = loaded?.config.api.port ?? DEFAULT_LOCAL_API_PORT;
  const publishableKey = loaded?.config.auth.publishable_key ?? defaultPublishableKey;
  return {
    url: `http://127.0.0.1:${port}/functions/v1/${slug}`,
    publishableKey,
  };
});

// Only invoked in text mode: json/stream-json runs stay payload-only and
// never scaffold IDE settings as an undisclosed side effect.
const promptForIdeSettings = Effect.fnUntraced(function* (workdir: string) {
  const output = yield* Output;
  // Also honors `SUPABASE_YES`, not just the `--yes` flag.
  const yes = yield* resolveYes;

  // `promptYesNo` auto-accepts VS Code under `--yes`/`SUPABASE_YES`, and
  // otherwise scans one piped line from non-TTY stdin, so `echo n | ...`
  // declines VS Code and falls through to the IntelliJ question.
  if (yield* promptYesNo(output, yes, "Generate VS Code settings for Deno?", true)) {
    yield* writeVscodeConfig(workdir).pipe(Effect.mapError(mapFunctionsNewWriteError(".vscode")));
    return;
  }

  if (yield* promptYesNo(output, yes, "Generate IntelliJ IDEA settings for Deno?", false)) {
    yield* writeIntelliJConfig(workdir).pipe(
      Effect.mapError(mapFunctionsNewWriteError(".idea/deno.xml")),
    );
  }
});

const appendFunctionConfig = Effect.fnUntraced(function* (
  workdir: string,
  slug: string,
  verifyJwt: boolean,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const output = yield* Output;
  const relPath = path.join("supabase", "config.toml");
  const configPath = path.join(workdir, relPath);
  const existing = yield* fs.readFileString(configPath).pipe(Effect.option);

  if (Option.isSome(existing) && hasFunctionConfigDeclaration(existing.value, slug)) {
    yield* output.raw(`[functions.${slug}] is already declared in ${bold(relPath)}\n`, "stderr");
    return;
  }

  // Appends rather than rewrites, so the existing file is left byte-for-byte
  // untouched and a partial write can never truncate it. The template starts
  // with a newline, so it attaches cleanly regardless of the file's trailing newline.
  yield* fs
    .writeFileString(configPath, renderFunctionsNewConfig(slug, verifyJwt), { flag: "a" })
    .pipe(
      Effect.mapError(
        (cause) =>
          new FunctionsNewWriteError({
            path: relPath,
            message: `failed to append config: ${String(cause)}`,
          }),
      ),
    );
});

export const functionsNew = Effect.fn("functions.new")(function* (flags: FunctionsNewFlags) {
  const output = yield* Output;
  const cliSettings = yield* CommandSettings;
  const telemetryState = yield* TelemetryState;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const tty = yield* Tty;

  yield* Effect.gen(function* () {
    yield* validateWorkdirIsDirectory(cliSettings.workdir, fs).pipe(
      Effect.mapError((error) => new FunctionsNewWorkdirError({ message: error.message })),
    );

    const invalidSlugMessage = validateFunctionSlugMessage(flags.functionName);
    if (invalidSlugMessage !== undefined) {
      return yield* Effect.fail(
        new FunctionsNewInvalidSlugError({
          message: invalidSlugMessage,
          detail: invalidFunctionSlugDetail,
        }),
      );
    }

    const existingSlugs = yield* listExistingFunctionSlugs(cliSettings.workdir);
    const isFirstFunction = existingSlugs.size === 0;
    const authMode: FunctionsNewAuthMode = flags.auth;

    const relFunctionDir = path.join("supabase", "functions", flags.functionName);
    const relEntrypoint = path.join(relFunctionDir, "index.ts");
    const functionDir = path.join(cliSettings.workdir, relFunctionDir);
    const entrypointPath = path.join(cliSettings.workdir, relEntrypoint);

    yield* fs.makeDirectory(functionDir, { recursive: true }).pipe(
      Effect.mapError(
        (cause) =>
          new FunctionsNewWriteError({
            path: relFunctionDir,
            message: String(cause),
          }),
      ),
    );

    const entrypointExists = yield* fs
      .exists(entrypointPath)
      .pipe(Effect.orElseSucceed(() => false));
    if (entrypointExists) {
      return yield* Effect.fail(
        new FunctionsNewFileExistsError({
          path: relEntrypoint,
          message: "failed to create entrypoint: file already exists",
          suggestion: `Remove ${relEntrypoint} or use a different Function name.`,
        }),
      );
    }

    const templateInputs = yield* resolveTemplateInputs(cliSettings, flags.functionName);
    yield* fs
      .writeFileString(entrypointPath, renderFunctionsNewEntrypoint(authMode, templateInputs))
      .pipe(
        Effect.mapError(
          (cause) =>
            new FunctionsNewWriteError({
              path: relEntrypoint,
              message: `failed to write entrypoint: ${String(cause)}`,
            }),
        ),
      );

    yield* appendFunctionConfig(cliSettings.workdir, flags.functionName, authMode === "user");

    yield* fs.writeFileString(path.join(functionDir, "deno.json"), FUNCTIONS_NEW_DENO_JSON).pipe(
      Effect.mapError(
        (cause) =>
          new FunctionsNewWriteError({
            path: path.join(relFunctionDir, "deno.json"),
            message: `failed to create deno.json config: ${String(cause)}`,
          }),
      ),
    );
    yield* fs.writeFileString(path.join(functionDir, ".npmrc"), FUNCTIONS_NEW_NPMRC).pipe(
      Effect.mapError(
        (cause) =>
          new FunctionsNewWriteError({
            path: path.join(relFunctionDir, ".npmrc"),
            message: `failed to create .npmrc config: ${String(cause)}`,
          }),
      ),
    );

    if (output.format === "text") {
      yield* output.raw(
        `Created new Function at ${tty.stdoutIsTty ? bold(relFunctionDir) : relFunctionDir}\n`,
      );
    }

    // Text mode only: json/stream-json runs stay payload-only.
    if (isFirstFunction && output.format === "text") {
      yield* promptForIdeSettings(cliSettings.workdir);
    }

    if (output.format === "json" || output.format === "stream-json") {
      yield* output.success("", {
        path: relFunctionDir,
        function_name: flags.functionName,
        auth: authMode,
      });
    }
  }).pipe(Effect.ensuring(telemetryState.flush));
});
