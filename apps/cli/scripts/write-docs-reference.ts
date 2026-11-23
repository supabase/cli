import { $ } from "bun";
import { Console, Effect, FileSystem, Path } from "effect";
import { fileURLToPath } from "node:url";
import { shell } from "./publish-pull-request.ts";

interface Destination {
  readonly parent: string;
  readonly target: string;
  readonly info: FileSystem.File.Info | undefined;
}

export const writeDocsReference = Effect.fn("Docs.replaceReference")(function* (
  destinations: { readonly spec: Destination; readonly sidebar: Destination },
  spec: string,
  sidebar: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const prettier = fileURLToPath(new URL("../node_modules/.bin/prettier", import.meta.url));
  const specTemp = yield* fs.makeTempDirectoryScoped({
    directory: destinations.spec.parent,
    prefix: ".cli-reference-",
  });
  const sidebarTemp = yield* fs.makeTempDirectoryScoped({
    directory: destinations.sidebar.parent,
    prefix: ".cli-reference-",
  });
  const preparedSpec = path.join(specTemp, "commands.yaml");
  const preparedSidebar = path.join(sidebarTemp, "sections.json");
  const backup = path.join(specTemp, "original");
  yield* fs.writeFileString(preparedSpec, spec);
  yield* shell(
    () =>
      $`${prettier} --no-config --single-quote --print-width 100 --log-level warn --write ${preparedSpec}`,
  );
  yield* fs.writeFileString(preparedSidebar, `${sidebar}\n`);
  if (destinations.spec.info !== undefined) {
    yield* fs.copyFile(destinations.spec.target, backup);
    yield* fs.chmod(preparedSpec, destinations.spec.info.mode & 0o777);
  }
  if (destinations.sidebar.info !== undefined) {
    yield* fs.chmod(preparedSidebar, destinations.sidebar.info.mode & 0o777);
  }
  yield* Effect.uninterruptible(
    Effect.gen(function* () {
      yield* fs.rename(preparedSpec, destinations.spec.target);
      yield* fs
        .rename(preparedSidebar, destinations.sidebar.target)
        .pipe(
          Effect.onError(() =>
            (destinations.spec.info === undefined
              ? fs.remove(destinations.spec.target)
              : fs.rename(backup, destinations.spec.target)
            ).pipe(
              Effect.catch((error) =>
                Console.error(`Could not restore ${destinations.spec.target}: ${error.message}`),
              ),
            ),
          ),
        );
    }),
  );
}, Effect.scoped);
