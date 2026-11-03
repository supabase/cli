/**
 * Gates an `@supabase/config` npm release on its compiled `.d.ts` surface — diffs the freshly
 * built `packages/config/dist/**\/*.d.ts` against the previously published npm tarball's
 * declarations, so a human approving `npm publish` sees the surface diff before signing off. The
 * PR-time counterpart is the advisory compare in `tools/config-api-compare.ts`.
 *
 * Usage:
 *   bun tools/config-release-gate.ts --version <next version> [--registry <url>] [--tarball <path>] [--local-dist <dir>]
 *
 * `--version` is the version semantic-release computed for this release. `--registry` defaults to
 * `npm config get registry` (so a local Verdaccio harness works here too), falling back to the
 * public npm registry. `--tarball` points at a local `.tgz` to use as the "published" side instead
 * of querying the registry; a registry-downloaded tarball is verified against its
 * `dist.integrity` and refused if its URL points off-registry. `--local-dist` overrides the "next
 * release" side (default: `packages/config/dist`); the release workflow points it at the dist tree
 * extracted from the packed release tarball, so the evidence matches the exact artifact shipped.
 *
 * This tool never builds `packages/config/dist` itself — run the package build first. When the
 * package has never been published (npm view returns E404), the full surface ships as-is.
 *
 * Never exits 1 on a surface diff: the gate is the human approval step reading this summary, not
 * an automatic pass/fail check.
 *
 * Exit codes: 0 the gate ran (including a first release with nothing published yet), 2 tool
 * failure.
 */

import { BunFileSystem, BunPath } from "@effect/platform-bun";
import {
  Cause,
  Console,
  Effect,
  FileSystem,
  Layer,
  Path,
  PlatformError,
  Schema,
  Stream,
} from "effect";
import { FetchHttpClient, HttpClient, type HttpClientError } from "effect/http";
import process from "node:process";
import { parseArgs } from "node:util";
import {
  type CompareResult,
  countByStatus,
  countDeclarationFiles,
  diffDeclarationTrees,
  type FileEntry,
  readUtf8,
  renderDiffDetailsBlocks,
  writeStepSummary,
} from "./lib/dts-diff.ts";

const PACKAGE_NAME = "@supabase/config";
const DEFAULT_REGISTRY = "https://registry.npmjs.org";

const toolPaths = Effect.gen(function* () {
  const path = yield* Path.Path;
  const repoRoot = path.resolve(import.meta.dir, "..");
  const packageRoot = path.join(repoRoot, "packages", "config");
  const localDistDir = path.join(packageRoot, "dist");
  return { repoRoot, localDistDir };
});

class ConfigReleaseGateError extends Schema.TaggedError<ConfigReleaseGateError>()(
  "ConfigReleaseGateError",
  { message: Schema.String },
) {}

const foreignFailure = (cause: unknown) =>
  new ConfigReleaseGateError({ message: cause instanceof Error ? cause.message : String(cause) });

const UnknownFromJsonString = Schema.fromJsonString(Schema.Unknown);

/* Native `JSON.parse`, so a malformed package.json fails with its own `SyntaxError`. */
const parseJson = (text: string): unknown => JSON.parse(text);

/* Reports the underlying fetch error's message, not the HttpClientError summary. */
const httpFailure = (error: HttpClientError.HttpClientError) =>
  foreignFailure(error.cause ?? error);

interface CommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

const runCommand = Effect.fnUntraced(function* (
  cmd: readonly string[],
): Effect.fn.Return<CommandResult, ConfigReleaseGateError, Path.Path> {
  const { repoRoot } = yield* toolPaths;
  const proc = yield* Effect.try({
    try: () => Bun.spawn([...cmd], { cwd: repoRoot, stdout: "pipe", stderr: "pipe" }),
    catch: foreignFailure,
  });
  const [exitCode, stdout, stderr] = yield* Effect.tryPromise({
    try: () =>
      Promise.all([
        proc.exited,
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ]),
    catch: foreignFailure,
  });
  return { exitCode, stdout, stderr };
});

const requireBinaries = Effect.fnUntraced(function* (names: readonly string[]) {
  const missing = names.filter((name) => Bun.which(name) === null);
  if (missing.length > 0) {
    return yield* new ConfigReleaseGateError({
      message: `this tool requires ${missing.join(", ")} on PATH.`,
    });
  }
});

/**
 * Reads the ambient npm registry so a local Verdaccio harness, which rewrites npm's registry
 * config, is honored instead of assuming the public registry.
 */
