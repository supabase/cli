import { Context, type Effect, type Option } from "effect";
import type { DockerRunError } from "./docker-run.errors.ts";

type DockerNetwork =
  | { readonly _tag: "host" }
  | { readonly _tag: "named"; readonly name: string }
  | { readonly _tag: "none" };

export interface DockerRunOpts {
  readonly image: string;
  readonly cmd: ReadonlyArray<string>;
  readonly env: Readonly<Record<string, string>>;
  readonly binds: ReadonlyArray<string>;
  readonly workingDir: Option.Option<string>;
  readonly securityOpt: ReadonlyArray<string>;
  /**
   * Overrides the image's `ENTRYPOINT` (docker CLI `--entrypoint`), e.g. running `sh -c <heredoc>`
   * instead of the edge-runtime image's default entrypoint. Omitted (or `None`) keeps the image's
   * own entrypoint.
   */
  readonly entrypoint?: Option.Option<string>;
  /**
   * Extra `host:ip` mappings (`--add-host`): `host.docker.internal:host-gateway` on Linux, empty
   * on macOS/Windows.
   */
  readonly extraHosts: ReadonlyArray<string>;
  readonly network: DockerNetwork;
  /**
   * Docker labels (`--label k=v`) applied to the container. Omitted (the default) for callers
   * whose container is always synchronously reaped by this same process; set by callers whose
   * container can outlive an interrupted process, so `stop`/rollback's project-label filter (see
   * `docker-remove-all.ts`) can still find and remove it if orphaned.
   */
  readonly labels?: Readonly<Record<string, string>>;
  /**
   * Skips this layer's own image resolution when the caller already resolved `image` through a
   * `projectEnvValues`-aware path. This layer's own resolver has no `projectEnvValues` in scope,
   * so re-resolving an already-resolved image would rebuild registry candidates using the default
   * registry, discarding a project-dotenv-only registry override. Defaults to `false`.
   */
  readonly skipImageResolve?: boolean;
}

/**
 * The result of a captured `docker run`: the container's exit code, its full stdout as raw bytes
 * (so binary-safe output survives intact), and its stderr decoded as text for failure
 * classification.
 */
interface DockerRunCaptureResult {
  readonly exitCode: number;
  readonly stdout: Uint8Array;
  readonly stderr: string;
}

interface DockerRunShape {
  /** Runs `docker run --rm ...`, inheriting stdio, returns the container's exit code. */
  readonly run: (opts: DockerRunOpts) => Effect.Effect<number, DockerRunError>;
  /**
   * Runs `docker run --rm ...`, capturing the full stdout into a buffer (instead of inheriting
   * it) and collecting stderr for classification. Used by callers that must parse the whole
   * stdout payload (e.g. as JSON) rather than stream it (`db dump` streams instead — see
   * {@link runStream}).
   *
   * `teeStderr` controls whether container stderr is also written to the parent terminal in real
   * time.
   */
  readonly runCapture: (
    opts: DockerRunOpts,
    captureOpts?: { readonly teeStderr?: boolean },
  ) => Effect.Effect<DockerRunCaptureResult, DockerRunError>;
  /**
   * Runs `docker run --rm ...`, streaming container stdout to `onStdout` chunk-by-chunk as it
   * arrives (instead of buffering), while collecting stderr for classification. `onStdout` chunks
   * are delivered in arrival order; its failure aborts the run and propagates as `E`. Returns the
   * exit code and captured stderr; stdout bytes are not retained.
   *
   * `teeStderr` mirrors {@link runCapture}. `captureStderr` (default `true`) buffers stderr for
   * the returned string — pass `false` when the caller only tees it, since a container with
   * unbounded stderr (e.g. `test db`'s pgTAP notices) would otherwise grow without bound.
   */
  readonly runStream: <E>(
    opts: DockerRunOpts,
    streamOpts: {
      readonly onStdout: (chunk: Uint8Array) => Effect.Effect<void, E>;
      readonly teeStderr?: boolean;
      readonly captureStderr?: boolean;
    },
  ) => Effect.Effect<{ readonly exitCode: number; readonly stderr: string }, DockerRunError | E>;
}

export class DockerRun extends Context.Service<DockerRun, DockerRunShape>()(
  "supabase/cli/DockerRun",
) {}
