import { Effect, Option } from "effect";
import { DbConfigLoadError } from "../../../command-internal/db-config.errors.ts";
import { getDocumentValue, isDocumentRecord } from "../../../config/cli-config-document.ts";
import { CliConfigValues } from "../../../config/cli-config-values.service.ts";
import type { InspectRule } from "./report.rules.ts";

const RULE_FIELDS: ReadonlyArray<string> = ["query", "name", "pass", "fail"];

/**
 * Reads `[experimental.inspect.rules]` from the config snapshot; when non-empty, these rules
 * replace the embedded defaults. A missing field is the empty string, and an unknown key aborts
 * the load so a misspelled field is not silently dropped.
 */
export const readInspectRules = Effect.fn("inspect.report.readRules")(function* (workdir: string) {
  const configValues = yield* CliConfigValues;
  const snapshot = yield* configValues.load({ workdir, projectRef: Option.none() });
  const rules = snapshot.materialized.config.experimental.inspect?.rules ?? [];
  const rawRules = getDocumentValue(snapshot.loaded.document, "experimental.inspect.rules");

  for (const [index, raw] of (Array.isArray(rawRules) ? rawRules : []).entries()) {
    const unknownKeys = isDocumentRecord(raw)
      ? Object.keys(raw).filter((key) => !RULE_FIELDS.includes(key))
      : [];
    if (unknownKeys.length > 0) {
      return yield* new DbConfigLoadError({
        message: `failed to load config: experimental.inspect.rules[${index}] has invalid keys: ${unknownKeys.join(", ")}`,
      });
    }
  }

  return rules.map((rule): InspectRule => ({
    query: rule.query ?? "",
    name: rule.name ?? "",
    pass: rule.pass ?? "",
    fail: rule.fail ?? "",
  }));
});
