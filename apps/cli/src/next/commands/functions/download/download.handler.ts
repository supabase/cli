import { Effect, Stdio } from "effect";
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
  const stdio = yield* Stdio.Stdio;
  const rawArgs = yield* stdio.args;

  yield* downloadFunctions(flags, {
    api,
    projectRoot: projectHome.projectRoot,
    rawArgs,
    resolveProjectRef,
    // In machine-output mode the child's stdout is captured and discarded
    // instead of inherited (CLI-1546: stdout is payload-only in machine
    // mode) — `downloadFunctions` emits the `Output` envelope itself.
    proxyDownload: (proxyFlags, projectRef, captureOutput) => {
      const args = makeGoProxyDownloadArgs(proxyFlags, projectRef);
      const cwd = projectHome.projectRoot;
      return captureOutput
        ? Effect.asVoid(proxy.execCapture(args, { cwd, stdin: "ignore" }))
        : proxy.exec(args, { cwd });
    },
  });
});
