import type { V1ListAllBranchesOutput } from "@supabase/api/effect";
import { Duration, Effect, FileSystem, Option, Path } from "effect";
import type { PlatformError } from "effect/PlatformError";

import { CommandPlatformApi } from "../auth/command-platform-api.service.ts";
import { CommandSettings } from "../config/command-settings.service.ts";
import { ProjectRefResolver, PROJECT_REF_PATTERN } from "../config/project-ref.service.ts";
import { LinkedProjectCache } from "../telemetry/linked-project-cache.service.ts";
import { TelemetryState } from "../telemetry/telemetry-state.service.ts";
import { Output } from "../shared/output/output.service.ts";
import { Analytics } from "../shared/telemetry/analytics.service.ts";
import { withAnalyticsContext } from "../shared/telemetry/analytics-context.ts";
import {
  EventProjectLinked,
  GroupOrganization,
  GroupProject,
  PropLinkedVia,
  PropParentProjectRef,
} from "../shared/telemetry/event-catalog.ts";
import { classifyProjectLookupError } from "./branch-target.ts";
import {
  type CachedLinkedProject,
  parentNotLinkedMessage,
  parentRefInvalidMessage,
  parentRefTypoHint,
  parseCachedLinkedProject,
  resolveLinkedParentRef,
} from "./parent-project-ref.ts";
import { dashboardUrl } from "./profile.ts";
import { mapTenantApiKeysError } from "./get-tenant-api-keys.ts";
import { sanitizeInlineName, mapHttpError } from "./http-errors.ts";
import { linkServicesCore } from "./link-services-core.ts";
import { extractServiceKeys } from "./tenant-keys.ts";
import { tempPaths } from "./temp-paths.ts";
import {
  LinkApiKeysNetworkError,
  LinkAuthTokenError,
  LinkBranchListNetworkError,
  LinkBranchListStatusError,
  LinkBranchNotFoundError,
  LinkBranchNotLinkedError,
  LinkBranchNotReadyError,
  LinkMissingKeyError,
  LinkParentRefInvalidError,
  LinkProjectStatusError,
  LinkProjectStatusNetworkError,
  LinkRefArgConflictError,
  ProjectPausedError,
} from "../commands/link/link.errors.ts";
import type { LinkFlags } from "../commands/link/link.command.ts";

type LinkBranches = typeof V1ListAllBranchesOutput.Type;
type LinkBranch = LinkBranches[number];

/** Result of resolving a branch name/UUID to its project ref, threaded into the
 * machine payload (`branch`, `parent_project_ref`) alongside the plain ref. */
interface LinkBranchResolution {
  readonly projectRef: string;
  readonly branchName: string;
  readonly parentRef: string;
}

// Classify a `getProject` failure: a 404 means the project is a branch (resolve
// to `None`, link continues); any other status surfaces the body; transport
// failures surface a network error.
const classifyProjectError = classifyProjectLookupError({
  statusError: LinkProjectStatusError,
  networkError: LinkProjectStatusNetworkError,
  statusMessage: (_status, body) => `Unexpected error retrieving remote project status: ${body}`,
  networkMessage: (cause) => `failed to retrieve remote project status: ${String(cause)}`,
});

type WriteTempFile = (filePath: string, content: string) => Effect.Effect<void, PlatformError>;

const mapApiKeysError = mapTenantApiKeysError({
  networkError: LinkApiKeysNetworkError,
  statusError: LinkAuthTokenError,
});

// Same reasoning + duration as `branch-target.ts`'s branch-lookup bound
// (`BRANCH_LOOKUP_TIMEOUT`) — duplicated locally rather than
// shared across two otherwise-unrelated modules: the best-effort 404-path
// stale-cache correlation lookup below must not let an otherwise-successful
// `link` silently stall ~6 minutes at the very end on the generated client's
// own 60s×5-retry defaults (PR #6168 review).
const LINK_CACHE_CORRELATION_TIMEOUT = Duration.seconds(5);

const LINK_MAX_LISTED_BRANCHES = 20;

