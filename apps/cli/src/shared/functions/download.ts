import { operationDefinitions, type ApiClient } from "@supabase/api/effect";
import { randomUUID } from "node:crypto";
import { open, rename, rm } from "node:fs/promises";
import { dirname, isAbsolute, join, posix, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { Effect, FileSystem, Option } from "effect";
import * as HttpClientError from "effect/unstable/http/HttpClientError";
import type * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import { Output } from "../output/output.service.ts";
import { invalidFunctionSlugDetail, validateFunctionSlugMessage } from "./functions.shared.ts";
import {
  ConflictingFunctionDownloadFlagsError,
  FunctionDownloadNotFoundError,
  InvalidFunctionDownloadResponseError,
  InvalidFunctionSlugError,
  UnsafeFunctionDownloadPathError,
} from "./download.errors.ts";

const legacyEntrypointPath = "file:///src/index.ts";

export interface DownloadFunctionsOptions {
  readonly functionName: Option.Option<string>;
  readonly projectRef: Option.Option<string>;
  readonly useApi: boolean;
  readonly useDocker: boolean;
  readonly legacyBundle: boolean;
}

export interface DownloadFunctionsDependencies<
  ResolveError,
  ResolveRequirements,
  ProxyError,
  ProxyRequirements,
> {
  readonly api: ApiClient;
  readonly projectRoot: string;
  readonly resolveProjectRef: (
    projectRef: Option.Option<string>,
  ) => Effect.Effect<string, ResolveError, ResolveRequirements>;
  readonly proxyDownload: (
    flags: DownloadFunctionsOptions,
    projectRef: string,
  ) => Effect.Effect<void, ProxyError, ProxyRequirements>;
}

interface DownloadRuntimeDependencies {
  readonly api: ApiClient;
  readonly projectRoot: string;
}

export function makeGoProxyDownloadArgs(
  flags: DownloadFunctionsOptions,
  projectRef: string,
): ReadonlyArray<string> {
  const args: string[] = ["functions", "download"];
  if (Option.isSome(flags.functionName)) {
    args.push(flags.functionName.value);
  }
  args.push("--project-ref", projectRef);
  if (flags.useDocker) {
    args.push("--use-docker");
  }
  if (flags.legacyBundle) {
    args.push("--legacy-bundle");
  }
  return args;
}

interface DownloadMetadata {
  readonly entrypoint_path?: string;
}

interface DownloadFilePart {
  readonly path: string;
  readonly body: Uint8Array;
}

interface DecodedMultipartForm {
  readonly metadata: DownloadMetadata | undefined;
  readonly files: ReadonlyArray<DownloadFilePart>;
}

interface MultipartPart {
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Uint8Array;
}

function getObjectProperty(value: unknown, key: string): unknown {
  return typeof value === "object" && value !== null ? Reflect.get(value, key) : undefined;
}

function isContainedPath(root: string, candidate: string): boolean {
  const relativeCandidate = relative(root, candidate);
  return (
    relativeCandidate === "" ||
    (!isAbsolute(relativeCandidate) &&
      relativeCandidate !== ".." &&
      !relativeCandidate.startsWith(`..${sep}`))
  );
}

function validateSlug(slug: string): Effect.Effect<void, InvalidFunctionSlugError> {
  if (validateFunctionSlugMessage(slug) === undefined) {
    return Effect.void;
  }

  return Effect.fail(new InvalidFunctionSlugError({ message: invalidFunctionSlugDetail }));
}

function validateDownloadFlags(
  flags: DownloadFunctionsOptions,
): Effect.Effect<void, ConflictingFunctionDownloadFlagsError> {
  const selected = [
    flags.useApi ? "--use-api" : undefined,
    flags.useDocker ? "--use-docker" : undefined,
    flags.legacyBundle ? "--legacy-bundle" : undefined,
  ].filter((flag) => flag !== undefined);

  return selected.length <= 1
    ? Effect.void
    : Effect.fail(
        new ConflictingFunctionDownloadFlagsError({
          message: `flags ${selected.join(", ")} are mutually exclusive`,
        }),
      );
}

function mapTransportError(prefix: string, error: unknown): Error {
  if (HttpClientError.isHttpClientError(error)) {
    const description = error.reason.description ?? error.reason._tag;
    return new Error(`${prefix}: ${description}`);
  }

  if (error instanceof Error) {
    return new Error(`${prefix}: ${error.message}`);
  }

  return new Error(`${prefix}: ${String(error)}`);
}

function hasEntrypointPath(metadata: DownloadMetadata | undefined): metadata is {
  readonly entrypoint_path: string;
} {
  return metadata?.entrypoint_path !== undefined && metadata.entrypoint_path.length > 0;
}

function fileUrlToEntrypointPath(rawEntrypoint: string): string {
  const fileUrl = new URL(rawEntrypoint);
  try {
    return fileURLToPath(fileUrl);
  } catch {
    return decodeURIComponent(fileUrl.pathname);
  }
}

function parseDownloadMetadata(raw: string): DownloadMetadata {
  const text = raw.trim();
  if (text.length === 0) {
    return {};
  }

  const parsed = JSON.parse(text);
  const deno2EntrypointPath = getObjectProperty(parsed, "deno2_entrypoint_path");
  if (typeof deno2EntrypointPath === "string" && deno2EntrypointPath.length > 0) {
    return { entrypoint_path: deno2EntrypointPath };
  }

  const entrypointPath = getObjectProperty(parsed, "entrypoint_path");
  return typeof entrypointPath === "string" && entrypointPath.length > 0
    ? { entrypoint_path: entrypointPath }
    : {};
}

function readMultipartBoundary(
  contentType: string,
): Effect.Effect<string, InvalidFunctionDownloadResponseError> {
  if (contentType.length === 0) {
    return Effect.fail(
      new InvalidFunctionDownloadResponseError({
        message: "failed to parse content type: missing content type",
      }),
    );
  }

  const mediaTypeMatch = contentType.match(/^\s*([^;]+)/);
  const mediaType = mediaTypeMatch?.[1]?.trim() ?? contentType.trim();
  if (!mediaType.toLowerCase().startsWith("multipart/")) {
    return Effect.fail(
      new InvalidFunctionDownloadResponseError({
        message: `expected multipart response, got ${mediaType}`,
      }),
    );
  }

  const boundaryMatch = contentType.match(/boundary="?([^";]+)"?/i);
  if (boundaryMatch?.[1] === undefined) {
    return Effect.fail(
      new InvalidFunctionDownloadResponseError({
        message: "failed to parse content type: missing multipart boundary",
      }),
    );
  }

  return Effect.succeed(boundaryMatch[1]);
}

