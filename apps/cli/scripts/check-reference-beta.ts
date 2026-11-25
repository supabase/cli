/**
 * Validates reference-beta definition files against the vendored
 * `docs/reference-beta/definition.schema.json` (JSON Schema 2020-12) and checks each `id` matches
 * its file name. Independent of the generator: it reads only the files and the schema. Run as
 * `bun scripts/check-reference-beta.ts [definitions-dir]`; exits non-zero on any problem.
 */
import { BunServices } from "@effect/platform-bun";
import Ajv2020 from "ajv/dist/2020.js";
import { Console, Effect, FileSystem, Path, Schema } from "effect";
import process from "node:process";
import { parse } from "yaml";

const SchemaJson = Schema.fromJsonString(Schema.Unknown);

const FRONTMATTER = /^---\n([\s\S]*?)\n---(?:\n|$)/;

/** Prints every problem in every file to stderr and returns the number of invalid files. */
export const checkReferenceDefinitions = Effect.fn("docs.checkReferenceBeta")(function* (
  definitionsDir: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const schemaPath = path.resolve(import.meta.dir, "../docs/reference-beta/definition.schema.json");
  const schema = yield* fs
    .readFileString(schemaPath)
    .pipe(Effect.flatMap(Schema.decodeEffect(SchemaJson)), Effect.orDie);
  if (typeof schema !== "object" || schema === null) {
    return yield* Effect.die(new Error(`${schemaPath} is not a JSON object.`));
  }
  const validate = new Ajv2020({ allErrors: true, strict: false }).compile(schema);

  const names = (yield* fs.readDirectory(definitionsDir))
    .filter((name) => name.endsWith(".md"))
    .toSorted();
  if (names.length === 0) {
    yield* Console.error(`No definitions found in ${definitionsDir}`);
    return 1;
  }

  let invalid = 0;
  for (const name of names) {
    const errors: Array<string> = [];
    const text = (yield* fs.readFileString(path.join(definitionsDir, name))).replaceAll(
      "\r\n",
      "\n",
    );
    const match = FRONTMATTER.exec(text);
    if (match === null) {
      errors.push("missing YAML frontmatter");
    } else {
      const data: unknown = yield* Effect.try(() => parse(match[1] ?? "")).pipe(
        Effect.catch((error) => {
          errors.push(`invalid YAML: ${error.message}`);
          return Effect.void;
        }),
      );
      if (data !== undefined && !validate(data)) {
        for (const error of validate.errors ?? []) {
          errors.push(`${error.instancePath || "/"} ${error.message ?? ""}`.trim());
        }
      }
      const id = typeof data === "object" && data !== null && "id" in data ? data.id : undefined;
      if (id !== name.slice(0, -".md".length)) errors.push("id does not match the file name");
    }
    if (errors.length > 0) {
      invalid += 1;
      yield* Console.error([`✗ ${name}`, ...errors.map((error) => `    ${error}`)].join("\n"));
    }
  }
  yield* Effect.annotateCurrentSpan({ files: names.length, invalid });
  yield* Console.error(
    invalid > 0
      ? `${invalid} of ${names.length} definitions are invalid`
      : `All ${names.length} definitions match the schema`,
  );
  return invalid;
});

if (import.meta.main) {
  await Effect.runPromise(
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const dir = path.resolve(
        process.argv[2] ?? path.resolve(import.meta.dir, "../docs/reference-beta/definitions"),
      );
      const invalid = yield* checkReferenceDefinitions(dir);
      if (invalid > 0) return yield* Effect.sync(() => process.exit(1));
    }).pipe(Effect.provide(BunServices.layer)),
  );
}
