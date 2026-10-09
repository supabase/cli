import { languages, type OptionSpec, type OptionValue, type OptionValues } from "@supabase/typegen";
import { Option } from "effect";
import { Flag } from "effect/unstable/cli";

/** A user-facing registry option as one CLI flag, merged across the languages that declare it. */
export interface LanguageFlagSpec {
  readonly name: string;
  readonly kind: OptionSpec["kind"];
  readonly help: string;
  /** Every declaring language's choices; `undefined` for other kinds. */
  readonly choices?: ReadonlyArray<string>;
  /** Shown in help and docs only when every declaring language agrees; never sent. */
  readonly default?: OptionValue;
}

export type GenTypesLanguageFlagValue = Option.Option<string | boolean>;

/**
 * One flag per option name. The flag carries no default: the registry applies each language's
 * own default to the values the user did not set.
 */
export const mergeUserOptions = (
  specs: ReadonlyArray<OptionSpec>,
): ReadonlyArray<LanguageFlagSpec> => {
  const byName = new Map<string, LanguageFlagSpec>();
  for (const spec of specs) {
    if (spec.audience !== "user") continue;
    const existing = byName.get(spec.name);
    if (existing === undefined) {
      byName.set(spec.name, {
        name: spec.name,
        kind: spec.kind,
        help: spec.help,
        choices: spec.kind === "choice" ? [...spec.choices] : undefined,
        default: spec.default,
      });
      continue;
    }
    if (existing.kind !== spec.kind) {
      throw new Error(
        `@supabase/typegen declares --${spec.name} as both ${existing.kind} and ${spec.kind}`,
      );
    }
    byName.set(spec.name, {
      ...existing,
      choices:
        existing.choices !== undefined && spec.kind === "choice"
          ? [...new Set([...existing.choices, ...spec.choices])]
          : existing.choices,
      default: existing.default === spec.default ? existing.default : undefined,
    });
  }
  return [...byName.values()];
};

const languageFlag = (spec: LanguageFlagSpec): Flag.Flag<GenTypesLanguageFlagValue> => {
  const help =
    spec.default === undefined ? spec.help : `${spec.help} (default ${String(spec.default)})`;
  switch (spec.kind) {
    case "boolean":
      return Flag.boolean(spec.name).pipe(Flag.withDescription(help), Flag.optional);
    case "choice":
      return Flag.choice(spec.name, spec.choices ?? []).pipe(
        Flag.withDescription(help),
        Flag.optional,
      );
    case "string":
      return Flag.string(spec.name).pipe(Flag.withDescription(help), Flag.optional);
  }
};

/** Throws when a registry option reuses a flag name the command or the CLI already defines. */
export const languageFlagsFor = (
  specs: ReadonlyArray<LanguageFlagSpec>,
  reservedFlagNames: Iterable<string>,
): Readonly<Record<string, Flag.Flag<GenTypesLanguageFlagValue>>> => {
  const reserved = new Set(reservedFlagNames);
  const collisions = specs.map((spec) => spec.name).filter((name) => reserved.has(name));
  if (collisions.length > 0) {
    throw new Error(
      `@supabase/typegen declares language flags that collide with CLI flags: ${collisions.join(", ")}`,
    );
  }
  return Object.fromEntries(specs.map((spec) => [spec.name, languageFlag(spec)]));
};

/** The values the user set, keyed by option name; unset flags are absent. */
export const optionValuesFor = (
  specs: ReadonlyArray<LanguageFlagSpec>,
  flags: Readonly<Record<string, unknown>>,
): OptionValues => {
  const values: Record<string, OptionValue> = {};
  for (const spec of specs) {
    const value = flags[spec.name];
    if (!Option.isOption(value) || Option.isNone(value)) continue;
    if (typeof value.value === "string" || typeof value.value === "boolean") {
      values[spec.name] = value.value;
    }
  }
  return values;
};

/** Documented defaults keyed the way `DOCS_DEFAULT_OVERRIDES` expects. */
export const flagDefaultsFor = (
  specs: ReadonlyArray<LanguageFlagSpec>,
): Readonly<Record<string, string>> =>
  Object.fromEntries(
    specs.flatMap((spec) =>
      spec.default === undefined ? [] : [[`supabase-gen-types ${spec.name}`, String(spec.default)]],
    ),
  );

export const GEN_TYPES_LANGUAGES: ReadonlyArray<string> = languages.map(
  (language) => language.name,
);

const GEN_TYPES_LANGUAGE_OPTIONS = mergeUserOptions(
  languages.flatMap((language) => language.options),
);

export const GEN_TYPES_LANGUAGE_FLAG_NAMES: ReadonlyArray<string> = GEN_TYPES_LANGUAGE_OPTIONS.map(
  (option) => option.name,
);

/** Language flags that consume the next argv token, for the argv scans in the handler. */
export const GEN_TYPES_LANGUAGE_VALUE_FLAG_NAMES: ReadonlyArray<string> =
  GEN_TYPES_LANGUAGE_OPTIONS.filter((option) => option.kind !== "boolean").map(
    (option) => option.name,
  );

export const genTypesLanguageFlags = (reservedFlagNames: Iterable<string>) =>
  languageFlagsFor(GEN_TYPES_LANGUAGE_OPTIONS, reservedFlagNames);

export const genTypesLanguageFlagDefaults = (): Readonly<Record<string, string>> =>
  flagDefaultsFor(GEN_TYPES_LANGUAGE_OPTIONS);

export const languageOptionValues = (flags: Readonly<Record<string, unknown>>): OptionValues =>
  optionValuesFor(GEN_TYPES_LANGUAGE_OPTIONS, flags);
