/**
 * The closed set of experimental features a project can opt into. An entry here is what makes
 * a feature reachable from `supabase experiments enable`; `experimental-feature.ts` resolves
 * one at startup and `cli/root.ts` decides what to register from the result.
 *
 * Only booleans that gate a command path belong here. The other `[experimental]` keys
 * (`orioledb_version`, `s3_host`, `pgdelta`, …) are configuration the user fills in, not
 * opt-ins a name alone can toggle.
 */

export const EXPERIMENT_NAMES = ["compute", "stack"] as const;

export type ExperimentName = (typeof EXPERIMENT_NAMES)[number];

/** One line per experiment, for the `experiments` argument help. */
const EXPERIMENT_DESCRIPTIONS: Record<ExperimentName, string> = {
  compute: "run containers next to your project",
  stack: "new local backend behind start and stop",
};

/** The environment override for one experiment, which takes precedence over project config. */
export function experimentEnvName(feature: ExperimentName): string {
  return `SUPABASE_EXPERIMENTAL_${feature.toUpperCase()}`;
}

/**
 * The `FEATURE` argument's help text: what each name in the closed set actually turns on.
 * Without it the help lists bare names, which is how an experiment ends up undiscoverable.
 */
export function experimentArgumentDescription(verb: "enable" | "disable"): string {
  const catalog = EXPERIMENT_NAMES.map(
    (feature) => `${feature}: ${EXPERIMENT_DESCRIPTIONS[feature]}`,
  ).join("; ");
  return `Experiments to ${verb}. ${catalog}.`;
}
