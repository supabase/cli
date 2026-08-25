import {
  fillServiceVersionManifest,
  planStackVersions,
  resolveStackSummary,
} from "@supabase/stack/effect";
import { Effect, Exit, Option } from "effect";
import { Credentials } from "../../auth/credentials.service.ts";
import { CliSettings } from "../../config/cli-settings.service.ts";
import { CliProjectHome } from "../../config/cli-project-home.service.ts";
import { CliProjectLocalServiceVersions } from "../../config/cli-project-local-service-versions.service.ts";
import { ProjectLinkState } from "../../config/project-link-state.service.ts";
import { Output } from "../../../shared/output/output.service.ts";
import {
  CommandRuntime,
  getCommandRuntimeCommand,
} from "../../../shared/runtime/command-runtime.service.ts";
import {
  fetchLinkedServiceVersions,
  formatServicesWarning,
  listLocalServiceVersions,
  mergeRemoteServiceVersions,
  renderServicesTable,
  renderServicesWarning,
} from "../../../shared/services/services.shared.ts";

export const services = Effect.fnUntraced(function* () {
  const output = yield* Output;
  const cliSettings = yield* CliSettings;
  const credentials = yield* Credentials;
  const cliProjectLocalServiceVersions = yield* CliProjectLocalServiceVersions;
  const projectLinkState = yield* ProjectLinkState;
  const cliProjectHome = yield* CliProjectHome;
  const commandRuntime = yield* CommandRuntime;

  const linkedStateExit = yield* projectLinkState.load.pipe(Effect.exit);
  const linkedState = Exit.isSuccess(linkedStateExit) ? linkedStateExit.value : Option.none();
  const accessToken = yield* credentials.getAccessToken;
  const localServiceVersions = yield* cliProjectLocalServiceVersions.load;
  const existingSummary = yield* resolveStackSummary({
    cacheRoot: cliSettings.supabaseHome,
    projectDir: cliProjectHome.projectRoot,
    name: "default",
  }).pipe(
    Effect.map(Option.some),
    Effect.catchTag("NoRunningStackError", () => Effect.succeed(Option.none())),
  );
  const serviceVersionContext = planStackVersions({
    ...(Option.isSome(linkedState) ? { candidateBaseline: linkedState.value.versions } : {}),
    ...(Option.isSome(existingSummary)
      ? { pinnedBaseline: fillServiceVersionManifest(existingSummary.value.versions) }
      : {}),
    ...(Option.isSome(localServiceVersions)
      ? { localOverrides: localServiceVersions.value.versions }
      : {}),
  });
  const localImageOptions = {
    serviceVersions: serviceVersionContext.runtimeVersions,
  };

  let rows = listLocalServiceVersions(localImageOptions);
  if (Option.isSome(linkedState) && Option.isSome(accessToken)) {
    const remote = yield* fetchLinkedServiceVersions({
      apiUrl: cliSettings.apiUrl,
      projectHost: cliSettings.projectHost,
      projectRef: linkedState.value.project.ref,
      accessToken: accessToken.value,
      userAgent: "@supabase/cli",
      headers: {
        "X-Supabase-Command": getCommandRuntimeCommand(commandRuntime),
        "X-Supabase-Command-Run-ID": commandRuntime.commandRunId,
      },
    });
    rows = mergeRemoteServiceVersions(remote, localImageOptions);
  }

  const warning = renderServicesWarning(rows);
  if (warning !== undefined) {
    yield* output.raw(formatServicesWarning(warning, output.format === "text"), "stderr");
  }

  if (output.format === "text") {
    yield* output.raw(renderServicesTable(rows));
    return;
  }

  yield* output.success("", { services: rows });
});
