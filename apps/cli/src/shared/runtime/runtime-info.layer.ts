import { homedir } from "node:os";
import process from "node:process";
import { Layer } from "effect";

import { RuntimeInfo } from "./runtime-info.service.ts";

export const runtimeInfoLayer = Layer.sync(RuntimeInfo, () =>
  RuntimeInfo.of({
    cwd: process.cwd(),
    platform: process.platform,
    arch: process.arch,
    homeDir: homedir(),
    execPath: process.execPath,
    pid: process.pid,
  }),
);
