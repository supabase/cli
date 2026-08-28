/**
 * Gates an `@supabase/config` npm release on its compiled `.d.ts` surface —
 * diffs the freshly built `packages/config/dist/**\/*.d.ts` against the
 * previously published npm tarball's declarations, so a human approving
 * `npm publish` sees the surface diff before signing off (CLI-2233; the
 * release-time counterpart to the PR-time advisory compare in
 * `tools/config-api-compare.ts`).
 *
 * Usage:
 *   bun tools/config-release-gate.ts --version <next version> [--registry <url>] [--tarball <path>]
 *
 * `--version` is the version semantic-release computed for this release.
 * `--registry` defaults to the public npm registry. `--tarball` points at a
 * local `.tgz` to use as the "published" side instead of querying the
 * registry — for local testing and pipeline rehearsal.
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
  const result = await runCommand(["tar", "-xzf", tarballPath, "-C", destDir]);
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

type PublishedSide =
  | { readonly kind: "first-publish" }
  | { readonly kind: "resolved"; readonly version: string; readonly distDir: string };

/**
 * Resolves the "published" side of the diff: an explicit `--tarball` wins;
 * otherwise queries `<registry>` for the current `dist-tags.latest` and
 * downloads that tarball. An `npm view` `E404` means the package has never
 * been published — reported as `"first-publish"` rather than an error.
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

  const latestResult = await runCommand([
    "npm",
    "view",
    PACKAGE_NAME,
    "dist-tags.latest",
    "--registry",
    registry,
  ]);
  if (latestResult.exitCode !== 0) {
    if (latestResult.stderr.includes("E404")) {
      return { kind: "first-publish" };
    }
    throw new Error(
      `npm view ${PACKAGE_NAME} dist-tags.latest --registry ${registry} failed: ${latestResult.stderr.trim()}`,
    );
  }
  const latestVersion = latestResult.stdout.trim();

  const tarballUrlResult = await runCommand([
    "npm",
    "view",
    `${PACKAGE_NAME}@${latestVersion}`,
    "dist.tarball",
    "--registry",
    registry,
  ]);
  if (tarballUrlResult.exitCode !== 0) {
    throw new Error(
      `npm view ${PACKAGE_NAME}@${latestVersion} dist.tarball --registry ${registry} failed: ` +
        tarballUrlResult.stderr.trim(),
    );
  }
  const tarballUrl = tarballUrlResult.stdout.trim();

  const downloadedTarballPath = path.join(extractDir, "published.tgz");
  await downloadFile(tarballUrl, downloadedTarballPath);
  await extractTarball(downloadedTarballPath, extractDir);

  return {
    kind: "resolved",
    version: latestVersion,
    distDir: path.join(extractDir, "package", "dist"),
  };
}

type BumpClass = "major" | "minor" | "patch" | "none";

interface VersionParts {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
}

function parseVersionParts(version: string): VersionParts {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!match) {
    throw new Error(`expected a simple "x.y.z" version (no prerelease), got "${version}".`);
  }
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) };
}

/**
 * Numeric major/minor/patch comparison only. Both inputs are semantic-release
 * output (or a caller-supplied "next" version), which this tool assumes are
 * always plain "x.y.z" — no prerelease/build-metadata handling.
 */
function computeBumpClass(publishedVersion: string, nextVersion: string): BumpClass {
  const published = parseVersionParts(publishedVersion);
  const next = parseVersionParts(nextVersion);
  if (next.major !== published.major) return "major";
  if (next.minor !== published.minor) return "minor";
  if (next.patch !== published.patch) return "patch";
  return "none";
}

/**
 * Semver sanity warnings for the human approver — surfaced prominently but
 * never turned into a non-zero exit; the human decides.
 */
function computeWarnings(bumpClass: BumpClass, result: CompareResult): string[] {
  const warnings: string[] = [];
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
    },
  });

  if (!values.version) {
    throw new Error("--version <next version> is required.");
  }
  const nextVersion = values.version;
  const registry = values.registry ?? DEFAULT_REGISTRY;

  requireBinaries(values.tarball ? ["tar", "diff"] : ["tar", "diff", "npm"]);

  if (!(await pathExists(localDistDir)) || (await countDeclarationFiles(localDistDir)) === 0) {
    throw new Error(
      `${localDistDir} has no .d.ts files — run the package build first (e.g. ` +
        "`pnpm exec turbo run @supabase/config#build`).",
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

    console.log(
      `[config-release-gate] comparing published ${published.version} against next ${nextVersion}...`,
    );
    const result = await diffDeclarationTrees(localDistDir, published.distDir);
    const bumpClass = computeBumpClass(published.version, nextVersion);
    const warnings = computeWarnings(bumpClass, result);

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
