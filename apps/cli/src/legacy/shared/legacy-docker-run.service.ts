import { Context, type Effect, type Option } from "effect";
import type { LegacyDockerRunError } from "./legacy-docker-run.errors.ts";

type LegacyDockerNetwork =
  | { readonly _tag: "host" }
  | { readonly _tag: "named"; readonly name: string }
  | { readonly _tag: "none" };

export interface LegacyDockerRunOpts {
  readonly image: string;
  readonly cmd: ReadonlyArray<string>;
  readonly env: Readonly<Record<string, string>>;
  readonly binds: ReadonlyArray<string>;
  readonly workingDir: Option.Option<string>;
  readonly securityOpt: ReadonlyArray<string>;
  /**
   * Overrides the image's `ENTRYPOINT` (docker CLI `--entrypoint`). Go sets
   * `container.Config.Entrypoint` directly when it must replace an image's own
   * entrypoint — e.g. `RunEdgeRuntimeScript` runs `sh -c <heredoc>` instead of
   * the edge-runtime image's default `edge-runtime` entrypoint
   * (`apps/cli-go/internal/utils/edgeruntime.go`). Omitted (or `None`) keeps the
   * image's entrypoint, matching the pg_dump / pg_prove containers.
   */
  readonly entrypoint?: Option.Option<string>;
  /**
   * Extra `host:ip` mappings (`--add-host`). Go populates `HostConfig.ExtraHosts`
   * in `DockerStart` with `host.docker.internal:host-gateway` on Linux
   * (`apps/cli-go/internal/utils/docker_linux.go`); empty on macOS/Windows.
   */
  readonly extraHosts: ReadonlyArray<string>;
  readonly network: LegacyDockerNetwork;
  /**
   * Docker labels (`--label k=v`) applied to the container. Go's `DockerStart`
   * unconditionally sets `com.supabase.cli.project`/`com.docker.compose.project`
   * on every container it starts (`apps/cli-go/internal/utils/docker.go:371-376`),
   * including one-shot jobs — omitted here (defaults to none) for callers whose
   * container is always synchronously reaped by the SAME process before it could
   * ever need project-label-based discovery (e.g. `db dump`/`pg_prove`/edge-runtime
   * one-shot runs); set by callers whose container can outlive an interrupted
   * process (e.g. `start`'s fresh-volume PG15+ realtime/storage/auth migrate jobs)
   * so `supabase stop`/rollback's project-label filter
   * (`legacy-docker-remove-all.ts`) can still find and remove it if orphaned.
   */
  readonly labels?: Readonly<Record<string, string>>;
  /**
   * Skips this layer's own image resolution (`legacyMakeDockerImageResolver`) when the
   * caller already resolved `image` itself through a `projectEnvValues`-aware path (e.g.
   * `start`'s one-shot fresh-DB setup jobs, resolved via `legacyEnsureImagesCached` before
   * `legacyStartSetupLocalDatabase` ever calls this service). This layer's own resolver is
   * built once, statically, with no `projectEnvValues` in scope (see
   * `legacy-docker-run.layer.ts`'s header) — re-resolving an ALREADY-resolved image (e.g.
   * `registry.example.com/supabase/gotrue:v2.192.0`) would treat it as a fresh, unresolved
   * image reference and rebuild registry candidates from it using the DEFAULT registry,
   * silently discarding a project-dotenv-only `SUPABASE_INTERNAL_IMAGE_REGISTRY` override.
   * Defaults to `false` (existing ambient-only resolution) for every other caller.
   */
  readonly skipImageResolve?: boolean;
}

/**
 * The result of a captured `docker run`: the container's exit code, its full
 * stdout as raw bytes (so binary-safe SQL dumps survive intact), and its stderr
 * decoded as text for failure classification. Mirrors Go's `dockerExec`, which
 * streams stdout to the caller's writer and tees stderr into a buffer
 * (`apps/cli-go/internal/db/dump/dump.go:50-90`).
 */
interface LegacyDockerRunCaptureResult {
  readonly exitCode: number;
  readonly stdout: Uint8Array;
  readonly stderr: string;
}

interface LegacyDockerRunShape {
  /** Runs `docker run --rm ...`, inheriting stdio, returns the container's exit code. */
  readonly run: (opts: LegacyDockerRunOpts) => Effect.Effect<number, LegacyDockerRunError>;
  /**
   * Runs `docker run --rm ...` capturing the full stdout into a buffer (instead of
   * inheriting it) and collecting stderr for classification. Used by the declarative
   * edge-runtime / pg-delta export, which must parse the whole stdout payload as JSON.
   * (`db dump` streams instead — see {@link runStream}.)
   *
   * `teeStderr` controls whether container stderr is also written to the parent
   * terminal in real time. The edge-runtime / pg-delta path leaves it off (Go passes
   * a plain `bytes.Buffer`, surfacing stderr only on failure —
   * `apps/cli-go/internal/utils/edgeruntime.go:79-113`).
   */
  readonly runCapture: (
    opts: LegacyDockerRunOpts,
    captureOpts?: { readonly teeStderr?: boolean },
  ) => Effect.Effect<LegacyDockerRunCaptureResult, LegacyDockerRunError>;
  /**
   * Runs `docker run --rm ...` streaming container stdout to `onStdout` chunk-by-chunk
   * as it arrives (instead of buffering), while collecting stderr for classification.
   * Mirrors Go's `DockerStreamLogs` → `stdcopy.StdCopy(stdout, stderr, logs)` with
   * `Follow:true` (`apps/cli-go/internal/utils/docker.go:374,394`): the destination is
   * the real sink, so a large `db dump` streams to `--file`/stdout at constant memory
   * and a piped consumer sees output incrementally.
   *
   * `onStdout` chunks are delivered in arrival order; its failure aborts the run and
   * propagates as `E`. `teeStderr` mirrors `runCapture` (Go's
   * `io.MultiWriter(os.Stderr, errBuf)`). Returns the exit code + captured stderr; the
   * stdout bytes are not retained.
   */
  readonly runStream: <E>(
    opts: LegacyDockerRunOpts,
    streamOpts: {
      readonly onStdout: (chunk: Uint8Array) => Effect.Effect<void, E>;
      readonly teeStderr?: boolean;
    },
  ) => Effect.Effect<
    { readonly exitCode: number; readonly stderr: string },
    LegacyDockerRunError | E
  >;
}

export class LegacyDockerRun extends Context.Service<LegacyDockerRun, LegacyDockerRunShape>()(
  "supabase/legacy/DockerRun",
) {}
