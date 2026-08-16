import { Effect } from "effect";
import { remotesAdd } from "../../../../shared/remotes/remotes-crud.ts";
import { ProjectHome } from "../../../config/project-home.service.ts";
import type { RemotesAddFlags } from "./add.command.ts";

export const add = Effect.fn("remotes.add")(function* (flags: RemotesAddFlags) {
  const projectHome = yield* ProjectHome;
  yield* remotesAdd(projectHome.projectRoot, flags.name, flags.projectRef);
});
