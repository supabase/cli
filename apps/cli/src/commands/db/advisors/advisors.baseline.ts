import { applyConfigEdits, writeCliConfigDocumentText } from "@supabase/config/internal";
import { MIGRATION_CHECK_RULES, type MigrationCheckRule } from "@supabase/config/internal";
import { Effect, FileSystem, Option, Path } from "effect";

import { getDocumentValue } from "../../../config/cli-config-document.ts";
import { CliConfigValues } from "../../../config/cli-config-values.service.ts";
import { CommandSettings } from "../../../config/command-settings.service.ts";
import { readDbToml } from "../../../command-internal/db-config.toml-read.ts";
import type { MigrationChecksPolicy } from "../../../command-internal/migration-checks-policy.ts";
import { OutputFlag } from "../../../command-internal/global-flags.ts";
import { encodeSortedJson } from "../../../command-internal/output.encoders.ts";
import { Output } from "../../../shared/output/output.service.ts";
import {
  missingProjectConfigMessageEffect,
  relativeConfigPath,
} from "../../../command-internal/workdir-project.ts";
import { DbAdvisorsBaselineError } from "./advisors.errors.ts";

/** One object a `[db.migrations.checks.exclude]` rule skips. */
export interface BaselineExclusion {
  readonly rule: MigrationCheckRule;
  readonly object: string;
}

const EXCLUDE_PATH = ["db", "migrations", "checks", "exclude"] as const;

/** Rules `--baseline` records: every rule the policy does not turn off. */
export const baselineRules = (policy: MigrationChecksPolicy): ReadonlyArray<MigrationCheckRule> =>
  MIGRATION_CHECK_RULES.filter((rule) => policy.severities[rule] !== "off");

/** The `[db.migrations.checks]` policy and exposed schemas for the target, `[remotes.*]` included. */
export const loadBaselinePolicy = Effect.fn("db.advisors.baseline.policy")(function* (
  ref: string | undefined,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const cliSettings = yield* CommandSettings;
  const toml = yield* readDbToml(fs, path, cliSettings.workdir, ref);
  return { policy: toml.migrationChecks, exposedSchemas: toml.apiSchemas };
});

const fileEntries = (document: unknown, rule: MigrationCheckRule): ReadonlyArray<string> => {
  const value = getDocumentValue(document, [...EXCLUDE_PATH, rule]);
  return Array.isArray(value) ? value.filter((entry) => typeof entry === "string") : [];
};

/**
 * Adds `findings` the policy does not already exclude to `[db.migrations.checks.exclude]` in the
 * project config file, keeping existing entries (sorted) and the rest of the file byte for
 * byte, and reports what it added.
 */
export const writeBaseline = Effect.fn("db.advisors.baseline.write")(function* (
  policy: MigrationChecksPolicy,
  findings: ReadonlyArray<BaselineExclusion>,
) {
  const output = yield* Output;
  const outputFlag = yield* OutputFlag;
  const cliSettings = yield* CommandSettings;
  const configValues = yield* CliConfigValues;
  const configError = (cause: { readonly message: string }) =>
    new DbAdvisorsBaselineError({ message: cause.message, reason: "config" });
  const resolvedConfig = yield* configValues
    .load({ workdir: cliSettings.workdir, projectRef: Option.none() })
    .pipe(Effect.mapError(configError));
  if (!resolvedConfig.hasConfigFile) {
    return yield* new DbAdvisorsBaselineError({
      message: yield* missingProjectConfigMessageEffect(cliSettings),
      reason: "config",
    });
  }
  // The file as written, without env or `[remotes.*]` overlays, since the edit rewrites it.
  const loaded = yield* resolvedConfig.fileDeclared.pipe(Effect.mapError(configError));
  const configPath = relativeConfigPath(cliSettings.workdir, loaded.path);

  const excluded = new Set(
    policy.exclude.map((entry) => JSON.stringify([entry.rule, entry.object])),
  );
  const added: Array<BaselineExclusion> = [];
  const edits = MIGRATION_CHECK_RULES.flatMap((rule) => {
    const existing = fileEntries(loaded.rawDocument, rule);
    const present = new Set(existing);
    const objects = [
      ...new Set(
        findings
          .filter(
            (finding) =>
              finding.rule === rule &&
              !present.has(finding.object) &&
              !excluded.has(JSON.stringify([rule, finding.object])),
          )
          .map((finding) => finding.object),
      ),
    ].toSorted();
    added.push(...objects.map((object) => ({ rule, object })));
    const merged = [...new Set([...existing, ...objects])].toSorted();
    const unchanged =
      merged.length === existing.length && merged.every((entry, index) => entry === existing[index]);
    return unchanged ? [] : [{ path: [...EXCLUDE_PATH, rule], value: merged }];
  });
  yield* Effect.annotateCurrentSpan({
    "advisor.baseline.finding_count": findings.length,
    "advisor.baseline.added_count": added.length,
  });

  if (edits.length > 0) {
    if (loaded.rawText === undefined) {
      return yield* new DbAdvisorsBaselineError({
        message: `${configPath} could not be read. Rerun the command.`,
        reason: "config",
      });
    }
    const outcome = applyConfigEdits(loaded.rawText, loaded.format, edits);
    if (outcome.kind === "refused") {
      return yield* new DbAdvisorsBaselineError({
        message: `cannot write ${configPath}: ${outcome.refusal.detail}. Add the entries to [db.migrations.checks.exclude] by hand.`,
        reason: "layout",
      });
    }
    yield* configValues
      .writeThrough(writeCliConfigDocumentText(loaded.path, outcome.text))
      .pipe(
        Effect.catchTag(
          "CliConfigWriteError",
          (cause) => new DbAdvisorsBaselineError({ message: cause.message, reason: "write" }),
        ),
      );
  }

  const lines = MIGRATION_CHECK_RULES.flatMap((rule) => {
    const objects = added.filter((entry) => entry.rule === rule).map((entry) => entry.object);
    return objects.length === 0 ? [] : [`  ${rule}: ${objects.join(", ")}`];
  });
  const message =
    added.length === 0
      ? `No new findings: ${configPath} already excludes every current finding.`
      : `Added ${added.length} ${added.length === 1 ? "object" : "objects"} to [db.migrations.checks.exclude] in ${configPath}.`;
  const result = { baseline: { config: configPath, added, message } };
  if (Option.getOrUndefined(outputFlag) === "json") {
    yield* output.raw(encodeSortedJson(result));
    return;
  }
  if (output.format !== "text") {
    yield* output.success(message, result);
    return;
  }
  yield* output.raw(
    lines.length === 0
      ? `${message}\n`
      : `${message.replace(/\.$/u, ":")}\n${lines.join("\n")}\n`,
  );
});