function linkBranchNotFoundMessage(
  value: string,
  parentRef: string,
  branches: LinkBranches,
): string {
  if (branches.length === 0) {
    return `Branch "${value}" not found: project ${parentRef} has no branches.${parentRefTypoHint(value)}`;
  }

  const sortedNames = branches.map((branch) => branch.name).toSorted();
  const shown = sortedNames.slice(0, LINK_MAX_LISTED_BRANCHES);
  const remaining = sortedNames.length - shown.length;
  // Branch names are API-provided; sanitize the same way response bodies are
  // before embedding them in an error message (module policy).
  const shownSanitized = sanitizeInlineName(shown.join(", "));
  const namesList =
    remaining > 0
      ? `${shownSanitized}, … (${remaining} more — run supabase branches list)`
      : shownSanitized;

  const trimmedLower = value.trim().toLowerCase();
  const nearMiss = branches.find((branch) => branch.name.toLowerCase() === trimmedLower);
  // Sanitized like the list above — an API-provided name must not be able to
  // inject ANSI/OSC/newline controls into the terminal (PR #6168 review).
  const didYouMean =
    nearMiss !== undefined ? ` Did you mean "${sanitizeInlineName(nearMiss.name)}"?` : "";

  return (
    `Branch "${value}" not found for project ${parentRef}. Available branches: ${namesList}` +
    `${didYouMean}${parentRefTypoHint(value)}`
  );
}

/**
 * Resolves a non-ref-shaped `[ref-or-branch]`/`--project-ref` value to the
 * branch's project ref by looking it up (by name or UUID) against the PARENT
 * project's branches. TS-only surface (CLI-2167, no Go counterpart).
 *
 * A value that is ref-shaped (20 lowercase letters) is ALWAYS treated as a
 * ref and never looked up as a branch name — this keeps every
 * currently-working invocation byte-identical, and CLI-2167 accepts the
 * (vanishingly rare) collision with a 20-lowercase-letter branch name.
 *
 * Deliberately uses the LIST endpoint (`GET /v1/projects/{ref}/branches`)
 * rather than `branches.resolver.ts`'s single-branch lookup
 * (`resolveBranchProjectRef`, which calls `GET /v1/branches/{id}` for a
 * UUID or `GET /v1/projects/{ref}/branches/{name}` for a name): the full list
 * powers the available-branches error enrichment below, and — unlike that
 * resolver, which is handed an already-resolved `projectRef` by its caller —
 * `link` has to resolve the parent project itself first anyway.
 */
const resolveLinkBranchRef = Effect.fnUntraced(function* (value: string) {
  const output = yield* Output;
  const api = yield* CommandPlatformApi;

  const parent = yield* resolveLinkedParentRef();
  if (parent.kind === "absent") {
    return yield* Effect.fail(
      new LinkBranchNotLinkedError({ message: parentNotLinkedMessage(value) }),
    );
  }
  if (parent.kind === "invalid") {
    return yield* Effect.fail(
      new LinkParentRefInvalidError({ message: parentRefInvalidMessage(value) }),
    );
  }
  const parentRef = parent.ref;

  const mapBranchListError = mapHttpError({
    networkError: LinkBranchListNetworkError,
    statusError: LinkBranchListStatusError,
    networkMessage: (cause) => `failed to list branches: ${cause}`,
    statusMessage: (status, body) =>
      status === 404
        ? `Cannot list branches for project ${parentRef} (HTTP 404). If ${parentRef} is itself a preview branch, link its parent project first: supabase link --project-ref <parent-ref>`
        : `unexpected list branches status ${status}: ${body}`,
  });

  const task = output.format === "text" ? yield* output.task("Resolving branch...") : undefined;
  const branches: LinkBranches = yield* api.v1.listAllBranches({ ref: parentRef }).pipe(
    Effect.tapError(() => task?.fail() ?? Effect.void),
    Effect.catch(mapBranchListError),
  );
  yield* task?.clear() ?? Effect.void;

  const found: LinkBranch | undefined = branches.find(
    // UUID matching is case-insensitive (canonical branch ids are lowercase
    // hex, but uppercase input is a valid UUID spelling — PR #6168 review);
    // name matching stays exact, with the did-you-mean hint covering near misses.
    (branch) => branch.name === value || branch.id.toLowerCase() === value.toLowerCase(),
  );
  if (found === undefined) {
    return yield* Effect.fail(
      new LinkBranchNotFoundError({
        message: linkBranchNotFoundMessage(value, parentRef, branches),
      }),
    );
  }

  if (!PROJECT_REF_PATTERN.test(found.project_ref)) {
    return yield* Effect.fail(
      new LinkBranchNotReadyError({
        branch: found.name,
        status: found.status,
        message: `Branch "${sanitizeInlineName(found.name)}" has no project ref yet (status: ${found.status}). Wait for it to finish provisioning, then retry.`,
      }),
    );
  }

  const line = `Resolved branch "${sanitizeInlineName(found.name)}" of project ${parentRef} to project ref ${found.project_ref}.`;
  yield* output.format === "text" ? output.raw(`${line}\n`, "stderr") : output.info(line);

  return { projectRef: found.project_ref, branchName: found.name, parentRef };
});

