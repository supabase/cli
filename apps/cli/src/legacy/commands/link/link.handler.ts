import type { ApiClient, V1ListAllBranchesOutput } from "@supabase/api/effect";
import { Effect, FileSystem, Option, Path } from "effect";
import type { PlatformError } from "effect/PlatformError";
import * as HttpClientError from "effect/unstable/http/HttpClientError";

import { LegacyPlatformApi } from "../../auth/legacy-platform-api.service.ts";
import { LegacyCliConfig } from "../../config/legacy-cli-config.service.ts";
import {
  LegacyProjectRefResolver,
  PROJECT_REF_PATTERN,
} from "../../config/legacy-project-ref.service.ts";
import { LegacyLinkedProjectCache } from "../../telemetry/legacy-linked-project-cache.service.ts";
import { LegacyTelemetryState } from "../../telemetry/legacy-telemetry-state.service.ts";
import { Output } from "../../../shared/output/output.service.ts";
import { Analytics } from "../../../shared/telemetry/analytics.service.ts";
import { withAnalyticsContext } from "../../../shared/telemetry/analytics-context.ts";
import {
  EventProjectLinked,
  GroupOrganization,
  GroupProject,
  PropLinkedVia,
  PropParentProjectRef,
} from "../../../shared/telemetry/event-catalog.ts";
import { legacyResolveLinkedParentRef } from "../../shared/legacy-parent-project-ref.ts";
import { legacyDashboardUrl } from "../../shared/legacy-profile.ts";
import { legacyMapTenantApiKeysError } from "../../shared/legacy-get-tenant-api-keys.ts";
import { mapLegacyHttpError, sanitizeLegacyErrorBody } from "../../shared/legacy-http-errors.ts";
import { legacyLinkServicesCore } from "../../shared/legacy-link-services-core.ts";
import { legacyExtractServiceKeys } from "../../shared/legacy-tenant-keys.ts";
import { legacyTempPaths } from "../../shared/legacy-temp-paths.ts";
import {
  LegacyLinkApiKeysNetworkError,
  LegacyLinkAuthTokenError,
  LegacyLinkBranchListNetworkError,
  LegacyLinkBranchListStatusError,
  LegacyLinkBranchNotFoundError,
  LegacyLinkBranchNotLinkedError,
  LegacyLinkBranchNotReadyError,
  LegacyLinkMissingKeyError,
  LegacyLinkParentRefInvalidError,
  LegacyLinkProjectStatusError,
  LegacyLinkProjectStatusNetworkError,
  LegacyLinkRefArgConflictError,
  LegacyProjectPausedError,
} from "./link.errors.ts";
import type { LegacyLinkFlags } from "./link.command.ts";

type LegacyLinkProject = Effect.Success<ReturnType<ApiClient["v1"]["getProject"]>>;
type LegacyLinkBranches = typeof V1ListAllBranchesOutput.Type;
type LegacyLinkBranch = LegacyLinkBranches[number];

/** Result of resolving a branch name/UUID to its project ref, threaded into the
 * machine payload (`branch`, `parent_project_ref`) alongside the plain ref. */
interface LegacyLinkBranchResolution {
  readonly projectRef: string;
  readonly branchName: string;
  readonly parentRef: string;
}

// Classify a `getProject` failure: a 404 means the project is a branch (resolve
// to `None`, link continues); any other status surfaces the body; transport
// failures surface a network error. Mirrors `checkRemoteProjectStatus`
// (`link.go:240-253`).
const classifyProjectError = (
  cause: unknown,
): Effect.Effect<
  Option.Option<LegacyLinkProject>,
  LegacyLinkProjectStatusError | LegacyLinkProjectStatusNetworkError
