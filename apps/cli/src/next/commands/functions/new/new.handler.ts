import { dirname } from "node:path";
import {
  edgeFunctionEntrypointFileName,
  edgeFunctionPackageManifestFileName,
  edgeFunctionsDirectoryName,
  findProjectPaths,
} from "@supabase/config";
import { Effect, FileSystem, Option, Path } from "effect";
import { Output } from "../../../../shared/output/output.service.ts";
import { RuntimeInfo } from "../../../../shared/runtime/runtime-info.service.ts";
import {
  FunctionEntrypointExistsError,
  InvalidFunctionSlugError,
  MissingFunctionSlugError,
} from "./new.errors.ts";

const functionSlugPattern = /^[A-Za-z0-9_-]+$/;

const packageJson = `${JSON.stringify(
  {
    private: true,
    type: "module",
    dependencies: {},
  },
  null,
  2,
)}\n`;

const entrypointSource = `export default {
  async fetch(request: Request): Promise<Response> {
    const name = new URL(request.url).searchParams.get("name") ?? "World";
    return new Response(\`Hello \${name}!\`, {
      headers: { "content-type": "text/plain" },
    });
  },
};
`;

function validateSlugMessage(slug: string): string | undefined {
  return functionSlugPattern.test(slug)
    ? undefined
    : "Use only alphanumeric characters, underscores, and hyphens.";
}

function validateSlug(slug: string): Effect.Effect<void, InvalidFunctionSlugError> {
  if (validateSlugMessage(slug) === undefined) {
    return Effect.void;
  }

  return Effect.fail(
    new InvalidFunctionSlugError({
      detail: "Invalid Function name. Use only alphanumeric characters, underscores, and hyphens.",
      suggestion: "Try a slug like `hello-world` or `process_payment`.",
    }),
  );
}

function resolveSlug(slug: Option.Option<string>) {
  return Effect.gen(function* () {
    if (Option.isSome(slug)) {
      return slug.value;
    }

    const output = yield* Output;
    if (output.format === "text" && output.interactive) {
      return yield* output.promptText("Function name", { validate: validateSlugMessage });
    }

    return yield* Effect.fail(
      new MissingFunctionSlugError({
        detail: "Function name is required in non-interactive mode.",
        suggestion: "Pass a function name, for example `supabase functions new hello-world`.",
      }),
    );
  });
}

function projectRootForConfigPath(configPath: string): string {
  return dirname(dirname(configPath));
}

export const functionsNew = Effect.fnUntraced(function* (slugInput: Option.Option<string>) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const output = yield* Output;
  const runtimeInfo = yield* RuntimeInfo;

  yield* output.intro("Create Edge Function");

  const slug = yield* resolveSlug(slugInput);
  yield* validateSlug(slug);

  const projectPaths = yield* findProjectPaths(runtimeInfo.cwd);
  const projectRoot =
    projectPaths === null ? runtimeInfo.cwd : projectRootForConfigPath(projectPaths.configPath);
  const functionDir = path.join(projectRoot, "supabase", edgeFunctionsDirectoryName, slug);
  const entrypointPath = path.join(functionDir, edgeFunctionEntrypointFileName);
  const packageManifestPath = path.join(functionDir, edgeFunctionPackageManifestFileName);

  if (yield* fs.exists(entrypointPath)) {
    return yield* Effect.fail(
      new FunctionEntrypointExistsError({
        detail: `Function entrypoint already exists at ${entrypointPath}.`,
        suggestion: "Choose a different function name or remove the existing entrypoint first.",
      }),
    );
  }

  yield* fs.makeDirectory(functionDir, { recursive: true });
  yield* fs.writeFileString(entrypointPath, entrypointSource);
  if (!(yield* fs.exists(packageManifestPath))) {
    yield* fs.writeFileString(packageManifestPath, packageJson);
  }

  yield* output.success("Created Edge Function.", {
    function_slug: slug,
    function_dir: functionDir,
    entrypoint_path: entrypointPath,
    package_manifest_path: packageManifestPath,
  });
  yield* output.outro(`Created ${path.join("supabase", edgeFunctionsDirectoryName, slug)}.`);
});
