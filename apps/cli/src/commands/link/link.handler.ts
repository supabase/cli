import { defaultArtifactSelection } from "@supabase/stack/defaults";
import { DateTime, Duration, Effect, Option, Ref, Schema } from "effect";

import { CommandPlatformApi } from "../../auth/command-platform-api.service.ts";
import { CliConfigValues } from "../../config/cli-config-values.service.ts";
import { CommandSettings } from "../../config/command-settings.service.ts";
import { ProjectRefResolver, PROJECT_REF_PATTERN } from "../../config/project-ref.service.ts";
import { LinkedProjectCache } from "../../telemetry/linked-project-cache.service.ts";
import { TelemetryState } from "../../telemetry/telemetry-state.service.ts";
import { Output } from "../../shared/output/output.service.ts";
import { Analytics } from "../../shared/telemetry/analytics.service.ts";
import { withAnalyticsContext } from "../../shared/telemetry/analytics-context.ts";
import { identifyProjectGroups } from "../../shared/telemetry/identify-project-groups.ts";
import {
  EventProjectLinked,
  PropLinkedVia,
  PropParentProjectRef,
} from "../../shared/telemetry/event-catalog.ts";
import { classifyProjectLookupError } from "../../command-internal/branch-target.ts";
import {
  type CachedLinkedProject,
  parseCachedLinkedProject,
} from "../../shared/config/link-snapshot.ts";
import { dashboardUrl } from "../../command-internal/profile.ts";
import { mapTenantApiKeysError } from "../../command-internal/get-tenant-api-keys.ts";
import { sanitizeInlineName } from "../../command-internal/http-errors.ts";
import { fetchPoolerUrl, linkServicesCore } from "../../command-internal/link-services-core.ts";
import { currentProjectStateMode } from "../../shared/config/project-state-mode.ts";
import {
  type ProjectLink,
  readProjectLink,
  ensureProjectDirectory,
  writeProjectLink,
} from "../../shared/config/project-link.ts";
import { extractServiceKeys } from "../../command-internal/tenant-keys.ts";
import { linkRemote, observeHostedVersions } from "../../command-internal/hosted-versions.ts";
import { loadLocalProjectContext } from "../../command-internal/local-project-context.ts";
import { loadStackConfig, StackConfigError } from "../../command-internal/stack-config.ts";
import {
  LOCK_FILE,
  linkedLock,
  type LinkedLock,
  type LockRequest,
  withProjectLease,
} from "../../command-internal/stack-lock.ts";
import { LegacyProjectState } from "../../shared/config/legacy-project-state.service.ts";
import {
  LinkApiKeysNetworkError,
  LinkAuthTokenError,
  LinkMissingKeyError,
  LinkProjectStatusError,
  LinkProjectStatusNetworkError,
  LinkRefArgConflictError,
  ProjectPausedError,
} from "./link.errors.ts";
import {
  type BranchResolution,
  resolveLinkBranchRef,
} from "../../command-internal/target/branch-resolution.ts";
import type { LinkFlags } from "./link.command.ts";

// Classify a `getProject` failure: a 404 means the project is a branch (resolve
// to `None`, link continues); any other status surfaces the body; transport
// failures surface a network error.
const classifyProjectError = classifyProjectLookupError({
  statusError: LinkProjectStatusError,
  networkError: LinkProjectStatusNetworkError,
  statusMessage: (_status, body) => `Unexpected error retrieving remote project status: ${body}`,
  networkMessage: (cause) => `failed to retrieve remote project status: ${String(cause)}`,
});

const mapApiKeysError = mapTenantApiKeysError({
  networkError: LinkApiKeysNetworkError,
  statusError: LinkAuthTokenError,
});

// Bounds the best-effort cache-correlation lookup below so it can't silently stall for minutes
// on the generated client's default 60s×5 retries.
const LINK_CACHE_CORRELATION_TIMEOUT = Duration.seconds(5);

const encodeLinkedProjectCache = Schema.encodeEffect(
  Schema.fromJsonString(
    Schema.Struct({
      ref: Schema.String,
      name: Schema.String,
      organization_id: Schema.String,
      organization_slug: Schema.String,
    }),
  ),
);

const encodeLinkedParentCache = Schema.encodeEffect(
  Schema.fromJsonString(Schema.Struct({ ref: Schema.String })),
);

