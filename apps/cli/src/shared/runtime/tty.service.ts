import { Context } from "effect";

interface TtyShape {
  readonly stdinIsTty: boolean;
  readonly stdoutIsTty: boolean;
  /** stdout is a pipe (a reader interposes, e.g. PowerShell `>`/`|`). */
  readonly stdoutIsPipe: boolean;
}

export class Tty extends Context.Service<Tty, TtyShape>()("supabase/runtime/Tty") {}
