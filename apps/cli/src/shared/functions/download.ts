import { operationDefinitions, type ApiClient } from "@supabase/api/effect";
import { loadProjectConfig } from "@supabase/config";
import { randomUUID } from "node:crypto";
import { mkdir, open, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, posix, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { Effect, FileSystem, Option } from "effect";
import * as HttpClientError from "effect/unstable/http/HttpClientError";
import type * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import { Output } from "../output/output.service.ts";
import {
  cobraMutuallyExclusiveErrorMessage,
  explicitBooleanLongFlag,
  explicitNonEmptyStringFlag,
  hasExplicitLongFlag,
} from "../cli/cobra-flag-groups.ts";
import { legacyDescribeContainerCliFailure } from "../../legacy/shared/legacy-container-cli.ts";
import { legacyGetRegistryImageUrl } from "../../legacy/shared/legacy-docker-registry.ts";
import {
  edgeRuntimeImageTag,
  ensureDockerNamedVolume,
  ensureDockerNetwork,
  isDockerRunning,
  localDockerId,
  resolveEdgeRuntimeVersion,
  runChildProcess,
} from "./functions-docker.ts";
import {
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

const legacyEntrypointPath = "file:///src/index.ts";
// Go: `utils.DockerDenoDir`/`utils.DockerEszipDir` (`internal/utils/deno.go:34-35`)
// — fixed container-side paths for the docker-unbundle path, unrelated to
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

interface DownloadRuntimeDependencies {
  readonly api: ApiClient;
  readonly projectRoot: string;
}

/** Adds what the Docker-unbundle path needs beyond the server-side path. */
interface DownloadDockerRuntimeDependencies extends DownloadRuntimeDependencies {
  readonly rawArgs: ReadonlyArray<string>;
}

/**
 * What {@link resolveEdgeRuntimeImage} needs to resolve the Docker
 * edge-runtime image tag — split out so it's declared once instead of
 * duplicated across `DownloadFunctionsDependencies`'s fields.
 */
interface EdgeRuntimeImageDependencies {
  readonly projectRoot: string;
  /**
   * `true` in the legacy shell, `false` in `next` — forwarded verbatim to
   * `loadProjectConfig`'s `goViperCompat` option (matches every other
   * `functions`-family command, e.g. `deploy.ts`'s own `DeployFunctionsDependencies`).
   */
  readonly goViperCompat: boolean;
  /**
   * Fallback edge-runtime image tag used when the project config doesn't pin
   * `edge_runtime.deno_version` to `1` (which forces the older
   * `DENO1_EDGE_RUNTIME_VERSION`) — mirrors `deploy.ts`'s own
   * `edgeRuntimeVersion` dependency, read via
   * `resolveEdgeRuntimeVersionPin` by the shell-specific handler.
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
   * `captureOutput` is `true` whenever `output.format !== "text"`: the Go
   * child's raw stdout must not reach the terminal (it would corrupt the
   * JSON/NDJSON envelope, CLI-1546's "stdout is payload-only in machine
   * mode" invariant), so the dependency must capture/discard it (e.g. via
   * `LegacyGoProxy.execCapture`) instead of inheriting stdio. Only invoked
   * for `--legacy-bundle` today — `--use-docker` now runs natively (CLI-1963).
   */
  readonly proxyDownload: (
    flags: DownloadFunctionsOptions,
    projectRef: string,
    captureOutput: boolean,
  ) => Effect.Effect<void, ProxyError, ProxyRequirements>;
}

// `--legacy-bundle` is the only case `downloadFunctions()` still delegates to
// the Go binary for (CLI-1963) — `functionName` is the one remaining piece of
// user input the delegating branch needs to forward.
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
 * Go parity (`downloadAll`, `apps/cli-go/internal/functions/download/download.go:172-188`,
 * CLI-1891): the Management API's function list is untrusted — a malicious or
 * compromised response (or a MITM) could return a slug containing `..` or `/`
 * segments, which every downloader below joins into a filesystem path
 * (the docker-unbundle temp eszip path, and the server-side path's functions
 * directory) before any validation of its own. This is the single point of
 * entry that must reject it, rather than relying on each downstream
 * path-construction site to defend itself — same rule Go's own comment states.
 * Distinct from {@link validateSlug} (used for the user-supplied `<Function
 * name>` argument), which fails with a plain `InvalidFunctionSlugError` and no
 * "failed to download function" prefix or suggestion.
 */
function validateRemoteSlug(slug: string): Effect.Effect<void, Error> {
  if (validateFunctionSlugMessage(slug) === undefined) {
    return Effect.void;
  }

  return Effect.fail(
    Object.assign(new Error(`failed to download function ${slug}: ${invalidFunctionSlugDetail}`), {
      suggestion: `The Supabase API returned an unexpected function slug (${slug}). Retry the command, and if this keeps happening, verify your network connection is not being intercepted before contacting Supabase support.`,
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

// Go: `downloadOne` (`apps/cli-go/internal/functions/download/download.go:218-245`)
// sends this request with no `Accept` header set at all (contrast
// `downloadBody` above, which requests `multipart/form-data` for the
// server-side path). This operation's generated contract marks its response
// `kind: "json"` (`packages/api/src/generated/contracts.ts`), so
// `executeRaw` would otherwise default to `Accept: application/json` here
// (`buildRequest`'s unconditional `acceptJson` for json-kind operations,
// `packages/api/src/internal/client.ts`) and risk a negotiated JSON response
// instead of the raw eszip body — overriding to `*/*` (no preference) is the
// closest equivalent this API surface has to Go sending no header at all.
// Go explicitly decodes a brotli `Content-Encoding` itself because Go's
// `http.Transport` only auto-decodes `gzip`; this TS CLI's transport
// (`effect/unstable/http`'s `FetchHttpClient`, backed by the platform
// `fetch`) already transparently decodes `br` per the Fetch spec — while
// still reporting `Content-Encoding: br` on the exposed `Response.headers`
// (confirmed empirically: a `fetch()` against a real `Content-Encoding: br`
// response returns already-decompressed bytes from `arrayBuffer()`).
// Re-running `brotliDecompressSync` here would therefore throw on
// already-decoded bytes, so this reads the body as-is and does not
// re-implement Go's manual decode step. Error prefix ("failed to get
// function body") is deliberately distinct from `downloadBody`'s ("failed to
// download function") — the two Go call sites use different wording.
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

function suggestLegacyBundle(slug: string): string {
  // Go: `suggestLegacyBundle` (`download.go:314-316`) — verbatim, including
  // the source's own "trying running" wording and its leading newline.
  return `\nIf your function is deployed using CLI < 1.120.0, trying running supabase functions download --legacy-bundle ${slug} instead.`;
}

function suggestDenoV2(): string {
  // Go: `suggestDenoV2` (`download.go:306-312`), verbatim including its
  // trailing newline.
  return "Please use deno v2 in supabase/config.toml to download this Function:\n\n[edge_runtime]\ndeno_version = 2\n";
}

/**
 * Attaches Go's `suggestLegacyBundle` hint to any Docker-extraction failure —
 * matches `downloadWithDockerUnbundle`'s `CmdSuggestion +=
 * suggestLegacyBundle(slug)` (`download.go:211-214`), which runs whenever
 * `extractOne` fails for *any* reason (network/volume creation, container
 * create/start, log streaming, container inspect), not just a non-zero exit
 * code. `ensureDockerNetwork`/`ensureDockerNamedVolume` already prefix their
 * own "failed to create docker network/volume: ..." context on the failures
 * they raise themselves (`functions-docker.ts`), so this only normalizes
 * (never re-prefixes) whatever `legacyDescribeContainerCliFailure` reports.
 */
function withLegacyBundleSuggestion(slug: string) {
  return (cause: unknown): Error =>
    Object.assign(new Error(legacyDescribeContainerCliFailure(cause)), {
      suggestion: suggestLegacyBundle(slug),
    });
}

/**
 * Same as {@link withLegacyBundleSuggestion}, plus a `step` prefix — for
 * `runChildProcess` itself, whose own failure (a spawn error, or the
 * `PlatformError` `functions-docker.ts`'s hoisted `collectByteStream` erases
 * to `unknown`) carries no context of its own about which command was
 * running, unlike `ensureDockerNetwork`/`ensureDockerNamedVolume`'s
 * self-describing errors.
 */
function withDockerStepFailure(step: string, slug: string) {
  return (cause: unknown): Error =>
    Object.assign(new Error(`${step}: ${legacyDescribeContainerCliFailure(cause)}`), {
      suggestion: suggestLegacyBundle(slug),
    });
}

// Go: `Config.EdgeRuntime.Image` (`extractOne`, `download.go:271`) resolves
// from `edge_runtime.deno_version` — `1` pins the older
// `DENO1_EDGE_RUNTIME_VERSION`, anything else (including unset) uses the
// project's configured/default tag (`resolveEdgeRuntimeVersion`, shared with
// `deploy.ts`). `project_id` mirrors `deploy.ts`'s own
// `deployConfig?.project_id ?? projectRef` fallback for Docker network/volume
// naming (`GetId`, `internal/utils/config.go:57-58`). Resolved once per
// invocation by the caller (`downloadFunctions`), not once per slug — Go's
// `Config` is likewise loaded once, before any per-function work.
const resolveEdgeRuntimeImage = Effect.fnUntraced(function* (
  dependencies: EdgeRuntimeImageDependencies,
  projectRef: string,
) {
  const loadedConfig = yield* loadProjectConfig(dependencies.projectRoot, {
    projectRef,
    goViperCompat: dependencies.goViperCompat,
    // `search: false`/`tomlOnly: true` only under `goViperCompat` (the legacy caller, whose
    // `dependencies.projectRoot` is `cliConfig.workdir` — already Go's fully-resolved chdir
    // target, same reasoning as `legacy-local-project-context.ts`/`start.handler.ts`). Go's
    // `flags.LoadConfig` (`pkg/config/utils.go:43-48`) only ever resolves `supabase/config.toml`
    // from that exact workdir, with no ancestor climb and no concept of a JSON project config —
    // leaving these unset here would let an unrelated ancestor project's config win, or a stray
    // `supabase/config.json` be preferred over `config.toml`, for the legacy shell's Docker
    // download path specifically. The `next` shell keeps the package defaults (ancestor search,
    // JSON preferred), matching its other non-Go-parity `loadProjectConfig` callers.
    search: dependencies.goViperCompat ? false : undefined,
    tomlOnly: dependencies.goViperCompat,
  });
  // A project with no `supabase/config.toml`/`config.json` makes
  // `loadProjectConfig` return `null` outright, so `denoVersion` below falls
  // through to `undefined` and this always resolves the v2 default. Go's
  // `flags.LoadConfig` never short-circuits like that: `Config.Load` →
  // `loadFromFile` (`pkg/config/config.go:579-611`) merges the template
  // defaults and enables `viper.AutomaticEnv()` with `SetEnvPrefix("SUPABASE")`
  // *before* attempting to read the file — `mergeFileConfig` (`config.go:701-716`)
  // simply no-ops on `os.ErrNotExist` — so `SUPABASE_EDGE_RUNTIME_DENO_VERSION=1`
  // (or the same key in `supabase/.env`, via `loadNestedEnv`) still pins the
  // deno-v1 image even with no config.toml on disk. Pre-existing, not
  // introduced by this PR: `@supabase/config`'s `loadProjectConfig` has no
  // equivalent of Go's generic `ExperimentalBindStruct`+`AutomaticEnv` field
  // binding at all (it only expands literal `env(...)` references already
  // written inside the TOML), so `deploy.ts`'s identical
  // `resolveEdgeRuntimeVersion(deployConfig?.edge_runtime.deno_version, ...)`
  // call has the same gap whether or not config.toml exists. A fix belongs in
  // the shared config-loading layer every native caller goes through (`gen
  // types`, `next start`, `functions dev/serve/deploy`, …), not duplicated
  // per call site here — left open (review round on CLI-1963's `functions
  // download` port).
  const denoVersion = loadedConfig?.config?.edge_runtime.deno_version;
  const projectId = loadedConfig?.config?.project_id ?? projectRef;
  const edgeRuntimeVersion = yield* resolveEdgeRuntimeVersion(
    denoVersion,
    dependencies.edgeRuntimeVersion,
  );
  return {
    projectId,
    denoVersion,
    // `edgeRuntimeImageTag` (not a bare `v${edgeRuntimeVersion}` prepend) —
    // `dependencies.edgeRuntimeVersion` comes from a `.temp/edge-runtime-version`
    // pin that may already carry its own `v` prefix (see the helper's doc).
    //
    // Single `legacyGetRegistryImageUrl` value, not the ECR→GHCR→Docker-Hub
    // retry `legacyGetRegistryImageUrlCandidates` gives `start` (review round
    // on CLI-1963's `functions download` port). Go's `DockerStart` resolves
    // `config.Image` through `DockerResolveImageIfNotCached`
    // (`internal/utils/docker.go:326-348,363-365`), which tries every
    // registry candidate — including for this exact edge-runtime unbundle
    // container — so an ECR outage/throttle that the previous Go-delegated
    // default path would have survived can now fail this native path outright.
    // Pre-existing, not introduced by this PR: `deploy.ts`'s and `serve.ts`'s
    // own already-shipped native Docker paths resolve this identically
    // (single-URL, no retry) — `legacyGetRegistryImageUrlCandidates` has only
    // ever been wired up for `start` (see its own doc comment). Extending the
    // retry to all three `functions` Docker paths is a shared, cross-cutting
    // follow-up, not something to fix piecemeal for `download` alone.
    image: legacyGetRegistryImageUrl(
      `supabase/edge-runtime:${edgeRuntimeImageTag(edgeRuntimeVersion)}`,
    ),
  };
});

interface EdgeRuntimeImage {
  readonly projectId: string;
  readonly denoVersion: number | undefined;
  readonly image: string;
}

// Go: `downloadWithDockerUnbundle`/`extractOne`
// (`download.go:198-282`) — downloads the function body as an eszip, writes
// it to a temp file, then runs the edge-runtime image's `unbundle`
// subcommand against it, mounting the *shared* `supabase/functions`
// directory (not the slug's own subdirectory — `download_test.go:267-271`
// asserts this explicitly).
const downloadWithDockerUnbundle = Effect.fnUntraced(function* (
  dependencies: DownloadDockerRuntimeDependencies,
  edgeRuntimeImage: EdgeRuntimeImage,
  projectRef: string,
  slug: string,
) {
  const output = yield* Output;

  // Go: `downloadOne` (`download.go:219`) — lowercase "function", distinct
  // from the server-side path's "Downloading Function:" (capital F,
  // `downloadWithServerSideUnbundle`, `download.go:329`).
  yield* output.raw(`Downloading function: ${slug}\n`, "stderr");

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

  // Go: the `defer fsys.Remove(eszipPath)` cleanup is registered right after
  // the write and covers the whole of `extractOne`, including the container
  // run — it fires on every return path, success or failure
  // (`download.go:203-209`). `Effect.ensuring` below is the equivalent: it
  // wraps every step from here on so a failure resolving the network/volume,
  // spawning Docker, or a non-zero container exit all still clean up the
  // temp eszip, matching Go instead of only doing so on the happy path.
  //
  // Go gates this on `viper.GetBool("DEBUG")` (`download.go:203`), which
  // resolves an explicit `--debug=false` to `false` (cleanup runs) — a plain
  // presence check would get that backwards, so this reads the last explicit
  // occurrence's boolean value instead (`explicitBooleanLongFlag`), falling
  // back to `false` (cleanup runs) when `--debug` never appears. `SUPABASE_DEBUG`
  // env-var fallback is a separate, pre-existing gap shared with every other
  // `hasGlobalLongFlag(rawArgs, "debug")` call site in this file family
  // (e.g. `deploy.ts`) and the legacy debug logger itself, none of which
  // currently honor it either — left open rather than fixed piecemeal here.
  const debugEnabled = explicitBooleanLongFlag(dependencies.rawArgs, "debug") ?? false;
  const cleanupEszip = debugEnabled
    ? Effect.void
    : Effect.tryPromise({
        try: () => rm(eszipPath, { force: true }),
        catch: (cause) => (cause instanceof Error ? cause.message : String(cause)),
      }).pipe(Effect.catch((message) => output.raw(`${message}\n`, "stderr")));

  const { projectId, denoVersion, image } = edgeRuntimeImage;
  const functionsDir = resolve(dependencies.projectRoot, "supabase", "functions");
  const hostEszipPath = resolve(eszipPath);
  const dockerEszipPath = posix.join(DOCKER_ESZIP_DIR, eszipFileName);
  const dockerOutputPath = posix.join(DOCKER_DENO_DIR, slug);

  // Go: `viper.GetString("network-id")` else `NetId` (`docker.go:379-383`) —
  // `--network-id` is a persistent root flag (`cmd/root.go:328`), not
  // registered on `functions download` itself. Go only treats the override as
  // set when `len(networkId) > 0`, so an explicit-but-empty `--network-id=`
  // must fall through to the generated network name too, not just an omitted
  // flag — `explicitNonEmptyStringFlag` (unlike the unexported
  // `explicitStringFlag`) treats that case as unset for exactly this reason.
  //
  // Go's root `init()` also binds every persistent flag (including
  // `network-id`) through `viper.BindPFlags` after enabling
  // `viper.AutomaticEnv()` with `SetEnvPrefix("SUPABASE")` and a `-`→`_`
  // replacer (`cmd/root.go:316-334`), so `SUPABASE_NETWORK_ID` overrides the
  // flag's empty default whenever `--network-id` itself is never passed —
  // this raw-argv-only lookup has no equivalent env-var fallback. Pre-existing,
  // not introduced by this PR: `start.handler.ts`'s `LegacyNetworkIdFlag` and
  // `deploy.ts`'s/`serve.ts`'s own network-id resolution don't check
  // `SUPABASE_NETWORK_ID` either — no native command does today. A fix
  // belongs in one shared place for the global `--network-id` resolution,
  // not duplicated per Docker-path call site here — left open (review round
  // on CLI-1963's `functions download` port).
  const networkMode =
    explicitNonEmptyStringFlag(dependencies.rawArgs, "network-id") ??
    localDockerId("network", projectId);

  const extract = Effect.gen(function* () {
    yield* ensureDockerNetwork(networkMode, projectId).pipe(
      Effect.mapError(withLegacyBundleSuggestion(slug)),
    );
    yield* ensureDockerNamedVolume(localDockerId("edge_runtime", projectId), projectId).pipe(
      Effect.mapError(withLegacyBundleSuggestion(slug)),
    );

    // Bind order matches `extractOne` (`download.go:260-266`) exactly. Go's
    // `DockerStart` drops the named-volume bind entirely on Bitbucket
    // (`internal/utils/docker.go:400-405`) rather than just skipping its
    // explicit creation — `docker run -v <name>:...` would otherwise still
    // implicitly create the named volume, which Bitbucket's restricted Docker
    // environment doesn't allow, same carve-out as `deploy.ts`'s
    // `buildDockerBinds`.
    const binds = [
      ...(process.env["BITBUCKET_CLONE_DIR"] === undefined
        ? [`${localDockerId("edge_runtime", projectId)}:/root/.cache/deno:rw`]
        : []),
      `${hostEszipPath}:${dockerEszipPath}:ro`,
      `${functionsDir}:${DOCKER_DENO_DIR}:rw`,
    ];
    const command = [
      "run",
      "--rm",
      ...binds.flatMap((bind) => ["-v", bind]),
      "--network",
      networkMode,
    ];
    if (process.platform === "linux") {
      command.push("--add-host", "host.docker.internal:host-gateway");
    }
    command.push(image, "unbundle", "--eszip", dockerEszipPath, "--output", dockerOutputPath);

    const result = yield* runChildProcess("docker", command, {
      stdout: "pipe",
      stderr: "pipe",
    }).pipe(
      Effect.mapError(
        withDockerStepFailure("failed to run the edge-runtime unbundle container", slug),
      ),
    );

    // Go pipes the container's stdout straight to `os.Stdout` (`download.go:279`);
    // machine-output modes must keep stdout payload-only (CLI-1546), so this
    // mirrors `deploy.ts`'s own `bundleFunctionWithDocker` routing.
    if (result.stdout.length > 0) {
      yield* output.raw(result.stdout, output.format === "text" ? "stdout" : "stderr");
    }
    if (result.stderr.length > 0) {
      yield* output.raw(result.stderr, "stderr");
    }

    if (result.exitCode !== 0) {
      // Go's `getErrorLogger` (deno-v1 only) sets `CmdSuggestion =
      // suggestDenoV2()` (assignment) as soon as a full stderr line reads
      // "invalid eszip v2" (case-insensitive), then `downloadWithDockerUnbundle`
      // appends `suggestLegacyBundle` (`+=`) once extraction has failed
      // (`download.go:213,284-304`). Go's own implementation races these two
      // goroutines (the pipe writer is never closed) — this resolves that
      // race deterministically to the common (non-race) ordering instead of
      // reproducing the nondeterminism. The line match is exact (not a
      // substring) to match Go's `strings.EqualFold(line, "invalid eszip v2")`.
      const invalidEszipV2 =
        denoVersion === 1 &&
        result.stderr
          .split(/\r?\n/)
          .some((line) => line.trim().toLowerCase() === "invalid eszip v2");
      const suggestion = (invalidEszipV2 ? suggestDenoV2() : "") + suggestLegacyBundle(slug);
      return yield* Effect.fail(
        Object.assign(new Error(`error running container: exit ${result.exitCode}`), {
          suggestion,
        }),
      );
    }

    // Go: `downloadWithDockerUnbundle` has no final "Downloaded Function ..."
    // print, unlike `RunLegacy`/`downloadWithServerSideUnbundle` — its only
    // stdout/stderr text is "Downloading function: ..." above plus whatever
    // the `unbundle` container itself wrote.
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

    // `--legacy-bundle` is the only case still delegated to the Go binary
    // after CLI-1963: it requires installing/upgrading a real Deno binary on
    // the host (`InstallOrUpgradeDeno`) and shelling out to an embedded Deno
    // script — a Deno-host-binary-management subsystem with no precedent
    // anywhere else in this codebase or the Go CLI itself. See CLI-1963 for
    // the parity-audit rationale on why porting it is tracked separately.
    // `--use-docker` (default `true`) now runs natively below, matching
    // Go's own dispatcher, which falls through to the *same* native
    // server-side downloader when Docker isn't running rather than
    // delegating anywhere (`download.go:138-148`).
    if (flags.legacyBundle) {
      const projectRef = yield* dependencies.resolveProjectRef(flags.projectRef);

      if (output.format === "text") {
        yield* dependencies.proxyDownload(flags, projectRef, false);
        return;
      }

      // Resolve the slug list *before* delegating, mirroring Go's own
      // `downloadAll` (which also lists before looping through downloads,
      // `apps/cli-go/internal/functions/download/download.go`). The
      // delegated Go child never emits the TS `Output` envelope itself
      // (CLI-1546: stdout is payload-only in machine mode, so its raw text
      // is captured/discarded below, not inherited) — this list is purely
      // for the JSON payload. Resolving it first means a transient listing
      // failure is reported before any download side effect, instead of
      // masking an already-successful delegated download with a later,
      // unrelated listing failure.
      const slugs = Option.isSome(flags.functionName)
        ? [flags.functionName.value]
        : yield* listRemoteFunctionSlugs(dependencies.api, projectRef);

      // Mirrors the native path's empty-project short-circuit just below:
      // an empty project has nothing to delegate, so report it the same way
      // ("No functions found.") instead of still invoking the Go child (an
      // unnecessary Docker/subprocess round-trip) and reporting a
      // misleading "Downloaded Edge Function source." success with an
      // empty slug list.
      if (slugs.length === 0) {
        yield* output.success("No functions found.", {
          function_slugs: [],
          project_ref: projectRef,
        });
        return;
      }

      yield* dependencies.proxyDownload(flags, projectRef, true);

      yield* output.success("Downloaded Edge Function source.", {
        function_slugs: slugs,
        project_ref: projectRef,
      });
      return;
    }

    const projectRef = yield* dependencies.resolveProjectRef(flags.projectRef);

    // Go: `flags.LoadConfig(fsys)` runs unconditionally at the very top of
    // `Run`, before checking `useDocker`, before checking whether Docker
    // itself is running, and before any API/filesystem side effect
    // (`download.go:135-138`) — an invalid `supabase/config.toml` (e.g. a bad
    // `edge_runtime.deno_version`) must fail up front regardless of
    // `--use-api`/`--use-docker`/Docker's running state, not only on the
    // Docker happy path. Resolving unconditionally here (rather than nested
    // inside the `isDockerRunning()` branch below) keeps that ordering: a
    // config error now surfaces even when `--use-api` was passed or Docker is
    // down, matching Go instead of silently skipping validation and
    // proceeding straight to `listRemoteFunctionSlugs`/`downloadSingle`.
    const resolvedEdgeRuntimeImage = yield* resolveEdgeRuntimeImage(dependencies, projectRef);

    // Go: `Run` resolves ONE downloader for the entire invocation, before any
    // per-function work — including before listing when no slug is given
    // (`download.go:138-153`), so this warning can print even when the
    // project turns out to have zero functions. Mirrors Go's
    // `if useApi { useDocker = false }` (`cmd/functions.go:51-53`), which
    // reads the resolved flag value, not `pflag.Changed`.
    // Single source of truth for "use the Docker downloader": `undefined`
    // means the native server-side path runs instead, whether because
    // `--use-api` (or `--use-docker=false`) resolved that way or because
    // Docker isn't running. Deliberately not a separate `useDocker: boolean`
    // alongside this — a boolean that could disagree with whether an image
    // was actually resolved would let the loop below silently downgrade to
    // the server-side path while claiming to honor `--use-docker`.
    const edgeRuntimeImage: EdgeRuntimeImage | undefined =
      !flags.useApi && flags.useDocker
        ? (yield* isDockerRunning())
          ? resolvedEdgeRuntimeImage
          : yield* output
              .raw("WARNING: Docker is not running\n", "stderr")
              .pipe(Effect.as(undefined))
        : undefined;

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
      // Go: CLI-1891, `downloadAll`'s per-item validation runs before any
      // per-slug network/filesystem work (`download.go:182-188`). A
      // user-supplied slug is already validated above (`validateSlug`); this
      // covers slugs sourced from the Management API's function list, which
      // this threat model treats as untrusted (a malicious/compromised
      // response, or a MITM).
      if (Option.isNone(flags.functionName)) {
        yield* validateRemoteSlug(slug);
      }
      if (edgeRuntimeImage !== undefined) {
        downloaded.push(
          yield* downloadWithDockerUnbundle(dependencies, edgeRuntimeImage, projectRef, slug),
        );
      } else {
        downloaded.push(yield* downloadSingle(dependencies, projectRef, slug));
      }
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
