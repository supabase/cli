import { Effect } from "effect";
import { remotesList } from "../../../../shared/remotes/remotes-crud.ts";
import { ProjectHome } from "../../../config/project-home.service.ts";

export const list = Effect.fn("remotes.list")(function* () {
  const projectHome = yield* ProjectHome;
  yield* remotesList(projectHome.projectRoot);
});
