import { ConfigProvider, Layer } from "effect";

/** Installs the live process environment for the CLI's runtime config reads. */
export const cliConfigProviderLayer = Layer.sync(ConfigProvider.ConfigProvider, () =>
  ConfigProvider.fromEnvRecord(process.env, { preserveEmptyStrings: true }),
);
