import { Effect, FileSystem, Path } from "effect";
import { SCHEMA_DRAFT_JOURNAL_FILE_NAME } from "./schema-paths.ts";

/** Unlink `.supabase/schema-draft.json`. Missing file is success. */
export const clearDraftJournalFile = (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  workdir: string,
) =>
  fs
    .remove(path.join(workdir, ".supabase", SCHEMA_DRAFT_JOURNAL_FILE_NAME))
    .pipe(
      Effect.catchTag("PlatformError", (error) =>
        error.reason._tag === "NotFound" ? Effect.void : Effect.fail(error),
      ),
    );
