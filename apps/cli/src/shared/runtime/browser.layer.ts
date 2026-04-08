import { Config, Effect, FileSystem, Layer } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { RuntimeInfo } from "./runtime-info.service.ts";
import { Browser } from "./browser.service.ts";

const makeBrowser = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const runtimeInfo = yield* RuntimeInfo;

  return Browser.of({
    open: (url: string) =>
      Effect.gen(function* () {
        let command: string;
        let args: string[];

        if (runtimeInfo.platform === "darwin") {
          command = "open";
          args = [url];
        } else if (runtimeInfo.platform === "win32") {
          const systemRoot = yield* Config.string("SYSTEMROOT").pipe(
            Config.withDefault("C:\\Windows"),
          );
          command = `${systemRoot}\\System32\\rundll32.exe`;
          args = ["url.dll,FileProtocolHandler", url];
        } else {
          let isWsl = false;
          const osReleaseExists = yield* fs.exists("/proc/sys/kernel/osrelease");
          if (osReleaseExists) {
            const osrelease = yield* fs.readFileString("/proc/sys/kernel/osrelease");
            isWsl = osrelease.toLowerCase().includes("microsoft");
          }
          command = isWsl ? "wslview" : "xdg-open";
          args = [url];
        }

        const cmd = ChildProcess.make(command, args, {
          detached: true,
          stdin: "ignore",
          stdout: "ignore",
          stderr: "ignore",
        });
        yield* spawner.exitCode(cmd);
      }).pipe(Effect.ignore),
  });
});

export const browserLayer = Layer.effect(Browser, makeBrowser);
