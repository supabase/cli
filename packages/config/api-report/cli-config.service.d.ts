import type { Effect } from "effect";
import { Context } from "effect";
import type { PlatformError } from "effect/PlatformError";
import type { LoadedCliConfig, LoadCliConfigOptions, SaveCliConfigOptions } from "./config-document.ts";
import type { CliConfigParseError, CliProjectEnvParseError, DuplicateRemoteProjectIdError, InvalidRemoteProjectIdError } from "./errors.ts";
/**
 * Every error a `load`/`loadFile`/`save` rejection can carry: this package's
 * own tagged failures (a malformed config document, a duplicate or
 * malformed `[remotes.*]` block, a malformed `.env`/`.env.local` file) plus
 * `PlatformError`, the single tagged wrapper Effect's `FileSystem` service
 * uses for every host/OS failure (`effect/PlatformError`). A Promise-based
 * consumer (`@supabase/config/io`) can distinguish these via `instanceof`.
 */
type CliConfigStoreError = CliConfigParseError | DuplicateRemoteProjectIdError | InvalidRemoteProjectIdError | CliProjectEnvParseError | PlatformError;
interface CliConfigStoreShape {
    readonly load: (cwd: string, options?: LoadCliConfigOptions) => Effect.Effect<LoadedCliConfig | null, CliConfigStoreError>;
    readonly loadFile: (path: string) => Effect.Effect<LoadedCliConfig, CliConfigStoreError>;
    readonly save: (options: SaveCliConfigOptions) => Effect.Effect<LoadedCliConfig, CliConfigStoreError>;
}
declare const CliConfigStore_base: Context.ServiceClass<CliConfigStore, "@supabase/config/CliConfigStore", CliConfigStoreShape>;
export declare class CliConfigStore extends CliConfigStore_base {
}
export {};