const ambientNpmRegistry = Effect.fnUntraced(function* () {
  const result = yield* runCommand(["npm", "config", "get", "registry"]);
  const registry = result.stdout.trim().replace(/\/+$/, "");
  return result.exitCode === 0 && registry !== "" ? registry : DEFAULT_REGISTRY;
});

const pathExists = (fs: FileSystem.FileSystem, target: string) =>
  fs.stat(target).pipe(
    Effect.as(true),
    Effect.orElseSucceed(() => false),
  );

const extractTarball = Effect.fnUntraced(function* (tarballPath: string, destDir: string) {
  const fs = yield* FileSystem.FileSystem;
  yield* fs.makeDirectory(destDir, { recursive: true });
  // The tarball is registry-supplied, i.e. untrusted: never restore its
  // recorded owners or permission bits. (GNU tar already refuses `..`
  // members, so path escape is covered by the extractor itself.)
  const result = yield* runCommand([
    "tar",
    "-xzf",
    tarballPath,
    "-C",
    destDir,
    "--no-same-owner",
    "--no-same-permissions",
  ]);
  if (result.exitCode !== 0) {
    return yield* new ConfigReleaseGateError({
      message: `tar extraction of ${tarballPath} into ${destDir} failed: ${result.stderr.trim()}`,
    });
  }
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Reads the `version` field out of an extracted tarball's `package/package.json`. */
const readExtractedPackageVersion = Effect.fnUntraced(function* (extractDir: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const packageJsonPath = path.join(extractDir, "package", "package.json");
  const raw = yield* readUtf8(fs, packageJsonPath);
  const parsed = yield* Effect.try({ try: () => parseJson(raw), catch: foreignFailure });
  if (!isRecord(parsed) || typeof parsed.version !== "string") {
    return yield* new ConfigReleaseGateError({
      message: `${packageJsonPath} has no string "version" field.`,
    });
  }
  return parsed.version;
});

const downloadFile = Effect.fnUntraced(function* (url: string, destPath: string) {
  const fs = yield* FileSystem.FileSystem;
  const client = yield* HttpClient.HttpClient;
  const response = yield* client.get(url).pipe(Effect.mapError(httpFailure));
  if (response.status < 200 || response.status >= 300) {
    return yield* new ConfigReleaseGateError({
      message: `failed to download ${url}: HTTP ${response.status}`,
    });
  }
  yield* response.stream.pipe(
    /* A body-less 2xx (204/205) has no stream, and still leaves an empty file. */
    Stream.catchReason("HttpClientError", "EmptyBodyError", () => Stream.empty),
    Stream.mapError(httpFailure),
    Stream.run(fs.sink(destPath)),
  );
});

/**
 * `npm view --json` reports errors as `{"error":{"code":…}}` on stdout, so a
 * genuine E404 (never published) is distinguishable from a transport failure
 * or an error message that merely mentions "E404" somewhere.
 */
const npmViewJson = Effect.fnUntraced(function* (
  spec: string,
  field: string,
  registry: string,
): Effect.fn.Return<
  { readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly code: string },
  ConfigReleaseGateError,
  Path.Path
> {
  const result = yield* runCommand(["npm", "view", spec, field, "--registry", registry, "--json"]);
  // `npm view` prints nothing at all for an absent field.
  const parsed: unknown =
    result.stdout.trim() === ""
      ? undefined
      : yield* Schema.decodeEffect(UnknownFromJsonString)(result.stdout).pipe(
          Effect.mapError(
            () =>
              new ConfigReleaseGateError({
                message: `npm view ${spec} ${field} --registry ${registry} returned unparseable output: ${result.stdout.trim().slice(0, 200)}`,
              }),
          ),
        );
  if (result.exitCode !== 0) {
    if (isRecord(parsed) && isRecord(parsed.error) && typeof parsed.error.code === "string") {
      return { ok: false, code: parsed.error.code };
    }
    return yield* new ConfigReleaseGateError({
      message: `npm view ${spec} ${field} --registry ${registry} failed: ${result.stderr.trim()}`,
    });
  }
  return { ok: true, value: parsed };
});

const verifyTarballIntegrity = Effect.fnUntraced(function* (
  tarballPath: string,
  integrity: string,
) {
  if (!integrity.startsWith("sha512-")) {
    return yield* new ConfigReleaseGateError({
      message: `expected a sha512 integrity value from the registry, got "${integrity}".`,
    });
  }
  const hasher = new Bun.CryptoHasher("sha512");
  hasher.update(
    yield* Effect.tryPromise({
      try: () => Bun.file(tarballPath).arrayBuffer(),
      catch: foreignFailure,
    }),
  );
  const digest = `sha512-${hasher.digest("base64")}`;
  if (digest !== integrity) {
    return yield* new ConfigReleaseGateError({
      message: `downloaded tarball failed integrity verification: registry says ${integrity}, got ${digest}.`,
    });
  }
});

type PublishedSide =
  | { readonly kind: "first-publish" }
  | { readonly kind: "resolved"; readonly version: string; readonly distDir: string };

/**
 * Resolves the "published" side of the diff: an explicit `--tarball` wins; otherwise downloads
 * `dist-tags.latest` from `<registry>`, verified against its `dist.integrity` and refused if its
 * URL points off-registry. No published version (or no `latest` tag) resolves to `"first-publish"`.
 */
const resolvePublishedSide = Effect.fnUntraced(function* (
  registry: string,
  tarballArg: string | undefined,
  extractDir: string,
): Effect.fn.Return<
  PublishedSide,
  ConfigReleaseGateError | PlatformError.PlatformError,
  FileSystem.FileSystem | Path.Path | HttpClient.HttpClient
> {
  const path = yield* Path.Path;
  if (tarballArg) {
    yield* extractTarball(tarballArg, extractDir);
    const version = yield* readExtractedPackageVersion(extractDir);
    return { kind: "resolved", version, distDir: path.join(extractDir, "package", "dist") };
  }

  const latestResult = yield* npmViewJson(PACKAGE_NAME, "dist-tags.latest", registry);
  if (!latestResult.ok) {
    if (latestResult.code === "E404") {
      return { kind: "first-publish" };
    }
    return yield* new ConfigReleaseGateError({
      message: `npm view ${PACKAGE_NAME} dist-tags.latest failed with ${latestResult.code}.`,
    });
  }
  if (typeof latestResult.value !== "string" || latestResult.value === "") {
    yield* Console.warn(
      `[config-release-gate] ${PACKAGE_NAME} exists on ${registry} but has no "latest" dist-tag — treating as first publish.`,
    );
    return { kind: "first-publish" };
  }
  const latestVersion = latestResult.value;

  const spec = `${PACKAGE_NAME}@${latestVersion}`;
  const [tarballUrlResult, integrityResult] = yield* Effect.all(
    [npmViewJson(spec, "dist.tarball", registry), npmViewJson(spec, "dist.integrity", registry)],
    { concurrency: "unbounded" },
  );
  if (!tarballUrlResult.ok || typeof tarballUrlResult.value !== "string") {
    return yield* new ConfigReleaseGateError({
      message: `npm view ${spec} dist.tarball returned no tarball URL.`,
    });
  }
  if (!integrityResult.ok || typeof integrityResult.value !== "string") {
    return yield* new ConfigReleaseGateError({
      message: `npm view ${spec} dist.integrity returned no integrity value.`,
    });
  }
  const tarballUrl = tarballUrlResult.value;
  const [tarballOrigin, registryOrigin] = yield* Effect.try({
    try: () => [new URL(tarballUrl).origin, new URL(registry).origin],
    catch: foreignFailure,
  });
  if (tarballOrigin !== registryOrigin) {
    return yield* new ConfigReleaseGateError({
      message: `refusing tarball from ${tarballOrigin} — it does not match the registry origin ${registryOrigin}.`,
    });
  }

  const downloadedTarballPath = path.join(extractDir, "published.tgz");
  yield* downloadFile(tarballUrl, downloadedTarballPath);
  yield* verifyTarballIntegrity(downloadedTarballPath, integrityResult.value);
  yield* extractTarball(downloadedTarballPath, extractDir);

  return {
    kind: "resolved",
    version: latestVersion,
    distDir: path.join(extractDir, "package", "dist"),
  };
});

type BumpClass = "major" | "minor" | "patch" | "none" | "downgrade" | "unknown";

interface VersionParts {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
}

function parseVersionParts(version: string): VersionParts | null {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!match) {
    return null;
  }
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) };
}

