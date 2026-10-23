import type { ApiClient } from "@supabase/api/effect";
import { Effect, Option } from "effect";
import * as HttpClientError from "effect/http/HttpClientError";

import { CommandSettings } from "../config/command-settings.service.ts";
import type { ProjectLink } from "../shared/config/project-link.ts";
import type { HostedProbe } from "./stack-lock.ts";
import { extractServiceKeys } from "./tenant-keys.ts";
import { probeFailure, probeTenantVersions, type HostedObservation } from "./tenant-versions.ts";

/** The version the platform reports for the database; an empty string means it reports none. */
const databaseObservation = (version: string): HostedObservation => {
  const raw = version.trim();
  return raw.length === 0 ? { _tag: "Unreported" } : { _tag: "Observed", raw, version: raw };
};

/**
 * The remote a link document names, as the lock records it: the project and the branch ref, so the
 * same branch records the same remote however it was linked. A document that does not say whether
 * its branch is the default one is the default branch when its ref is the project's.
 */
export const linkRemote = (link: ProjectLink): HostedProbe["remote"] => {
  const { active_branch: branch, project } = link;
  return {
    project: project.ref,
    branch: { ref: branch.ref, isDefault: branch.is_default ?? branch.ref === project.ref },
  };
};

/**
 * Observes the hosted versions of `ref`: the database from the project, or from the branch's own
 * configuration when `ref` is a branch, and Auth, REST and Storage from the tenant endpoints. A
 * request that fails is reported as such, never as an absent service.
 */
export const observeHostedVersions = Effect.fn("link.probe")(function* (input: {
  readonly api: ApiClient;
  readonly ref: string;
  readonly serviceKey: string;
  /** The version `getProject` reported; absent when `ref` is a branch. */
  readonly databaseVersion: Option.Option<string>;
}) {
  const settings = yield* CommandSettings;
  const [database, tenant] = yield* Effect.all(
    [
      Option.isSome(input.databaseVersion)
        ? Effect.succeed(databaseObservation(input.databaseVersion.value))
        : input.api.v1.getABranchConfig({ branch_id_or_ref: input.ref }).pipe(
            Effect.map((config) => databaseObservation(config.postgres_version)),
            Effect.catch((error) => Effect.succeed(probeFailure(error))),
          ),
      probeTenantVersions({
        ref: input.ref,
        projectHost: settings.projectHost,
        serviceKey: input.serviceKey,
        userAgent: settings.userAgent,
      }),
    ],
    { concurrency: 2 },
  );
  const observations: HostedProbe["observations"] = { database, ...tenant };
  const found = Object.values(observations);
  yield* Effect.annotateCurrentSpan({
    "link.observed_count": found.filter(({ _tag }) => _tag === "Observed").length,
    "link.unreported_count": found.filter(({ _tag }) => _tag === "Unreported").length,
    "link.failed_count": found.filter(({ _tag }) => _tag === "Failed").length,
  });
  return observations;
});

const isNotFound = (error: unknown) =>
  HttpClientError.isHttpClientError(error) && error.response?.status === 404;

/**
 * Probes the hosted target of a link document for `stack update`. Fails when the project or its
 * keys cannot be read; a version that cannot be read becomes a failed observation.
 */
export const probeLinkedTarget = Effect.fn("update.probe")(function* (
  api: ApiClient,
  link: ProjectLink,
) {
  const ref = link.active_branch.ref;
  const project = yield* api.v1.getProject({ ref }).pipe(
    Effect.asSome,
    Effect.catchIf(isNotFound, () => Effect.succeedNone),
  );
  const keys = yield* api.v1.getProjectApiKeys({ ref, reveal: true });
  const observations = yield* observeHostedVersions({
    api,
    ref,
    serviceKey: extractServiceKeys(keys).serviceRole,
    databaseVersion: Option.map(project, (found) => found.database.version),
  });
  return { remote: linkRemote(link), observations } satisfies HostedProbe;
});
