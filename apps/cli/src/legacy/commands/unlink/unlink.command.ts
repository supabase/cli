import { Command } from "effect/unstable/cli";
import { legacyUnlink } from "./unlink.handler.ts";

export const legacyUnlinkCommand = Command.make("unlink").pipe(
  Command.withDescription("Unlink a Supabase project."),
  Command.withShortDescription("Unlink a Supabase project"),
  Command.withHandler(() => legacyUnlink()),
);
