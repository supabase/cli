import { Effect, FileSystem, Layer, Path } from "effect";

import { SkillWriter, formatAsSkill, type SkillEntry } from "./skill-writer.service.ts";

/**
 * skillWriterLayer - Effect-native skill file installation.
 *
 * The service contract stays focused on "write these entries", while this layer
 * decides how directory creation and file writes happen in the active runtime.
 */
export const skillWriterLayer = Layer.effect(
  SkillWriter,
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const pathService = yield* Path.Path;

    return {
      // Each skill gets its own directory so agent homes match their expected layout.
      writeSkillFiles: (outputDir: string, entries: ReadonlyArray<SkillEntry>) =>
        Effect.forEach(entries, (entry) =>
          Effect.gen(function* () {
            const skillDir = pathService.join(outputDir, entry.skillName);
            yield* fs.makeDirectory(skillDir, { recursive: true });
            yield* fs.writeFileString(pathService.join(skillDir, "SKILL.md"), formatAsSkill(entry));
          }),
        ).pipe(Effect.asVoid, Effect.orDie),
    };
  }),
);
