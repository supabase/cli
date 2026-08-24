import { BunServices } from "@effect/platform-bun";
import { Effect, FileSystem, Path, Schema } from "effect";
import process from "node:process";
import { parseArgs } from "node:util";

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

const version = values.version;
if (!version) {
  process.stderr.write(
    "Usage: pnpm exec bun apps/cli/scripts/sync-versions.ts --version <version>\n",
  );
  process.exit(1);
}

const packageJson = Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown));

const main = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = path.resolve(import.meta.dir, "../../..");

  for (const pkg of ALL_PACKAGES) {
    const pkgJsonPath = path.join(root, ...PACKAGE_PATHS[pkg], "package.json");
    const pkgJson: Record<string, unknown> = yield* Schema.decodeEffect(packageJson)(
      yield* fs.readFileString(pkgJsonPath),
    );
    pkgJson.version = version;
    const encoded = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown, { space: 2 }))(
      pkgJson,
    );
    yield* fs.writeFileString(pkgJsonPath, `${encoded}\n`);
    yield* Effect.sync(() => process.stdout.write(`Updated ${pkg} to v${version}\n`));
  }

  yield* Effect.sync(() => process.stdout.write(`\nAll packages synced to v${version}.\n`));
});

if (import.meta.main) {
  await Effect.runPromise(main.pipe(Effect.provide(BunServices.layer)));
}
