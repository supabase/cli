import { Effect, FileSystem, Path } from "effect";

/** Writes `project-ref` and a stub `pooler-url` so `--remote` skips the live Postgres probe. */
export const linkProject = Effect.fnUntraced(function* (dir: string, ref: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const tempDir = path.join(dir, "supabase", ".temp");
  yield* fs.makeDirectory(tempDir, { recursive: true });
  yield* fs.writeFileString(path.join(tempDir, "project-ref"), ref);
  yield* fs.writeFileString(
    path.join(tempDir, "pooler-url"),
    `postgresql://postgres.${ref}:[YOUR-PASSWORD]@aws-0-eu-central-1.pooler.supabase.com:6543/postgres`,
  );
});
