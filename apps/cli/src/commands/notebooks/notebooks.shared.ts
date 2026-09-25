import type { ApiClient } from "@supabase/api/effect";
import { V2GetNotebookInput, V2UpdateNotebookInput } from "@supabase/api/effect";
import { Effect, Exit, FileSystem, Option, Path, Schema, Stream } from "effect";
import { Output } from "../../shared/output/output.service.ts";
import { notebooksMachineOutputRequested } from "./notebooks.output.ts";
import { sanitizeInlineName, mapHttpError } from "../../command-internal/http-errors.ts";
import {
  canonicalPathForContainment,
  isPathContainedInRoot,
} from "../../command-internal/path-containment.ts";
import {
  NotebookFileError,
  NotebookIdError,
  NotebookNameConflictError,
  NotebooksNetworkError,
  NotebooksPaginationError,
  NotebooksUnexpectedStatusError,
} from "./notebooks.errors.ts";

/**
 * The shared half of `supabase notebooks push` / `pull`: where notebooks live on
 * disk, what a notebook file is, and the five Management API routes both
 * commands drive. The handlers own the flow — which side is copied where, and
 * what to do about the notebooks only one side has. This module provides the
 * shared reconciliation prompt.
 *
 * A notebook's identity across the two sides is its **name**, which is the file
 * name: the API assigns a uuid, but a checkout is shared through git and a uuid
 * in a filename is unreadable, so the name is what a push matches on. Names are
 * not unique in the API, so a project holding two notebooks of one name is
 * refused rather than guessed at (`NotebookNameConflictError`).
 */

/** `supabase/notebooks/`, alongside `supabase/functions/` and `supabase/workers/`. */
export const notebooksDir = Effect.fnUntraced(function* (workdir: string) {
  const path = yield* Path.Path;
  return path.join(workdir, "supabase", "notebooks");
});

const notebookFileExtension = ".json";

/**
 * `--project-ref` is a project identifier, not user content, so its value is
 * logged verbatim — the same call `functions download` / `functions deploy` make
 * for the same flag.
 */
export const notebooksProjectRefSafeFlags = ["project-ref"] as const;

/** Page size for the list walk — the API's maximum, so the walk is one call in practice. */
const NOTEBOOK_PAGE_SIZE = 100;

const updateAttributes = V2UpdateNotebookInput.fields.data.fields.attributes.fields;
const notebookIdSchema = V2GetNotebookInput.fields.id;

/**
 * A notebook file is the notebook's API attributes minus the ones the file
 * cannot own: `name` is the file name, and the server owns the timestamps and
 * the `owner` / `updated_by` identities. Deriving the fields from the generated
 * update input keeps the cell union in one place — the file format changes when
 * the API's does, with no schema here to fall behind it.
 *
 * `content` is required: a notebook file without cells is not a notebook. Cell
 * `id`s are written back out on pull and echoed on push, which is how a cell
 * keeps its identity across an update instead of being replaced by a copy.
 */
const NotebookFileSchema = Schema.Struct({
  description: updateAttributes.description,
  favorite: updateAttributes.favorite,
  content: Schema.requiredKey(updateAttributes.content),
});

export type NotebookFile = typeof NotebookFileSchema.Type;

const NotebookFileJson = Schema.fromJsonString(Schema.Unknown, { space: 2 });

const NameJson = Schema.fromJsonString(Schema.String);

const quoteName = (name: string) => Schema.encodeEffect(NameJson)(name).pipe(Effect.orDie);

/** A project notebook as the list route describes it — no cells. */
export interface RemoteNotebook {
  readonly id: string;
  readonly name: string;
}

/**
 * Whether a notebook name can be a file name in `supabase/notebooks/`. A
 * notebook name is free text up to 255 characters, so it can hold a path
 * separator, and joining that onto the notebooks directory would write outside
 * it. Pull reports the ones it skipped rather than sanitising them into a name
 * that would then push back as a rename.
 */
export function isNotebookNameWritable(name: string): boolean {
  if (name.length === 0 || name === "." || name === ".." || /[. ]$/.test(name)) return false;
  // Keep committed filenames portable, including Windows device names with extensions.
  if (/^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(name)) return false;
  if (new TextEncoder().encode(`${name}${notebookFileExtension}`).length > 255) return false;
  return !name.split("").some((char) => {
    const code = char.charCodeAt(0);
    return '<>:"/\\|?*'.includes(char) || code < 0x20 || code === 0x7f;
  });
}