function findBytes(payload: Uint8Array, needle: Uint8Array, fromIndex = 0): number {
  outer: for (let index = fromIndex; index <= payload.length - needle.length; index += 1) {
    for (let offset = 0; offset < needle.length; offset += 1) {
      if (payload[index + offset] !== needle[offset]) {
        continue outer;
      }
    }
    return index;
  }
  return -1;
}

function parseMultipartHeaders(rawHeaders: string): Readonly<Record<string, string>> {
  const headers: Record<string, string> = {};
  for (const line of rawHeaders.split("\r\n")) {
    const separatorIndex = line.indexOf(":");
    if (separatorIndex < 0) {
      continue;
    }
    const name = line.slice(0, separatorIndex).trim().toLowerCase();
    const value = line.slice(separatorIndex + 1).trim();
    headers[name] = value;
  }
  return headers;
}

function findNextMultipartBoundary(
  payload: Uint8Array,
  boundaryPrefix: Uint8Array,
  from = 0,
): number {
  let offset = from;
  while (offset < payload.length) {
    const index = findBytes(payload, boundaryPrefix, offset);
    if (index < 0) {
      return -1;
    }

    const suffixIndex = index + boundaryPrefix.length;
    const isClosingBoundary = payload[suffixIndex] === 45 && payload[suffixIndex + 1] === 45;
    const isPartBoundary = payload[suffixIndex] === 13 && payload[suffixIndex + 1] === 10;
    if (isClosingBoundary || isPartBoundary) {
      return index;
    }

    offset = index + 1;
  }

  return -1;
}

