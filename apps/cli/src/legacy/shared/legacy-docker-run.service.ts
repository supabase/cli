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
   * Runs `docker run --rm ...` capturing stdout into a buffer (instead of
   * inheriting it) while teeing stderr to the parent process and collecting it
   * for classification. Used by `db dump` (which must redirect the SQL stream to
   * `--file` or post-process it) and the declarative edge-runtime export.
   */
  readonly runCapture: (
    opts: LegacyDockerRunOpts,
  ) => Effect.Effect<LegacyDockerRunCaptureResult, LegacyDockerRunError>;
}

export class LegacyDockerRun extends Context.Service<LegacyDockerRun, LegacyDockerRunShape>()(
  "supabase/legacy/DockerRun",
) {}
