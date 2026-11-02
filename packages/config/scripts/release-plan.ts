/**
 * Computes the `@supabase/config` release plan via semantic-release's dry-run
 * JS API — the version-computation half of an otherwise independent release
 * pipeline; actual publishing happens in later, separate workflow steps (see
 * `.github/workflows/release-config.yml`).
 *
 * Commit analysis and release-notes generation are scoped to this package's own
 * history via `./semantic-release-path-filter.ts` (see that file for why a
 * monorepo-wide run would be wrong here).
 *
 * Always exits 0 once semantic-release completes, whether or not a release is
 * due — a non-zero exit means this script itself failed to run the plan, not
 * that no release was found.
 */

import { BunServices } from "@effect/platform-bun";
import {
  Cause,
  Config,
  Console,
  Data,
  Effect,
  FileSystem,
  Path,
  PlatformError,
  Predicate,
  Schema,
} from "effect";
import process from "node:process";
import { parseArgs } from "node:util";

import { PACKAGE_PATH_PREFIX } from "./semantic-release-path-filter.ts";

// Not `import.meta.dir`: that Bun-ism doesn't survive vitest's module
// transform, and this module is imported by its unit test.
const packageRoot = Effect.gen(function* () {
  const path = yield* Path.Path;
  return path.resolve(path.dirname(yield* path.fromFileUrl(new URL(import.meta.url))), "..");
});

class ReleasePlanError extends Data.TaggedError("ReleasePlanError")<{
  readonly message: string;
}> {}

/* Keeps the platform's own error text in the `[release-plan]` failure report. */
const hostFailure = Effect.mapError(
  (error: PlatformError.PlatformError) =>
    new ReleasePlanError({
      message: error.cause instanceof Error ? error.cause.message : error.message,
    }),
);

const decodeJson = Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown));

interface ConfigPackageJson {
  readonly name: string;
  readonly private?: boolean;
}

interface ReleaseDuePlan {
  readonly due: true;
  readonly version: string;
  readonly bumpType: string;
  readonly notes: string;
  readonly isPrivate: boolean;
}

/**
 * `semantic-release`'s dry-run API returns bare `false` with no reason of its
 * own; {@link resolveHeadDivergence} is what tells "genuinely nothing to
 * release" apart from "this HEAD can't release" so the summary can say which.
 */
export type NoReleaseReason = "no-releasable-commits" | "branch-behind-remote" | "branch-diverged";

export interface NoReleasePlan {
  readonly due: false;
  readonly reason: NoReleaseReason;
}

export type ReleasePlan = ReleaseDuePlan | NoReleasePlan;

// The sole entry feeds both semantic-release's `branches` option and the git
// comparison below — one place to change the release branch, not two.
const RELEASE_BRANCHES = ["develop"] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

const readPackageJson = Effect.fnUntraced(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const packageJsonPath = path.join(yield* packageRoot, "package.json");
  const parsed: unknown = yield* decodeJson(
    yield* fs.readFileString(packageJsonPath).pipe(hostFailure),
  ).pipe(
    Effect.mapError(
      (error) =>
        new ReleasePlanError({ message: `${packageJsonPath} is malformed: ${error.message}` }),
    ),
  );
  if (
    !isRecord(parsed) ||
    typeof parsed.name !== "string" ||
    (parsed.private !== undefined && typeof parsed.private !== "boolean")
  ) {
    return yield* new ReleasePlanError({
      message: `${packageJsonPath} is malformed: expected a string "name" and an optional boolean "private".`,
    });
  }
  const packageJson: ConfigPackageJson = { name: parsed.name, private: parsed.private };
  return packageJson;
});

const runGit = Effect.fnUntraced(function* (args: readonly string[], cwd: string) {
  const proc = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  const [stdout, exitCode] = yield* Effect.promise(() =>
    Promise.all([new Response(proc.stdout).text(), proc.exited]),
  );
  return { exitCode, stdout: stdout.trim() };
});

type HeadDivergence = "current" | "behind-remote" | "diverged" | "unknown";

/**
 * Compares `HEAD` against `origin/${RELEASE_BRANCHES[0]}` to tell a stale
 * checkout (semantic-release refuses to plan behind the branch it publishes
 * from) apart from a checkout that's actually current. Falls back to
 * `"unknown"` — never blocking the plan — when the remote ref can't be
 * resolved, e.g. a local-only clone with no `origin` fetched.
 */
