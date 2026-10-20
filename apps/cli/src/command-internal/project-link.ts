import { NamespaceError, publish } from "@supabase/stack/effect";
import { Effect, FileSystem, Option, Path, Schema } from "effect";

import type { ExperimentalFeatureFlagError } from "./experimental-feature.ts";
import type { ProjectRefReadError } from "./legacy-project-state.service.ts";
import {
  actionability,
  type CliErrorActionabilityDeclaration,
  ErrorActionabilityId,
} from "../shared/telemetry/error-actionability.ts";

/** Document name under `<workdir>/supabase`, local to one checkout. */
const PROJECT_LINK_FILENAME = ".link.json";

/** Lines `supabase/.gitignore` needs so the link, the lock, their staged writes, and the stack lease stay out of version control. */
const GITIGNORE_LINES = [
  PROJECT_LINK_FILENAME,
  `.${PROJECT_LINK_FILENAME}.*.tmp`,
  ".supabase.lock.*.tmp",
  ".supabase.lock.lease",
] as const;

const ProjectLinkProject = Schema.Struct({
  ref: Schema.String,
  name: Schema.optionalKey(Schema.String),
  organization_id: Schema.optionalKey(Schema.String),
  organization_slug: Schema.optionalKey(Schema.String),
});

const ProjectLinkActiveBranch = Schema.Struct({
  ref: Schema.String,
  name: Schema.optionalKey(Schema.String),
  is_default: Schema.optionalKey(Schema.Boolean),
  pooler_url: Schema.optionalKey(Schema.String),
});

/**
 * The hosted link target of a stack-mode checkout. `project` is the parent project and
 * `active_branch` the ref commands act on, which is the project's own ref unless a branch was
 * linked.
 */
const ProjectLinkDocument = Schema.Struct({
  project: ProjectLinkProject,
  active_branch: ProjectLinkActiveBranch,
  fetchedAt: Schema.String,
});

export type ProjectLink = typeof ProjectLinkDocument.Type;

const decodeProjectLink = Schema.decodeUnknownEffect(Schema.fromJsonString(ProjectLinkDocument));

/** `supabase/.link.json` exists but does not decode. */
export class ProjectLinkMalformedError extends Schema.TaggedError<ProjectLinkMalformedError>()(
  "ProjectLinkMalformedError",
  { path: Schema.String, message: Schema.String },
) {
  get suggestion(): string {
    return "Run `supabase link` to write the project link again.";
  }

  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.relinkProject;
  }
}

/** Reading, writing, or removing `supabase/.link.json` failed for a reason other than absence. */
export class ProjectLinkIoError extends Schema.TaggedError<ProjectLinkIoError>()(
  "ProjectLinkIoError",
  {
    path: Schema.String,
    message: Schema.String,
  },
) {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.permission;
  }
}

const projectLinkPath = (path: Path.Path, workdir: string): string =>
  path.join(workdir, "supabase", PROJECT_LINK_FILENAME);

export const readProjectLinkFile = Effect.fn("ProjectLink.readFile")(function* (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  workdir: string,
) {
  const file = projectLinkPath(path, workdir);
  const content = yield* fs.readFileString(file).pipe(
    Effect.map(Option.some),
    Effect.catchTag("PlatformError", (error) =>
      error.reason._tag === "NotFound"
        ? Effect.succeed(Option.none<string>())
        : Effect.fail(
            new ProjectLinkIoError({
              path: file,
              message: `failed to read ${file}: ${error.message}`,
            }),
          ),
    ),
  );
  if (Option.isNone(content)) return Option.none<ProjectLink>();
  const link = yield* decodeProjectLink(content.value).pipe(
    Effect.mapError(
      (cause) =>
        new ProjectLinkMalformedError({
          path: file,
          message: `${file} is not a valid project link: ${cause.message}`,
        }),
    ),
  );
  return Option.some(link);
});

