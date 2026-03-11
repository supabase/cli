import { ServiceMap } from "effect";

interface RuntimeInfoShape {
  readonly cwd: string;
  readonly platform: NodeJS.Platform;
  readonly arch: NodeJS.Architecture;
  readonly homeDir: string;
  readonly execPath: string;
  readonly pid: number;
}

export class RuntimeInfo extends ServiceMap.Service<RuntimeInfo, RuntimeInfoShape>()(
  "@supabase/cli/runtime/RuntimeInfo",
) {}