const resolveHeadDivergence = Effect.fnUntraced(function* (
  cwd: string,
): Effect.fn.Return<HeadDivergence> {
  const remoteRef = `origin/${RELEASE_BRANCHES[0]}`;
  const remote = yield* runGit(["rev-parse", "--verify", remoteRef], cwd);
  if (remote.exitCode !== 0 || remote.stdout === "") {
    return "unknown";
  }

  const head = yield* runGit(["rev-parse", "HEAD"], cwd);
  if (head.exitCode !== 0 || head.stdout === "") {
    return "unknown";
  }
  if (head.stdout === remote.stdout) {
    return "current";
  }

  const ancestor = yield* runGit(["merge-base", "--is-ancestor", "HEAD", remoteRef], cwd);
  if (ancestor.exitCode === 0) {
    return "behind-remote";
  }
  if (ancestor.exitCode === 1) {
    return "diverged";
  }
  return "unknown";
});

/**
 * Runs semantic-release in dry-run mode against this package's own history.
 * `result === false` means it refused to plan — either no releasable commits
 * since the last `config-v*` tag, or (semantic-release logs this itself, but
 * doesn't say so in its return value) this checkout is behind or diverged
 * from the branch it releases from; {@link resolveHeadDivergence} tells them
 * apart via git rather than parsing its log output. Otherwise
 * `result.nextRelease` carries the computed version, bump type, and notes.
 */
const computeReleasePlan = Effect.fnUntraced(function* (isPrivate: boolean) {
  const { default: semanticRelease } = yield* Effect.promise(() => import("semantic-release"));
  const cwd = yield* packageRoot;
  const result = yield* Effect.promise(() =>
    semanticRelease(
      {
        branches: [...RELEASE_BRANCHES],
        tagFormat: "config-v${version}",
        dryRun: true,
        plugins: ["./scripts/semantic-release-path-filter.ts"],
      },
      { cwd, env: process.env },
    ),
  );

  if (result === false) {
    const divergence = yield* resolveHeadDivergence(cwd);
    const plan: ReleasePlan = {
      due: false,
      reason:
        divergence === "behind-remote"
          ? "branch-behind-remote"
          : divergence === "diverged"
            ? "branch-diverged"
            : "no-releasable-commits",
    };
    return plan;
  }

  // With no config-v* tag on the branch, semantic-release would cut 1.0.0
  // analyzed from the entire monorepo history, so the release notes would be a
  // changelog of every commit that ever touched packages/config/. Refuse until a
  // baseline tag exists (see AGENTS.md "One-time setup"); the escape hatch is
  // for an intentional first cut.
  if (!result.lastRelease.gitTag && !(yield* readEnv("CONFIG_RELEASE_ALLOW_NO_BASELINE"))) {
    return yield* new ReleasePlanError({
      message:
        "no config-v* baseline tag found on this branch: semantic-release would release " +
        `${result.nextRelease.version} with notes generated from the entire monorepo history. ` +
        "Push a baseline tag first (e.g. config-v0.1.0 — see packages/config/AGENTS.md), or set " +
        "CONFIG_RELEASE_ALLOW_NO_BASELINE=1 to proceed deliberately.",
    });
  }

  const version = result.nextRelease.version;
  // The version flows into `npm pkg set`, a git tag name, and a GH release
  // title — refuse anything that isn't the plain stable x.y.z this
  // stable-only train can produce.
  if (!/^\d+\.\d+\.\d+$/.test(version)) {
    return yield* new ReleasePlanError({
      message: `computed version "${version}" is not a plain x.y.z stable version.`,
    });
  }

  const plan: ReleasePlan = {
    due: true,
    version,
    bumpType: result.nextRelease.type,
    notes: result.nextRelease.notes ?? "",
    isPrivate,
  };
  return plan;
});

function readEnv(name: string) {
  return Config.String(name).pipe(Config.withDefault(""));
}

const appendFile = Effect.fnUntraced(function* (filePath: string, data: string) {
  const fs = yield* FileSystem.FileSystem;
  yield* fs.writeFileString(filePath, data, { flag: "a" }).pipe(hostFailure);
});

const appendGithubOutput = Effect.fnUntraced(function* (lines: readonly string[]) {
  const outputPath = yield* readEnv("GITHUB_OUTPUT");
  if (!outputPath) {
    return;
  }
  yield* appendFile(outputPath, `${lines.join("\n")}\n`);
});

const appendStepSummary = Effect.fnUntraced(function* (markdown: string) {
  const summaryPath = yield* readEnv("GITHUB_STEP_SUMMARY");
  if (!summaryPath) {
    return;
  }
  yield* appendFile(summaryPath, `${markdown}\n`);
});

/**
 * A fence long enough that no backtick run inside `content` can close it.
 * Notes are commit-message-derived (PR titles/bodies, including external
 * contributors'), so rendering them as live markdown would let a crafted
 * commit message forge parts of this summary.
 */
