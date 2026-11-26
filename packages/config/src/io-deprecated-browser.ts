import * as io from "./io-browser.ts";

export * from "./io-browser.ts";

/** @deprecated `@supabase/config/io` will stop depending on Effect in a future release; Effect users should import `@supabase/config/io-effect`, everyone else `@supabase/config/io-promises`. */
export const loadCliConfig = io.loadCliConfig;

/** @deprecated `@supabase/config/io` will stop depending on Effect in a future release; Effect users should import `@supabase/config/io-effect`, everyone else `@supabase/config/io-promises`. */
export const findCliProjectRoot = io.findCliProjectRoot;

/** @deprecated `@supabase/config/io` will stop depending on Effect in a future release; Effect users should import `@supabase/config/io-effect`, everyone else `@supabase/config/io-promises`. */
export const findCliProjectPaths = io.findCliProjectPaths;

/** @deprecated `@supabase/config/io` will stop depending on Effect in a future release; Effect users should import `@supabase/config/io-effect`, everyone else `@supabase/config/io-promises`. */
export const loadCliConfigFile = io.loadCliConfigFile;

/** @deprecated `@supabase/config/io` will stop depending on Effect in a future release; Effect users should import `@supabase/config/io-effect`, everyone else `@supabase/config/io-promises`. */
export const loadCliProjectEnvironment = io.loadCliProjectEnvironment;

/** @deprecated `@supabase/config/io` will stop depending on Effect in a future release; Effect users should import `@supabase/config/io-effect`, everyone else `@supabase/config/io-promises`. */
export const saveCliConfig = io.saveCliConfig;

/** @deprecated `@supabase/config/io` will stop depending on Effect in a future release; Effect users should import `@supabase/config/io-effect`, everyone else `@supabase/config/io-promises`. */
export const inferFunctionsManifest = io.inferFunctionsManifest;