> => {
  if (HttpClientError.isHttpClientError(cause) && cause.response !== undefined) {
    const status = cause.response.status;
    if (status === 404) {
      return Effect.succeedNone;
    }
    return cause.response.text.pipe(
      Effect.orElseSucceed(() => ""),
      // Cap + strip control chars, matching `mapLegacyHttpError`'s defence-in-depth
      // so an oversized / control-char body can't bloat JSON output or inject ANSI.
      Effect.map(sanitizeLegacyErrorBody),
      Effect.flatMap((body) =>
        Effect.fail(
          new LegacyLinkProjectStatusError({
            status,
            body,
            message: `Unexpected error retrieving remote project status: ${body}`,
          }),
        ),
      ),
    );
  }
  // Everything else: a transport `HttpClientError` (no response) is a network
  // failure; a non-`HttpClientError` (the generated client's `SchemaError`
  // rejecting the response body) is an API response problem.
  return Effect.fail(
    new LegacyLinkProjectStatusNetworkError({
      message: `failed to retrieve remote project status: ${String(cause)}`,
      decode: !HttpClientError.isHttpClientError(cause),
    }),
  );
};

type WriteTempFile = (filePath: string, content: string) => Effect.Effect<void, PlatformError>;

const mapApiKeysError = legacyMapTenantApiKeysError({
  networkError: LegacyLinkApiKeysNetworkError,
  statusError: LegacyLinkAuthTokenError,
});

/**
 * A value made entirely of lowercase letters (but not 20 of them, or it would
 * already have been treated as a ref) is a plausible ref typo. Appended to
 * both branch-not-found messages and the not-linked message (CLI-2167).
 */
function legacyLinkTypoHint(value: string): string {
  if (!/^[a-z]+$/.test(value)) return "";
  return `\n  If you meant a project ref: refs are exactly 20 lowercase letters ("${value}" has ${value.length}).`;
}

function legacyLinkNotLinkedMessage(value: string): string {
  return (
    `Cannot resolve "${value}": it is not a project ref (refs are exactly 20 lowercase letters, ` +
    "like `abcdefghijklmnopqrst`), so it was treated as a branch name — but no project is linked " +
    "to search for branches.\n" +
    "  If it is a branch name, link the parent project first: supabase link --project-ref <parent-ref>" +
    legacyLinkTypoHint(value)
  );
}

const LEGACY_LINK_MAX_LISTED_BRANCHES = 20;

