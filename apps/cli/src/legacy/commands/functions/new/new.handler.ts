import { loadCliConfig } from "@supabase/config/internal";
import { defaultPublishableKey } from "../../../../shared/stack-constants.ts";
import { Effect, FileSystem, Option, Path } from "effect";

import {
  invalidFunctionSlugDetail,
  validateFunctionSlugMessage,
} from "../../../../shared/functions/functions.shared.ts";
import { writeIntelliJConfig, writeVscodeConfig } from "../../../../shared/init/project-init.ts";
import { legacyResolveYes } from "../../../../shared/legacy/global-flags.ts";
import { legacyPromptYesNo } from "../../../../shared/legacy/legacy-prompt-yes-no.ts";
import { Output } from "../../../../shared/output/output.service.ts";
import { Tty } from "../../../../shared/runtime/tty.service.ts";
import { LegacyCliSettings } from "../../../config/legacy-cli-settings.service.ts";
import { legacyBold } from "../../../shared/legacy-colors.ts";
import { LegacyTelemetryState } from "../../../telemetry/legacy-telemetry-state.service.ts";
import type { LegacyFunctionsNewFlags } from "./new.command.ts";
import {
  LegacyFunctionsNewFileExistsError,
  LegacyFunctionsNewInvalidSlugError,
  LegacyFunctionsNewWriteError,
  mapLegacyFunctionsNewWriteError,
} from "./new.errors.ts";
import {
  LEGACY_FUNCTIONS_NEW_DENO_JSON,
  LEGACY_FUNCTIONS_NEW_NPMRC,
  type LegacyFunctionsNewAuthMode,
  renderLegacyFunctionsNewConfig,
  renderLegacyFunctionsNewEntrypoint,
} from "./new.templates.ts";

const DEFAULT_LOCAL_API_PORT = 54321;

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Established behavior checks the *parsed* config map after a best-effort
// config load. This intentionally scans the raw TOML text instead:
// config loading here is non-fatal (a malformed `config.toml` must still
// allow scaffolding), so a raw-text section scan is the deterministic
// fallback that does not depend on a successful parse. The strict
// `^\s*\[functions\.<slug>\]\s*$` anchoring keeps this in practical
// lock-step with the parsed-map check for all well-formed configs.
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

const resolveTemplateInputs = Effect.fnUntraced(function* (workdir: string, slug: string) {
  const loaded = yield* loadCliConfig(workdir, { goViperCompat: true }).pipe(
    Effect.orElseSucceed(() => null),
  );
  const port = loaded?.config.api.port ?? DEFAULT_LOCAL_API_PORT;
  const publishableKey = loaded?.config.auth.publishable_key ?? defaultPublishableKey;
  return {
    url: `http://127.0.0.1:${port}/functions/v1/${slug}`,
    publishableKey,
  };
});

