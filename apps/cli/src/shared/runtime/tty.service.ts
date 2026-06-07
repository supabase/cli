import { Context } from "effect";

interface TtyShape {
  readonly stdinIsTty: boolean;
  readonly stdoutIsTty: boolean;
}

export class Tty extends Context.Service<Tty, TtyShape>()("supabase/runtime/Tty") {}