/**
 * The parent project recorded in a stack-mode link written for a branch-project ref (the 404
 * arm). A resolved branch names its parent, keeping an agreeing document's richer metadata; a
 * raw ref keeps a divergent document's project only when that project still lists `ref` as a
 * branch, and otherwise has no known parent, so the project is the ref itself.
 */
const resolveStackLinkParent = Effect.fn("link.resolveStackParent")(function* (input: {
  readonly ref: string;
  readonly workdir: string;
  readonly branchResolution: Option.Option<BranchResolution>;
}) {
  const output = yield* Output;
  const api = yield* CommandPlatformApi;
  const existing = (yield* readProjectLink(input.workdir).pipe(Effect.option)).pipe(Option.flatten);
  const existingProject = Option.map(existing, (link) => link.project);

  if (Option.isSome(input.branchResolution)) {
    const parentRef = input.branchResolution.value.parentRef;
    return Option.isSome(existingProject) && existingProject.value.ref === parentRef
      ? existingProject.value
      : { ref: parentRef };
  }
  if (Option.isNone(existingProject) || existingProject.value.ref === input.ref) {
    return { ref: input.ref };
  }
  if (!PROJECT_REF_PATTERN.test(existingProject.value.ref)) return { ref: input.ref };

  const correlating =
    output.format === "text" ? yield* output.task("Checking branch parent...") : undefined;
  const verified = yield* api.v1.listAllBranches({ ref: existingProject.value.ref }).pipe(
    Effect.timeout(LINK_CACHE_CORRELATION_TIMEOUT),
    Effect.map((branches) => branches.some((branch) => branch.project_ref === input.ref)),
    Effect.orElseSucceed(() => false),
    Effect.ensuring(correlating?.clear ?? Effect.void),
    Effect.tap((result) => Effect.annotateCurrentSpan("link.parent_verified", result)),
  );
  return verified ? existingProject.value : { ref: input.ref };
});

const renderLinkedLock = (result: LinkedLock) => {
  const rows = result.services.map(({ service, hosted, locked, resolution }) => [
    service,
    hosted ?? "-",
    locked,
    resolution,
  ]);
  const header = ["service", "hosted", "locked", "resolution"];
  const widths = header.map((title, column) =>
    Math.max(title.length, ...rows.map((row) => row[column]?.length ?? 0)),
  );
  const line = (cells: ReadonlyArray<string>) =>
    `  ${cells.map((cell, column) => cell.padEnd(widths[column] ?? 0)).join("  ")}`.trimEnd();
  const changed = result.services.filter(({ changed }) => changed).length;
  return [
    "Hosted versions:",
    line(header),
    ...rows.map(line),
    result.frozen
      ? `${LOCK_FILE} was left untouched.`
      : result.written
        ? `Updated ${LOCK_FILE}${result.observing === undefined ? "" : `: now observing ${result.observing}`} (${changed} ${changed === 1 ? "version change" : "version changes"}). Review and commit it.`
        : `${LOCK_FILE} is already up to date.`,
  ].join("\n");
};

/**
 * Publishes a stack-mode link and records its hosted versions in `supabase/supabase.lock`: the
 * project config is validated first, then, under the project lease, the project or branch is
 * probed, `.link.json` published, and the lock written. `undefined` when the project has no
 * `supabase/config.toml`, so there is no lock to keep and only `.link.json` is published.
 */
