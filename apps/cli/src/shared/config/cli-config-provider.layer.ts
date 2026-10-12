import { ConfigProvider, Context, Layer } from "effect";

/** The process environment for synchronous leaf code that has no Effect context to read `Config` from. */
export const ambientEnvironment = (): NodeJS.ProcessEnv => process.env;

/** Installs the live process environment for the CLI's runtime config reads. */
export const cliConfigProviderLayer = Layer.sync(ConfigProvider.ConfigProvider, () =>
  ConfigProvider.fromEnvRecord(ambientEnvironment(), { preserveEmptyStrings: true }),
);

/** Lists the environment variable names to look for by prefix; the provider still supplies their values. */
export const CliEnvNameSource = Context.Reference<() => Iterable<string>>(
  "supabase/config/CliEnvNameSource",
  { defaultValue: () => () => Object.keys(ambientEnvironment()) },
);
