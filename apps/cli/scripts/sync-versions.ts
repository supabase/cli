import { parseArgs } from "node:util";
import process from "node:process";
import { BunPath } from "@effect/platform-bun";
import { Console, Data, Effect, Path, Schema } from "effect";

const PACKAGE_PATHS = {
  cli: ["apps", "cli"],
  "cli-darwin-arm64": ["packages", "cli-darwin-arm64"],
  "cli-darwin-x64": ["packages", "cli-darwin-x64"],
  "cli-linux-arm64": ["packages", "cli-linux-arm64"],
  "cli-linux-arm64-musl": ["packages", "cli-linux-arm64-musl"],
  "cli-linux-x64": ["packages", "cli-linux-x64"],
  "cli-linux-x64-musl": ["packages", "cli-linux-x64-musl"],
  "cli-windows-arm64": ["packages", "cli-windows-arm64"],
  "cli-windows-x64": ["packages", "cli-windows-x64"],
} as const;

const ALL_PACKAGES = Object.keys(PACKAGE_PATHS) as Array<keyof typeof PACKAGE_PATHS>;

const { values } = parseArgs({
  options: {
    version: { type: "string" },
  },
});

class PackageJsonFailed extends Data.TaggedError("PackageJsonFailed")<{
  readonly cause: unknown;
}> {}

const encodePackageJson = Schema.encodeEffect(
  Schema.fromJsonString(Schema.Unknown, { space: "\t" }),
);

const version = values.version;

const main = Effect.gen(function* () {
  if (!version) {
    yield* Console.error("Usage: bun apps/cli/scripts/sync-versions.ts --version <version>");
    process.exit(1);
  }

  const path = yield* Path.Path;
  const root = path.resolve(import.meta.dir, "../../..");

  for (const pkg of ALL_PACKAGES) {
    const pkgJsonPath = path.join(root, ...PACKAGE_PATHS[pkg], "package.json");
    const pkgJson = yield* Effect.tryPromise({
      try: () => Bun.file(pkgJsonPath).json(),
      catch: (cause) => new PackageJsonFailed({ cause }),
    });

    pkgJson.version = version;

    const contents = `${yield* encodePackageJson(pkgJson)}\n`;
    yield* Effect.tryPromise({
      try: () => Bun.write(pkgJsonPath, contents),
      catch: (cause) => new PackageJsonFailed({ cause }),
    });
    yield* Console.log(`Updated ${pkg} to v${version}`);
  }

  yield* Console.log(`\nAll packages synced to v${version}.`);
});

function thrownValue(error: { readonly message: string; readonly cause?: unknown }): unknown {
  return error.cause !== undefined ? error.cause : new Error(error.message);
}

await Effect.runPromise(
  main.pipe(
    Effect.catch((error) => Effect.die(thrownValue(error))),
    Effect.provide(BunPath.layer),
  ),
);
