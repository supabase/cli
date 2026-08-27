import { Effect, FileSystem, Path } from "effect";
export interface CliProjectPaths {
    readonly projectRoot: string;
    readonly supabaseDir: string;
    readonly configPath: string;
    readonly envPath: string;
    readonly envLocalPath: string;
}
export interface FindCliProjectPathsOptions {
    /**
     * When `false`, only `cwd` itself is checked for `supabase/config.{json,toml}` —
     * no ancestor climb. Go's own resolution never searches twice: an explicit
     * `--workdir`/`SUPABASE_WORKDIR` is used exactly as given (`ChangeWorkDir`,
     * `apps/cli-go/internal/utils/misc.go:238-257`), and once `os.Chdir`'d there,
     * `config.toml` is read as a plain relative path with no further ancestor
     * search (`NewPathBuilder`, `pkg/config/utils.go:43-48`). Ancestor climbing in
     * Go only ever happens once, as the *default* when workdir is unset
     * (`getProjectRoot`, `internal/utils/misc.go:216-231`).
     *
     * Callers that already hold an authoritative, Go-equivalent project root
     * (e.g. the legacy `stop`/`status` ports' `cliSettings.workdir`, which mirrors
     * `ChangeWorkDir`'s own explicit-vs-default resolution) should pass `false`
     * here to avoid a second, un-Go-like ancestor search that could otherwise
     * pick up an unrelated ancestor project's config.
     *
     * Defaults to `true` (the original ancestor-search behavior), so existing
     * callers are unaffected.
     */
    readonly search?: boolean;
}
export declare const findCliProjectPaths: (cwd: string, options?: FindCliProjectPathsOptions | undefined) => Effect.Effect<{
    projectRoot: string;
    supabaseDir: string;
    configPath: string;
    envPath: string;
    envLocalPath: string;
} | null, never, FileSystem.FileSystem | Path.Path>;
export declare const findCliProjectRoot: (cwd: string) => Effect.Effect<string | null, never, FileSystem.FileSystem | Path.Path>;
