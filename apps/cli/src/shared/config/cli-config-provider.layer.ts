import { ConfigProvider, Layer } from "effect";

/** The process environment for synchronous leaf code that has no Effect context to read `Config` from. */
export const ambientEnvironment = (): NodeJS.ProcessEnv => process.env;

/** Installs the live process environment for the CLI's runtime config reads. */
export const cliConfigProviderLayer = Layer.sync(ConfigProvider.ConfigProvider, () =>
  ConfigProvider.fromEnvRecord(ambientEnvironment(), { preserveEmptyStrings: true }),
);