const notebookFilePath = Effect.fnUntraced(function* (workdir: string, name: string) {
  const path = yield* Path.Path;
  return path.join(yield* notebooksDir(workdir), `${name}${notebookFileExtension}`);
});

/**
 * Refuses a notebooks path that canonicalizes outside the project root. A checkout is shared
 * through git, which carries symlinks, so `supabase/notebooks` or a single entry inside it can
 * point anywhere the user can write; without this the command would read, replace, or delete
 * files elsewhere on disk. Same rule and failure mode as email template `content_path`
 * (`resolveEmailTemplateContentPath`).
 */
const ensureNotebookPathContained = Effect.fnUntraced(function* (workdir: string, path: string) {
  const contained = yield* Effect.try({
    try: () =>
      isPathContainedInRoot(
        canonicalPathForContainment(workdir),
        canonicalPathForContainment(path),
      ),
    catch: (cause) =>
      new NotebookFileError({
        detail: `Cannot resolve ${path}: ${cause instanceof Error ? cause.message : String(cause)}`,
        suggestion: "Check the notebooks path is a readable directory.",
      }),
  });
  if (!contained) {
    // Echoes the declared path rather than what it resolves to, so a hostile checkout cannot
    // use the error to probe where its symlink lands.
    return yield* new NotebookFileError({
      detail: `${path} resolves outside the project root ${workdir}.`,
      suggestion: "Remove the symlink so supabase/notebooks stays inside the project.",
    });
  }
  return path;
});

export const validateNotebookId = Effect.fnUntraced(function* (value: string) {
  return yield* Schema.decodeEffect(notebookIdSchema)(value).pipe(
    Effect.mapError(
      () =>
        new NotebookIdError({
          detail: `${JSON.stringify(value)} is not a notebook id.`,
          suggestion: "Pass the UUID shown in the notebook's dashboard URL.",
        }),
    ),
  );
});

const ensureNotebookNameWritable = Effect.fnUntraced(function* (name: string) {
  if (!isNotebookNameWritable(name)) {
    return yield* new NotebookFileError({
      detail: `The project notebook name ${yield* quoteName(name)} cannot be stored as a file name.`,
      suggestion: "Rename the notebook in the dashboard, then run the command again.",
    });
  }
  return name;
});

/**
 * The notebook names `supabase/notebooks/` holds, sorted, so both commands walk
 * them in a stable order rather than whatever the filesystem returned. A
 * missing directory is an empty project, not a failure — `pull` creates it.
 */
const readNotebookDirectory = Effect.fnUntraced(function* (workdir: string) {
  const fs = yield* FileSystem.FileSystem;
  const dir = yield* ensureNotebookPathContained(workdir, yield* notebooksDir(workdir));
  const entries = yield* fs.readDirectory(dir).pipe(
    Effect.catchReason(
      "PlatformError",
      "NotFound",
      () => Effect.succeed<ReadonlyArray<string>>([]),
      (_reason, cause) =>
        Effect.fail(
          new NotebookFileError({
            detail: `Cannot read ${dir}: ${cause.message}`,
            suggestion: "Check the notebooks path is a readable directory.",
          }),
        ),
    ),
  );

  return entries;
});

export const listLocalNotebooks = Effect.fnUntraced(function* (workdir: string) {
  return (yield* readNotebookDirectory(workdir))
    .filter((entry) => entry.endsWith(notebookFileExtension))
    .map((entry) => entry.slice(0, -notebookFileExtension.length))
    .filter((name) => isNotebookNameWritable(name))
    .sort();
});

/**
 * Whether two file names collide on a case-insensitive filesystem. `toLowerCase` is not case
 * folding — Greek `ς` and `σ` stay distinct under it while APFS and NTFS store them as one
 * name — so comparison runs at the collator's accent sensitivity, which ignores case and
 * normalization form but keeps genuinely different names (`ß`/`ss`, `İ`/`i`) apart.
 */
const portableFilenameCollator = new Intl.Collator(undefined, { sensitivity: "accent" });

function isPortableFilenameAlias(left: string, right: string): boolean {
  return portableFilenameCollator.compare(left, right) === 0;
}

