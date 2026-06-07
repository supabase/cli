import { Effect, FileSystem, Layer, Option, Schema } from "effect";
import {
  InvalidProjectLinkStateError,
  ProjectLinkState,
  ProjectLinkStateValueSchema,
  ProjectNotLinkedError,
  type ActiveBranch,
  type ProjectLinkStateValue,
} from "./project-link-state.service.ts";
import { ProjectHome } from "./project-home.service.ts";

const ProjectLinkStateValueFileSchema = Schema.fromJsonString(ProjectLinkStateValueSchema);
const decodeProjectLinkStateValue = Schema.decodeUnknownEffect(ProjectLinkStateValueFileSchema);
const encodeProjectLinkStateValue = Schema.encodeUnknownSync(ProjectLinkStateValueSchema);

function encodePrettyJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function invalidProjectLinkStateError(filePath: string): InvalidProjectLinkStateError {
  return new InvalidProjectLinkStateError({
    detail: `The linked project state file at ${filePath} is invalid or unreadable.`,
    suggestion: "Fix or remove project.json, then retry the command.",
  });
}

const makeProjectLinkState = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const projectHome = yield* ProjectHome;

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
      return Option.some(decoded);
    });

  const load = Effect.gen(function* () {
    return yield* loadFromPath(projectHome.projectLinkPath);
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
});

export const projectLinkStateLayer = Layer.effect(ProjectLinkState, makeProjectLinkState);
