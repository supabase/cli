import { languages, type OptionSpec, type OptionValue, type OptionValues } from "@supabase/typegen";
import { Flag } from "effect/unstable/cli";
import { Option } from "effect";

/**
 * Everything `gen types` derives from the `@supabase/typegen` registry, so the command, the
 * handler and the tests read one definition. Adding a language or a language flag is a bump of
 * that dependency; nothing here names a language.
 */

/** `--lang` values, in the registry's display order. */
export const GEN_TYPES_LANGUAGES: ReadonlyArray<string> = languages.map(
  (language) => language.name,
);

/**
 * Language flags users set, for example `--swift-access-control`; consumer options are not flags.
 * A name two languages both declare is one flag, so it is listed once.
 */
const GEN_TYPES_LANGUAGE_OPTIONS: ReadonlyArray<OptionSpec> = [
  ...new Map(
    languages
      .flatMap((language) => language.options.filter((option) => option.audience === "user"))
      .map((option) => [option.name, option] as const),
  ).values(),
];

export const GEN_TYPES_LANGUAGE_FLAG_NAMES: ReadonlyArray<string> = GEN_TYPES_LANGUAGE_OPTIONS.map(
  (option) => option.name,
);

/** Language flags that consume the next argv token, for the pflag-style scans in the handler. */
export const GEN_TYPES_LANGUAGE_VALUE_FLAG_NAMES: ReadonlyArray<string> =
  GEN_TYPES_LANGUAGE_OPTIONS.filter((option) => option.kind !== "boolean").map(
    (option) => option.name,
  );

export type GenTypesLanguageFlagValue = string | boolean | Option.Option<string>;

const languageFlag = (spec: OptionSpec): Flag.Flag<GenTypesLanguageFlagValue> => {
  switch (spec.kind) {
    case "boolean":
      return Flag.boolean(spec.name).pipe(
        Flag.withDescription(spec.help),
        Flag.withDefault(spec.default),
      );
    case "choice":
      return Flag.choice(spec.name, spec.choices).pipe(
        Flag.withDescription(`${spec.help} (default ${spec.default})`),
        Flag.withDefault(spec.default),
      );
    case "string":
      return spec.default === undefined
        ? Flag.string(spec.name).pipe(Flag.withDescription(spec.help), Flag.optional)
        : Flag.string(spec.name).pipe(
            Flag.withDescription(`${spec.help} (default ${spec.default})`),
            Flag.withDefault(spec.default),
          );
  }
};

/** One flag per user-facing language option, keyed by the flag name. */
export const genTypesLanguageFlags: Readonly<Record<string, Flag.Flag<GenTypesLanguageFlagValue>>> =
  Object.fromEntries(GEN_TYPES_LANGUAGE_OPTIONS.map((spec) => [spec.name, languageFlag(spec)]));

/** Documented defaults of the language flags, keyed the way `DOCS_DEFAULT_OVERRIDES` expects. */
export const genTypesLanguageFlagDefaults = (): Readonly<Record<string, string>> =>
  Object.fromEntries(
    GEN_TYPES_LANGUAGE_OPTIONS.flatMap((spec) =>
      spec.default === undefined ? [] : [[`supabase-gen-types ${spec.name}`, String(spec.default)]],
    ),
  );

/** Reads the parsed language flags back into registry option values. */
export const languageOptionValues = (flags: Readonly<Record<string, unknown>>): OptionValues => {
  const values: Record<string, OptionValue> = {};
  for (const name of GEN_TYPES_LANGUAGE_FLAG_NAMES) {
    const value = flags[name];
    if (Option.isOption(value)) {
      if (Option.isSome(value) && typeof value.value === "string") values[name] = value.value;
    } else if (typeof value === "string" || typeof value === "boolean") {
      values[name] = value;
    }
  }
  return values;
};
