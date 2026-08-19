import { Effect, FileSystem, Layer, Option, Path, Schema } from "effect";
import { ProjectHome } from "../../next/config/project-home.service.ts";
import {
  InvalidProjectLinkStateError,
  ProjectLinkState,
  ProjectLinkStateValueSchema,
  ProjectNotLinkedError,
  type ActiveBranch,
  type LinkedServiceVersions,
  type ProjectLinkStateValue,
} from "../../next/config/project-link-state.service.ts";
import { LegacyCliConfig } from "../config/legacy-cli-config.service.ts";
import { PROJECT_REF_PATTERN } from "../config/legacy-project-ref.service.ts";
import { legacyParseCachedLinkedProject } from "../shared/legacy-parent-project-ref.ts";
import { legacyReadProjectRefFile, legacyTempPaths } from "../shared/legacy-temp-paths.ts";

const decodeProjectLinkStateValue = Schema.decodeUnknownEffect(
  Schema.fromJsonString(ProjectLinkStateValueSchema),
);
const encodeProjectLinkStateValue = Schema.encodeUnknownSync(ProjectLinkStateValueSchema);

function invalidProjectLinkStateError(filePath: string): InvalidProjectLinkStateError {
  return new InvalidProjectLinkStateError({
    detail: `The linked project state file at ${filePath} is invalid or unreadable.`,
    suggestion: "Fix or remove the file, then retry the command.",
  });
}

function encodePrettyJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

const readOptionalVersion = (fs: FileSystem.FileSystem, filePath: string) =>
  fs.readFileString(filePath).pipe(
    Effect.map((content) => content.trim()),
    Effect.orElseSucceed(() => ""),
    Effect.map((value) => (value.length > 0 ? value : undefined)),
  );

/**
 * Stable-shell `ProjectLinkState` for schema/migrations commands.
 *
 * Prefers next's `.supabase/project.json` when present. Otherwise reconstructs
 * identity from the files `supabase link` actually writes:
 * `supabase/.temp/project-ref`, `linked-project.json`, and version pins.
 */
export const legacySchemaProjectLinkStateLayer = Layer.effect(
  ProjectLinkState,
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const projectHome = yield* ProjectHome;
    const cliConfig = yield* LegacyCliConfig;

    const loadFromPath = (filePath: string) =>
      Effect.gen(function* () {
        const exists = yield* fs
          .exists(filePath)
          .pipe(Effect.mapError(() => invalidProjectLinkStateError(filePath)));
        if (!exists) {
          return Option.none<ProjectLinkStateValue>();
        }

        const content = yield* fs
          .readFileString(filePath)
          .pipe(Effect.mapError(() => invalidProjectLinkStateError(filePath)));
        const decoded = yield* decodeProjectLinkStateValue(content).pipe(
          Effect.mapError(() => invalidProjectLinkStateError(filePath)),
        );
        if (!PROJECT_REF_PATTERN.test(decoded.project.ref)) {
          return yield* new InvalidProjectLinkStateError({
            detail: `The linked project state file at ${filePath} has an invalid project ref.`,
            suggestion: "Fix or remove the file, then retry the command.",
          });
        }
        return Option.some(decoded);
      });

    const loadFromLegacyTemp = Effect.gen(function* () {
      const workdir = cliConfig.workdir;
      const paths = legacyTempPaths(path, workdir);
      let ref: string | undefined;
      if (Option.isSome(cliConfig.projectId)) {
        if (!PROJECT_REF_PATTERN.test(cliConfig.projectId.value)) {
          return yield* new InvalidProjectLinkStateError({
            detail: "SUPABASE_PROJECT_ID is not a valid project ref.",
            suggestion:
              "Set a 20-letter project ref, or unset SUPABASE_PROJECT_ID to use supabase/.temp/project-ref.",
          });
        }
        ref = cliConfig.projectId.value;
      } else {
        const fileRef = yield* legacyReadProjectRefFile(fs, path, workdir).pipe(
          Effect.mapError(
            (error) =>
              new InvalidProjectLinkStateError({
                detail: error.message,
                suggestion: "Fix or remove supabase/.temp/project-ref, then retry.",
              }),
          ),
        );
        if (Option.isSome(fileRef) && !PROJECT_REF_PATTERN.test(fileRef.value)) {
          return yield* new InvalidProjectLinkStateError({
            detail: "supabase/.temp/project-ref is not a valid project ref.",
            suggestion: "Run `supabase link` again, or remove the invalid project-ref file.",
          });
        }
        ref = Option.isSome(fileRef) ? fileRef.value : undefined;
      }
      if (ref === undefined) {
        return Option.none<ProjectLinkStateValue>();
      }

      const cacheContent = yield* fs
        .readFileString(paths.linkedProjectCache)
        .pipe(Effect.orElseSucceed(() => ""));
      const cached = legacyParseCachedLinkedProject(cacheContent);
      const postgres = yield* readOptionalVersion(fs, paths.postgresVersion);
      const postgrest = yield* readOptionalVersion(fs, paths.restVersion);
      const auth = yield* readOptionalVersion(fs, paths.gotrueVersion);
      const storage = yield* readOptionalVersion(fs, paths.storageVersion);
      const versions: LinkedServiceVersions = {
        ...(postgres === undefined ? {} : { postgres }),
        ...(postgrest === undefined ? {} : { postgrest }),
        ...(auth === undefined ? {} : { auth }),
        ...(storage === undefined ? {} : { storage }),
      };

      return Option.some({
        project: {
          ref,
          name: Option.isSome(cached) ? (cached.value.name ?? ref) : ref,
          organization_id: Option.isSome(cached) ? (cached.value.organizationId ?? "") : "",
          organization_slug: Option.isSome(cached) ? (cached.value.organizationSlug ?? "") : "",
        },
        active_branch: {
          ref,
          name: "main",
          is_default: true,
        },
        fetchedAt: "",
        versions,
      } satisfies ProjectLinkStateValue);
    });

    const load = Effect.gen(function* () {
      const next = yield* loadFromPath(projectHome.projectLinkPath);
      if (Option.isSome(next)) return next;
      return yield* loadFromLegacyTemp;
    });

    const save = (state: ProjectLinkStateValue) =>
      Effect.gen(function* () {
        yield* projectHome.ensureProjectHomeDir;
        const encoded = encodeProjectLinkStateValue(state);
        yield* fs.writeFileString(projectHome.projectLinkPath, encodePrettyJson(encoded), {
          mode: 0o600,
        });
      }).pipe(Effect.orDie);

    const clear = fs.remove(projectHome.projectLinkPath).pipe(Effect.ignore, Effect.orDie);

    const getActiveBranch = load.pipe(Effect.map(Option.map((state) => state.active_branch)));

    const setActiveBranch = (branch: ActiveBranch) =>
      Effect.gen(function* () {
        const current = yield* load;
        if (Option.isNone(current)) {
          return yield* Effect.fail(
            new ProjectNotLinkedError({
              detail: "Cannot set active branch: no linked project found.",
              suggestion: "Run `supabase link` to link this checkout to a Supabase project first.",
            }),
          );
        }
        yield* save({ ...current.value, active_branch: branch });
      });

    return ProjectLinkState.of({
      load,
      save,
      clear,
      getActiveBranch,
      setActiveBranch,
    });
  }),
);
