import { Effect, FileSystem, Layer, Option, Predicate, Schema } from "effect";
import {
  InvalidProjectLinkStateError,
  ProjectLinkState,
  ProjectLinkStateValueSchema,
  ProjectNotLinkedError,
  type ActiveBranch,
  type ProjectLinkStateValue,
} from "./project-link-state.service.ts";
import { CliProjectHome } from "./cli-project-home.service.ts";

const ProjectLinkStateValueFileSchema = Schema.fromJsonString(ProjectLinkStateValueSchema);
const decodeProjectLinkStateValue = Schema.decodeUnknownEffect(ProjectLinkStateValueFileSchema);
const encodeProjectLinkStateValue = Schema.encodeUnknownEffect(ProjectLinkStateValueSchema);

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
  const cliProjectHome = yield* CliProjectHome;

  const loadFromPath = (filePath: string) =>
    Effect.gen(function* () {
      const exists = yield* fs.exists(filePath);
      if (!exists) {
        return Option.none<ProjectLinkStateValue>();
      }

      const content = yield* fs.readFileString(filePath);
      const decoded = yield* decodeProjectLinkStateValue(content);
      return Option.some(decoded);
    }).pipe(Effect.mapError(() => invalidProjectLinkStateError(filePath)));

  const load = loadFromPath(cliProjectHome.projectLinkPath);

  const save = (state: ProjectLinkStateValue) =>
    Effect.gen(function* () {
      yield* cliProjectHome.ensureCliProjectHomeDir;
      const encoded = yield* encodeProjectLinkStateValue(state).pipe(
        Effect.mapError(() => invalidProjectLinkStateError(cliProjectHome.projectLinkPath)),
      );
      yield* fs.writeFileString(cliProjectHome.projectLinkPath, encodePrettyJson(encoded), {
        mode: 0o600,
      });
    });

  const clear = fs
    .remove(cliProjectHome.projectLinkPath)
    .pipe(
      Effect.catchTag("PlatformError", (error) =>
        Predicate.isTagged(error.reason, "NotFound") ? Effect.void : Effect.fail(error),
      ),
    );

  const getActiveBranch = load.pipe(Effect.map(Option.map((state) => state.active_branch)));

  const setActiveBranch = (branch: ActiveBranch) =>
    Effect.gen(function* () {
      const current = yield* load;
      if (Option.isNone(current)) {
        return yield* new ProjectNotLinkedError({
          detail: "Cannot set active branch: no linked project found.",
          suggestion: "Run `supabase link` to link this checkout to a Supabase project first.",
        });
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
