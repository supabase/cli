import { Effect, Exit, Option } from "effect";
import { Credentials } from "../../auth/credentials.service.ts";
import { CliSettings } from "../../config/cli-settings.service.ts";
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
  const commandRuntime = yield* CommandRuntime;

  const linkedStateExit = yield* projectLinkState.load.pipe(Effect.exit);
  const linkedState = Exit.isSuccess(linkedStateExit) ? linkedStateExit.value : Option.none();
  const accessToken = yield* credentials.getAccessToken;
  const localServiceVersions = yield* cliProjectLocalServiceVersions.load;
  const localImageOptions = {
    serviceVersions: Option.isSome(localServiceVersions) ? localServiceVersions.value.versions : {},
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