/**
 * Numeric major/minor/patch comparison; an unparseable version (the published side can come from
 * outside this pipeline) degrades to `"unknown"` rather than failing the job. Ordering matters,
 * not just inequality: an equal or lower next version signals tag/registry skew (a hand-pushed or
 * deleted `config-v*` tag), which gets its own warning instead of a spurious "major bump".
 */
function computeBumpClass(publishedVersion: string, nextVersion: string): BumpClass {
  const published = parseVersionParts(publishedVersion);
  const next = parseVersionParts(nextVersion);
  if (published === null || next === null) return "unknown";
  for (const part of ["major", "minor", "patch"] as const) {
    if (next[part] > published[part]) return part;
    if (next[part] < published[part]) return "downgrade";
  }
  return "none";
}

/** A `changed` file whose unified diff removes lines — the shape an export deletion takes. */
function hasRemovedDeclarationLines(entries: readonly FileEntry[]): boolean {
  return entries.some((entry) => entry.status === "changed" && unifiedDiffRemovesLines(entry.diff));
}

/**
 * Only lines inside hunks (after the first `@@`) count — a bare prefix test would miss a removed
 * content line that itself starts with `--` (its hunk rendering is `---`) and false-positive on
 * the old-file header.
 */
function unifiedDiffRemovesLines(diff: string): boolean {
  let inHunk = false;
  for (const line of diff.split("\n")) {
    if (line.startsWith("@@")) {
      inHunk = true;
      continue;
    }
    if (inHunk && line.startsWith("-")) {
      return true;
    }
  }
  return false;
}

