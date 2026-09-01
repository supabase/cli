import { Context } from "effect";

interface TtyShape {
  readonly stdinIsTty: boolean;
  readonly stdoutIsTty: boolean;
  /**
   * fd 1 is a FIFO per fstat — the signal for the Windows piped-dump warning
   * (PowerShell `>`/`|` interpose one). False on fstat errors and for non-FIFO
   * channels such as the socketpairs Node/Bun parents use for "pipe" stdio.
   */
  readonly stdoutIsPipe: boolean;
}

export class Tty extends Context.Service<Tty, TtyShape>()("supabase/runtime/Tty") {}
