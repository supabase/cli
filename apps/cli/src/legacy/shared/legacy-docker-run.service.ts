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
   * Extra `host:ip` mappings (`--add-host`). Go populates `HostConfig.ExtraHosts`
   * in `DockerStart` with `host.docker.internal:host-gateway` on Linux
   * (`apps/cli-go/internal/utils/docker_linux.go`); empty on macOS/Windows.
   */
  readonly extraHosts: ReadonlyArray<string>;
  readonly network: LegacyDockerNetwork;
}

interface LegacyDockerRunShape {
  /** Runs `docker run --rm ...`, inheriting stdio, returns the container's exit code. */
  readonly run: (opts: LegacyDockerRunOpts) => Effect.Effect<number, LegacyDockerRunError>;
}

export class LegacyDockerRun extends Context.Service<LegacyDockerRun, LegacyDockerRunShape>()(
  "supabase/legacy/DockerRun",
) {}
