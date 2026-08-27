import { Effect, FileSystem, Path } from "effect";
import { type CliConfig } from "./base.ts";
import { type ResolvedFunctionConfig } from "./functions-manifest-model.ts";
interface InferFunctionsManifestOptions {
    readonly cwd: string;
    readonly config?: CliConfig;
    /** Forwarded to {@link findCliProjectPaths}'s own `search` option — see its doc comment. */
    readonly search?: boolean;
}
export declare const inferFunctionsManifest: (options: InferFunctionsManifestOptions) => Effect.Effect<Record<string, ResolvedFunctionConfig>, import("./errors.ts").CliConfigParseError | import("./errors.ts").CliProjectEnvParseError | import("./errors.ts").DuplicateRemoteProjectIdError | import("./errors.ts").InvalidRemoteProjectIdError | import("effect/PlatformError").PlatformError, FileSystem.FileSystem | Path.Path>;
export {};
