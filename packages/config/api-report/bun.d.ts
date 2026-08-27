export declare const loadCliConfig: (cwd: string, options?: import("./config-document.ts").LoadCliConfigOptions) => Promise<import("./config-document.ts").LoadedCliConfig | null>;
export declare const findCliProjectRoot: (cwd: string) => Promise<string | null>;
export declare const findCliProjectPaths: (cwd: string) => Promise<import("./paths.ts").CliProjectPaths | null>;
export declare const loadCliConfigFile: (path: string) => Promise<import("./config-document.ts").LoadedCliConfig>;
export declare const loadCliProjectEnvironment: (options: import("./project.ts").LoadCliProjectEnvironmentOptions) => Promise<import("./project.ts").CliProjectEnvironment | null>;
export declare const saveCliConfig: (options: import("./config-document.ts").SaveCliConfigOptions) => Promise<import("./config-document.ts").LoadedCliConfig>;
export declare const inferFunctionsManifest: (cwd: string) => Promise<import("./functions-manifest-model.ts").FunctionsManifest>;
export type { CliConfigIo } from "./promise-facade.ts";
export * from "./index.ts";
