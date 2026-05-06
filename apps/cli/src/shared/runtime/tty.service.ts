import { ServiceMap } from "effect";

interface TtyShape {
  readonly stdinIsTty: boolean;
  readonly stdoutIsTty: boolean;
}

export class Tty extends ServiceMap.Service<Tty, TtyShape>()("supabase/runtime/Tty") {}