/** Reject aliases on every platform so a checkout can safely move between filesystems. */
export const ensureNotebookDestinationsUnique = Effect.fnUntraced(function* (
  workdir: string,
  names: ReadonlyArray<string>,
) {
  const destinations: Array<string> = [];
  const existing = yield* readNotebookDirectory(workdir);
  for (const name of names) {
    yield* ensureNotebookNameWritable(name);
    const filename = `${name}${notebookFileExtension}`;
    const collision =
      destinations.find((entry) => isPortableFilenameAlias(entry, filename)) ??
      existing.find((entry) => isPortableFilenameAlias(entry, filename) && entry !== filename);
    if (collision !== undefined) {
      return yield* new NotebookNameConflictError({
        detail: `${yield* quoteName(filename)} and ${yield* quoteName(collision)} refer to the same portable filename.`,
        suggestion: "Rename the conflicting notebooks or local files before pulling them.",
      });
    }
    destinations.push(filename);
  }
});

export const readNotebookFile = Effect.fnUntraced(function* (workdir: string, name: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* ensureNotebookPathContained(workdir, yield* notebookFilePath(workdir, name));

  const contents = yield* fs.readFileString(path).pipe(
    Effect.mapError(
      (cause) =>
        new NotebookFileError({
          detail: `Cannot read ${path}: ${cause.message}`,
          suggestion: "Check the file exists and is readable.",
        }),
    ),
  );

  const parsed = yield* Effect.try({
    try: () => parseNotebookJson(contents),
    catch: (cause) =>
      new NotebookFileError({
        detail: `${path} is not valid JSON: ${String(cause)}`,
        suggestion:
          "Run supabase notebooks pull <notebook-id> to replace it with the project's copy.",
      }),
  });

  return yield* Schema.decodeUnknownEffect(NotebookFileSchema)(parsed).pipe(
    Effect.mapError(
      (cause) =>
        new NotebookFileError({
          detail: `${path} is not a notebook: ${cause.message}`,
          suggestion:
            "Run supabase notebooks pull <notebook-id> to replace it with the project's copy.",
        }),
    ),
  );
});

// Native `JSON.parse` keeps the runtime's syntax-error text in the `is not valid JSON` message.
function parseNotebookJson(text: string): unknown {
  return JSON.parse(text);
}

/**
 * Writes one notebook file, creating `supabase/notebooks/` if this is the first.
 * Trailing newline and two-space indent so a pulled notebook is a normal
 * committed JSON file rather than one line the next diff cannot be read.
 */
export const writeNotebookFile = Effect.fnUntraced(function* (
  workdir: string,
  name: string,
  notebook: NotebookFile,
  mode: "create" | "replace" = "create",
) {
  const fs = yield* FileSystem.FileSystem;
  yield* ensureNotebookNameWritable(name);
  const dir = yield* notebooksDir(workdir);
  const path = yield* ensureNotebookPathContained(workdir, yield* notebookFilePath(workdir, name));

  yield* Effect.gen(function* () {
    yield* fs.makeDirectory(dir, { recursive: true });
    const temporaryPath = yield* fs.makeTempFileScoped({ directory: dir, prefix: ".notebook-" });
    const contents = yield* Schema.encodeEffect(NotebookFileJson)(notebook).pipe(Effect.orDie);
    yield* fs.writeFileString(temporaryPath, `${contents}\n`);
    if (mode === "replace") {
      yield* fs.rename(temporaryPath, path);
    } else {
      // A hard link publishes the complete file atomically and refuses existing destinations.
      yield* fs.link(temporaryPath, path);
    }
  }).pipe(
    Effect.scoped,
    Effect.catchTag(
      "PlatformError",
      (cause) =>
        new NotebookFileError({
          detail: `Cannot write ${path}: ${cause.message}`,
          suggestion: "Check the notebooks directory is writable.",
        }),
    ),
  );
});

export const removeNotebookFile = Effect.fnUntraced(function* (workdir: string, name: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* ensureNotebookPathContained(workdir, yield* notebookFilePath(workdir, name));
  yield* fs.remove(path).pipe(
    Effect.mapError(
      (cause) =>
        new NotebookFileError({
          detail: `Cannot remove ${path}: ${cause.message}`,
          suggestion: "Check the notebook file and directory permissions.",
        }),
    ),
  );
});

const mapNotebookHttpError = (subject: string) => {
  const label = sanitizeInlineName(subject);
  return mapHttpError({
    networkError: NotebooksNetworkError,
    statusError: NotebooksUnexpectedStatusError,
    networkMessage: (cause) => `failed to ${label}: ${cause}`,
    statusMessage: (status, body) => `unexpected ${label} status ${status}: ${body}`,
  });
};