export const linkProject = Effect.fnUntraced(function* (flags: LinkFlags) {
  const output = yield* Output;
  const api = yield* CommandPlatformApi;
  const cliSettings = yield* CommandSettings;
  const resolver = yield* ProjectRefResolver;
  const linkedProjectCache = yield* LinkedProjectCache;
  const telemetryState = yield* TelemetryState;
  const analytics = yield* Analytics;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  // Captured as soon as ref/branch resolution succeeds (mirrors `projects
  // delete`'s `resolvedRef` pattern, `delete.handler.ts:52`) — everything
  // from ref resolution onward now sits inside the `Effect.ensuring` wrapper
  // below (PR #6168 review): previously, a branch-name resolution failure
  // (not found, not ready, not linked, a parent-list failure) — or even the
  // `--project-ref`/positional conflict check — exited BEFORE that wrapper
  // was ever reached, so telemetry state was silently never flushed for
  // those failures. This is a strict improvement (TS-only feature, no Go
  // behavior to preserve here); `undefined` still means "never resolved a
  // ref at all", so the post-run cache fill correctly stays a no-op for it.
  let resolvedRef: string | undefined;

  // Persist the linked-project cache and telemetry state whether the link
  // succeeds or fails. `link` itself writes `linked-project.json` on success
  // (below), so `cache` only fires for the failure / 404 paths.
  yield* Effect.gen(function* () {
    // Normalize inputs: an empty-string positional or flag value is absent,
    // mirroring the resolver's own treatment of an empty `--project-ref`.
    const refArg = Option.filter(flags.refOrBranch, (value) => value.length > 0);
    const projectRefFlag = Option.filter(flags.projectRef, (value) => value.length > 0);

    if (Option.isSome(refArg) && Option.isSome(projectRefFlag)) {
      return yield* Effect.fail(
        new LinkRefArgConflictError({
          message:
            "Cannot use both the [ref-or-branch] argument and the --project-ref flag. Specify the project ref or branch name once.",
        }),
      );
    }

    const requested = Option.isSome(refArg) ? refArg : projectRefFlag;

    // A ref-shaped value (20 lowercase letters) is always treated as a ref and
    // never looked up as a branch name (see `resolveLinkBranchRef`).
    const branchResolution =
      Option.isSome(requested) && !PROJECT_REF_PATTERN.test(requested.value)
        ? Option.some(yield* resolveLinkBranchRef(requested.value))
        : Option.none<LinkBranchResolution>();

    const resolvedRefOrBranch = Option.isSome(branchResolution)
      ? Option.some(branchResolution.value.projectRef)
      : requested;

    const ref = yield* resolver.resolveForLink(resolvedRefOrBranch);
    resolvedRef = ref;
    const paths = tempPaths(path, cliSettings.workdir);

    const writeTempFile: WriteTempFile = (filePath, content) =>
      fs
        .makeDirectory(path.dirname(filePath), { recursive: true })
        .pipe(Effect.andThen(() => fs.writeFileString(filePath, content)));

    // 1. Check remote project status (404 tolerated for branch projects).
    const project = yield* api.v1
      .getProject({ ref })
      .pipe(Effect.asSome, Effect.catch(classifyProjectError));

    if (Option.isSome(project)) {
      const status = project.value.status;
      if (status === "INACTIVE") {
        return yield* Effect.fail(
          new ProjectPausedError({
            message: "project is paused",
            suggestion: `An admin must unpause it from the Supabase dashboard at ${dashboardUrl(
              cliSettings.profile,
            )}/project/${ref}`,
          }),
        );
      }
      if (status !== "ACTIVE_HEALTHY") {
        yield* output.raw(
          `WARNING: Project status is ${status} instead of Active Healthy. Some operations might fail.\n`,
          "stderr",
        );
      }
      // Update postgres image version to match the remote project (link.go:269).
      const version = project.value.database.version;
      if (version.length > 0) {
        yield* writeTempFile(paths.postgresVersion, version);
      }
    }

    // 2. Resolve service keys (auth check).
    const keys = yield* api.v1
      .getProjectApiKeys({ ref, reveal: true })
      .pipe(Effect.catch(mapApiKeysError));
    const { anon, serviceRole } = extractServiceKeys(keys);
    if (anon.length === 0 && serviceRole.length === 0) {
      return yield* Effect.fail(new LinkMissingKeyError({ message: "Anon key not found." }));
    }

    // 3. Link services — best-effort, using the service-role key for tenant probes.
    yield* linkServicesCore({
      ref,
      serviceKey: serviceRole,
      skipPooler: flags.skipPooler,
      workdir: cliSettings.workdir,
    });

    // 4. Save project ref (mandatory — a write failure fails the command).
    yield* writeTempFile(paths.projectRef, ref);

    // 5. Telemetry + linked-project cache (only for resolvable projects, i.e.
    // not the 404 branch path). `link.go:40-67`.
    if (Option.isSome(project)) {
      const p = project.value;
      // SaveLinkedProject — best-effort (debug-logged in Go, never fatal).
      // Same fail-safe fallback as the branch path (PR #6168 review): if the
      // rewrite fails while a stale cache for a DIFFERENT project survives,
      // delete it rather than leave the parent chain trusting the old
      // project — no cache beats a wrong one.
      yield* writeTempFile(
        paths.linkedProjectCache,
        JSON.stringify({
          ref: p.ref,
          name: p.name,
          organization_id: p.organization_id,
          organization_slug: p.organization_slug,
        }),
      ).pipe(
        Effect.catch(() => fs.remove(paths.linkedProjectCache, { force: true })),
        Effect.ignore,
      );

      const groups = { organization: p.organization_id, project: p.ref } as const;
      if (p.organization_id.length > 0) {
        yield* analytics.groupIdentify(GroupOrganization, p.organization_id, {
          organization_slug: p.organization_slug,
        });
      }
      if (p.ref.length > 0) {
        yield* analytics.groupIdentify(GroupProject, p.ref, {
          name: p.name,
          organization_slug: p.organization_slug,
        });
      }
      // Confirmed on staging (PR #6168 review): a DEFAULT branch's
      // `project_ref` IS the parent's own ref, so `link main` resolves via
      // `branchResolution` above but `getProject(ref)` still returns 200
      // (this arm), never the 404 arm below — without this, a
      // default-branch link would be misclassified as a plain project link
      // and lose `linked_via`.
      const linkedViaProperties: Record<string, unknown> = Option.isSome(branchResolution)
        ? {
            [PropLinkedVia]: "branch",
            [PropParentProjectRef]: branchResolution.value.parentRef,
          }
        : {};
      yield* analytics
        .capture(EventProjectLinked, linkedViaProperties)
        .pipe(withAnalyticsContext({ groups }));
    } else {
      // 404 path: `ref` is a branch (assumed, or confirmed when
      // `branchResolution` resolved it by name/UUID). The plain-project arm
      // above never writes `linked-project.json` for THIS ref, and the
      // post-run `LinkedProjectCache.cache(ref)` fill (`Effect.ensuring`
      // below) GETs `ref` itself — a branch ref 404s there too — so without
      // this, the PARENT evidence `resolveLinkedParentRef`'s chain
      // depends on can be lost forever or silently go stale (PR #6168 review,
      // two confirmed gaps). Both arms are best-effort — `Effect.ignore` —
      // and never affect `link`'s own outcome.
      const cachedParent = yield* fs.readFileString(paths.linkedProjectCache).pipe(
        Effect.map(parseCachedLinkedProject),
        Effect.orElseSucceed(() => Option.none<CachedLinkedProject>()),
      );

      if (Option.isSome(branchResolution)) {
        // (a) The branch was resolved by name/UUID, so its parent is KNOWN
        // here — persist it durably so it survives even when the existing
        // cache is missing or malformed (previously: never written at all
        // for this ref, so a missing/malformed cache stayed that way
        // forever). Leave an already-agreeing cache untouched — it may be
        // richer (name/org) than the ref-only record below, e.g. from a
        // real `link <parent-ref>` run.
        const parentRef = branchResolution.value.parentRef;
        if (Option.isNone(cachedParent) || cachedParent.value.ref !== parentRef) {
          // Fail-safe fallback (PR #6168 review): if the replacement write
          // fails (e.g. an unwritable stale cache file), DELETE the stale
          // cache instead of leaving a wrong parent trusted by the parent
          // chain — no parent info beats wrong parent info. Both steps stay
          // best-effort; the mandatory `project-ref` write in the same
          // directory already succeeded, so a residual double-failure here
          // is practically unreachable.
          yield* writeTempFile(paths.linkedProjectCache, JSON.stringify({ ref: parentRef })).pipe(
            Effect.catch(() => fs.remove(paths.linkedProjectCache, { force: true })),
            Effect.ignore,
          );
        }

        // TS-only event extension (CLI-2167): a branch name/UUID was resolved
        // to `ref` above, so we know definitively this is a branch link —
        // fire the same event with `linked_via`/`parent_project_ref` so
        // branch links are no longer telemetry-invisible. Only refs go out
        // (never the branch name, which is user-created content); no
        // `groupIdentify` here since we have no org/name metadata for the
        // branch, just the group association on the capture itself.
        yield* analytics
          .capture(EventProjectLinked, {
            [PropLinkedVia]: "branch",
            [PropParentProjectRef]: parentRef,
          })
          .pipe(withAnalyticsContext({ groups: { project: ref } }));
      } else if (
        Option.isSome(cachedParent) &&
        cachedParent.value.ref !== ref &&
        PROJECT_REF_PATTERN.test(cachedParent.value.ref)
      ) {
        // (b) A raw ref-shaped branch link (no name resolution attempted, so
        // its parent is unknown here) whose cache names a DIFFERENT project —
        // best-effort correlate the two: if `cachedParent`'s own branches
        // verifiably still include `ref`, the cache is still accurate, keep
        // it; anything else — verifiably absent, or ANY lookup failure
        // (network, decode, 403, 404, timeout) — deletes it. Fail-SAFE, not
        // fail-convenient (PR #6168 review): an unverified divergent cache
        // silently misdirects parent-scoped MUTATIONS onto the wrong project,
        // while deleting merely downgrades later branches commands to a loud
        // not-linked error the user recovers from by relinking the parent.
        // The window is tiny anyway — link's own API calls just succeeded
        // moments before this runs. One extra API call, only on this path,
        // only when a cache exists and diverges from `ref`; the plain
        // 404-ref path with no cache, or a cache that already agrees with
        // `ref`, needs no correlation. Hard-bounded
        // (`LINK_CACHE_CORRELATION_TIMEOUT`).
        // By this point the user has already seen the linking work happen
        // (service-link warnings, a resolved-branch line, ...), so a
        // successful link otherwise feels DONE right before this silently
        // runs for up to 5s more ahead of "Finished supabase link." — show a
        // spinner in text mode so it never sits silent (PR #6168 review).
        const correlating =
          output.format === "text" ? yield* output.task("Checking branch parent...") : undefined;
        const verified = yield* api.v1.listAllBranches({ ref: cachedParent.value.ref }).pipe(
          Effect.timeout(LINK_CACHE_CORRELATION_TIMEOUT),
          Effect.map((branches) => branches.some((branch) => branch.project_ref === ref)),
          Effect.catch(() => Effect.succeed(false)),
          Effect.ensuring(correlating?.clear() ?? Effect.void),
        );
        if (!verified) {
          yield* fs.remove(paths.linkedProjectCache, { force: true }).pipe(Effect.ignore);
        }
      }
    }

    // 6. PostRun: `Finished supabase link.` to stdout (text), structured success
    // otherwise.
    if (output.format === "text") {
      yield* output.raw("Finished supabase link.\n");
    } else {
      yield* output.success("", {
        project_ref: ref,
        // Purely additive — only present when a branch name/UUID was resolved
        // to `ref` above; absent for a plain project-ref link (CLI-2167).
        ...(Option.isSome(branchResolution)
          ? {
              branch: branchResolution.value.branchName,
              parent_project_ref: branchResolution.value.parentRef,
            }
          : {}),
      });
    }
  }).pipe(
    Effect.ensuring(
      Effect.suspend(() =>
        resolvedRef === undefined ? Effect.void : linkedProjectCache.cache(resolvedRef),
      ),
    ),
    Effect.ensuring(telemetryState.flush),
  );
});