function decodeMultipartParts(
  payload: Uint8Array,
  boundary: string,
): Effect.Effect<ReadonlyArray<MultipartPart>, InvalidFunctionDownloadResponseError> {
  return Effect.try({
    try: () => {
      const encoder = new TextEncoder();
      const decoder = new TextDecoder();
      const delimiter = encoder.encode(`--${boundary}`);
      const headerSeparator = encoder.encode("\r\n\r\n");
      const nextPartPrefix = encoder.encode(`\r\n--${boundary}`);
      const parts: MultipartPart[] = [];
      let delimiterIndex = findBytes(payload, delimiter);
      if (delimiterIndex < 0) {
        throw new Error("multipart response is missing its opening boundary");
      }

      while (delimiterIndex >= 0) {
        let partStart = delimiterIndex + delimiter.length;
        if (payload[partStart] === 45 && payload[partStart + 1] === 45) {
          break;
        }
        if (payload[partStart] === 13 && payload[partStart + 1] === 10) {
          partStart += 2;
        }

        const separatorIndex = findBytes(payload, headerSeparator, partStart);
        if (separatorIndex < 0) {
          throw new Error("multipart part is missing its header separator");
        }
        const bodyStart = separatorIndex + headerSeparator.length;
        const nextPartIndex = findNextMultipartBoundary(payload, nextPartPrefix, bodyStart);
        if (nextPartIndex < 0) {
          throw new Error("multipart response is missing its closing boundary");
        }

        parts.push({
          headers: parseMultipartHeaders(decoder.decode(payload.slice(partStart, separatorIndex))),
          body: payload.slice(bodyStart, nextPartIndex),
        });
        delimiterIndex = nextPartIndex + 2;
      }

      return parts;
    },
    catch: (cause) =>
      new InvalidFunctionDownloadResponseError({
        message: `failed to read form: ${cause instanceof Error ? cause.message : String(cause)}`,
      }),
  });
}

function readContentDispositionParam(
  contentDisposition: string,
  param: "name" | "filename" | "filename*",
): Effect.Effect<string | undefined, InvalidFunctionDownloadResponseError> {
  const paramPattern = param.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const quotedMatch = contentDisposition.match(
    new RegExp(`(?:^|;)\\s*${paramPattern}="((?:[^"\\\\]|\\\\.)*)"`, "i"),
  );
  if (quotedMatch !== null) {
    return Effect.succeed(quotedMatch[1]?.replaceAll('\\"', '"'));
  }

  const assignmentMatch = contentDisposition.match(
    new RegExp(`(?:^|;)\\s*${paramPattern}=([^;]*)`, "i"),
  );
  if (assignmentMatch === null) {
    return Effect.succeed(undefined);
  }
  const token = assignmentMatch[1]?.trim() ?? "";
  if (token.length > 0 && !token.startsWith('"') && !/\s/.test(token)) {
    return Effect.succeed(token);
  }

  return Effect.fail(
    new InvalidFunctionDownloadResponseError({
      message: `failed to parse content disposition: malformed ${param}`,
    }),
  );
}

function decodeRfc5987Param(
  value: string,
): Effect.Effect<string, InvalidFunctionDownloadResponseError> {
  const firstQuote = value.indexOf("'");
  const secondQuote = firstQuote < 0 ? -1 : value.indexOf("'", firstQuote + 1);
  if (firstQuote < 0 || secondQuote < 0) {
    return Effect.fail(
      new InvalidFunctionDownloadResponseError({
        message: "failed to parse content disposition: malformed filename*",
      }),
    );
  }

  const charset = value.slice(0, firstQuote).toLowerCase();
  if (charset !== "utf-8" && charset !== "us-ascii") {
    return Effect.fail(
      new InvalidFunctionDownloadResponseError({
        message: `failed to parse content disposition: unsupported filename* charset ${charset}`,
      }),
    );
  }

  return Effect.try({
    try: () => decodeURIComponent(value.slice(secondQuote + 1)),
    catch: (cause) =>
      new InvalidFunctionDownloadResponseError({
        message: `failed to parse content disposition: malformed filename*: ${cause instanceof Error ? cause.message : String(cause)}`,
      }),
  });
}

function readFormFieldName(
  headers: Readonly<Record<string, string>>,
): Effect.Effect<string | undefined, InvalidFunctionDownloadResponseError> {
  const contentDisposition = headers["content-disposition"];
  if (contentDisposition === undefined) {
    return Effect.succeed(undefined);
  }
  return readContentDispositionParam(contentDisposition, "name");
}

function readContentDispositionFilename(
  contentDisposition: string,
): Effect.Effect<string | undefined, InvalidFunctionDownloadResponseError> {
  return Effect.gen(function* () {
    const encodedFilename = yield* readContentDispositionParam(contentDisposition, "filename*");
    if (encodedFilename !== undefined) {
      return yield* decodeRfc5987Param(encodedFilename);
    }

    return yield* readContentDispositionParam(contentDisposition, "filename");
  });
}

