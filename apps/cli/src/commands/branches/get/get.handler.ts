import { styleText } from "node:util";

import type {
  V1GetABranchConfigOutput,
  V1GetProjectApiKeysOutput,
  V1GetPoolerConfigOutput,
} from "@supabase/api/effect";
import { Effect, Option } from "effect";

import { CommandPlatformApi } from "../../../auth/command-platform-api.service.ts";
import { CommandSettings } from "../../../config/command-settings.service.ts";
import { LinkedProjectCache } from "../../../telemetry/linked-project-cache.service.ts";
import { TelemetryState } from "../../../telemetry/telemetry-state.service.ts";
import { OutputFlag } from "../../../command-internal/global-flags.ts";
import { Output } from "../../../shared/output/output.service.ts";
import { Tty } from "../../../shared/runtime/tty.service.ts";
import {
  encodeEnv,
  encodeGoJson,
  encodeToml,
  encodeYaml,
} from "../../../command-internal/go-output.encoders.ts";
import { mapHttpError } from "../../../command-internal/http-errors.ts";
import { resolveParentScopedProjectRef } from "../../../command-internal/parent-project-ref.ts";
import {
  BranchesApiKeysNetworkError,
  BranchesApiKeysUnexpectedStatusError,
  BranchesFindNetworkError,
  BranchesFindUnexpectedStatusError,
  BranchesGetNetworkError,
  BranchesGetUnexpectedStatusError,
  BranchesPoolerNetworkError,
  BranchesPoolerUnexpectedStatusError,
  BranchesPrimaryNotFoundError,
} from "../branches.errors.ts";
import { renderBranchGetTable, toStandardEnvs } from "../branches.format.ts";
import { projectHost } from "../../../command-internal/profile.ts";
import { promptBranchId } from "../branches.prompt.ts";
import {
  BRANCH_PROJECT_REF_PATTERN,
  BRANCH_UUID_PATTERN,
} from "../../../command-internal/ref-patterns.ts";
import type { BranchesGetFlags } from "./get.command.ts";

type BranchDetail = typeof V1GetABranchConfigOutput.Type;
type ApiKeys = typeof V1GetProjectApiKeysOutput.Type;
type Pooler = typeof V1GetPoolerConfigOutput.Type;

const mapFindError = mapHttpError({
  networkError: BranchesFindNetworkError,
  statusError: BranchesFindUnexpectedStatusError,
  networkMessage: (cause) => `failed to find branch: ${cause}`,
  statusMessage: (status, body) => `unexpected find branch status ${status}: ${body}`,
});

const mapGetError = mapHttpError({
  networkError: BranchesGetNetworkError,
  statusError: BranchesGetUnexpectedStatusError,
  networkMessage: (cause) => `failed to get branch: ${cause}`,
  statusMessage: (status, body) => `unexpected get branch status ${status}: ${body}`,
});

const mapApiKeysError = mapHttpError({
  networkError: BranchesApiKeysNetworkError,
  statusError: BranchesApiKeysUnexpectedStatusError,
  networkMessage: (cause) => `failed to get api keys: ${cause}`,
  statusMessage: (status, body) => `unexpected get api keys status ${status}: ${body}`,
});

const mapPoolerError = mapHttpError({
  networkError: BranchesPoolerNetworkError,
  statusError: BranchesPoolerUnexpectedStatusError,
  networkMessage: (cause) => `failed to get pooler: ${cause}`,
  statusMessage: (status, body) => `unexpected get pooler status ${status}: ${body}`,
});

