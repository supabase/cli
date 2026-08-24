import { Context } from "effect";

export interface RuntimeInfoShape {
  readonly cwd: string;
  readonly platform: NodeJS.Platform;
  readonly arch: NodeJS.Architecture;
  readonly homeDir: string;
  readonly execPath: string;
  readonly pid: number;
  /** The host OS account name, when the platform exposes it. */
  readonly osUser?: string;
}

export class RuntimeInfo extends Context.Service<RuntimeInfo, RuntimeInfoShape>()(
  "supabase/runtime/RuntimeInfo",
) {}