function getPartPath(
  headers: Readonly<Record<string, string>>,
): Effect.Effect<string, InvalidFunctionDownloadResponseError> {
  const supabasePath = headers["supabase-path"];
  if (supabasePath !== undefined && supabasePath.length > 0) {
    return Effect.succeed(supabasePath);
  }

  const contentDisposition = headers["content-disposition"];
  if (contentDisposition === undefined || contentDisposition.length === 0) {
    return Effect.succeed("");
  }

  return readContentDispositionFilename(contentDisposition).pipe(
    Effect.map((filename) => filename ?? ""),
  );
}

function decodeMultipartForm(
  response: HttpClientResponse.HttpClientResponse,
): Effect.Effect<DecodedMultipartForm, InvalidFunctionDownloadResponseError> {
  return Effect.gen(function* () {
    const contentType = response.headers["content-type"] ?? "";
    const boundary = yield* readMultipartBoundary(contentType);
    const payload = new Uint8Array(
      yield* response.arrayBuffer.pipe(
        Effect.mapError(
          (cause) =>
            new InvalidFunctionDownloadResponseError({
              message: `failed to read form: ${cause instanceof Error ? cause.message : String(cause)}`,
            }),
        ),
      ),
    );
    const parts = yield* decodeMultipartParts(payload, boundary);

    let metadata: DownloadMetadata | undefined;
    const files: DownloadFilePart[] = [];

    for (const part of parts) {
      const filePath = yield* getPartPath(part.headers);
      if (filePath.length > 0) {
        files.push({ path: filePath, body: part.body });
        continue;
      }

      const fieldName = yield* readFormFieldName(part.headers);
      if (fieldName === "metadata") {
        const rawMetadata = new TextDecoder().decode(part.body);
        metadata = yield* Effect.try({
          try: () => parseDownloadMetadata(rawMetadata),
          catch: (cause) =>
            new InvalidFunctionDownloadResponseError({
              message: `failed to unmarshal metadata: ${cause instanceof Error ? cause.message : String(cause)}`,
            }),
        });
      }
    }

    return { metadata, files };
  });
}

function resolveEntrypointPath(
  metadata: DownloadMetadata | undefined,
  remoteFunction: DownloadMetadata | undefined,
) {
  const rawEntrypoint = hasEntrypointPath(metadata)
    ? metadata.entrypoint_path
    : hasEntrypointPath(remoteFunction)
      ? remoteFunction.entrypoint_path
      : legacyEntrypointPath;

  try {
    if (rawEntrypoint.startsWith("file://")) {
      return fileUrlToEntrypointPath(rawEntrypoint);
    }
  } catch {
    return rawEntrypoint;
  }

  return rawEntrypoint;
}

function resolveDownloadDestination(
  functionsRoot: string,
  functionDir: string,
  entrypointPath: string,
  partPath: string,
): Effect.Effect<string, UnsafeFunctionDownloadPathError> {
  const normalizedEntrypoint = entrypointPath.replaceAll("\\", "/");
  const normalizedPartPath = partPath.replaceAll("\\", "/");
  const relativePath =
    posix.isAbsolute(normalizedEntrypoint) === posix.isAbsolute(normalizedPartPath)
      ? posix.relative(normalizedEntrypoint, normalizedPartPath)
      : posix.join("..", normalizedPartPath);
  const entrypointName = posix.basename(normalizedEntrypoint);
  const destination =
    relativePath.length === 0
      ? resolve(functionDir, entrypointName)
      : resolve(functionDir, entrypointName, ...relativePath.split("/"));
  if (isContainedPath(resolve(functionsRoot), destination)) {
    return Effect.succeed(destination);
  }

  return Effect.fail(
    new UnsafeFunctionDownloadPathError({
      message: `refusing to extract Function file outside ${functionsRoot}: ${partPath}`,
    }),
  );
}

function ensureContainedPath(root: string, candidate: string, sourcePath: string) {
  if (isContainedPath(root, candidate)) {
    return Effect.void;
  }

  return Effect.fail(
    new UnsafeFunctionDownloadPathError({
      message: `refusing to extract Function file outside ${root}: ${sourcePath}`,
    }),
  );
}