const publishStackLink = Effect.fn("link.lock")(function* (input: {
  readonly ref: string;
  readonly link: ProjectLink;
  readonly serviceKey: string;
  /** The version `getProject` reported; absent when the ref is a branch. */
  readonly databaseVersion: Option.Option<string>;
  readonly frozen: boolean;
}) {
  const output = yield* Output;
  const api = yield* CommandPlatformApi;
  const { workdir } = yield* CommandSettings;
  const publishLink = writeProjectLink(workdir, input.link);
  const context = yield* loadLocalProjectContext(
    workdir,
    (message) => new StackConfigError({ message }),
  );
  if (!context.resolvedConfig.hasConfigFile) {
    yield* ensureProjectDirectory(workdir);
    yield* withProjectLease(workdir, publishLink);
    return undefined;
  }

  // The loader offers the lock request only part-way through validating the config, so the
  // request is taken from it and the lock is resolved once the whole config has validated.
  const requested = yield* Ref.make(Option.none<LockRequest>());
  yield* loadStackConfig(workdir, {
    selection: (request) =>
      Ref.set(requested, Option.some(request)).pipe(Effect.as(defaultArtifactSelection())),
  });
  const request = yield* Ref.get(requested).pipe(Effect.flatMap(Effect.fromOption), Effect.orDie);
  const result = yield* linkedLock({
    frozen: input.frozen,
    probe: observeHostedVersions({
      api,
      ref: input.ref,
      serviceKey: input.serviceKey,
      databaseVersion: input.databaseVersion,
    }).pipe(Effect.map((observations) => ({ remote: linkRemote(input.link), observations }))),
    publishLink,
    report: (locked) =>
      output.format === "text" ? output.info(renderLinkedLock(locked)) : Effect.void,
    output,
  })(request);
  yield* Effect.annotateCurrentSpan({
    "link.resolved_count": result.services.length,
    "link.unobserved_count": result.services.filter(({ resolution }) => resolution === "unobserved")
      .length,
    "link.kept_count": result.kept.length,
    "link.lock_written": result.written,
  });
  return result;
});

