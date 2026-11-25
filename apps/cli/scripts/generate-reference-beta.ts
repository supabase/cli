/**
 * Writes the reference-beta definitions (one `<id>.md` per published command) from the same
 * bundle `generate-docs-spec.ts` builds, then runs `check-reference-beta.ts` on them. Run as
 * `bun scripts/generate-reference-beta.ts [out-dir]`; the directory defaults to
 * `docs/reference-beta/definitions` and is wiped first.
 */
import { BunServices } from "@effect/platform-bun";
import { Console, Effect, FileSystem, Path } from "effect";
import process from "node:process";
import { buildReferenceFiles } from "../src/docs/reference-beta.ts";
import { checkReferenceDefinitions } from "./check-reference-beta.ts";
import { loadDocsBundle } from "./docs-bundle.ts";

await Effect.runPromise(
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const outDir = path.resolve(
      process.argv[2] ?? path.resolve(import.meta.dir, "../docs/reference-beta/definitions"),
    );
    const bundle = yield* loadDocsBundle({ version: "latest", prerelease: false, major: 3 });
    const files = buildReferenceFiles(bundle);
    yield* fs.remove(outDir, { recursive: true, force: true });
    yield* fs.makeDirectory(outDir, { recursive: true });
    yield* Effect.forEach(files, (file) =>
      fs.writeFileString(path.join(outDir, `${file.id}.md`), file.contents),
    );
    yield* Console.error(`Wrote ${files.length} definitions to ${outDir}`);
    const failures = yield* checkReferenceDefinitions(outDir);
    if (failures > 0) return yield* Effect.sync(() => process.exit(1));
  }).pipe(Effect.withSpan("docs.generateReferenceBeta"), Effect.provide(BunServices.layer)),
);