function legacyLinkBranchNotFoundMessage(
  value: string,
  parentRef: string,
  branches: LegacyLinkBranches,
): string {
  if (branches.length === 0) {
    return `Branch "${value}" not found: project ${parentRef} has no branches.${legacyLinkTypoHint(value)}`;
  }

  const sortedNames = branches.map((branch) => branch.name).toSorted();
  const shown = sortedNames.slice(0, LEGACY_LINK_MAX_LISTED_BRANCHES);
  const remaining = sortedNames.length - shown.length;
  // Branch names are API-provided; sanitize the same way response bodies are
  // before embedding them in an error message (module policy).
  const shownSanitized = sanitizeLegacyErrorBody(shown.join(", "));
  const namesList =
    remaining > 0
      ? `${shownSanitized}, … (${remaining} more — run supabase branches list)`
      : shownSanitized;

  const trimmedLower = value.trim().toLowerCase();
  const nearMiss = branches.find((branch) => branch.name.toLowerCase() === trimmedLower);
  // Sanitized like the list above — an API-provided name must not be able to
  // inject ANSI/OSC/newline controls into the terminal (PR #6168 review).
  const didYouMean =
    nearMiss !== undefined ? ` Did you mean "${sanitizeLegacyErrorBody(nearMiss.name)}"?` : "";

  return (
    `Branch "${value}" not found for project ${parentRef}. Available branches: ${namesList}` +
    `${didYouMean}${legacyLinkTypoHint(value)}`
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
 * (`legacyResolveBranchProjectRef`, which calls `GET /v1/branches/{id}` for a
 * UUID or `GET /v1/projects/{ref}/branches/{name}` for a name): the full list
 * powers the available-branches error enrichment below, and — unlike that
 * resolver, which is handed an already-resolved `projectRef` by its caller —
 * `link` has to resolve the parent project itself first anyway.
 */
const resolveLegacyLinkBranchRef = Effect.fnUntraced(function* (value: string) {
  const output = yield* Output;
  const api = yield* LegacyPlatformApi;

  const parent = yield* legacyResolveLinkedParentRef();
  if (parent.kind === "absent") {
    return yield* Effect.fail(
      new LegacyLinkBranchNotLinkedError({ message: legacyLinkNotLinkedMessage(value) }),
    );
  }
  if (parent.kind === "invalid") {
    return yield* Effect.fail(
      new LegacyLinkParentRefInvalidError({
        message: `Cannot resolve branch "${value}": the linked project ref is invalid (checked SUPABASE_PROJECT_ID, supabase/.temp/linked-project.json, supabase/.temp/project-ref). Relink the parent project first: supabase link --project-ref <parent-ref>`,
      }),
    );
  }
  const parentRef = parent.ref;

  const mapBranchListError = mapLegacyHttpError({
    networkError: LegacyLinkBranchListNetworkError,
    statusError: LegacyLinkBranchListStatusError,
    networkMessage: (cause) => `failed to list branches: ${cause}`,
    statusMessage: (status, body) =>
      status === 404
        ? `Cannot list branches for project ${parentRef} (HTTP 404). If ${parentRef} is itself a preview branch, link its parent project first: supabase link --project-ref <parent-ref>`
        : `unexpected list branches status ${status}: ${body}`,
  });

  const task = output.format === "text" ? yield* output.task("Resolving branch...") : undefined;
  const branches: LegacyLinkBranches = yield* api.v1.listAllBranches({ ref: parentRef }).pipe(
    Effect.tapError(() => task?.fail() ?? Effect.void),
    Effect.catch(mapBranchListError),
  );
  yield* task?.clear() ?? Effect.void;

  const found: LegacyLinkBranch | undefined = branches.find(
    (branch) => branch.name === value || branch.id === value,
  );
  if (found === undefined) {
    return yield* Effect.fail(
      new LegacyLinkBranchNotFoundError({
        message: legacyLinkBranchNotFoundMessage(value, parentRef, branches),
      }),
    );
  }

  if (!PROJECT_REF_PATTERN.test(found.project_ref)) {
    return yield* Effect.fail(
      new LegacyLinkBranchNotReadyError({
        branch: found.name,
        status: found.status,
        message: `Branch "${sanitizeLegacyErrorBody(found.name)}" has no project ref yet (status: ${found.status}). Wait for it to finish provisioning, then retry.`,
      }),
    );
  }

  const line = `Resolved branch "${sanitizeLegacyErrorBody(found.name)}" of project ${parentRef} to project ref ${found.project_ref}.`;
  yield* output.format === "text" ? output.raw(`${line}\n`, "stderr") : output.info(line);

  return { projectRef: found.project_ref, branchName: found.name, parentRef };
});

export const legacyLink = Effect.fn("legacy.link")(function* (flags: LegacyLinkFlags) {
  const output = yield* Output;
  const api = yield* LegacyPlatformApi;
  const cliConfig = yield* LegacyCliConfig;
  const resolver = yield* LegacyProjectRefResolver;
  const linkedProjectCache = yield* LegacyLinkedProjectCache;
  const telemetryState = yield* LegacyTelemetryState;
  const analytics = yield* Analytics;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  // Normalize inputs: an empty-string positional or flag value is absent,
  // mirroring the resolver's own treatment of an empty `--project-ref`.
  const refArg = Option.filter(flags.refOrBranch, (value) => value.length > 0);
  const projectRefFlag = Option.filter(flags.projectRef, (value) => value.length > 0);

  if (Option.isSome(refArg) && Option.isSome(projectRefFlag)) {
    return yield* Effect.fail(
      new LegacyLinkRefArgConflictError({
        message:
          "Cannot use both the [ref-or-branch] argument and the --project-ref flag. Specify the project ref or branch name once.",
      }),
    );
  }

  const requested = Option.isSome(refArg) ? refArg : projectRefFlag;

  // A ref-shaped value (20 lowercase letters) is always treated as a ref and
  // never looked up as a branch name (see `resolveLegacyLinkBranchRef`).
  const branchResolution =
    Option.isSome(requested) && !PROJECT_REF_PATTERN.test(requested.value)
      ? Option.some(yield* resolveLegacyLinkBranchRef(requested.value))
      : Option.none<LegacyLinkBranchResolution>();

  const resolvedRefOrBranch = Option.isSome(branchResolution)
    ? Option.some(branchResolution.value.projectRef)
    : requested;

  const ref = yield* resolver.resolveForLink(resolvedRefOrBranch);
  const paths = legacyTempPaths(path, cliConfig.workdir);

  const writeTempFile: WriteTempFile = (filePath, content) =>
    fs
      .makeDirectory(path.dirname(filePath), { recursive: true })
      .pipe(Effect.andThen(() => fs.writeFileString(filePath, content)));

  // Mirror Go's PersistentPostRun (`apps/cli-go/cmd/root.go:176`): persist the
  // linked-project cache and telemetry state whether the link succeeds or fails.
  // `link` itself writes `linked-project.json` on success (below), so `cache`
  // only fires for the failure / 404 paths.
  yield* Effect.gen(function* () {
    // 1. Check remote project status (404 tolerated for branch projects).
    const project = yield* api.v1
      .getProject({ ref })
      .pipe(Effect.asSome, Effect.catch(classifyProjectError));

    if (Option.isSome(project)) {
      const status = project.value.status;
      if (status === "INACTIVE") {
        return yield* Effect.fail(
          new LegacyProjectPausedError({
            message: "project is paused",
            suggestion: `An admin must unpause it from the Supabase dashboard at ${legacyDashboardUrl(
              cliConfig.profile,
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
    const { anon, serviceRole } = legacyExtractServiceKeys(keys);
    if (anon.length === 0 && serviceRole.length === 0) {
      return yield* Effect.fail(new LegacyLinkMissingKeyError({ message: "Anon key not found." }));
    }

    // 3. Link services — best-effort, using the service-role key for tenant probes.
    yield* legacyLinkServicesCore({
      ref,
      serviceKey: serviceRole,
      skipPooler: flags.skipPooler,
      workdir: cliConfig.workdir,
    });

    // 4. Save project ref (mandatory — a write failure fails the command).
    yield* writeTempFile(paths.projectRef, ref);

    // 5. Telemetry + linked-project cache (only for resolvable projects, i.e.
    // not the 404 branch path). `link.go:40-67`.
    if (Option.isSome(project)) {
      const p = project.value;
      // SaveLinkedProject — best-effort (debug-logged in Go, never fatal).
      yield* writeTempFile(
        paths.linkedProjectCache,
        JSON.stringify({
          ref: p.ref,
          name: p.name,
          organization_id: p.organization_id,
          organization_slug: p.organization_slug,
        }),
      ).pipe(Effect.ignore);

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
    } else if (Option.isSome(branchResolution)) {
      // TS-only event extension (CLI-2167): a branch name/UUID was resolved to
      // `ref` above, so we know definitively this is a branch link — fire the
      // same event with `linked_via`/`parent_project_ref` so branch links are
      // no longer telemetry-invisible. Only refs go out (never the branch
      // name, which is user-created content); no `groupIdentify` here since we
      // have no org/name metadata for the branch, just the group association
      // on the capture itself. The plain 404-ref path (no name resolution)
      // intentionally still emits nothing — a 404 is only *assumed* to be a
      // branch, never confirmed.
      yield* analytics
        .capture(EventProjectLinked, {
          [PropLinkedVia]: "branch",
          [PropParentProjectRef]: branchResolution.value.parentRef,
        })
        .pipe(withAnalyticsContext({ groups: { project: ref } }));
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
  }).pipe(Effect.ensuring(linkedProjectCache.cache(ref)), Effect.ensuring(telemetryState.flush));
});
