import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Effect, FileSystem, Path } from "effect";
import { clearDraftJournalFile } from "./clear-draft-journal.ts";
import { SCHEMA_DRAFT_JOURNAL_FILE_NAME } from "./schema-paths.ts";

describe("clearDraftJournalFile", () => {
  it.live("unlinks the draft journal and treats a missing file as success", () => {
    const workdir = mkdtempSync(join(tmpdir(), "clear-draft-"));
    const journalDir = join(workdir, ".supabase");
    const journalPath = join(journalDir, SCHEMA_DRAFT_JOURNAL_FILE_NAME);
    mkdirSync(journalDir, { recursive: true });
    writeFileSync(journalPath, "{}\n");

    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      yield* clearDraftJournalFile(fs, path, workdir);
      expect(existsSync(journalPath)).toBe(false);
      yield* clearDraftJournalFile(fs, path, workdir);
    }).pipe(Effect.provide(BunServices.layer));
  });
});