/** Reads the link document, `None` when absent. A document that does not decode fails. */
export const readProjectLink = Effect.fn("ProjectLink.read")(function* (workdir: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  return yield* readProjectLinkFile(fs, path, workdir);
});

/**
 * Appends the entries of the local-only files under `supabase/` to `supabase/.gitignore`. A
 * symlinked `.gitignore` is user-managed and stays untouched, so a checkout cannot aim the write
 * at a file outside the project.
 */
export const ensureGitignore = Effect.fn("ProjectLink.ensureGitignore")(function* (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  workdir: string,
) {
  const gitignorePath = path.join(workdir, "supabase", ".gitignore");
  if (Option.isSome(yield* fs.readLink(gitignorePath).pipe(Effect.option))) return;
  const existing = yield* fs
    .readFileString(gitignorePath)
    .pipe(
      Effect.catchTag("PlatformError", (error) =>
        error.reason._tag === "NotFound" ? Effect.succeed("") : Effect.fail(error),
      ),
    );
  const present = new Set(existing.split("\n").map((line) => line.trim()));
  const missing = GITIGNORE_LINES.filter((line) => !present.has(line));
  if (missing.length === 0) return;
  const separator = existing.length === 0 || existing.endsWith("\n") ? "" : "\n";
  yield* publish(fs, path, {
    target: gitignorePath,
    content: `${existing}${separator}${missing.join("\n")}\n`,
    mode: 0o644,
  });
});

/**
 * Publishes the link document atomically after making sure `supabase/.gitignore` ignores it, so
 * a reader sees the prior link or the complete new one.
 */
export const writeProjectLink = Effect.fn("ProjectLink.write")(function* (
  workdir: string,
  link: ProjectLink,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const file = projectLinkPath(path, workdir);
  yield* Effect.annotateCurrentSpan({
    "project.ref": link.project.ref,
    "link.active_ref": link.active_branch.ref,
    "link.has_pooler_url": link.active_branch.pooler_url !== undefined,
  });
  yield* Effect.gen(function* () {
    yield* fs.makeDirectory(path.dirname(file), { recursive: true });
    yield* ensureGitignore(fs, path, workdir);
    yield* publish(fs, path, { target: file, content: `${JSON.stringify(link, null, 2)}\n` });
  }).pipe(
    Effect.catchTags({
      PlatformError: (error) =>
        Effect.fail(
          new ProjectLinkIoError({
            path: file,
            message: `failed to write ${file}: ${error.message}`,
          }),
        ),
      "Namespace.NamespaceError": (error: NamespaceError) =>
        Effect.fail(
          new ProjectLinkIoError({
            path: file,
            message: `failed to write ${file}: ${error.message}`,
          }),
        ),
    }),
  );
});

/** Creates `supabase/`, where the link document and the project lease live. */
export const ensureProjectDirectory = Effect.fn("ProjectLink.ensureDirectory")(function* (
  workdir: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = path.dirname(projectLinkPath(path, workdir));
  yield* fs.makeDirectory(directory, { recursive: true }).pipe(
    Effect.mapError(
      (error) =>
        new ProjectLinkIoError({
          path: directory,
          message: `failed to create ${directory}: ${error.message}`,
        }),
    ),
  );
});

/** Removes the link document; an absent file is not an error. */
export const removeProjectLink = Effect.fn("ProjectLink.remove")(function* (workdir: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const file = projectLinkPath(path, workdir);
  yield* fs.remove(file, { force: true }).pipe(
    Effect.mapError(
      (error) =>
        new ProjectLinkIoError({
          path: file,
          message: `failed to remove ${file}: ${error.message}`,
        }),
    ),
  );
});

/** Failures of reading the linked ref in either project-state mode. */
export type LinkedProjectRefReadError =
  | ProjectRefReadError
  | ProjectLinkMalformedError
  | ProjectLinkIoError
  | ExperimentalFeatureFlagError;
