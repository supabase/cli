import * as SmolToml from "smol-toml";
import type { ConfigFormat } from "@supabase/config";
import {
  EXPERIMENT_NAMES,
  experimentEnvName,
  type ExperimentName,
} from "../../command-internal/experiment-registry.ts";

/**
 * One experiment's disposition after `experiments enable`/`disable` decided what to do with
 * it. `changed: false` means the project config already said what was asked.
 */
export interface ExperimentOutcome {
  readonly feature: ExperimentName;
  readonly previous: boolean;
  readonly changed: boolean;
  /** The `SUPABASE_EXPERIMENTAL_*` value shadowing this setting in the current process. */
  readonly envOverride: string | undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * The `[experimental]` booleans the document currently declares, or `undefined` when it does
 * not parse at all. An unreadable document is not an error here: `applyConfigEdits` runs next
 * and refuses with a reason naming the actual layout problem, which is more use to the reader
 * than "parse failed".
 */
export function readExperimentValues(
  format: ConfigFormat,
  text: string,
): Partial<Record<ExperimentName, boolean>> | undefined {
  let document: unknown;
  try {
    document = format === "json" ? JSON.parse(text) : SmolToml.parse(text);
  } catch {
    return undefined;
  }
  if (!isRecord(document)) return {};
  const experimental = document["experimental"];
  if (!isRecord(experimental)) return {};

  const values: Partial<Record<ExperimentName, boolean>> = {};
  for (const feature of EXPERIMENT_NAMES) {
    const value = experimental[feature];
    if (typeof value === "boolean") {
      values[feature] = value;
    }
  }
  return values;
}

/**
 * The text-mode report: one line per requested experiment, then any environment override that
 * would make the file's new value a lie for the current shell.
 */
export function renderExperimentOutcomes(input: {
  readonly outcomes: ReadonlyArray<ExperimentOutcome>;
  readonly enabled: boolean;
  readonly configPath: string;
}): string {
  const verb = input.enabled ? "Enabled" : "Disabled";
  const state = input.enabled ? "enabled" : "disabled";
  const lines = input.outcomes.map((outcome) =>
    outcome.changed
      ? `${verb} ${outcome.feature} in ${input.configPath}.`
      : `${outcome.feature} is already ${state} in ${input.configPath}.`,
  );

  for (const outcome of input.outcomes) {
    if (outcome.envOverride === undefined) continue;
    lines.push(
      `Note: ${experimentEnvName(outcome.feature)}=${outcome.envOverride} takes precedence over ${input.configPath} for this shell.`,
    );
  }

  return `${lines.join("\n")}\n`;
}
