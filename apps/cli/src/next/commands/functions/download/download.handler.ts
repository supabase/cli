import { Effect } from "effect";
import { PlatformApi } from "../../../auth/platform-api.service.ts";
import { ProjectHome } from "../../../config/project-home.service.ts";
import {
  downloadFunctions,
  makeGoProxyDownloadArgs,
} from "../../../../shared/functions/download.ts";
import { LegacyGoProxy } from "../../../../shared/legacy/go-proxy.service.ts";
import { resolveProjectRef } from "../functions.shared.ts";
import type { FunctionsDownloadFlags } from "./download.command.ts";

export const functionsDownload = Effect.fnUntraced(function* (flags: FunctionsDownloadFlags) {
  const api = yield* PlatformApi;
  const projectHome = yield* ProjectHome;
  const proxy = yield* LegacyGoProxy;

  yield* downloadFunctions(flags, {
    api,
    projectRoot: projectHome.projectRoot,
    resolveProjectRef,
    proxyDownload: (proxyFlags, projectRef) =>
      proxy.exec(makeGoProxyDownloadArgs(proxyFlags, projectRef), { cwd: projectHome.projectRoot }),
  });
});