const withNotebookTask =
  (subject: string) =>
  <A, E, R>(self: Effect.Effect<A, E, R>) =>
    Effect.gen(function* () {
      const output = yield* Output;
      if (output.format !== "text" || (yield* notebooksMachineOutputRequested()))
        return yield* self;
      return yield* Effect.acquireUseRelease(
        output.task(`${sanitizeInlineName(subject)}...`),
        () => self,
        (task, exit) => (Exit.isFailure(exit) ? task.fail() : task.clear()),
      );
    });

interface NotebookListCursor {
  readonly after: string | undefined;
  readonly visited: ReadonlySet<string>;
}

type NotebookListPage = readonly [ReadonlyArray<RemoteNotebook>, Option.Option<NotebookListCursor>];

const listRemoteNotebookPage = Effect.fnUntraced(function* (
  api: ApiClient,
  ref: string,
  cursor: NotebookListCursor,
) {
  const page = yield* api.v2
    .listNotebooks({
      ref,
      page: {
        size: NOTEBOOK_PAGE_SIZE,
        ...(cursor.after === undefined ? {} : { after: cursor.after }),
      },
      sort: "name",
    })
    .pipe(
      Effect.catch(mapNotebookHttpError("list notebooks")),
      withNotebookTask("Listing notebooks"),
    );

  const notebooks = page.data.map((resource): RemoteNotebook => ({
    id: resource.id,
    name: resource.attributes.name,
  }));

  const next = page.links.next;
  if (next === null) {
    const last: NotebookListPage = [notebooks, Option.none()];
    return last;
  }
  // The cursor is opaque, so it is read back out of the link the server built
  // rather than derived from the rows. `links.next` is a path, so its query is
  // taken from the string directly rather than through a URL and a made-up base.
  const after = new URLSearchParams(next.split("?")[1] ?? "").get("page[after]");
  // A link with no cursor, or one repeating the cursor already walked, would
  // loop forever. Neither is a page this command can make progress on.
  if (after === null || after.length === 0 || cursor.visited.has(after)) {
    return yield* new NotebooksPaginationError({
      message:
        "The notebook list returned a missing or repeated pagination cursor. No reconciliation was performed.",
    });
  }
  const more: NotebookListPage = [
    notebooks,
    Option.some({ after, visited: new Set([...cursor.visited, after]) }),
  ];
  return more;
});

/**
 * Every notebook in the project. The list route is cursor-paginated and its
 * `links.next` carries the cursor for the following page, so the walk follows
 * that rather than counting rows: `next` is null exactly when the page was the
 * last one, which a length comparison cannot tell on an exact multiple.
 */
export const listRemoteNotebooks = Effect.fnUntraced(function* (api: ApiClient, ref: string) {
  return yield* Stream.paginate(
    { after: undefined, visited: new Set<string>() },
    (cursor: NotebookListCursor) => listRemoteNotebookPage(api, ref, cursor),
  ).pipe(Stream.runCollect);
});

export const ensureRemoteNotebookNamesUnique = Effect.fnUntraced(function* (
  remote: ReadonlyArray<RemoteNotebook>,
) {
  const counts = new Map<string, number>();
  for (const notebook of remote) {
    counts.set(notebook.name, (counts.get(notebook.name) ?? 0) + 1);
  }
  for (const [name, count] of counts) {
    if (count > 1) {
      return yield* new NotebookNameConflictError({
        detail: `The project has ${count} notebooks named ${yield* quoteName(name)}.`,
        suggestion:
          "Rename them in the dashboard so each notebook has its own name, then run the command again.",
      });
    }
  }
});

const readRemoteNotebook = Effect.fnUntraced(function* (
  api: ApiClient,
  ref: string,
  id: string,
  subject: string,
) {
  const response = yield* api.v2
    .getNotebook({ ref, id })
    .pipe(
      Effect.catch(mapNotebookHttpError(`read notebook ${subject}`)),
      withNotebookTask(`Downloading notebook ${subject}`),
    );

  const { description, favorite, content, name } = response.data.attributes;
  return {
    notebook: { id: response.data.id, name } satisfies RemoteNotebook,
    file: {
      ...(description === null ? {} : { description }),
      favorite,
      content: { cells: content.cells },
    } satisfies NotebookFile,
  };
});

/** Reads one project notebook and returns it in the shape a notebook file holds. */
export const downloadNotebook = Effect.fnUntraced(function* (
  api: ApiClient,
  ref: string,
  notebook: RemoteNotebook,
) {
  // `schema_version` is dropped: the server owns it, and the update route's
  // `content` does not accept it back. A null `description` becomes an absent
  // key rather than `"description": null` — the update route takes a string or
  // nothing, so a written null would not push back.
  return (yield* readRemoteNotebook(api, ref, notebook.id, notebook.name)).file;
});