export const branchesGet = Effect.fn("branches.get")(function* (flags: BranchesGetFlags) {
  const output = yield* Output;
  const goOutputFlag = yield* OutputFlag;
  const api = yield* CommandPlatformApi;
  const linkedProjectCache = yield* LinkedProjectCache;
  const telemetryState = yield* TelemetryState;
  const cliSettings = yield* CommandSettings;
  void (yield* Tty); // ensures Tty is in handler R so promptBranchId resolves

  // `branches` is PARENT-scoped: after `supabase link <branch>`,
  // `supabase/.temp/project-ref` holds the branch's own ref, and the platform
  // 403s on that ref for every branches-management endpoint (CLI-2167 follow-up).
  const ref = yield* resolveParentScopedProjectRef(flags.projectRef);

  yield* Effect.gen(function* () {
    // Branch-id resolution. Empty input goes through the prompt helper.
    const branchInput = yield* promptBranchId(flags.name, ref);

    // ------------------------------------------------------------------
    // 1. Lookup: if input is not a UUID and not a ref pattern, fetch the
    //    project ref via V1GetABranch (`GET /v1/projects/{ref}/branches/{name}`).
    // ------------------------------------------------------------------
    let branchIdOrRef = branchInput;
    if (!BRANCH_UUID_PATTERN.test(branchInput) && !BRANCH_PROJECT_REF_PATTERN.test(branchInput)) {
      const lookup = yield* api.v1
        .getABranch({ ref, name: branchInput })
        .pipe(Effect.catch(mapFindError));
      branchIdOrRef = lookup.project_ref;
    }

    // ------------------------------------------------------------------
    // 2. Detail: V1GetABranchConfig (`GET /v1/branches/{id_or_ref}`).
    //    Mask db_user / db_pass / jwt_secret with `******` when nil.
    // ------------------------------------------------------------------
    const fetching =
      output.format === "text" ? yield* output.task("Fetching branch...") : undefined;
    const rawDetail: BranchDetail = yield* api.v1
      .getABranchConfig({ branch_id_or_ref: branchIdOrRef })
      .pipe(
        Effect.tapError(() => fetching?.fail() ?? Effect.void),
        Effect.catch(mapGetError),
      );
    yield* fetching?.clear() ?? Effect.void;
    const detail: BranchDetail = {
      ...rawDetail,
      db_user: rawDetail.db_user ?? "******",
      db_pass: rawDetail.db_pass ?? "******",
      jwt_secret: rawDetail.jwt_secret ?? "******",
    };

    const goFmt = Option.getOrUndefined(goOutputFlag);
    const wantsEnvMap = goFmt !== undefined && goFmt !== "pretty";
    const wantsTsStructured = output.format === "json" || output.format === "stream-json";

    if (goFmt === "pretty" || (goFmt === undefined && output.format === "text")) {
      yield* output.raw(renderBranchGetTable(detail));
      return;
    }

    // ------------------------------------------------------------------
    // 3+4. API keys + pooler config (only for non-pretty modes).
    // ------------------------------------------------------------------
    const keys: ApiKeys = yield* api.v1
      .getProjectApiKeys({ ref: detail.ref })
      .pipe(Effect.catch(mapApiKeysError));
    const poolers: Pooler = yield* api.v1
      .getPoolerConfig({ ref: detail.ref })
      .pipe(Effect.catch(mapPoolerError));
    const primary = poolers.find((p) => p.database_type === "PRIMARY");
    if (primary === undefined) {
      return yield* new BranchesPrimaryNotFoundError({
        message: "primary database not found",
      });
    }

    const host = projectHost(cliSettings.profile);
    const projected = toStandardEnvs(detail, primary, keys, host);
    if (projected.poolerWarning !== undefined && output.format === "text") {
      // Established output: `fmt.Fprintln(os.Stderr, utils.Yellow("WARNING:"), err)`.
      // The "WARNING:" prefix is yellow, then a space, then the parse error message.
      yield* output.raw(
        `${styleText("yellow", "WARNING:")} ${projected.poolerWarning}\n`,
        "stderr",
      );
    }
    const envMap = projected.envs;

    if (goFmt === "json") {
      yield* output.raw(encodeGoJson(envMap));
      return;
    }
    if (goFmt === "yaml") {
      yield* output.raw(encodeYaml(envMap));
      return;
    }
    if (goFmt === "toml") {
      yield* output.raw(encodeToml(envMap) + "\n");
      return;
    }
    if (goFmt === "env") {
      yield* output.raw(encodeEnv(envMap) + "\n");
      return;
    }

    if (wantsTsStructured) {
      // No goFmt set but TS structured output requested.
      yield* output.success("", envMap);
      return;
    }

    // Defensive — should be unreachable given the wantsEnvMap branch above.
    void wantsEnvMap;
    yield* output.raw(encodeGoJson(envMap));
  }).pipe(Effect.ensuring(linkedProjectCache.cache(ref)), Effect.ensuring(telemetryState.flush));
});
