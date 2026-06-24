import { loadProjectConfig } from "@supabase/config";
import { defaultPublishableKey } from "@supabase/stack/effect";
import { Effect, FileSystem, Option, Path } from "effect";

import {
  invalidFunctionSlugDetail,
  validateFunctionSlugMessage,
} from "../../../../shared/functions/functions.shared.ts";
import { writeIntelliJConfig, writeVscodeConfig } from "../../../../shared/init/project-init.ts";
import { LegacyYesFlag } from "../../../../shared/legacy/global-flags.ts";
import { Output } from "../../../../shared/output/output.service.ts";
import { Tty } from "../../../../shared/runtime/tty.service.ts";
import { LegacyCliConfig } from "../../../config/legacy-cli-config.service.ts";
import { legacyBold } from "../../../shared/legacy-colors.ts";
import { LegacyTelemetryState } from "../../../telemetry/legacy-telemetry-state.service.ts";
import type { LegacyFunctionsNewFlags } from "./new.command.ts";
import {
  LegacyFunctionsNewFileExistsError,
  LegacyFunctionsNewInvalidSlugError,
  LegacyFunctionsNewWriteError,
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

function mapIdeWriteError(cause: unknown): LegacyFunctionsNewWriteError {
  if (typeof cause === "object" && cause !== null && "message" in cause) {
    return new LegacyFunctionsNewWriteError({
      path: ".vscode",
      message: String(cause.message),
    });
  }
  return new LegacyFunctionsNewWriteError({
    path: ".vscode",
    message: String(cause),
  });
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
  const loaded = yield* loadProjectConfig(workdir).pipe(Effect.orElseSucceed(() => null));
  const port = loaded?.config.api.port ?? DEFAULT_LOCAL_API_PORT;
  const publishableKey = loaded?.config.auth.publishable_key ?? defaultPublishableKey;
  return {
    url: `http://127.0.0.1:${port}/functions/v1/${slug}`,
    publishableKey,
  };
});

const promptForIdeSettings = Effect.fnUntraced(function* (
  workdir: string,
  announce: boolean,
  format: "text" | "json" | "stream-json",
) {
  const output = yield* Output;
  const tty = yield* Tty;
  const yes = yield* LegacyYesFlag;

  if (yes) {
    yield* output.raw("Generate VS Code settings for Deno? [Y/n] y\n", "stderr");
    yield* writeVscodeConfig(workdir, { announce }).pipe(Effect.mapError(mapIdeWriteError));
    return;
  }

  if (!tty.stdinIsTty) {
    yield* output.raw("Generate VS Code settings for Deno? [Y/n]\n", "stderr");
    yield* writeVscodeConfig(workdir, { announce }).pipe(Effect.mapError(mapIdeWriteError));
    return;
  }

  if (format !== "text") {
    return;
  }

  if (yield* output.promptConfirm("Generate VS Code settings for Deno?", { defaultValue: true })) {
    yield* writeVscodeConfig(workdir, { announce: true }).pipe(Effect.mapError(mapIdeWriteError));
    return;
  }

  if (
    yield* output.promptConfirm("Generate IntelliJ IDEA settings for Deno?", {
      defaultValue: false,
    })
  ) {
    yield* writeIntelliJConfig(workdir, { announce: true }).pipe(
      Effect.mapError(
        (cause) =>
          new LegacyFunctionsNewWriteError({
            path: ".idea/deno.xml",
            message:
              typeof cause === "object" && cause !== null && "message" in cause
                ? String(cause.message)
                : String(cause),
          }),
      ),
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

  const next = `${Option.getOrElse(existing, () => "")}${renderLegacyFunctionsNewConfig(
    slug,
    verifyJwt,
  )}`;
  yield* fs.writeFileString(configPath, next).pipe(
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
  const cliConfig = yield* LegacyCliConfig;
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

    const existingSlugs = yield* listExistingFunctionSlugs(cliConfig.workdir);
    const isFirstFunction = existingSlugs.size === 0;
    const authMode: LegacyFunctionsNewAuthMode = flags.auth;

    const relFunctionDir = path.join("supabase", "functions", flags.functionName);
    const relEntrypoint = path.join(relFunctionDir, "index.ts");
    const functionDir = path.join(cliConfig.workdir, relFunctionDir);
    const entrypointPath = path.join(cliConfig.workdir, relEntrypoint);

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

    const templateInputs = yield* resolveTemplateInputs(cliConfig.workdir, flags.functionName);
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

    yield* appendFunctionConfig(cliConfig.workdir, flags.functionName, authMode === "user");

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

    if (isFirstFunction) {
      yield* promptForIdeSettings(cliConfig.workdir, output.format === "text", output.format);
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