export const downloadNotebookById = Effect.fnUntraced(function* (
  api: ApiClient,
  ref: string,
  id: string,
) {
  return yield* readRemoteNotebook(api, ref, id, id);
});

/**
 * Writes one notebook file to the project — updating the notebook of that name
 * when there is one, and creating it otherwise. Returns which of the two
 * happened so the caller can report it.
 */
export const uploadNotebook = Effect.fnUntraced(function* (options: {
  readonly api: ApiClient;
  readonly ref: string;
  readonly name: string;
  readonly file: NotebookFile;
  readonly existing: RemoteNotebook | undefined;
}) {
  // Keys the file left out stay out of the request rather than going up as
  // explicit nulls, which is how `favorite` keeps whatever the dashboard set on
  // a notebook whose file never mentions it.
  const data = {
    type: "notebook" as const,
    attributes: {
      name: options.name,
      ...(options.file.description === undefined ? {} : { description: options.file.description }),
      ...(options.file.favorite === undefined ? {} : { favorite: options.file.favorite }),
      content: options.file.content,
    },
  };

  if (options.existing === undefined) {
    yield* options.api.v2
      .createNotebook({ ref: options.ref, data })
      .pipe(
        Effect.catch(mapNotebookHttpError(`create notebook ${options.name}`)),
        withNotebookTask(`Creating notebook ${options.name}`),
      );
    return "created" as const;
  }

  yield* options.api.v2
    .updateNotebook({ ref: options.ref, id: options.existing.id, data })
    .pipe(
      Effect.catch(mapNotebookHttpError(`update notebook ${options.name}`)),
      withNotebookTask(`Updating notebook ${options.name}`),
    );
  return "updated" as const;
});

export const deleteRemoteNotebook = Effect.fnUntraced(function* (
  api: ApiClient,
  ref: string,
  notebook: RemoteNotebook,
) {
  yield* api.v2
    .deleteNotebook({ ref, id: notebook.id })
    .pipe(
      Effect.catch(mapNotebookHttpError(`delete notebook ${notebook.name}`)),
      withNotebookTask(`Deleting notebook ${notebook.name}`),
    );
});

/** What to do about the notebooks only one of the two sides has. */
export type NotebooksReconcileChoice = "keep" | "delete" | "copy";

/**
 * Asks what should happen to the notebooks the other side does not have.
 *
 * Three answers rather than a confirmation, because the two useful ones point
 * opposite ways: a notebook missing from a checkout is either one somebody
 * deleted and the project has not caught up with, or one somebody added on the
 * other side that the checkout has not caught up with. Nothing in either list
 * says which, so the command asks instead of picking.
 *
 * `keep` is the answer whenever there is nobody to ask — a non-TTY, a machine
 * output format, or a cancelled prompt. The other answers mutate local or remote
 * state, so the unattended run reports the divergence and leaves both sides alone rather
 * than resolving it in a direction nobody chose.
 */
export const promptNotebooksReconcile = Effect.fnUntraced(function* (options: {
  readonly summary: string;
  readonly names: ReadonlyArray<string>;
  readonly deleteLabel: string;
  readonly copyLabel: string;
  /** `-o json|yaml|toml|env` — stdout belongs to the payload, so do not prompt. */
  readonly machineOutput: boolean;
}) {
  const output = yield* Output;

  const listing = `${options.summary}\n${options.names.map((name) => ` • ${sanitizeInlineName(name)}`).join("\n")}\n`;
  yield* output.raw(listing, "stderr");

  if (output.format !== "text" || !output.interactive || options.machineOutput) {
    yield* output.raw("Left alone — rerun interactively to resolve.\n", "stderr");
    return "keep";
  }

  const answer = yield* output
    .promptSelect(
      "What should happen to them?",
      [
        { value: "keep", label: "Leave them alone" },
        { value: "copy", label: options.copyLabel },
        { value: "delete", label: options.deleteLabel },
      ],
      // The listing above is on stderr, and clack renders to stdout by default,
      // which would split one question across two streams.
      { stream: "stderr" },
    )
    .pipe(Effect.orElseSucceed(() => "keep"));

  // `promptSelect` hands back a bare string, so the three answers are narrowed
  // rather than trusted — an unrecognised one leaves both sides alone.
  return answer === "copy" || answer === "delete"
    ? answer
    : ("keep" satisfies NotebooksReconcileChoice);
});
