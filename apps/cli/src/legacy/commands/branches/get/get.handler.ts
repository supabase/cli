import { styleText } from "node:util";

import type {
  V1GetABranchConfigOutput,
  V1GetProjectApiKeysOutput,
  V1GetPoolerConfigOutput,
} from "@supabase/api/effect";
import { Effect, Option } from "effect";

import { LegacyPlatformApi } from "../../../auth/legacy-platform-api.service.ts";
import { LegacyCliConfig } from "../../../config/legacy-cli-config.service.ts";
import { LegacyProjectRefResolver } from "../../../config/legacy-project-ref.service.ts";
import { LegacyLinkedProjectCache } from "../../../telemetry/legacy-linked-project-cache.service.ts";
import { LegacyTelemetryState } from "../../../telemetry/legacy-telemetry-state.service.ts";
import { LegacyOutputFlag } from "../../../../shared/legacy/global-flags.ts";
import { Output } from "../../../../shared/output/output.service.ts";
import { Tty } from "../../../../shared/runtime/tty.service.ts";
import {
  encodeEnv,
  encodeGoJson,
  encodeToml,
  encodeYaml,
} from "../../../shared/legacy-go-output.encoders.ts";
import { mapLegacyHttpError } from "../../../shared/legacy-http-errors.ts";
import {
  LegacyBranchesApiKeysNetworkError,
  LegacyBranchesApiKeysUnexpectedStatusError,
  LegacyBranchesFindNetworkError,
  LegacyBranchesFindUnexpectedStatusError,
  LegacyBranchesGetNetworkError,
  LegacyBranchesGetUnexpectedStatusError,
  LegacyBranchesPoolerNetworkError,
  LegacyBranchesPoolerUnexpectedStatusError,
  LegacyBranchesPrimaryNotFoundError,
} from "../branches.errors.ts";
import { renderBranchGetTable, toStandardEnvs } from "../branches.format.ts";
import { legacyProjectHost } from "../../../shared/legacy-profile.ts";
import { legacyPromptBranchId } from "../branches.prompt.ts";
import {
  LEGACY_BRANCH_PROJECT_REF_PATTERN,
  LEGACY_BRANCH_UUID_PATTERN,
} from "../branches.resolver.ts";
import type { LegacyBranchesGetFlags } from "./get.command.ts";

type BranchDetail = typeof V1GetABranchConfigOutput.Type;
type ApiKeys = typeof V1GetProjectApiKeysOutput.Type;
type Pooler = typeof V1GetPoolerConfigOutput.Type;

const mapFindError = mapLegacyHttpError({
  networkError: LegacyBranchesFindNetworkError,
  statusError: LegacyBranchesFindUnexpectedStatusError,
  networkMessage: (cause) => `failed to find branch: ${cause}`,
  statusMessage: (status, body) => `unexpected find branch status ${status}: ${body}`,
});

const mapGetError = mapLegacyHttpError({
  networkError: LegacyBranchesGetNetworkError,
  statusError: LegacyBranchesGetUnexpectedStatusError,
  networkMessage: (cause) => `failed to get branch: ${cause}`,
  statusMessage: (status, body) => `unexpected get branch status ${status}: ${body}`,
});

const mapApiKeysError = mapLegacyHttpError({
  networkError: LegacyBranchesApiKeysNetworkError,
  statusError: LegacyBranchesApiKeysUnexpectedStatusError,
  networkMessage: (cause) => `failed to get api keys: ${cause}`,
  statusMessage: (status, body) => `unexpected get api keys status ${status}: ${body}`,
});

const mapPoolerError = mapLegacyHttpError({
  networkError: LegacyBranchesPoolerNetworkError,
  statusError: LegacyBranchesPoolerUnexpectedStatusError,
  networkMessage: (cause) => `failed to get pooler: ${cause}`,
  statusMessage: (status, body) => `unexpected get pooler status ${status}: ${body}`,
});

export const legacyBranchesGet = Effect.fn("legacy.branches.get")(function* (
  flags: LegacyBranchesGetFlags,
) {
  const output = yield* Output;
  const goOutputFlag = yield* LegacyOutputFlag;
  const api = yield* LegacyPlatformApi;
  const resolver = yield* LegacyProjectRefResolver;
  const linkedProjectCache = yield* LegacyLinkedProjectCache;
  const telemetryState = yield* LegacyTelemetryState;
  const cliConfig = yield* LegacyCliConfig;
  void (yield* Tty); // ensures Tty is in handler R so legacyPromptBranchId resolves

  const ref = yield* resolver.resolve(flags.projectRef);

  yield* Effect.gen(function* () {
    // Branch-id resolution. Empty input goes through the prompt helper.
    const branchInput = yield* legacyPromptBranchId(flags.name, ref);

    // ------------------------------------------------------------------
    // 1. Lookup: if input is not a UUID and not a ref pattern, fetch the
    //    project ref via V1GetABranch (`GET /v1/projects/{ref}/branches/{name}`).
    // ------------------------------------------------------------------
    let branchIdOrRef = branchInput;
    if (
      !LEGACY_BRANCH_UUID_PATTERN.test(branchInput) &&
      !LEGACY_BRANCH_PROJECT_REF_PATTERN.test(branchInput)
    ) {
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
      return yield* new LegacyBranchesPrimaryNotFoundError({
        message: "primary database not found",
      });
    }

    const projectHost = legacyProjectHost(cliConfig.profile);
    const projected = toStandardEnvs(detail, primary, keys, projectHost);
    if (projected.poolerWarning !== undefined && output.format === "text") {
      // Mirror Go's `fmt.Fprintln(os.Stderr, utils.Yellow("WARNING:"), err)`
      // (`apps/cli-go/internal/branches/get/get.go:94`). The "WARNING:" prefix
      // is yellow, then a space, then the parse error message.
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