/**
 * Semver sanity warnings for the human approver — surfaced prominently but
 * never turned into a non-zero exit; the human decides.
 */
function computeWarnings(bumpClass: BumpClass, result: CompareResult): string[] {
  const warnings: string[] = [];
  if (bumpClass === "unknown") {
    warnings.push(
      "Could not classify the version bump (a version is not a plain x.y.z) — review the diff without semver hints.",
    );
    return warnings;
  }
  if (bumpClass === "none") {
    warnings.push(
      "The next version EQUALS the published version — version computation is skewed (a config-v* " +
        "tag was hand-pushed or deleted); the publish step will refuse to ship different bytes " +
        "under it. Do not approve without investigating.",
    );
  }
  if (bumpClass === "downgrade") {
    warnings.push(
      "The next version is LOWER than the published version — tag/registry skew (a config-v* tag " +
        "was hand-pushed or deleted, or the registry was seeded outside this pipeline). Do not " +
        "approve without investigating.",
    );
  }
  if (!result.identical && bumpClass === "patch") {
    warnings.push(
      "Type-surface diff is non-empty but the version bump is only a patch — confirm this isn't a missed minor/major bump.",
    );
  }
  if (result.entries.some((entry) => entry.status === "removed") && bumpClass !== "major") {
    warnings.push(
      "A declaration file was removed but the version bump is not major — confirm this isn't a breaking change.",
    );
  }
  if (hasRemovedDeclarationLines(result.entries) && bumpClass !== "major") {
    warnings.push(
      "Declaration lines were removed from an existing .d.ts but the version bump is not major — confirm no export was dropped.",
    );
  }
  return warnings;
}

function renderTextReport(
  publishedVersion: string,
  nextVersion: string,
  result: CompareResult,
  warnings: readonly string[],
): string {
  const lines: string[] = [
    `@supabase/config release gate: ${publishedVersion} -> ${nextVersion}`,
    "",
  ];
  for (const warning of warnings) {
    lines.push(`WARNING: ${warning}`);
  }
  if (warnings.length > 0) {
    lines.push("");
  }

  if (result.identical) {
    lines.push("No type-surface differences.");
    return lines.join("\n");
  }

  lines.push(
    `Added: ${countByStatus(result.entries, "added")}, ` +
      `Removed: ${countByStatus(result.entries, "removed")}, ` +
      `Changed: ${countByStatus(result.entries, "changed")}`,
    "",
  );
  for (const entry of result.entries) {
    lines.push(`--- ${entry.status} ${entry.path} ---`, entry.diff.trimEnd(), "");
  }
  return lines.join("\n");
}

function renderMarkdownSummary(
  publishedVersion: string,
  nextVersion: string,
  result: CompareResult,
  warnings: readonly string[],
): string {
  const lines: string[] = [
    "## @supabase/config release gate — type-surface diff",
    "",
    `\`${publishedVersion}\` → \`${nextVersion}\``,
    "",
  ];
  for (const warning of warnings) {
    lines.push(`⚠️ **${warning}**`, "");
  }

  if (result.identical) {
    lines.push("No type-surface differences.");
    return lines.join("\n");
  }

  lines.push(
    `**${countByStatus(result.entries, "added")} added, ` +
      `${countByStatus(result.entries, "removed")} removed, ` +
      `${countByStatus(result.entries, "changed")} changed**`,
    "",
  );
  lines.push(...renderDiffDetailsBlocks(result.entries));
  return lines.join("\n");
}

