import { Effect } from "effect";
import { remotesRemove } from "../../../../shared/remotes/remotes-crud.ts";
import { ProjectHome } from "../../../config/project-home.service.ts";
import type { RemotesRemoveFlags } from "./remove.command.ts";

export const remove = Effect.fn("remotes.remove")(function* (flags: RemotesRemoveFlags) {
  const projectHome = yield* ProjectHome;
  yield* remotesRemove(projectHome.projectRoot, flags.name);
});
