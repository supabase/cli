import {
  applyConfigEdits,
  MIGRATION_CHECK_RULES,
  type MigrationCheckRule,
  writeCliConfigDocumentText,
} from "@supabase/config/internal";
import { parseObjectName } from "@supabase/pg-checks";
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

/** A finding to baseline: the rule and the object's raw schema and name. */
interface BaselineFinding {
  readonly rule: MigrationCheckRule;
  readonly schema: string;
  readonly name: string;
}

/** One object a `[db.migrations.checks.exclude]` rule skips, as written in the config. */
interface BaselineExclusion {
  readonly rule: MigrationCheckRule;
  readonly object: string;
}

const EXCLUDE_PATH = ["db", "migrations", "checks", "exclude"] as const;

const quotedPart = (part: string): string => `"${part.replaceAll('"', '""')}"`;

/**
 * The `[db.migrations.checks.exclude]` entry for a finding's object, `schema.name`, with a part
 * double-quoted when it holds a quote, edge whitespace, or (for the schema) a dot; `undefined`
 * when no entry can name it.
 */
const exclusionEntry = (schema: string, name: string): string | undefined => {
  if (schema === "" || name === "" || [schema, name].some((part) => /\$sbcq?\$/u.test(part))) {
    return undefined;
  }
  const plain = (part: string) => !part.includes('"') && part === part.trim();
  return `${plain(schema) && !schema.includes(".") ? schema : quotedPart(schema)}.${plain(name) ? name : quotedPart(name)}`;
};

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
  return {
    policy: toml.migrationChecks,
    exposedSchemas: toml.apiSchemas,
    appliedRemote: toml.appliedRemote,
  };
});

const fileEntries = (document: unknown, path: ReadonlyArray<string>): ReadonlyArray<string> => {
  const value = getDocumentValue(document, path);
  return Array.isArray(value) ? value.filter((entry) => typeof entry === "string") : [];
};

/**
 * Where a rule's exclusions are written for the target and the entries already there. A matched
 * `[remotes.<name>]` block's list replaces the root list, so the remote's own list is extended,
 * and one it lacks starts from the root entries it would otherwise replace.
 */
const excludeList = (
  document: unknown,
  rule: MigrationCheckRule,
  appliedRemote: string | undefined,
): { readonly path: ReadonlyArray<string>; readonly existing: ReadonlyArray<string> } => {
  const rootPath = [...EXCLUDE_PATH, rule];
  if (appliedRemote === undefined) {
    return { path: rootPath, existing: fileEntries(document, rootPath) };
  }
  const remotePath = ["remotes", appliedRemote, ...rootPath];
  return {
    path: remotePath,
    existing: Array.isArray(getDocumentValue(document, remotePath))
      ? fileEntries(document, remotePath)
      : fileEntries(document, rootPath),
  };
};

/** Identifies a rule's exclusion of one object, however its entry is quoted. */
const objectKey = (rule: string, schema: string, name: string): string =>
  JSON.stringify([rule, schema, name]);

const entryKey = (rule: string, entry: string): string | undefined => {
  const parsed = parseObjectName(entry);
  return parsed === null ? undefined : objectKey(rule, parsed.schema, parsed.name);
};

/**
 * Appends `findings` the policy does not already exclude to the target's
 * `[db.migrations.checks.exclude]` lists in the project config file, keeping existing entries and
 * the rest of the file byte for byte, and reports what it added. Nothing is written when nothing
 * is added.
 */
export const writeBaseline = Effect.fn("db.advisors.baseline.write")(function* (
  policy: MigrationChecksPolicy,
  findings: ReadonlyArray<BaselineFinding>,
  appliedRemote: string | undefined,
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

  const added: Array<BaselineExclusion> = [];
  const edits = MIGRATION_CHECK_RULES.flatMap((rule) => {
    const { path, existing } = excludeList(loaded.rawDocument, rule, appliedRemote);
    const skipped = new Set(
      [
        ...existing,
        ...policy.exclude.filter((entry) => entry.rule === rule).map((entry) => entry.object),
      ].flatMap((entry) => entryKey(rule, entry) ?? []),
    );
    const objects: Array<string> = [];
    for (const finding of findings) {
      const key = objectKey(rule, finding.schema, finding.name);
      const object = exclusionEntry(finding.schema, finding.name);
      if (finding.rule !== rule || object === undefined || skipped.has(key)) continue;
      skipped.add(key);
      objects.push(object);
    }
    objects.sort();
    added.push(...objects.map((object) => ({ rule, object })));
    return objects.length === 0 ? [] : [{ path, value: [...existing, ...objects] }];
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
    lines.length === 0 ? `${message}\n` : `${message.replace(/\.$/u, ":")}\n${lines.join("\n")}\n`,
  );
});
