import type { ApiClient } from "@supabase/api/effect";
import { Effect, Option } from "effect";

import { CommandSettings } from "../config/command-settings.service.ts";
import { CommandPlatformApi } from "../auth/command-platform-api.service.ts";
import { LegacyProjectState } from "../shared/config/legacy-project-state.service.ts";
import {
  fetchGotrueVersion,
  fetchPostgrestVersion,
  fetchStorageVersion,
} from "./tenant-versions.ts";
import { block } from "./command-permissions/model.ts";

/** `linkServicesCore`, shared by `link` and `bootstrap`. */
export const linkServices = block("link-services", [
  { operationId: "v1-get-storage-config", kind: "best-effort" },
  {
    operationId: "v1-get-pooler-config",
    kind: "best-effort",
    when: [{ flag: "skip-pooler", is: false }],
  },
]);

export interface LinkServicesInput {
  readonly ref: string;
  /**
   * Tenant API key used for the service version probes: `link` passes the
   * service-role key, `bootstrap` passes the anon key. Empty skips the probes.
   */
  readonly serviceKey: string;
  readonly skipPooler: boolean;
  /**
   * Absolute project directory whose `supabase/.temp/*` files receive the linked
   * service metadata. Passed explicitly (never read from `CommandSettings.workdir`)
   * because `bootstrap` links a freshly created project directory that differs
   * from the cwd-walked config workdir.
   */
  readonly workdir: string;
}

/**
 * Writes the best-effort portion of linking:
 * `supabase/.temp/{storage-migration,pooler-url,rest-version,gotrue-version,
 * storage-version}`. Each probe is independently best-effort — an
 * unreachable service never fails the caller. Does not write `project-ref`,
 * the linked-project cache, or fire `cli_project_linked`; the `link` command
 * owns those, and `bootstrap` calls this directly to skip them. When the saved
 * `project-ref` names another project or cannot be read, the files above except
 * `pooler-url` are removed first and a failed removal fails the call, since their
 * readers do no ref check; callers therefore save the new `project-ref` only after
 * this succeeds.
 */
export const linkServicesCore = Effect.fn("LinkServices.write")(function* (
  input: LinkServicesInput,
) {
  yield* Effect.annotateCurrentSpan({
    "project.ref": input.ref,
    "link.skip_pooler": input.skipPooler,
  });
  const api = yield* CommandPlatformApi;
  const cliSettings = yield* CommandSettings;
  const state = yield* LegacyProjectState;
  const { workdir } = input;

  const refChanged = yield* state.readProjectRef(workdir).pipe(
    Effect.map(Option.exists((ref) => ref !== input.ref)),
    Effect.orElseSucceed(() => true),
  );
  yield* Effect.annotateCurrentSpan("link.ref_changed", refChanged);
  if (refChanged) {
    yield* Effect.forEach(
      ["storageMigration", "restVersion", "gotrueVersion", "storageVersion"] as const,
      (file) => state.remove(workdir, file),
      { discard: true },
    );
  }

  yield* linkStorageMigration(api, input.ref, state, workdir);
  yield* linkPooler({ api, ref: input.ref, skipPooler: input.skipPooler, state, workdir });
  if (input.serviceKey.length === 0) return;

  const tenantOpts = {
    ref: input.ref,
    projectHost: cliSettings.projectHost,
    serviceKey: input.serviceKey,
    userAgent: cliSettings.userAgent,
  };
  yield* fetchPostgrestVersion(tenantOpts).pipe(
    Effect.flatMap((v) =>
      Option.isSome(v) ? state.write(workdir, "restVersion", v.value) : Effect.void,
    ),
    Effect.ignore,
  );
  yield* fetchGotrueVersion(tenantOpts).pipe(
    Effect.flatMap((v) =>
      Option.isSome(v) ? state.write(workdir, "gotrueVersion", v.value) : Effect.void,
    ),
    Effect.ignore,
  );
  yield* fetchStorageVersion(tenantOpts).pipe(
    Effect.flatMap((v) =>
      Option.isSome(v) ? state.write(workdir, "storageVersion", v.value) : Effect.void,
    ),
    Effect.ignore,
  );
});

const linkStorageMigration = (
  api: ApiClient,
  ref: string,
  state: LegacyProjectState["Service"],
  workdir: string,
) =>
  api.v1.getStorageConfig({ ref }).pipe(
    Effect.flatMap((config) =>
      config.migrationVersion === null
        ? Effect.void
        : state.write(workdir, "storageMigration", config.migrationVersion),
    ),
    Effect.ignore,
  );

/**
 * The session-mode connection string for a pooler config: drops the `[YOUR-PASSWORD]`
 * placeholder and forces port 5432 unless the pooler already reports session mode.
 */
const normalizePoolerUrl = (connectionString: string, poolMode: string): string => {
  const withoutPassword = connectionString.replaceAll(":[YOUR-PASSWORD]", "");
  return poolMode === "session" ? withoutPassword : withoutPassword.replaceAll(":6543/", ":5432/");
};

/** The normalized primary pooler URL for `ref`, `None` when the project reports no primary. */
export const fetchPoolerUrl = Effect.fn("link.fetchPoolerUrl")(function* (
  api: ApiClient,
  ref: string,
) {
  const configs = yield* api.v1.getPoolerConfig({ ref });
  const primary = configs.find((c) => c.database_type === "PRIMARY");
  return primary === undefined
    ? Option.none<string>()
    : Option.some(normalizePoolerUrl(primary.connection_string, primary.pool_mode));
});

const linkPooler = (opts: {
  api: ApiClient;
  ref: string;
  skipPooler: boolean;
  state: LegacyProjectState["Service"];
  workdir: string;
}) =>
  Effect.gen(function* () {
    if (opts.skipPooler) {
      // Use direct connection: drop any cached pooler URL.
      yield* opts.state.remove(opts.workdir, "poolerUrl").pipe(Effect.ignore);
      return;
    }
    const url = yield* fetchPoolerUrl(opts.api, opts.ref);
    if (Option.isSome(url)) yield* opts.state.write(opts.workdir, "poolerUrl", url.value);
  }).pipe(Effect.ignore);
