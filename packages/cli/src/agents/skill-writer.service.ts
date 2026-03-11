import { mkdirSync, writeFileSync } from "node:fs";
import nodePath from "node:path";
import { Effect, ServiceMap } from "effect";

export interface SkillEntry {
  readonly skillName: string;
  readonly skillDescription: string;
  readonly content: string;
}

function formatAsSkill(entry: SkillEntry): string {
  return `---
name: ${entry.skillName}
description: ${entry.skillDescription}
---

${entry.content}`;
}

/**
 * SkillWriter - Boundary for installing generated skill files into agent homes.
 *
 * The default implementation is synchronous and Node-specific so the service can
 * be used without additional layers in simple CLI code paths, while the live
 * layer swaps in Effect's filesystem services for tests and richer runtimes.
 */
interface SkillWriterShape {
  readonly writeSkillFiles: (
    outputDir: string,
    entries: ReadonlyArray<SkillEntry>,
  ) => Effect.Effect<void>;
}

/**
 * SkillWriter - Service reference for skill file installation.
 */
export const SkillWriter: ServiceMap.Reference<SkillWriterShape> = ServiceMap.Reference(
  "@supabase/cli/agents/SkillWriter",
  {
    defaultValue: () => ({
      writeSkillFiles: (outputDir: string, entries: ReadonlyArray<SkillEntry>) =>
        Effect.sync(() => {
          for (const entry of entries) {
            const skillDir = nodePath.join(outputDir, entry.skillName);
            mkdirSync(skillDir, { recursive: true });
            writeFileSync(nodePath.join(skillDir, "SKILL.md"), formatAsSkill(entry));
          }
        }),
    }),
  },
);

export { formatAsSkill };