const FIRST_PUBLISH_MESSAGE =
  "First publish — no published version to compare against; the full surface ships as-is.";

function renderFirstPublishSummary(nextVersion: string): string {
  return [
    "## @supabase/config release gate — type-surface diff",
    "",
    `Preparing the first release, \`${nextVersion}\`.`,
    "",
    FIRST_PUBLISH_MESSAGE,
  ].join("\n");
}

const main = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const { localDistDir } = yield* toolPaths;
  const { values } = yield* Effect.try({
    try: () =>
      parseArgs({
        options: {
          version: { type: "string" },
          registry: { type: "string" },
          tarball: { type: "string" },
          "local-dist": { type: "string" },
        },
      }),
    catch: foreignFailure,
  });

  if (!values.version) {
    return yield* new ConfigReleaseGateError({ message: "--version <next version> is required." });
  }
  const nextVersion = values.version;

  yield* requireBinaries(values.tarball ? ["tar", "diff"] : ["tar", "diff", "npm"]);

  const registry =
    values.registry ?? (values.tarball ? DEFAULT_REGISTRY : yield* ambientNpmRegistry());

  const localDist = values["local-dist"] ?? localDistDir;

  if (!(yield* pathExists(fs, localDist)) || (yield* countDeclarationFiles(localDist)) === 0) {
    return yield* new ConfigReleaseGateError({
      message:
        `${localDist} has no .d.ts files — ` +
        (values["local-dist"]
          ? "the packed tarball lost its declarations (the .gitignore/packlist trap packages/config/.npmignore exists for)."
          : "run the package build first (e.g. `pnpm exec turbo run @supabase/config#build`)."),
    });
  }

  const extractDir = yield* fs.makeTempDirectory({ prefix: "supabase-config-release-gate-" });

  const exit = yield* Effect.gen(function* () {
    const published = yield* resolvePublishedSide(registry, values.tarball, extractDir);

    if (published.kind === "first-publish") {
      yield* Console.log(
        `[config-release-gate] ${PACKAGE_NAME} has never been published to ${registry}.`,
      );
      yield* Console.log(FIRST_PUBLISH_MESSAGE);
      yield* writeStepSummary(renderFirstPublishSummary(nextVersion));
      return 0;
    }

    // A published tarball without declarations means "no baseline", not a tool failure — diff
    // against an empty tree instead of skipping, so the approver still sees the next release's
    // full surface (as additions) rather than approving sight unseen.
    let publishedDistDir = published.distDir;
    const extraWarnings: string[] = [];
    if ((yield* countDeclarationFiles(publishedDistDir)) === 0) {
      const message =
        `published ${published.version} tarball contains no .d.ts files — no baseline to diff ` +
        "against; the next release's full surface is shown below as additions.";
      yield* Console.warn(`[config-release-gate] ${message}`);
      extraWarnings.push(message);
      publishedDistDir = path.join(extractDir, "empty-published-dist");
      yield* fs.makeDirectory(publishedDistDir, { recursive: true });
    }

    yield* Console.log(
      `[config-release-gate] comparing published ${published.version} against next ${nextVersion}...`,
    );
    const result = yield* diffDeclarationTrees(localDist, publishedDistDir);
    const bumpClass = computeBumpClass(published.version, nextVersion);
    const warnings = [...extraWarnings, ...computeWarnings(bumpClass, result)];

    yield* Console.log(renderTextReport(published.version, nextVersion, result, warnings));
    yield* writeStepSummary(
      renderMarkdownSummary(published.version, nextVersion, result, warnings),
    );

    return 0;
  }).pipe(Effect.exit);
  yield* fs.remove(extractDir, { recursive: true, force: true });
  return yield* exit;
});

process.exit(
  await Effect.runPromise(
    main.pipe(
      Effect.catchCause((cause) => {
        const error = Cause.squash(cause);
        /* Prints a PlatformError's underlying cause message when it has one, not the PlatformError summary. */
        const reported =
          PlatformError.isPlatformError(error) && error.cause instanceof Error
            ? error.cause
            : error;
        return Console.error(
          `[config-release-gate] ${reported instanceof Error ? reported.message : String(reported)}`,
        ).pipe(Effect.as(2));
      }),
      Effect.provide(
        Layer.mergeAll(
          BunFileSystem.layer,
          BunPath.layer,
          FetchHttpClient.layer,
          Layer.succeed(HttpClient.TracerPropagationEnabled, false),
        ),
      ),
    ),
  ),
);
