import { findCliProjectPaths } from "@supabase/config/effect";
import {
  applyConfigEdits,
  writeCliConfigDocumentText,
  type ConfigEdit,
} from "@supabase/config/internal";
import type { ConfigFormat } from "@supabase/config";
import { Config, Effect, FileSystem, Option, Path } from "effect";
import {
  configEditRefusalPhrase,
  configEditRefusalRemediation,
} from "../../command-internal/config-edit-refusal.ts";
import {
  experimentEnvName,
  type ExperimentName,
} from "../../command-internal/experiment-registry.ts";
import { OutputFlag } from "../../command-internal/global-flags.ts";
import { unsupportedOutputFlagMessage } from "../../command-internal/go-output-flag.ts";
import { shouldSearchAncestors } from "../../command-internal/workdir-search.ts";
import { CommandSettings } from "../../config/command-settings.service.ts";
import { Output } from "../../shared/output/output.service.ts";
import {
  ExperimentsConfigReadError,
  ExperimentsOutputFlagUnsupportedError,
  ExperimentsProjectNotFoundError,
  ExperimentsUnsupportedLayoutError,
  ExperimentsWriteError,
} from "./experiments.errors.ts";
import {
  readExperimentValues,
  renderExperimentOutcomes,
  type ExperimentOutcome,
} from "./experiments.format.ts";

/**
 * `supabase experiments enable|disable <feature>…` — record an opt-in in the project's own
 * `supabase/config.{toml,json}`, so the whole team and CI inherit it.
 *
 * The write goes through `applyConfigEdits`, which edits the existing `[experimental]` table
 * in place. Appending a second `[experimental]` header instead would leave the file
 * unparseable, and an unparseable config resolves every experiment to off without reporting
 * anything — the exact failure this command exists to stop people hand-editing their way into.
 */

/** `features` with duplicates dropped, so `enable compute compute` reports one line. */
function distinct(features: ReadonlyArray<ExperimentName>): ReadonlyArray<ExperimentName> {
  return [...new Set(features)];
}

/** An env override only counts when it is actually set to something. */
const envOverrideFor = Effect.fnUntraced(function* (feature: ExperimentName) {
  const value = yield* Config.option(Config.string(experimentEnvName(feature)));
  return Option.isSome(value) && value.value !== "" ? value.value : undefined;
});

export const setExperiments = Effect.fnUntraced(function* (input: {
  readonly features: ReadonlyArray<ExperimentName>;
  readonly enabled: boolean;
  /** The invoked command path, for the `-o` refusal and edit-refusal remediation text. */
  readonly command: string;
}) {
  const output = yield* Output;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const settings = yield* CommandSettings;

  // Rejected first, so an invocation that can never produce output does not edit config.
  if (Option.isSome(yield* OutputFlag)) {
    return yield* new ExperimentsOutputFlagUnsupportedError({
      message: unsupportedOutputFlagMessage(input.command),
    });
  }

  const features = distinct(input.features);
  const paths = yield* findCliProjectPaths(settings.workdir, {
    search: shouldSearchAncestors(settings),
  });
  if (paths === null) {
    return yield* new ExperimentsProjectNotFoundError({
      message: `No supabase/config.toml or supabase/config.json found from ${settings.workdir}. Run supabase init first, or pass --workdir.`,
    });
  }

  const configPath = paths.configPath;
  const format: ConfigFormat = path.basename(configPath) === "config.json" ? "json" : "toml";
  const currentText = yield* fs.readFileString(configPath).pipe(
    Effect.mapError(
      (cause) =>
        new ExperimentsConfigReadError({
          message: `Unable to read ${configPath}: ${cause.message}`,
        }),
    ),
  );

  // `undefined` means the document does not parse; every feature becomes an edit so
  // `applyConfigEdits` is the one that names what is wrong with it.
  const previousValues = readExperimentValues(format, currentText);
  const previousFor = (feature: ExperimentName): boolean => previousValues?.[feature] ?? false;
  const targets =
    previousValues === undefined
      ? features
      : features.filter((feature) => previousFor(feature) !== input.enabled);

  if (targets.length > 0) {
    const edits: ReadonlyArray<ConfigEdit> = targets.map((feature) => ({
      path: ["experimental", feature],
      value: input.enabled,
    }));
    const outcome = applyConfigEdits(currentText, format, edits);
    if (outcome.kind === "refused") {
      const { reason, path: refusedPath, detail } = outcome.refusal;
      const location = refusedPath.length === 0 ? "" : ` at ${refusedPath.join(".")}`;
      return yield* new ExperimentsUnsupportedLayoutError({
        message: `cannot write ${configPath}: ${configEditRefusalPhrase(reason)}${location} — ${detail}. ${configEditRefusalRemediation(reason, input.command)}`,
      });
    }
    yield* writeCliConfigDocumentText(configPath, outcome.text).pipe(
      Effect.mapError((cause) => new ExperimentsWriteError({ message: cause.message })),
    );
  }

  const targetSet = new Set(targets);
  const outcomes = yield* Effect.forEach(features, (feature) =>
    envOverrideFor(feature).pipe(
      Effect.map((envOverride): ExperimentOutcome => ({
        feature,
        previous: previousFor(feature),
        changed: targetSet.has(feature),
        envOverride,
      })),
    ),
  );

  if (output.format !== "text") {
    // States the end state rather than a write count: a run that changed nothing still leaves
    // those experiments enabled, and `changed` per entry carries what actually moved.
    yield* output.success(
      `${features.join(", ")} ${input.enabled ? "enabled" : "disabled"} in ${configPath}.`,
      {
        config_path: configPath,
        enabled: input.enabled,
        experiments: outcomes.map((outcome) => ({
          name: outcome.feature,
          previous: outcome.previous,
          changed: outcome.changed,
          env_override: outcome.envOverride ?? null,
        })),
      },
    );
    return;
  }

  yield* output.raw(renderExperimentOutcomes({ outcomes, enabled: input.enabled, configPath }));
});
