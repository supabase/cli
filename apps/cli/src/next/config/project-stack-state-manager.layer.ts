import { Effect, Layer } from "effect";
import { StateManager, projectStateManagerPathsFromRoot } from "@supabase/stack/effect";
import { ProjectHome } from "./project-home.service.ts";

export const projectStackStateManagerLayer = Layer.unwrap(
  Effect.gen(function* () {
    const projectHome = yield* ProjectHome;
    return StateManager.make(projectStateManagerPathsFromRoot(projectHome.projectHomeDir));
  }),
);
