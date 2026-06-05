import { Context } from "effect";

interface RuntimeInfoShape {
  readonly cwd: string;
  readonly platform: NodeJS.Platform;
  readonly arch: NodeJS.Architecture;
  readonly homeDir: string;
  readonly execPath: string;
  readonly pid: number;
}

export class RuntimeInfo extends Context.Service<RuntimeInfo, RuntimeInfoShape>()(
  "supabase/runtime/RuntimeInfo",
) {}