function writeFileWithoutFollowingSymlinks(
  destination: string,
  body: Uint8Array,
  sourcePath: string,
) {
  return Effect.gen(function* () {
    const tempDestination = join(dirname(destination), `.supabase-download-${randomUUID()}.tmp`);
    const file = yield* Effect.tryPromise({
      try: () => open(tempDestination, "wx"),
      catch: (cause) =>
        new UnsafeFunctionDownloadPathError({
          message: `failed to create temporary Function file while extracting ${sourcePath}: ${cause instanceof Error ? cause.message : String(cause)}`,
        }),
    });

    yield* Effect.tryPromise({
      try: () => file.writeFile(body),
      catch: (cause) =>
        new UnsafeFunctionDownloadPathError({
          message: `failed to write Function file: ${sourcePath}: ${cause instanceof Error ? cause.message : String(cause)}`,
        }),
    }).pipe(Effect.ensuring(Effect.promise(() => file.close()).pipe(Effect.ignore)));

    yield* Effect.tryPromise({
      try: () => rename(tempDestination, destination),
      catch: (cause) =>
        new UnsafeFunctionDownloadPathError({
          message: `failed to move Function file into place: ${sourcePath}: ${cause instanceof Error ? cause.message : String(cause)}`,
        }),
    }).pipe(
      Effect.catch((error) =>
        Effect.promise(() => rm(tempDestination, { force: true })).pipe(
          Effect.ignore,
          Effect.andThen(() => Effect.fail(error)),
        ),
      ),
    );
  });
}

const listRemoteFunctionSlugs = Effect.fnUntraced(function* (api: ApiClient, projectRef: string) {
  const response = yield* api
    .executeRaw(operationDefinitions.v1ListAllFunctions, {
      ref: projectRef,
    })
    .pipe(Effect.mapError((error) => mapTransportError("failed to list functions", error)));

  const body = yield* response.text.pipe(Effect.orElseSucceed(() => ""));
  if (response.status !== 200) {
    return yield* Effect.fail(
      new Error(`unexpected list functions status ${response.status}: ${body}`),
    );
  }

  return yield* Effect.try({
    try: () => {
      const parsed = JSON.parse(body);
      if (!Array.isArray(parsed)) {
        throw new Error("expected functions list response to be an array");
      }
      return parsed.flatMap((value) => {
        const slug = getObjectProperty(value, "slug");
        return typeof slug === "string" ? [slug] : [];
      });
    },
    catch: (cause) =>
      new InvalidFunctionDownloadResponseError({
        message: `failed to read functions list: ${cause instanceof Error ? cause.message : String(cause)}`,
      }),
  });
});

const getRemoteFunction = Effect.fnUntraced(function* (
  api: ApiClient,
  projectRef: string,
  slug: string,
) {
  const response = yield* api
    .executeRaw(operationDefinitions.v1GetAFunction, {
      ref: projectRef,
      function_slug: slug,
    })
    .pipe(Effect.mapError((error) => mapTransportError("failed to get function metadata", error)));

  const body = yield* response.text.pipe(Effect.orElseSucceed(() => ""));
  switch (response.status) {
    case 200:
      break;
    case 404:
      return yield* Effect.fail(
        new FunctionDownloadNotFoundError({
          message: `Function ${slug} does not exist on the Supabase project.`,
        }),
      );
    default:
      return yield* Effect.fail(
        new Error(`Failed to download Function ${slug} on the Supabase project: ${body}`),
      );
  }

  return yield* Effect.try({
    try: () => {
      const parsed = JSON.parse(body);
      const entrypointPath = getObjectProperty(parsed, "entrypoint_path");
      return typeof entrypointPath === "string" && entrypointPath.length > 0
        ? { entrypoint_path: entrypointPath }
        : { entrypoint_path: legacyEntrypointPath };
    },
    catch: (cause) =>
      new InvalidFunctionDownloadResponseError({
        message: `failed to get function metadata: ${cause instanceof Error ? cause.message : String(cause)}`,
      }),
  });
});

const downloadBody = Effect.fnUntraced(function* (
  api: ApiClient,
  projectRef: string,
  slug: string,
) {
  const response = yield* api
    .executeRaw(
      operationDefinitions.v1GetAFunctionBody,
      {
        ref: projectRef,
        function_slug: slug,
      },
      { Accept: "multipart/form-data" },
    )
    .pipe(Effect.mapError((error) => mapTransportError("failed to download function", error)));

  if (response.status === 200) {
    return response;
  }

  const body = yield* response.text.pipe(Effect.orElseSucceed(() => ""));
  return yield* Effect.fail(new Error(`Error status ${response.status}: ${body}`));
});