// Console-driven IDE-settings prompt. Only invoked in text mode — the
// caller gates on `output.format === "text"` so json / stream-json runs stay payload-only and
// never scaffold IDE settings as an undisclosed side effect.
const promptForIdeSettings = Effect.fnUntraced(function* (workdir: string) {
  const output = yield* Output;
  // `--yes` OR `SUPABASE_YES`.
  const yes = yield* legacyResolveYes;

  // Both questions route through `legacyPromptYesNo`: `--yes`/
  // `SUPABASE_YES` auto-accepts VS Code with the `[Y/n] y` stderr echo; a
  // non-TTY stdin prints the label and scans one piped line (100ms), so
  // `echo n | supabase functions new` declines VS Code and falls through to
  // the IntelliJ question instead of hardcoding the default.
  if (yield* legacyPromptYesNo(output, yes, "Generate VS Code settings for Deno?", true)) {
    yield* writeVscodeConfig(workdir).pipe(
      Effect.mapError(mapLegacyFunctionsNewWriteError(".vscode")),
    );
    return;
  }

  if (yield* legacyPromptYesNo(output, yes, "Generate IntelliJ IDEA settings for Deno?", false)) {
    yield* writeIntelliJConfig(workdir).pipe(
      Effect.mapError(mapLegacyFunctionsNewWriteError(".idea/deno.xml")),
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
    yield* output.raw(
      `[functions.${slug}] is already declared in ${legacyBold(relPath)}\n`,
      "stderr",
    );
    return;
  }

  // Append (never rewrite) the rendered section, matching Go's
  // `os.OpenFile(ConfigPath, O_WRONLY|O_CREATE|O_APPEND)`: the existing file is left
  // byte-for-byte untouched and a partial write can never truncate it. The template begins
  // with a newline, so it attaches cleanly whether or not the file ends with one.
  yield* fs
    .writeFileString(configPath, renderLegacyFunctionsNewConfig(slug, verifyJwt), { flag: "a" })
    .pipe(
      Effect.mapError(
        (cause) =>
          new LegacyFunctionsNewWriteError({
            path: relPath,
            message: `failed to append config: ${String(cause)}`,
          }),
      ),
    );
});

export const legacyFunctionsNew = Effect.fn("legacy.functions.new")(function* (
  flags: LegacyFunctionsNewFlags,
) {
  const output = yield* Output;
  const cliSettings = yield* LegacyCliSettings;
  const telemetryState = yield* LegacyTelemetryState;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const tty = yield* Tty;

  yield* Effect.gen(function* () {
    const invalidSlugMessage = validateFunctionSlugMessage(flags.functionName);
    if (invalidSlugMessage !== undefined) {
      return yield* Effect.fail(
        new LegacyFunctionsNewInvalidSlugError({
          message: invalidSlugMessage,
          detail: invalidFunctionSlugDetail,
        }),
      );
    }

    const existingSlugs = yield* listExistingFunctionSlugs(cliSettings.workdir);
    const isFirstFunction = existingSlugs.size === 0;
    const authMode: LegacyFunctionsNewAuthMode = flags.auth;

    const relFunctionDir = path.join("supabase", "functions", flags.functionName);
    const relEntrypoint = path.join(relFunctionDir, "index.ts");
    const functionDir = path.join(cliSettings.workdir, relFunctionDir);
    const entrypointPath = path.join(cliSettings.workdir, relEntrypoint);

    yield* fs.makeDirectory(functionDir, { recursive: true }).pipe(
      Effect.mapError(
        (cause) =>
          new LegacyFunctionsNewWriteError({
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
        new LegacyFunctionsNewFileExistsError({
          path: relEntrypoint,
          message: "failed to create entrypoint: file already exists",
          suggestion: `Remove ${relEntrypoint} or use a different Function name.`,
        }),
      );
    }

    const templateInputs = yield* resolveTemplateInputs(cliSettings.workdir, flags.functionName);
    yield* fs
      .writeFileString(entrypointPath, renderLegacyFunctionsNewEntrypoint(authMode, templateInputs))
      .pipe(
        Effect.mapError(
          (cause) =>
            new LegacyFunctionsNewWriteError({
              path: relEntrypoint,
              message: `failed to write entrypoint: ${String(cause)}`,
            }),
        ),
      );

    yield* appendFunctionConfig(cliSettings.workdir, flags.functionName, authMode === "user");

    yield* fs
      .writeFileString(path.join(functionDir, "deno.json"), LEGACY_FUNCTIONS_NEW_DENO_JSON)
      .pipe(
        Effect.mapError(
          (cause) =>
            new LegacyFunctionsNewWriteError({
              path: path.join(relFunctionDir, "deno.json"),
              message: `failed to create deno.json config: ${String(cause)}`,
            }),
        ),
      );
    yield* fs.writeFileString(path.join(functionDir, ".npmrc"), LEGACY_FUNCTIONS_NEW_NPMRC).pipe(
      Effect.mapError(
        (cause) =>
          new LegacyFunctionsNewWriteError({
            path: path.join(relFunctionDir, ".npmrc"),
            message: `failed to create .npmrc config: ${String(cause)}`,
          }),
      ),
    );

    if (output.format === "text") {
      yield* output.raw(
        `Created new Function at ${tty.stdoutIsTty ? legacyBold(relFunctionDir) : relFunctionDir}\n`,
      );
    }

    // IDE scaffolding is a human-facing nicety: only offer it in text mode so json /
    // stream-json runs stay payload-only and never write IDE files as an undisclosed side effect.
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
