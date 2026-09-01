/**
 * Gates an `@supabase/config` npm release on its compiled `.d.ts` surface —
 * diffs the freshly built `packages/config/dist/**\/*.d.ts` against the
 * previously published npm tarball's declarations, so a human approving
 * `npm publish` sees the surface diff before signing off (CLI-2233; the
 * release-time counterpart to the PR-time advisory compare in
 * `tools/config-api-compare.ts`).
 *
 * Usage:
 *   bun tools/config-release-gate.ts --version <next version> [--registry <url>] [--tarball <path>] [--local-dist <dir>]
 *
 * `--version` is the version semantic-release computed for this release.
 * `--registry` defaults to `npm config get registry` (the same
 * probe-matches-publish-target alignment `apps/cli/scripts/publish.ts` uses,
 * so the local Verdaccio harness works here too), falling back to the public
 * npm registry. `--tarball` points at a local `.tgz` to use as the
 * "published" side instead of querying the registry — for local testing and
 * pipeline rehearsal. A registry-downloaded tarball is verified against the
 * registry's `dist.integrity` and refused if its URL points off-registry.
 * `--local-dist` overrides the "next release" side (default:
 * `packages/config/dist`) — the release workflow points it at the dist tree
 * extracted from the packed release tarball, so the approver's evidence is
 * generated from the exact artifact the publish job ships.
 *
 * This tool never builds `packages/config/dist` itself — run the package
 * build first. When the package has never been published (npm view returns
 * E404), the full surface ships as-is and there is nothing to diff against.
 *
 * Deliberately never exits 1 on a surface diff: the gate IS the human
 * approval step reading this summary, not an automatic pass/fail check.
 *
 * Exit codes: 0 the gate ran (including a first release with nothing
 * published yet), 2 tool failure.
 */

import { mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { parseArgs } from "node:util";
import {
  type CompareResult,
  countByStatus,
  countDeclarationFiles,
  diffDeclarationTrees,
  type FileEntry,
  renderDiffDetailsBlocks,
  writeStepSummary,
} from "./lib/dts-diff.ts";

const PACKAGE_NAME = "@supabase/config";
const DEFAULT_REGISTRY = "https://registry.npmjs.org";

const repoRoot = path.resolve(import.meta.dir, "..");
const packageRoot = path.join(repoRoot, "packages", "config");
const localDistDir = path.join(packageRoot, "dist");

interface CommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

async function runCommand(cmd: readonly string[]): Promise<CommandResult> {
  const proc = Bun.spawn([...cmd], { cwd: repoRoot, stdout: "pipe", stderr: "pipe" });
  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

function requireBinaries(names: readonly string[]): void {
  const missing = names.filter((name) => Bun.which(name) === null);
  if (missing.length > 0) {
    throw new Error(`this tool requires ${missing.join(", ")} on PATH.`);
  }
}

/**
 * Same probe-matches-publish-target alignment as `apps/cli/scripts/publish.ts`:
 * the local Verdaccio harness (`pnpm local-registry`) rewrites npm's registry
 * config, and the gate must read the registry the publish would target.
 */
async function ambientNpmRegistry(): Promise<string> {
  const result = await runCommand(["npm", "config", "get", "registry"]);
  const registry = result.stdout.trim().replace(/\/+$/, "");
  return result.exitCode === 0 && registry !== "" ? registry : DEFAULT_REGISTRY;
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

async function extractTarball(tarballPath: string, destDir: string): Promise<void> {
  await mkdir(destDir, { recursive: true });
  // The tarball is registry-supplied, i.e. untrusted: never restore its
  // recorded owners or permission bits. (GNU tar already refuses `..`
  // members, so path escape is covered by the extractor itself.)
  const result = await runCommand([
    "tar",
    "-xzf",
    tarballPath,
    "-C",
    destDir,
    "--no-same-owner",
    "--no-same-permissions",
  ]);
  if (result.exitCode !== 0) {
    throw new Error(
      `tar extraction of ${tarballPath} into ${destDir} failed: ${result.stderr.trim()}`,
    );
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Reads the `version` field out of an extracted tarball's `package/package.json`. */
async function readExtractedPackageVersion(extractDir: string): Promise<string> {
  const packageJsonPath = path.join(extractDir, "package", "package.json");
  const raw = await readFile(packageJsonPath, "utf8");
  const parsed: unknown = JSON.parse(raw);
  if (!isRecord(parsed) || typeof parsed.version !== "string") {
    throw new Error(`${packageJsonPath} has no string "version" field.`);
  }
  return parsed.version;
}

async function downloadFile(url: string, destPath: string): Promise<void> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`failed to download ${url}: HTTP ${response.status}`);
  }
  await Bun.write(destPath, response);
}

/**
 * `npm view --json` reports errors as `{"error":{"code":…}}` on stdout, so a
 * genuine E404 (never published) is distinguishable from a transport failure
 * or an error message that merely mentions "E404" somewhere.
 */
async function npmViewJson(
  spec: string,
  field: string,
  registry: string,
): Promise<
  { readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly code: string }
> {
  const result = await runCommand(["npm", "view", spec, field, "--registry", registry, "--json"]);
  let parsed: unknown;
  try {
    // `npm view` prints nothing at all for an absent field.
    parsed = result.stdout.trim() === "" ? undefined : JSON.parse(result.stdout);
  } catch {
    throw new Error(
      `npm view ${spec} ${field} --registry ${registry} returned unparseable output: ${result.stdout.trim().slice(0, 200)}`,
    );
  }
  if (result.exitCode !== 0) {
    if (isRecord(parsed) && isRecord(parsed.error) && typeof parsed.error.code === "string") {
      return { ok: false, code: parsed.error.code };
    }
    throw new Error(
      `npm view ${spec} ${field} --registry ${registry} failed: ${result.stderr.trim()}`,
    );
  }
  return { ok: true, value: parsed };
}

async function verifyTarballIntegrity(tarballPath: string, integrity: string): Promise<void> {
  if (!integrity.startsWith("sha512-")) {
    throw new Error(`expected a sha512 integrity value from the registry, got "${integrity}".`);
  }
  const hasher = new Bun.CryptoHasher("sha512");
  hasher.update(await Bun.file(tarballPath).arrayBuffer());
  const digest = `sha512-${hasher.digest("base64")}`;
  if (digest !== integrity) {
    throw new Error(
      `downloaded tarball failed integrity verification: registry says ${integrity}, got ${digest}.`,
    );
  }
}

type PublishedSide =
  | { readonly kind: "first-publish" }
  | { readonly kind: "resolved"; readonly version: string; readonly distDir: string };

/**
 * Resolves the "published" side of the diff: an explicit `--tarball` wins;
 * otherwise queries `<registry>` for the current `dist-tags.latest` and
 * downloads that tarball, verifying it against the registry's own
 * `dist.integrity` and refusing a tarball URL pointing off-registry. An
 * `E404` (or an existing package with no `latest` dist-tag) means there is
 * nothing published to compare against — reported as `"first-publish"`
 * rather than an error.
 */
async function resolvePublishedSide(
  registry: string,
  tarballArg: string | undefined,
  extractDir: string,
): Promise<PublishedSide> {
  if (tarballArg) {
    await extractTarball(tarballArg, extractDir);
    const version = await readExtractedPackageVersion(extractDir);
    return { kind: "resolved", version, distDir: path.join(extractDir, "package", "dist") };
  }

  const latestResult = await npmViewJson(PACKAGE_NAME, "dist-tags.latest", registry);
  if (!latestResult.ok) {
    if (latestResult.code === "E404") {
      return { kind: "first-publish" };
    }
    throw new Error(`npm view ${PACKAGE_NAME} dist-tags.latest failed with ${latestResult.code}.`);
  }
  if (typeof latestResult.value !== "string" || latestResult.value === "") {
    console.warn(
      `[config-release-gate] ${PACKAGE_NAME} exists on ${registry} but has no "latest" dist-tag — treating as first publish.`,
    );
    return { kind: "first-publish" };
  }
  const latestVersion = latestResult.value;

  const spec = `${PACKAGE_NAME}@${latestVersion}`;
  const [tarballUrlResult, integrityResult] = await Promise.all([
    npmViewJson(spec, "dist.tarball", registry),
    npmViewJson(spec, "dist.integrity", registry),
  ]);
  if (!tarballUrlResult.ok || typeof tarballUrlResult.value !== "string") {
    throw new Error(`npm view ${spec} dist.tarball returned no tarball URL.`);
  }
  if (!integrityResult.ok || typeof integrityResult.value !== "string") {
    throw new Error(`npm view ${spec} dist.integrity returned no integrity value.`);
  }
  const tarballUrl = tarballUrlResult.value;
  if (new URL(tarballUrl).origin !== new URL(registry).origin) {
    throw new Error(
      `refusing tarball from ${new URL(tarballUrl).origin} — it does not match the registry origin ${new URL(registry).origin}.`,
    );
  }

  const downloadedTarballPath = path.join(extractDir, "published.tgz");
  await downloadFile(tarballUrl, downloadedTarballPath);
  await verifyTarballIntegrity(downloadedTarballPath, integrityResult.value);
  await extractTarball(downloadedTarballPath, extractDir);

  return {
    kind: "resolved",
    version: latestVersion,
    distDir: path.join(extractDir, "package", "dist"),
  };
}

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
 * Numeric major/minor/patch comparison only — this train is stable-only, so
 * plain "x.y.z" is the expected shape on both sides. The published side comes
 * from outside this pipeline though (`dist-tags.latest`, or `--tarball`), so
 * an unparseable version degrades to `"unknown"` (warnings skipped, noted in
 * the summary) instead of failing the plan job. Ordering matters, not just
 * inequality: an equal or LOWER next version means tag/registry skew (a
 * hand-pushed or deleted `config-v*` tag), which deserves its own warning
 * rather than a spurious "major bump".
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
 * Only lines inside hunks (after the first `@@`) count — a prefix test alone
 * would both miss a removed content line that itself starts with `--` (its
 * hunk rendering starts with `---`) and false-positive on the old-file
 * header.
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

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      version: { type: "string" },
      registry: { type: "string" },
      tarball: { type: "string" },
      "local-dist": { type: "string" },
    },
  });

  if (!values.version) {
    throw new Error("--version <next version> is required.");
  }
  const nextVersion = values.version;

  requireBinaries(values.tarball ? ["tar", "diff"] : ["tar", "diff", "npm"]);

  const registry =
    values.registry ?? (values.tarball ? DEFAULT_REGISTRY : await ambientNpmRegistry());

  const localDist = values["local-dist"] ?? localDistDir;

  if (!(await pathExists(localDist)) || (await countDeclarationFiles(localDist)) === 0) {
    throw new Error(
      `${localDist} has no .d.ts files — ` +
        (values["local-dist"]
          ? "the packed tarball lost its declarations (the .gitignore/packlist trap packages/config/.npmignore exists for)."
          : "run the package build first (e.g. `pnpm exec turbo run @supabase/config#build`)."),
    );
  }

  const extractDir = await mkdtemp(path.join(tmpdir(), "supabase-config-release-gate-"));

  try {
    const published = await resolvePublishedSide(registry, values.tarball, extractDir);

    if (published.kind === "first-publish") {
      console.log(`[config-release-gate] ${PACKAGE_NAME} has never been published to ${registry}.`);
      console.log(FIRST_PUBLISH_MESSAGE);
      await writeStepSummary(renderFirstPublishSummary(nextVersion));
      return 0;
    }

    // A published tarball without declarations means "no baseline", not a
    // tool failure — the .gitignore/packlist trap that motivated
    // packages/config/.npmignore (CLI-2234) is exactly how such a tarball
    // could exist, and it must not block every subsequent release. Diff
    // against an empty tree instead of skipping, so the approver still sees
    // the next release's full surface (as additions) rather than approving
    // sight unseen.
    let publishedDistDir = published.distDir;
    const extraWarnings: string[] = [];
    if ((await countDeclarationFiles(publishedDistDir)) === 0) {
      const message =
        `published ${published.version} tarball contains no .d.ts files — no baseline to diff ` +
        "against; the next release's full surface is shown below as additions.";
      console.warn(`[config-release-gate] ${message}`);
      extraWarnings.push(message);
      publishedDistDir = path.join(extractDir, "empty-published-dist");
      await mkdir(publishedDistDir, { recursive: true });
    }

    console.log(
      `[config-release-gate] comparing published ${published.version} against next ${nextVersion}...`,
    );
    const result = await diffDeclarationTrees(localDist, publishedDistDir);
    const bumpClass = computeBumpClass(published.version, nextVersion);
    const warnings = [...extraWarnings, ...computeWarnings(bumpClass, result)];

    console.log(renderTextReport(published.version, nextVersion, result, warnings));
    await writeStepSummary(renderMarkdownSummary(published.version, nextVersion, result, warnings));

    return 0;
  } finally {
    await rm(extractDir, { recursive: true, force: true });
  }
}

try {
  process.exit(await main());
} catch (error) {
  console.error(`[config-release-gate] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(2);
}
