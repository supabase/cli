import type { LegacyPgDeltaImplementation } from "../../../../shared/legacy-pgdelta-next-flag.ts";
import type { LegacyPgDeltaRemovalSummary } from "../../shared/legacy-pgdelta-engine.service.ts";

/** Extensions that legacy pg-delta treated as part of its implicit Supabase baseline. */
const LEGACY_IMPLICIT_EXTENSIONS = ["pg_net", "pgcrypto", "uuid-ossp"] as const;

type LegacyDeclarativeCompatibilityAction = "none" | "repair-extensions" | "stage-next-export";

export interface LegacyDeclarativeCompatibilityGap {
  readonly repairableExtensions: ReadonlyArray<string>;
  readonly extensionIntents: LegacyPgDeltaRemovalSummary["extensionIntents"];
  readonly ambiguousRemovals: ReadonlyArray<string>;
  readonly recommendedAction: LegacyDeclarativeCompatibilityAction;
}

/**
 * Pure control-flow helpers ported from the legacy Go implementation (deleted
 * in CLI-1970; last present at commit 7b469f5b3) and kept free of
 * Effect/services so handler decisions remain unit-testable.
 */

export function legacyResolveDeclarativeMigrationName(name: string, file: string): string {
  return name.length > 0 ? name : file;
}

/** Whether sync applies the generated migration, prompts, or skips. */
export type LegacyDeclarativeApplyDecision = "apply" | "skip" | "prompt";

export function legacyResolveDeclarativeSyncApplyDecision(opts: {
  readonly apply: boolean;
  readonly noApply: boolean;
  readonly yes: boolean;
  readonly tty: boolean;
}): LegacyDeclarativeApplyDecision {
  if (opts.noApply) return "skip";
  if (opts.apply) return "apply";
  if (opts.yes) return "apply";
  if (opts.tty) return "prompt";
  return "skip";
}

const emptyCompatibilityGap = (): LegacyDeclarativeCompatibilityGap => ({
  repairableExtensions: [],
  extensionIntents: [],
  ambiguousRemovals: [],
  recommendedAction: "none",
});

/** Classifies manifest-less pg-delta next removals without performing any I/O. */
export function legacyClassifyDeclarativeCompatibilityGap(opts: {
  readonly implementation: LegacyPgDeltaImplementation;
  readonly manifestPresent: boolean;
  readonly removals: LegacyPgDeltaRemovalSummary;
}): LegacyDeclarativeCompatibilityGap {
  if (opts.implementation !== "next" || opts.manifestPresent) return emptyCompatibilityGap();

  const extensions = [...new Set(opts.removals.extensions)].sort();
  const repairableExtensions = extensions.filter((extension) =>
    LEGACY_IMPLICIT_EXTENSIONS.some((implicit) => implicit === extension),
  );
  const ambiguousRemovals = extensions.filter(
    (extension) => !LEGACY_IMPLICIT_EXTENSIONS.some((implicit) => implicit === extension),
  );
  const extensionIntents = opts.removals.extensionIntents;

  if (extensions.length === 0 && extensionIntents.length === 0) return emptyCompatibilityGap();
  const repairable =
    repairableExtensions.length > 0 &&
    ambiguousRemovals.length === 0 &&
    extensionIntents.length === 0;
  return {
    repairableExtensions,
    extensionIntents,
    ambiguousRemovals,
    recommendedAction: repairable ? "repair-extensions" : "stage-next-export",
  };
}

export const legacyExtensionDeclaration = (extension: string): string =>
  `CREATE EXTENSION IF NOT EXISTS "${extension}" WITH SCHEMA "extensions";`;

export function legacyFormatStagedExportRecommendation(
  gap: LegacyDeclarativeCompatibilityGap,
): string {
  const detected = [
    ...(gap.repairableExtensions.length > 0
      ? [`Legacy-implicit extensions: ${gap.repairableExtensions.join(", ")}`]
      : []),
    ...(gap.ambiguousRemovals.length > 0
      ? [`Extensions: ${gap.ambiguousRemovals.join(", ")}`]
      : []),
    ...(gap.extensionIntents.length > 0
      ? [
          `Extension-managed objects: ${gap.extensionIntents
            .map((intent) => `${intent.extension} ${intent.intentKind} ${intent.key}`)
            .join(", ")}`,
        ]
      : []),
  ];
  return [
    "WARNING: pg-delta next manages schema state that the legacy export did not represent.",
    ...detected,
    "Generate a next-compatible schema into a separate directory, review it, and adopt it when ready:",
    "supabase db schema declarative generate <target> --output supabase/database-next",
  ].join("\n");
}
