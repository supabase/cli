import type { FileSystem, Path } from "effect";
import { Layer } from "effect";
import type { LoadedCliConfig, LoadCliConfigOptions, SaveCliConfigOptions } from "./config-document.ts";
import type { FunctionsManifest } from "./functions-manifest-model.ts";
import type { CliProjectPaths } from "./paths.ts";
import type { LoadCliProjectEnvironmentOptions, CliProjectEnvironment } from "./project.ts";
/**
 * Names deliberately mirror `@supabase/config/effect` one-to-one — the
 * subpath itself (`/io` vs `/effect`) conveys Promise-vs-Effect, not the
 * member names.
 *
 * A rejection from `loadCliConfig`, `loadCliConfigFile`, or `saveCliConfig`
 * can carry any of `CliConfigStoreError`'s members (`cli-config.service.ts`):
 * this package's own `CliConfigParseError` / `DuplicateRemoteProjectIdError` /
 * `InvalidRemoteProjectIdError` / `CliProjectEnvParseError`, or `PlatformError`
 * for a host/OS failure — distinguish via `instanceof`.
 */
export interface CliConfigIo {
    readonly loadCliConfig: (cwd: string, options?: LoadCliConfigOptions) => Promise<LoadedCliConfig | null>;
    readonly findCliProjectRoot: (cwd: string) => Promise<string | null>;
    readonly findCliProjectPaths: (cwd: string) => Promise<CliProjectPaths | null>;
    readonly loadCliConfigFile: (path: string) => Promise<LoadedCliConfig>;
    readonly loadCliProjectEnvironment: (options: LoadCliProjectEnvironmentOptions) => Promise<CliProjectEnvironment | null>;
    readonly saveCliConfig: (options: SaveCliConfigOptions) => Promise<LoadedCliConfig>;
    readonly inferFunctionsManifest: (cwd: string) => Promise<FunctionsManifest>;
}
/**
 * Builds the Promise-based `@supabase/config/io` facade over a given platform
 * layer. `Layer`'s `ROut` is declared contravariant (`in ROut`), so a
 * platform layer providing a superset of `FileSystem | Path` (e.g.
 * `BunServices.layer` / `NodeServices.layer`) is assignable here.
 */
export declare function makeCliConfigIo(platformLayer: Layer.Layer<FileSystem.FileSystem | Path.Path>): CliConfigIo;
