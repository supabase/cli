import { BunServices } from "@effect/platform-bun";
import { CLI_CONFIG_SCHEMA_URL, PROJECT_CONFIG_SCHEMA_URL } from "@supabase/config";
import { HOSTED_LOCK_SCHEMA_URL } from "@supabase/stack/effect";
import { Console, Effect, FileSystem, Path, Schema } from "effect";
import { lockSchemaDocument, publishedSchemaPath } from "./published-schemas.ts";

const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown, { space: 2 }));

const main = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const cliRoot = path.resolve(import.meta.dir, "..");
  const configPackageDistDir = path.resolve(import.meta.dir, "../../../packages/config/dist");

  // Copy the post-processed artifacts so their published metadata matches the config package.
  for (const [schemaUrl, distFileName] of [
    [CLI_CONFIG_SCHEMA_URL, "schema.json"],
    [PROJECT_CONFIG_SCHEMA_URL, "project-schema.json"],
  ] as const) {
    const destPath = path.join(cliRoot, publishedSchemaPath(schemaUrl));
    yield* fs.makeDirectory(path.dirname(destPath), { recursive: true });
    yield* fs.copyFile(path.join(configPackageDistDir, distFileName), destPath);
    yield* Console.log(`Generated: ${path.relative(cliRoot, destPath)}`);
  }

  const lockPath = path.join(cliRoot, publishedSchemaPath(HOSTED_LOCK_SCHEMA_URL));
  yield* fs.makeDirectory(path.dirname(lockPath), { recursive: true });
  yield* fs.writeFileString(lockPath, `${yield* encodeJson(lockSchemaDocument())}\n`);
  yield* Console.log(`Generated: ${path.relative(cliRoot, lockPath)}`);
  yield* Effect.annotateCurrentSpan("schemas.count", 3);
});

await Effect.runPromise(
  main.pipe(Effect.withSpan("Schemas.generate"), Effect.provide(BunServices.layer)),
);
