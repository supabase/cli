import { Effect } from "effect";
import { LegacyGoProxy } from "../../../shared/legacy/go-proxy.service.ts";
import type { LegacyInitFlags } from "./init.command.ts";

export const legacyInit = Effect.fn("legacy.init")(function* (flags: LegacyInitFlags) {
  const proxy = yield* LegacyGoProxy;
  const args: string[] = ["init"];
  if (flags.interactive) args.push("--interactive");
  if (flags.useOrioledb) args.push("--use-orioledb");
  if (flags.force) args.push("--force");
  if (flags.withVscodeWorkspace) args.push("--with-vscode-workspace");
  if (flags.withVscodeSettings) args.push("--with-vscode-settings");
  if (flags.withIntellijSettings) args.push("--with-intellij-settings");
  yield* proxy.exec(args);
});