const downloadSingle = Effect.fnUntraced(function* (
  dependencies: DownloadRuntimeDependencies,
  projectRef: string,
  slug: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const output = yield* Output;

  if (output.format === "text") {
    yield* output.raw(`Downloading Function: ${slug}\n`, "stderr");
  }

  const response = yield* downloadBody(dependencies.api, projectRef, slug);
  const { metadata, files } = yield* decodeMultipartForm(response);
  const remoteFunction = hasEntrypointPath(metadata)
    ? undefined
    : yield* getRemoteFunction(dependencies.api, projectRef, slug);
  const entrypointPath = resolveEntrypointPath(metadata, remoteFunction);
  const projectRoot = dependencies.projectRoot;
  const functionsRoot = join(projectRoot, "supabase", "functions");
  const functionDir = join(functionsRoot, slug);
  const realProjectRoot = yield* fs.realPath(projectRoot);
  const makeContainedDirectory = Effect.fnUntraced(function* (
    root: string,
    directory: string,
    sourcePath: string,
  ) {
    let existingParent = directory;
    while (!(yield* fs.exists(existingParent))) {
      existingParent = dirname(existingParent);
    }
    const realExistingParent = yield* fs.realPath(existingParent);
    yield* ensureContainedPath(root, realExistingParent, sourcePath);
    yield* fs.makeDirectory(directory, { recursive: true });
    const realDirectory = yield* fs.realPath(directory);
    yield* ensureContainedPath(root, realDirectory, sourcePath);
  });

  yield* makeContainedDirectory(realProjectRoot, functionsRoot, functionsRoot);
  const realFunctionsRoot = yield* fs.realPath(functionsRoot);

  for (const file of files) {
    if (file.path.length === 0) {
      continue;
    }

    const destination = yield* resolveDownloadDestination(
      functionsRoot,
      functionDir,
      entrypointPath,
      file.path,
    );
    const parent = dirname(destination);
    yield* makeContainedDirectory(realFunctionsRoot, parent, file.path);
    yield* writeFileWithoutFollowingSymlinks(destination, file.body, file.path);
    yield* ensureContainedPath(realFunctionsRoot, yield* fs.realPath(destination), file.path);
    if (output.format === "text") {
      yield* output.raw(`Extracting file: ${destination}\n`, "stderr");
    }
  }

  if (output.format === "text") {
    yield* output.raw(`Downloaded Function ${slug} from project ${projectRef}.\n`, "stderr");
  }

  return slug;
});

export function downloadFunctions<ResolveError, ResolveRequirements, ProxyError, ProxyRequirements>(
  flags: DownloadFunctionsOptions,
  dependencies: DownloadFunctionsDependencies<
    ResolveError,
    ResolveRequirements,
    ProxyError,
    ProxyRequirements
  >,
) {
  return Effect.gen(function* () {
    const output = yield* Output;

    yield* validateDownloadFlags(flags);

    if (flags.useDocker || flags.legacyBundle) {
      const projectRef = yield* dependencies.resolveProjectRef(flags.projectRef);
      return yield* dependencies.proxyDownload(flags, projectRef);
    }

    if (Option.isSome(flags.functionName)) {
      yield* validateSlug(flags.functionName.value);
    }

    const projectRef = yield* dependencies.resolveProjectRef(flags.projectRef);
    const slugs = Option.isSome(flags.functionName)
      ? [flags.functionName.value]
      : yield* listRemoteFunctionSlugs(dependencies.api, projectRef);

    if (slugs.length === 0) {
      if (output.format === "text") {
        yield* output.raw(`No functions found in project  ${projectRef}\n`, "stderr");
        return;
      }
      yield* output.success("No functions found.", { function_slugs: [], project_ref: projectRef });
      return;
    }

    if (output.format === "text" && Option.isNone(flags.functionName)) {
      yield* output.raw(`Found ${slugs.length} function(s) to download\n`, "stderr");
    }

    const downloaded: string[] = [];
    for (const slug of slugs) {
      downloaded.push(yield* downloadSingle(dependencies, projectRef, slug));
    }

    if (output.format !== "text") {
      yield* output.success("Downloaded Edge Function source.", {
        function_slugs: downloaded,
        project_ref: projectRef,
      });
      return;
    }

    if (Option.isNone(flags.functionName)) {
      yield* output.raw(
        `Successfully downloaded all functions from project ${projectRef}\n`,
        "stderr",
      );
    }
  });
}
