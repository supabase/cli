import { Data, Effect, FileSystem, Path } from "effect";
import {
  isUsableServiceVersionTag,
  type LocalServiceVersionOverrides,
} from "../shared/services/services.shared.ts";
import {
  actionability,
  type CliErrorActionabilityDeclaration,
  ErrorActionabilityId,
} from "../shared/telemetry/error-actionability.ts";
import { legacyProjectStatePaths, type LegacyStateFile } from "./legacy-project-state.paths.ts";
import { usesStackState } from "./stack-backend.ts";

/** A saved `.temp` pin is not a usable image tag. The file is left unchanged. */
export class InvalidServiceVersionTagError extends Data.TaggedError(
  "InvalidServiceVersionTagError",
)<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.relinkProject;
  }
}

/**
 * `supabase/.temp/{gotrue,rest,storage,realtime,studio,pgmeta,logflare,pooler}-version` pin
 * files, written by `supabase link` for a linked/bootstrap project and read before any
 * command that pulls or starts these services to override their image tag. `gotrue`/
 * `postgrest` are additionally gated on `majorVersion > 14`.
 */
const VERSION_FILES = [
  ["auth", "gotrueVersion", (majorVersion: number | undefined) => (majorVersion ?? 17) > 14],
  ["postgrest", "restVersion", (majorVersion: number | undefined) => (majorVersion ?? 17) > 14],
  ["storage", "storageVersion"],
  ["realtime", "realtimeVersion"],
  ["studio", "studioVersion"],
  ["pgmeta", "pgmetaVersion"],
  ["analytics", "logflareVersion"],
  ["pooler", "poolerVersion"],
] as const satisfies ReadonlyArray<
  readonly [
    "auth" | "postgrest" | "storage" | "realtime" | "studio" | "pgmeta" | "analytics" | "pooler",
    LegacyStateFile,
    ((majorVersion: number | undefined) => boolean)?,
  ]
>;

/**
 * Reads every linked-service version pin present under `<workdir>/supabase/.temp/`,
 * returning only the services whose pin file exists and is non-blank. Any read error
 * (including not-exist) resolves to "" for that file. A pin that is not a usable
 * image tag fails; the file is not rewritten.
 */
export const readServiceVersionOverrides = Effect.fn("ServiceVersionOverrides.read")(function* (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  workdir: string,
  majorVersion: number | undefined,
) {
  const versions: LocalServiceVersionOverrides = {};
  if (yield* usesStackState) return versions;
  const paths = legacyProjectStatePaths(path, workdir);

  for (const [service, file, shouldRead] of VERSION_FILES) {
    if (shouldRead !== undefined && !shouldRead(majorVersion)) {
      continue;
    }

    const version = yield* fs.readFileString(paths[file]).pipe(
      Effect.map((content) => content.trim()),
      Effect.orElseSucceed(() => ""),
    );
    if (version.length === 0) continue;
    if (!isUsableServiceVersionTag(service, version)) {
      return yield* new InvalidServiceVersionTagError({
        message: `invalid ${service} image tag "${version}" in ${path.relative(workdir, paths[file])}; run supabase link again`,
      });
    }
    versions[service] = version;
  }

  return versions;
});