function fenceFor(content: string): string {
  const longestRun = Math.max(0, ...[...content.matchAll(/`+/g)].map((match) => match[0].length));
  return "`".repeat(Math.max(3, longestRun + 1));
}

export function toGithubOutputLines(plan: ReleasePlan): string[] {
  const shouldRelease = plan.due && !plan.isPrivate;
  const blockedOnPrivate = plan.due && plan.isPrivate;
  return [
    `should_release=${shouldRelease}`,
    `version=${plan.due ? plan.version : ""}`,
    `npm_tag=latest`,
    `blocked_on_private=${blockedOnPrivate}`,
  ];
}

/**
 * Shared between the GH step summary and local-run logging so both surfaces
 * point at the same fix: re-run from the branch tip, not the pinned commit.
 */
function noReleaseMessage(reason: NoReleaseReason): string {
  const branch = RELEASE_BRANCHES[0];
  switch (reason) {
    case "no-releasable-commits":
      return (
        `No release: no releasable commits touching \`${PACKAGE_PATH_PREFIX}\` since the last ` +
        "`config-v*` tag."
      );
    case "branch-behind-remote":
      return (
        `No release: this run's commit is behind \`origin/${branch}\`'s current tip, so ` +
        "semantic-release refused to plan — a re-run pinned to an older commit can never " +
        `release. Re-run the workflow from the tip of \`${branch}\` instead.`
      );
    case "branch-diverged":
      return (
        `No release: this run's commit has diverged from \`origin/${branch}\`'s current tip, ` +
        "so semantic-release refused to plan. Re-run the workflow from the tip of " +
        `\`${branch}\` instead.`
      );
  }
}

export function renderStepSummary(plan: ReleasePlan): string {
  const lines: string[] = ["## @supabase/config release plan", ""];

  if (!plan.due) {
    lines.push(noReleaseMessage(plan.reason));
    return lines.join("\n");
  }

  lines.push(`**${plan.version}** (\`${plan.bumpType}\` release).`, "");

  if (plan.isPrivate) {
    lines.push(
      "> [!WARNING]",
      "> `packages/config` is `private: true`, so publishing is blocked. This run validated the " +
        "release pipeline only; nothing will be published.",
      "",
    );
  }

  if (plan.notes) {
    const notes = plan.notes.trim();
    const fence = fenceFor(notes);
    lines.push(
      "<details><summary>Release notes (markdown source)</summary>",
      "",
      `${fence}markdown`,
      notes,
      fence,
      "",
      "</details>",
    );
  }

  return lines.join("\n");
}

function renderLocalPlan(plan: ReleasePlan): string {
  if (!plan.due) {
    return `[release-plan] ${noReleaseMessage(plan.reason)}`;
  }
  const privateNote = plan.isPrivate ? " (blocked: packages/config is private: true)" : "";
  return `[release-plan] @supabase/config would release ${plan.version} (${plan.bumpType})${privateNote}.`;
}

const main = Effect.gen(function* () {
  const { values } = parseArgs({ options: { "notes-out": { type: "string" } } });
  const notesOutPath = values["notes-out"];

  const packageJson = yield* readPackageJson();
  const isPrivate = packageJson.private === true;

  const plan = yield* computeReleasePlan(isPrivate);

  if (plan.due && notesOutPath) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    // Guarantee the trailing newline: the notes end up as a GH release
    // body_path file, and a missing final newline is the kind of upstream
    // formatting detail nothing else pins.
    const notes = plan.notes.endsWith("\n") ? plan.notes : `${plan.notes}\n`;
    /* `--notes-out` may name a file in a directory that does not exist yet; as with
       Bun.write, a failed mkdir reports the original open error. */
    yield* fs.writeFileString(notesOutPath, notes).pipe(
      Effect.catchIf(
        (error) => Predicate.isTagged(error.reason, "NotFound"),
        (error) =>
          fs.makeDirectory(path.dirname(notesOutPath), { recursive: true }).pipe(
            Effect.mapError(() => error),
            Effect.andThen(fs.writeFileString(notesOutPath, notes)),
          ),
      ),
      hostFailure,
    );
  }

  if (yield* readEnv("GITHUB_OUTPUT")) {
    yield* appendGithubOutput(toGithubOutputLines(plan));
  } else {
    yield* Console.log(renderLocalPlan(plan));
  }

  yield* appendStepSummary(renderStepSummary(plan));
});

if (import.meta.main) {
  await Effect.runPromise(
    main.pipe(
      Effect.catchCause((cause) => {
        const error = Cause.squash(cause);
        return Console.error(
          `[release-plan] ${error instanceof Error ? error.message : String(error)}`,
        ).pipe(Effect.andThen(Effect.sync(() => process.exit(1))));
      }),
      Effect.provide(BunServices.layer),
    ),
  );
}
