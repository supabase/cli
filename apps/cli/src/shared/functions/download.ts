import { operationDefinitions, SupabaseApiInputError, type ApiClient } from "@supabase/api/effect";
import { randomUUID } from "node:crypto";
import { mkdir, open, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, posix, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { Effect, FileSystem, Option } from "effect";
import * as HttpBody from "effect/unstable/http/HttpBody";
import * as HttpClientError from "effect/unstable/http/HttpClientError";
import type * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import { Output } from "../output/output.service.ts";
import {
  cobraMutuallyExclusiveErrorMessage,
  explicitBooleanLongFlag,
  lastExplicitLongFlagValue,
  hasExplicitLongFlag,
} from "../cli/cobra-flag-groups.ts";
import { describeContainerCliFailure } from "../../command-internal/container-cli.ts";
import { viperEnvStringWithProjectFallback } from "../../command-internal/viper-env.ts";
import {
  buildFunctionsDockerRunArgs,
  edgeRuntimeCacheVolume,
  ensureDockerNamedVolume,
  ensureDockerNetwork,
  isDockerRunning,
  resolveDockerNetworkMode,
  resolveEdgeRuntimeVersion,
  resolveFunctionsDockerImage,
  runChildProcess,
} from "./functions-docker.ts";
import { loadFunctionsCliConfig, type FunctionsGoConfigCompat } from "./functions-config.ts";
import {
  edgeRuntimeImage,
  FUNCTIONS_BUNDLER_MUTEX_GROUP,
  invalidFunctionSlugDetail,
  validateFunctionSlugMessage,
} from "./functions.shared.ts";
import {
  ConflictingFunctionDownloadFlagsError,
  FunctionDownloadNotFoundError,
  InvalidFunctionDownloadResponseError,
  InvalidFunctionSlugError,
  UnsafeFunctionDownloadPathError,
} from "./download.errors.ts";
import { FunctionsApiStatusError, FunctionsApiTransportError } from "./functions-api.errors.ts";

const legacyEntrypointPath = "file:///src/index.ts";
// Fixed container-side paths for the docker-unbundle path, unrelated to
// deploy's `toDockerPath` host-mirroring scheme.
const DOCKER_DENO_DIR = "/home/deno";
const DOCKER_ESZIP_DIR = "/root/eszips";

export interface DownloadFunctionsOptions {
  readonly functionName: Option.Option<string>;
  readonly projectRef: Option.Option<string>;
  readonly useApi: boolean;
  readonly useDocker: boolean;
  readonly legacyBundle: boolean;
}

export interface DownloadFunctionsResult {
  readonly projectRef: string;
  /** Downloaded slugs, in download order. Empty when the project has none. */
  readonly slugs: ReadonlyArray<string>;
  /** `true` when the remote project has no functions at all. */
  readonly empty: boolean;
}

interface DownloadRuntimeDependencies {
  readonly api: ApiClient;
  readonly projectRoot: string;
}

/** Adds what the Docker-unbundle path needs beyond the server-side path. */
interface DownloadDockerRuntimeDependencies extends DownloadRuntimeDependencies {
  readonly rawArgs: ReadonlyArray<string>;
  /**
   * Optional shell-specific styling hook for the `Downloading function:`
   * progress line. Defaults to identity (plain text); the CLI injects bold
   * styling here so this shared module stays free of CLI-specific rendering.
   */
  readonly styleEmphasis?: (text: string) => string;
  /**
   * Optional shell-specific styling hook for the `--legacy-bundle` command
   * suggested inside {@link suggestLegacyBundle} — same isolation rationale
   * as {@link styleEmphasis}.
   */
  readonly styleAqua?: (text: string) => string;
  /**
   * Optional shell-specific styling hook for the `WARNING:` token on the
   * "Docker is not running" fallback line — same isolation rationale as
   * {@link styleEmphasis}.
   */
  readonly styleWarning?: (text: string) => string;
}

/** What {@link resolveEdgeRuntimeImage} needs to resolve the Docker edge-runtime image tag. */
interface EdgeRuntimeImageDependencies {
  readonly projectRoot: string;
  /**
   * `undefined` for library callers; the CLI injects this so this file
   * never imports the command tree directly — see {@link FunctionsGoConfigCompat}.
   */
  readonly goConfigCompat: FunctionsGoConfigCompat | undefined;
  /**
   * Fallback edge-runtime image tag used when the project config doesn't
   * pin `edge_runtime.deno_version` to `1`. Mirrors `deploy.ts`'s own
   * `edgeRuntimeVersion` dependency.
   */
  readonly edgeRuntimeVersion: string;
}

export interface DownloadFunctionsDependencies<
  ResolveError,
  ResolveRequirements,
  ProxyError,
  ProxyRequirements,
>
  extends DownloadDockerRuntimeDependencies, EdgeRuntimeImageDependencies {
  readonly resolveProjectRef: (
    projectRef: Option.Option<string>,
  ) => Effect.Effect<string, ResolveError, ResolveRequirements>;
  /**
   * `true` whenever `output.format !== "text"`: the child's raw stdout must
   * not reach the terminal (it would corrupt the JSON/NDJSON envelope), so
   * the dependency must capture/discard it instead of inheriting stdio.
   */
  readonly proxyDownload: (
    flags: DownloadFunctionsOptions,
    projectRef: string,
    captureOutput: boolean,
  ) => Effect.Effect<void, ProxyError, ProxyRequirements>;
}

// `--legacy-bundle` is the only case `downloadFunctions()` still delegates
// to the Go binary; `functionName` is the one remaining input to forward.
export function makeGoProxyLegacyBundleArgs(
  functionName: Option.Option<string>,
  projectRef: string,
): ReadonlyArray<string> {
  const args: string[] = ["functions", "download"];
  if (Option.isSome(functionName)) {
    args.push(functionName.value);
  }
  args.push("--project-ref", projectRef, "--legacy-bundle");
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

/**
 * The Management API's function list is untrusted: a malicious or
 * compromised response could return a slug containing `..`/`/` segments,
 * which every downloader below joins into a filesystem path unvalidated.
 * This is the single point of entry that must reject it — distinct from
 * {@link validateSlug} (the user-supplied `<Function name>` argument).
 */
function validateRemoteSlug(
  slug: string,
  styleAqua: (text: string) => string = (text) => text,
): Effect.Effect<void, Error> {
  if (validateFunctionSlugMessage(slug) === undefined) {
    return Effect.void;
  }

  return Effect.fail(
    Object.assign(new Error(`failed to download function ${slug}: ${invalidFunctionSlugDetail}`), {
      suggestion: `The Supabase API returned an unexpected function slug (${styleAqua(slug)}). Retry the command, and if this keeps happening, verify your network connection is not being intercepted before contacting Supabase support.`,
    }),
  );
}

const downloadCommandPath = ["functions", "download"] as const;

function validateDownloadFlags(
  rawArgs: ReadonlyArray<string>,
): Effect.Effect<void, ConflictingFunctionDownloadFlagsError> {
  const changed = [
    hasExplicitLongFlag(rawArgs, downloadCommandPath, "use-api") ? "use-api" : undefined,
    hasExplicitLongFlag(rawArgs, downloadCommandPath, "use-docker") ? "use-docker" : undefined,
    hasExplicitLongFlag(rawArgs, downloadCommandPath, "legacy-bundle")
      ? "legacy-bundle"
      : undefined,
  ].filter((flag): flag is string => flag !== undefined);

  return changed.length <= 1
    ? Effect.void
    : Effect.fail(
        new ConflictingFunctionDownloadFlagsError({
          message: cobraMutuallyExclusiveErrorMessage(FUNCTIONS_BUNDLER_MUTEX_GROUP, changed),
        }),
      );
}

function mapTransportError(
  prefix: string,
  error: unknown,
): FunctionsApiTransportError | SupabaseApiInputError | HttpBody.HttpBodyError {
  // This mapper is shared by requests with different input ownership. Preserve
  // validation/build failures so their provenance is not inferred from text.
  if (error instanceof SupabaseApiInputError || error instanceof HttpBody.HttpBodyError) {
    return error;
  }

  if (HttpClientError.isHttpClientError(error)) {
    const description = error.reason.description ?? error.reason._tag;
    return new FunctionsApiTransportError({ message: `${prefix}: ${description}` });
  }

  if (error instanceof Error) {
    return new FunctionsApiTransportError({ message: `${prefix}: ${error.message}` });
  }

  return new FunctionsApiTransportError({ message: `${prefix}: ${String(error)}` });
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
      unsafeResponsePath: true,
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
      unsafeResponsePath: true,
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
      new FunctionsApiStatusError({
        status: response.status,
        message: `unexpected list functions status ${response.status}: ${body}`,
      }),
    );
  }

  return yield* Effect.try({
    try: () => {
      const parsed = JSON.parse(body);
      if (!Array.isArray(parsed)) {
        throw new Error("expected functions list response to be an array");
      }
      // A missing/null "slug" coerces to "" here (rather than being filtered
      // out) so it fails loudly downstream via `validateRemoteSlug`, instead
      // of silently vanishing from the list.
      //
      // A "slug" typed as something other than string/null throws here,
      // failing the whole list call before any function is downloaded —
      // never after some entries have already been fetched.
      return parsed.map((value) => {
        const slug = getObjectProperty(value, "slug");
        if (slug === null || slug === undefined) {
          return "";
        }
        if (typeof slug !== "string") {
          throw new Error(`expected function slug to be a string, got ${typeof slug}`);
        }
        return slug;
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
        new FunctionsApiStatusError({
          status: response.status,
          message: `Failed to download Function ${slug} on the Supabase project: ${body}`,
        }),
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
  return yield* Effect.fail(
    new FunctionsApiStatusError({
      status: response.status,
      message: `Error status ${response.status}: ${body}`,
      notFoundIsInvalidInput: true,
    }),
  );
});

// Overrides `Accept: */*` so `executeRaw` doesn't default to
// `Accept: application/json` for this json-kind operation and risk a
// negotiated JSON response instead of the raw eszip body. The HTTP transport
// already transparently decodes `Content-Encoding: br`, so this reads the
// body as-is with no manual decompression step.
const downloadEszipBody = Effect.fnUntraced(function* (
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
      { Accept: "*/*" },
    )
    .pipe(Effect.mapError((error) => mapTransportError("failed to get function body", error)));

  if (response.status !== 200) {
    const body = yield* response.text.pipe(Effect.orElseSucceed(() => ""));
    return yield* Effect.fail(new Error(`Error status ${response.status}: ${body}`));
  }

  return new Uint8Array(
    yield* response.arrayBuffer.pipe(
      Effect.mapError(
        (cause) =>
          new Error(
            `failed to download file: ${cause instanceof Error ? cause.message : String(cause)}`,
          ),
      ),
    ),
  );
});

function suggestLegacyBundle(
  slug: string,
  styleAqua: (text: string) => string = (text) => text,
): string {
  // Preserves the established "trying running" wording (not a typo) and
  // leading newline; `styleAqua` wraps only the suggested command, not the
  // whole sentence.
  return `\nIf your function is deployed using CLI < 1.120.0, trying running ${styleAqua(`supabase functions download --legacy-bundle ${slug}`)} instead.`;
}

function suggestDenoV2(styleEmphasis: (text: string) => string = (text) => text): string {
  // Preserves the established trailing newline; `styleEmphasis` covers the
  // config path the same way it covers the slug above.
  return `Please use deno v2 in ${styleEmphasis("supabase/config.toml")} to download this Function:\n\n[edge_runtime]\ndeno_version = 2\n`;
}

/**
 * Attaches the legacy-bundle hint to any Docker-extraction failure —
 * network/volume creation, container create/start, log streaming, or a
 * non-zero exit code alike. Only normalizes (never re-prefixes) whatever
 * {@link describeContainerCliFailure} reports, since
 * `ensureDockerNetwork`/`ensureDockerNamedVolume` prefix their own context.
 */
function withLegacyBundleSuggestion(slug: string, styleAqua?: (text: string) => string) {
  return (cause: unknown): Error =>
    Object.assign(new Error(describeContainerCliFailure(cause)), {
      suggestion: suggestLegacyBundle(slug, styleAqua),
    });
}

/**
 * Same as {@link withLegacyBundleSuggestion}, plus a `step` prefix: unlike
 * `ensureDockerNetwork`/`ensureDockerNamedVolume`'s self-describing errors,
 * `runChildProcess`'s own failure carries no context about which command
 * was running.
 */
function withDockerStepFailure(step: string, slug: string, styleAqua?: (text: string) => string) {
  return (cause: unknown): Error =>
    Object.assign(new Error(`${step}: ${describeContainerCliFailure(cause)}`), {
      suggestion: suggestLegacyBundle(slug, styleAqua),
    });
}

// `deno_version = 1` pins the older `DENO1_EDGE_RUNTIME_VERSION`; anything
// else (including unset) uses the project's configured/default tag.
// Resolved once per invocation by the caller, not once per slug.
const resolveEdgeRuntimeImage = Effect.fnUntraced(function* (
  dependencies: EdgeRuntimeImageDependencies,
  projectRef: string,
) {
  const context = yield* loadFunctionsCliConfig({
    projectRoot: dependencies.projectRoot,
    projectRef,
    goConfigCompat: dependencies.goConfigCompat,
  });
  const edgeRuntimeVersion = yield* resolveEdgeRuntimeVersion(
    context.denoVersion,
    dependencies.edgeRuntimeVersion,
  );
  return {
    projectId: context.projectId,
    denoVersion: context.denoVersion,
    // `edgeRuntimeImage` applies the tag verbatim; a `.temp/edge-runtime-version`
    // pin flows through unmodified. Registry mapping + pull-with-retry happens
    // per-container, right before `ensureDockerNetwork` (see the caller).
    rawImage: edgeRuntimeImage(edgeRuntimeVersion),
    projectEnvValues: context.projectEnvValues,
  };
});

interface EdgeRuntimeImage {
  readonly projectId: string;
  readonly denoVersion: number | undefined;
  /** Not yet registry-mapped/pull-resolved — see {@link resolveFunctionsDockerImage}. */
  readonly rawImage: string;
  readonly projectEnvValues: Readonly<Record<string, string>> | undefined;
}

/**
 * `EdgeRuntimeImage` plus the pull-resolved reference, resolved once per
 * invocation (not once per slug — see {@link downloadFunctions}'s own
 * resolve site): the image is identical for every function, so resolving it
 * per-slug would multiply both the cache-check subprocess count and, on a
 * registry outage, the retry-backoff sleep (up to ~36s) by the function count.
 */
interface PulledEdgeRuntimeImage extends EdgeRuntimeImage {
  readonly image: string;
}

// Downloads the function body as an eszip, writes it to a temp file, then
// runs the edge-runtime image's `unbundle` subcommand against it, mounting
// the shared `supabase/functions` directory (not the slug's own subdirectory).
const downloadWithDockerUnbundle = Effect.fnUntraced(function* (
  dependencies: DownloadDockerRuntimeDependencies,
  edgeRuntimeImage: PulledEdgeRuntimeImage,
  projectRef: string,
  slug: string,
) {
  const output = yield* Output;
  const styleEmphasis = dependencies.styleEmphasis ?? ((text: string) => text);
  const styleAqua = dependencies.styleAqua ?? ((text: string) => text);

  // Lowercase "function", distinct from the server-side path's "Downloading
  // Function:" (capital F) below — an established text difference, not a typo.
  yield* output.raw(`Downloading function: ${styleEmphasis(slug)}\n`, "stderr");

  const eszip = yield* downloadEszipBody(dependencies.api, projectRef, slug);

  const tempDir = join(dependencies.projectRoot, "supabase", ".temp");
  yield* Effect.tryPromise({
    try: () => mkdir(tempDir, { recursive: true }),
    catch: (cause) =>
      new Error(`failed to mkdir: ${cause instanceof Error ? cause.message : String(cause)}`),
  });
  const eszipFileName = `output_${slug}.eszip`;
  const eszipPath = join(tempDir, eszipFileName);
  yield* Effect.tryPromise({
    try: () => writeFile(eszipPath, eszip),
    catch: (cause) =>
      new Error(
        `failed to download file: ${cause instanceof Error ? cause.message : String(cause)}`,
      ),
  });

  // `Effect.ensuring` below wraps every step from here on so a failure
  // resolving the network/volume, spawning Docker, or a non-zero container
  // exit all still clean up the temp eszip file, not just the happy path.
  //
  // An explicit `--debug=false` must still run cleanup, so this reads the
  // flag's last explicit boolean value rather than a plain presence check,
  // falling back to `false` (cleanup runs) when `--debug` never appears.
  const debugEnabled = explicitBooleanLongFlag(dependencies.rawArgs, "debug") ?? false;
  const cleanupEszip = debugEnabled
    ? Effect.void
    : Effect.tryPromise({
        try: () => rm(eszipPath, { force: true }),
        catch: (cause) => (cause instanceof Error ? cause.message : String(cause)),
      }).pipe(Effect.catch((message) => output.raw(`${message}\n`, "stderr")));

  const { projectId, denoVersion, image, projectEnvValues } = edgeRuntimeImage;
  const functionsDir = resolve(dependencies.projectRoot, "supabase", "functions");
  const hostEszipPath = resolve(eszipPath);
  const cacheVolume = edgeRuntimeCacheVolume(projectId);
  const dockerEszipPath = posix.join(DOCKER_ESZIP_DIR, eszipFileName);
  const dockerOutputPath = posix.join(DOCKER_DENO_DIR, slug);

  // `--network-id` is a persistent root flag, not registered on `functions
  // download` itself. `lastExplicitLongFlagValue` preserves the "explicitly
  // cleared" vs "never touched" distinction `resolveDockerNetworkMode` needs
  // — see that function's own doc comment. `SUPABASE_NETWORK_ID` is CLI-only,
  // like `projectEnvValues` (`undefined` for library callers).
  const networkMode = resolveDockerNetworkMode({
    explicit: lastExplicitLongFlagValue(dependencies.rawArgs, [], "network-id"),
    envOverride:
      projectEnvValues === undefined
        ? undefined
        : viperEnvStringWithProjectFallback("SUPABASE_NETWORK_ID", projectEnvValues),
    projectId,
  });

  const extract = Effect.gen(function* () {
    // `image` is already pull-resolved once for the whole invocation — see
    // `downloadFunctions`'s own resolve site — not re-resolved per slug.
    yield* ensureDockerNetwork(networkMode, projectId).pipe(
      Effect.mapError(withLegacyBundleSuggestion(slug, styleAqua)),
    );
    yield* ensureDockerNamedVolume(cacheVolume.name, projectId).pipe(
      Effect.mapError(withLegacyBundleSuggestion(slug, styleAqua)),
    );

    // On Bitbucket, the named-volume bind is dropped entirely (not just its
    // explicit creation skipped): `docker run -v <name>:...` would otherwise
    // still implicitly create the volume, which Bitbucket's restricted
    // Docker environment doesn't allow — same carve-out as `deploy.ts`'s
    // `buildDockerBinds`.
    const binds = [
      ...(process.env["BITBUCKET_CLONE_DIR"] === undefined ? [cacheVolume.bind] : []),
      `${hostEszipPath}:${dockerEszipPath}:ro`,
      `${functionsDir}:${DOCKER_DENO_DIR}:rw`,
    ];
    const spec = {
      image,
      projectId,
      networkMode,
      binds,
      containerArgs: ["unbundle", "--eszip", dockerEszipPath, "--output", dockerOutputPath],
    };

    // Each chunk tees to `output.raw` live instead of buffering the whole
    // run. Container stdout routes to real stdout only in text mode —
    // machine-output modes must keep stdout payload-only — mirroring
    // `deploy.ts`'s own Docker routing.
    const result = yield* runChildProcess("docker", buildFunctionsDockerRunArgs(spec), {
      stdout: "pipe",
      stderr: "pipe",
      onStdout: (chunk) => output.raw(chunk, output.format === "text" ? "stdout" : "stderr"),
      onStderr: (chunk) => output.raw(chunk, "stderr"),
    }).pipe(
      Effect.mapError(
        withDockerStepFailure("failed to run the edge-runtime unbundle container", slug, styleAqua),
      ),
    );

    if (result.exitCode !== 0) {
      // Detects a full stderr line reading "invalid eszip v2"
      // (case-insensitive, exact match not substring) to append the deno-v2
      // suggestion ahead of the legacy-bundle one — deno-v1 containers only.
      const invalidEszipV2 =
        denoVersion === 1 &&
        result.stderr
          .split(/\r?\n/)
          .some((line) => line.trim().toLowerCase() === "invalid eszip v2");
      const suggestion =
        (invalidEszipV2 ? suggestDenoV2(styleEmphasis) : "") + suggestLegacyBundle(slug, styleAqua);
      return yield* Effect.fail(
        Object.assign(new Error(`error running container: exit ${result.exitCode}`), {
          suggestion,
        }),
      );
    }
    // No final "Downloaded Function ..." print here, unlike the server-side
    // path below — only "Downloading function: ..." plus the container's own output.
    return slug;
  });

  return yield* extract.pipe(Effect.ensuring(cleanupEszip));
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

/**
 * Mutates `error` in place via `Object.assign` and returns the same object,
 * so every caller's `_tag`/`instanceof` check on this loop's heterogeneous
 * error classes stays unchanged. Field name matches the established
 * `MigrationFetchWriteError.writtenSoFar` precedent, read by
 * `pull.aggregate.ts`'s `hasWrittenSoFar` duck-type so `supabase pull` can
 * report partial progress. Omitted entirely (not an empty array) when
 * nothing had downloaded yet, since the duck-type checks presence, not
 * non-emptiness.
 */
function attachDownloadWrittenSoFar<E extends object>(
  error: E,
  downloadedSoFar: ReadonlyArray<string>,
): E {
  return downloadedSoFar.length === 0
    ? error
    : Object.assign(error, { writtenSoFar: [...downloadedSoFar] });
}

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

    yield* validateDownloadFlags(dependencies.rawArgs);

    if (Option.isSome(flags.functionName)) {
      yield* validateSlug(flags.functionName.value);
    }

    // `--legacy-bundle` still delegates to the Go binary: it requires
    // installing/upgrading a Deno binary on the host and shelling out to an
    // embedded Deno script, with no other precedent in this codebase.
    // `--use-docker` (default `true`) runs natively below and falls through
    // to the same server-side downloader when Docker isn't running.
    if (flags.legacyBundle) {
      const projectRef = yield* dependencies.resolveProjectRef(flags.projectRef);

      if (output.format === "text") {
        yield* dependencies.proxyDownload(flags, projectRef, false);
        // The slug list is never resolved in text mode here, so this result
        // is not meaningful — callers never read it (the orchestrator never
        // sets `legacyBundle: true`).
        return { projectRef, slugs: [], empty: false };
      }

      // Resolved before delegating: this list is purely for the JSON
      // payload (the delegated child's own stdout is captured/discarded, not
      // inherited, since it never emits the `Output` envelope). Resolving it
      // first means a transient listing failure is reported before any
      // download side effect, rather than masking an already-successful
      // delegated download with an unrelated listing failure after the fact.
      const slugs = Option.isSome(flags.functionName)
        ? [flags.functionName.value]
        : yield* listRemoteFunctionSlugs(dependencies.api, projectRef);

      // Mirrors the native path's empty-project short-circuit below: an
      // empty project has nothing to delegate, so this reports "No functions
      // found." instead of invoking the Go child unnecessarily.
      if (slugs.length === 0) {
        yield* output.success("No functions found.", {
          function_slugs: [],
          project_ref: projectRef,
        });
        return { projectRef, slugs: [], empty: true };
      }

      yield* dependencies.proxyDownload(flags, projectRef, true);

      yield* output.success("Downloaded Edge Function source.", {
        function_slugs: slugs,
        project_ref: projectRef,
      });
      return { projectRef, slugs, empty: false };
    }

    const projectRef = yield* dependencies.resolveProjectRef(flags.projectRef);

    // Resolved unconditionally here, before checking `useDocker` or whether
    // Docker is running: an invalid `supabase/config.toml` (e.g. a bad
    // `edge_runtime.deno_version`) must fail up front regardless of
    // `--use-api`/`--use-docker`/Docker's state, not only on the Docker path.
    const resolvedEdgeRuntimeImage = yield* resolveEdgeRuntimeImage(dependencies, projectRef);

    // Resolved once for the entire invocation, before any per-function work,
    // so the "Docker is not running" warning can print even for a project
    // with zero functions. `edgeRuntimeImage === undefined` is the single
    // source of truth for "use the server-side path" instead of a separate
    // boolean that could silently disagree with whether an image resolved.
    const styleWarning = dependencies.styleWarning ?? ((text: string) => text);
    const edgeRuntimeImage: EdgeRuntimeImage | undefined =
      !flags.useApi && flags.useDocker
        ? (yield* isDockerRunning())
          ? resolvedEdgeRuntimeImage
          : yield* output
              .raw(`${styleWarning("WARNING:")} Docker is not running\n`, "stderr")
              .pipe(Effect.as(undefined))
        : undefined;

    const slugs = Option.isSome(flags.functionName)
      ? [flags.functionName.value]
      : yield* listRemoteFunctionSlugs(dependencies.api, projectRef);

    // The standalone `functionsDownload` handler emits the final summary;
    // this only computes and returns the result.
    if (slugs.length === 0) {
      return { projectRef, slugs: [], empty: true };
    }

    if (output.format === "text" && Option.isNone(flags.functionName)) {
      yield* output.raw(`Found ${slugs.length} function(s) to download\n`, "stderr");
    }

    // Resolved once for the whole invocation, not once per slug — see
    // `PulledEdgeRuntimeImage`'s own doc comment. The `--legacy-bundle`
    // suggestion on a resolve failure uses the first slug as a
    // representative example, since none is "the" one being processed yet.
    const styleAqua = dependencies.styleAqua ?? ((text: string) => text);
    const pulledEdgeRuntimeImage: PulledEdgeRuntimeImage | undefined =
      edgeRuntimeImage === undefined
        ? undefined
        : {
            ...edgeRuntimeImage,
            image: yield* resolveFunctionsDockerImage(
              edgeRuntimeImage.rawImage,
              edgeRuntimeImage.projectEnvValues,
            ).pipe(Effect.mapError(withLegacyBundleSuggestion(slugs[0] ?? "", styleAqua))),
          };

    const downloaded: string[] = [];
    // Absolute directory path per fully-downloaded slug, separate from
    // `downloaded` (bare slugs): a caller upstream (`pull.aggregate.ts`'s
    // `hasWrittenSoFar`) needs an on-disk path.
    const downloadedPaths: string[] = [];
    for (const slug of slugs) {
      yield* Effect.gen(function* () {
        // A user-supplied slug is already validated above; this covers
        // slugs sourced from the Management API's function list, which is
        // untrusted (a malicious/compromised response, or a MITM).
        if (Option.isNone(flags.functionName)) {
          yield* validateRemoteSlug(slug, styleAqua);
        }
        if (pulledEdgeRuntimeImage !== undefined) {
          downloaded.push(
            yield* downloadWithDockerUnbundle(
              dependencies,
              pulledEdgeRuntimeImage,
              projectRef,
              slug,
            ),
          );
        } else {
          downloaded.push(yield* downloadSingle(dependencies, projectRef, slug));
        }
        downloadedPaths.push(resolve(dependencies.projectRoot, "supabase", "functions", slug));
      }).pipe(Effect.mapError((error) => attachDownloadWrittenSoFar(error, downloadedPaths)));
    }

    // The standalone `functionsDownload` handler emits the final summary;
    // this only computes and returns the result.
    return { projectRef, slugs: downloaded, empty: false };
  });
}