export const link = Effect.fn("link")(function* (flags: LinkFlags) {
  const output = yield* Output;
  const api = yield* CommandPlatformApi;
  const cliSettings = yield* CommandSettings;
  const configValues = yield* CliConfigValues;
  const resolver = yield* ProjectRefResolver;
  const linkedProjectCache = yield* LinkedProjectCache;
  const telemetryState = yield* TelemetryState;
  const analytics = yield* Analytics;
  const legacyState = yield* LegacyProjectState;
  const stackState = (yield* currentProjectStateMode) === "stack";

  // Captured once ref/branch resolution succeeds; `undefined` means no ref was ever resolved,
  // so the post-run cache fill below stays a no-op.
  const resolvedRef = yield* Ref.make<string | undefined>(undefined);

  // Persists the linked-project cache and telemetry state whether the link succeeds or fails.
  // `link` itself writes `linked-project.json` on success (below), so `cache` only fires for
  // the failure / 404 paths.
  yield* Effect.gen(function* () {
    // An empty-string positional or flag value is treated as absent, matching the resolver's
    // own treatment of an empty `--project-ref`.
    const refArg = Option.filter(flags.refOrBranch, (value) => value.length > 0);
    const projectRefFlag = Option.filter(flags.projectRef, (value) => value.length > 0);

    if (Option.isSome(refArg) && Option.isSome(projectRefFlag)) {
      return yield* new LinkRefArgConflictError({
        message:
          "Cannot use both the [ref-or-branch] argument and the --project-ref flag. Specify the project ref or branch name once.",
      });
    }

    const requested = Option.isSome(refArg) ? refArg : projectRefFlag;

    const resolveBranch = Effect.fnUntraced(function* (value: string) {
      const found = yield* resolveLinkBranchRef(value);
      const line = `Resolved branch "${sanitizeInlineName(found.branchName)}" of project ${found.parentRef} to project ref ${found.projectRef}.`;
      yield* output.format === "text" ? output.raw(`${line}\n`, "stderr") : output.info(line);
      return found;
    });

    // A ref-shaped value (20 lowercase letters) is always treated as a ref and
    // never looked up as a branch name (see `resolveLinkBranchRef`).
    const branchResolution =
      Option.isSome(requested) && !PROJECT_REF_PATTERN.test(requested.value)
        ? Option.some(yield* resolveBranch(requested.value))
        : Option.none<BranchResolution>();

    const resolvedRefOrBranch = Option.isSome(branchResolution)
      ? Option.some(branchResolution.value.projectRef)
      : requested;

    const ref = yield* resolver.resolveForLink(resolvedRefOrBranch);
    yield* Ref.set(resolvedRef, ref);
    yield* Effect.annotateCurrentSpan({
      "project.ref": ref,
      "link.via_branch": Option.isSome(branchResolution),
    });
    const workdir = cliSettings.workdir;

    // 1. Check remote project status (404 tolerated for branch projects).
    const project = yield* api.v1
      .getProject({ ref })
      .pipe(Effect.asSome, Effect.catch(classifyProjectError));
    yield* Effect.annotateCurrentSpan(
      "project.status",
      Option.isSome(project) ? project.value.status : "not_found",
    );

    if (Option.isSome(project)) {
      const status = project.value.status;
      if (status === "INACTIVE") {
        return yield* new ProjectPausedError({
          message: "project is paused",
          suggestion: `An admin must unpause it from the Supabase dashboard at ${dashboardUrl(
            cliSettings.profile,
          )}/project/${ref}`,
        });
      }
      if (status !== "ACTIVE_HEALTHY") {
        yield* output.raw(
          `WARNING: Project status is ${status} instead of Active Healthy. Some operations might fail.\n`,
          "stderr",
        );
      }
      // Updates the postgres image version to match the remote project.
      const version = project.value.database.version;
      if (!stackState && version.length > 0) {
        yield* configValues.writeThrough(legacyState.write(workdir, "postgresVersion", version));
      }
    }

    // 2. Resolve service keys (auth check).
    const keys = yield* api.v1
      .getProjectApiKeys({ ref, reveal: true })
      .pipe(Effect.catch(mapApiKeysError));
    const { anon, serviceRole } = extractServiceKeys(keys);
    if (anon.length === 0 && serviceRole.length === 0) {
      return yield* new LinkMissingKeyError({ message: "Anon key not found." });
    }

    // 3. Link services — best-effort, using the service-role key for tenant probes. Stack mode
    // keeps only the pooler URL; versions come from the service lock.
    const poolerUrl = stackState
      ? flags.skipPooler
        ? Option.none<string>()
        : yield* fetchPoolerUrl(api, ref).pipe(Effect.option, Effect.map(Option.flatten))
      : yield* configValues
          .writeThrough(
            linkServicesCore({
              ref,
              serviceKey: serviceRole,
              skipPooler: flags.skipPooler,
              workdir,
            }),
          )
          .pipe(Effect.as(Option.none<string>()));

    // 4. Save the link (mandatory — a write failure fails the command). In stack mode the link
    // and the lock are published together under the lock lease, the link first.
    let stackLock: LinkedLock | undefined;
    if (stackState) {
      const parent = Option.isSome(project)
        ? {
            ref: project.value.ref,
            name: project.value.name,
            organization_id: project.value.organization_id,
            organization_slug: project.value.organization_slug,
          }
        : yield* resolveStackLinkParent({ ref, workdir, branchResolution });
      const link: ProjectLink = {
        project: parent,
        active_branch: {
          ref,
          ...(Option.isSome(branchResolution)
            ? {
                name: branchResolution.value.branchName,
                is_default: branchResolution.value.isDefault,
              }
            : // A ref that is not a project is a non-default branch, even when its parent is unknown.
              Option.isNone(project)
              ? { is_default: false }
              : {}),
          ...(Option.isSome(poolerUrl) ? { pooler_url: poolerUrl.value } : {}),
        },
        fetchedAt: DateTime.formatIso(yield* DateTime.now),
      };
      stackLock = yield* configValues.writeThrough(
        publishStackLink({
          ref,
          link,
          serviceKey: serviceRole,
          databaseVersion: Option.map(project, (found) => found.database.version),
          frozen: flags.frozen,
        }),
      );
    } else {
      yield* configValues.writeThrough(legacyState.write(workdir, "projectRef", ref));
    }

    // 5. Telemetry + linked-project cache (only for resolvable projects, not the 404 branch path).
    if (Option.isSome(project)) {
      const p = project.value;
      // Best-effort: if the rewrite fails while a stale cache for a different project
      // survives, delete it rather than leave the parent chain trusting the old project.
      if (!stackState) {
        yield* encodeLinkedProjectCache({
          ref: p.ref,
          name: p.name,
          organization_id: p.organization_id,
          organization_slug: p.organization_slug,
        }).pipe(
          Effect.flatMap((content) =>
            configValues.writeThrough(legacyState.write(workdir, "linkedProjectCache", content)),
          ),
          Effect.catch(() => legacyState.remove(workdir, "linkedProjectCache")),
          Effect.ignore,
        );
      }

      const groups = { organization: p.organization_id, project: p.ref } as const;
      yield* identifyProjectGroups(analytics, p);
      // A default branch's `project_ref` is the parent's own ref, so `link main` still hits
      // this 200 arm (never the 404 arm below); check `branchResolution` here too or a
      // default-branch link loses `linked_via`.
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
      // 404 path: `ref` is a branch. The plain-project arm above never writes
      // `linked-project.json` for this ref, and the post-run cache fill (`Effect.ensuring`
      // below) also GETs `ref` and 404s on a branch — so without persisting parent evidence
      // here, `resolveLinkedParentRef`'s chain can lose it or go stale. Both branches below
      // are best-effort and never affect `link`'s own outcome.
      const cachedParent = stackState
        ? Option.none<CachedLinkedProject>()
        : yield* legacyState.read(workdir, "linkedProjectCache").pipe(
            Effect.map(parseCachedLinkedProject),
            Effect.orElseSucceed(() => Option.none<CachedLinkedProject>()),
          );

      if (Option.isSome(branchResolution)) {
        // (a) The branch's parent is known here, so persist it durably even when the
        // existing cache is missing or malformed. Leave an already-agreeing cache untouched —
        // it may be richer (name/org) than the ref-only record below, e.g. from a real
        // `link <parent-ref>` run.
        const parentRef = branchResolution.value.parentRef;
        if (!stackState && (Option.isNone(cachedParent) || cachedParent.value.ref !== parentRef)) {
          // If the replacement write fails, delete the stale cache instead of leaving a
          // wrong parent trusted — no parent info beats wrong parent info.
          yield* encodeLinkedParentCache({ ref: parentRef }).pipe(
            Effect.flatMap((content) =>
              configValues.writeThrough(legacyState.write(workdir, "linkedProjectCache", content)),
            ),
            Effect.catch(() => legacyState.remove(workdir, "linkedProjectCache")),
            Effect.ignore,
          );
        }

        // A resolved branch name/UUID means this is definitively a branch link — fire the
        // same event with `linked_via`/`parent_project_ref`. Only the ref goes out, never the
        // branch name (user data); no `groupIdentify` since there's no org/name metadata for
        // a branch.
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
        // (b) A raw ref-shaped branch link has no known parent, so if the cache names a
        // different project, verify it: keep the cache only if that parent's branches still
        // include `ref`; any mismatch or lookup failure deletes it. An unverified divergent
        // cache would silently misdirect future parent-scoped mutations to the wrong project,
        // while deleting it only downgrades to a loud not-linked error the user fixes by
        // relinking.
        //
        // Shows a spinner in text mode so this silent, timeout-bounded correlation lookup
        // doesn't make an otherwise-finished link feel stalled.
        const correlating =
          output.format === "text" ? yield* output.task("Checking branch parent...") : undefined;
        const verified = yield* api.v1.listAllBranches({ ref: cachedParent.value.ref }).pipe(
          Effect.timeout(LINK_CACHE_CORRELATION_TIMEOUT),
          Effect.map((branches) => branches.some((branch) => branch.project_ref === ref)),
          Effect.orElseSucceed(() => false),
          Effect.ensuring(correlating?.clear ?? Effect.void),
          Effect.tap((result) => Effect.annotateCurrentSpan("link.parent_verified", result)),
        );
        if (!verified) {
          yield* legacyState.remove(workdir, "linkedProjectCache").pipe(Effect.ignore);
        }
      }
    }

    // 6. PostRun: `Finished supabase link.` to stdout (text), structured success otherwise.
    if (output.format === "text") {
      yield* output.raw("Finished supabase link.\n");
    } else {
      yield* output.success("", {
        project_ref: ref,
        ...(stackLock === undefined
          ? {}
          : {
              lock: {
                file: LOCK_FILE,
                written: stackLock.written,
                services: stackLock.services.map(({ service, hosted, locked, resolution }) => ({
                  service,
                  hosted: hosted ?? null,
                  locked,
                  resolution,
                })),
              },
            }),
        // Present only when a branch name/UUID was resolved above; absent for a plain
        // project-ref link.
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
      Effect.flatMap(Ref.get(resolvedRef), (ref) =>
        ref === undefined ? Effect.void : linkedProjectCache.cache(ref),
      ),
    ),
    Effect.ensuring(telemetryState.flush),
  );
});
