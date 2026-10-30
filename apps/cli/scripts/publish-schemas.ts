/**
 * Publishes the current version of each JSON Schema under `apps/docs/public/schemas` to
 * supabase.com by opening a PR against supabase/supabase, which serves
 * `apps/www/public/schemas` at https://supabase.com/schemas:
 *
 *   bun scripts/publish-schemas.ts --version <version>
 *
 * Lower versions of a schema are frozen: only the highest `v<N>.json` per schema is written. The
 * run refuses when the base branch already serves a higher version, or when the publishing branch
 * changes anything other than the current versions. A relative `--schemas-dir` resolves against the
 * repository root. A release that changes no schema opens or updates nothing.
 */
import { BunFileSystem, BunPath } from "@effect/platform-bun";
import { $ } from "bun";
import { Console, Data, Effect, FileSystem, JsonSchema, Layer, Path, Schema } from "effect";
import process from "node:process";
import { parseArgs } from "node:util";
import { publishPullRequest, shell } from "./publish-pull-request.ts";

const PUBLISHED_PATH = "apps/www/public/schemas";
const VERSION_FILE = /^v([1-9]\d*)\.json$/;

class PublishRefused extends Data.TaggedError("PublishRefused")<{ readonly reason: string }> {}

interface CurrentSchema {
  readonly name: string;
  readonly version: number;
  readonly file: string;
}

const decodeDocument = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
);

const { values } = parseArgs({
  options: {
    version: { type: "string" },
    repo: { type: "string", default: "supabase/supabase" },
    "schemas-dir": { type: "string", default: "apps/docs/public/schemas" },
    branch: { type: "string", default: "cli/schemas" },
    base: { type: "string", default: "master" },
    "dry-run": { type: "boolean", default: false },
  },
});

const versionsIn = (entries: ReadonlyArray<string>) =>
  entries.flatMap((entry) => {
    const match = VERSION_FILE.exec(entry);
    return match?.[1] === undefined ? [] : [Number(match[1])];
  });

const listDirectory = (directory: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    return (yield* fs.exists(directory)) ? (yield* fs.readDirectory(directory)).sort() : [];
  });

const discoverCurrentSchemas = (schemasDir: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const current: Array<CurrentSchema> = [];
    for (const name of yield* listDirectory(schemasDir)) {
      const directory = path.join(schemasDir, name);
      if ((yield* fs.stat(directory)).type !== "Directory") continue;
      const entries = yield* listDirectory(directory);
      if (entries.length === 0) continue;
      const misnamed = entries.find((entry) => !VERSION_FILE.test(entry));
      if (misnamed !== undefined) {
        return yield* new PublishRefused({
          reason: `${name}/${misnamed} does not match v<N>.json.`,
        });
      }
      const version = Math.max(...versionsIn(entries));
      current.push({ name, version, file: path.join(directory, `v${version}.json`) });
    }
    if (current.length === 0) {
      return yield* new PublishRefused({ reason: `no schemas found in ${schemasDir}.` });
    }
    return current;
  });

const validateCurrentSchema = ({ name, version, file }: CurrentSchema) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const label = `${name}/v${version}.json`;
    const document = yield* decodeDocument(yield* fs.readFileString(file)).pipe(
      Effect.mapError(() => new PublishRefused({ reason: `${label} is not a valid JSON object.` })),
    );
    if (document["$schema"] !== JsonSchema.META_SCHEMA_URI_DRAFT_07) {
      return yield* new PublishRefused({
        reason: `${label} must declare "$schema": "${JsonSchema.META_SCHEMA_URI_DRAFT_07}".`,
      });
    }
    const id = `https://supabase.com/schemas/${name}/v${version}.json`;
    if (document["$id"] !== id) {
      return yield* new PublishRefused({ reason: `${label} must declare "$id": "${id}".` });
    }
  });

const writeCurrentSchemas = (
  repo: string,
  base: string,
  branch: string,
  schemas: ReadonlyArray<CurrentSchema>,
  checkoutDir: string,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const published = (name: string) => path.join(checkoutDir, PUBLISHED_PATH, name);
    const prefix = `${PUBLISHED_PATH}/`;

    const listing = yield* shell(() =>
      $`git -C ${checkoutDir} -c core.quotePath=false ls-tree -r --name-only origin/${base} -- ${PUBLISHED_PATH}`.text(),
    );
    const servedPaths = listing
      .split("\n")
      .filter((line) => line.startsWith(prefix))
      .map((line) => line.slice(prefix.length));
    for (const { name, version } of schemas) {
      const served = versionsIn(
        servedPaths
          .filter((file) => file.startsWith(`${name}/`))
          .map((file) => file.slice(name.length + 1)),
      );
      const newest = Math.max(version, ...served);
      if (newest > version) {
        return yield* new PublishRefused({
          reason: `${repo} already serves ${name}/v${newest}.json, so writing ${name}/v${version}.json would modify a frozen version.`,
        });
      }
    }
    for (const { name, version, file } of schemas) {
      yield* fs.makeDirectory(published(name), { recursive: true });
      yield* fs.copyFile(file, path.join(published(name), `v${version}.json`));
    }

    yield* shell(() => $`git -C ${checkoutDir} add -- ${PUBLISHED_PATH}`);
    const changed = yield* shell(() =>
      $`git -C ${checkoutDir} -c core.quotePath=false diff --cached --name-only --no-renames origin/${base} -- ${PUBLISHED_PATH}`.text(),
    );
    const current = new Set(
      schemas.map(({ name, version }) => `${prefix}${name}/v${version}.json`),
    );
    const unexpected = changed
      .split("\n")
      .filter((line) => line !== "" && !current.has(line))
      .map((line) => line.slice(prefix.length))
      .sort();
    if (unexpected.length > 0) {
      return yield* new PublishRefused({
        reason: `${branch} also changes ${unexpected.join(", ")} against ${base}, and only the current schema versions may change. Delete ${branch} in ${repo} and rerun the publish.`,
      });
    }
  });

const main = Effect.gen(function* () {
  const path = yield* Path.Path;

  const versionArgument = values.version;
  if (!versionArgument) {
    yield* Console.error(
      "Usage: bun scripts/publish-schemas.ts --version <version> [--repo <owner/repo>] [--schemas-dir <path>] [--branch <name>] [--base <branch>] [--dry-run]",
    );
    return yield* Effect.sync(() => process.exit(1));
  }
  const version = versionArgument.startsWith("v") ? versionArgument.slice(1) : versionArgument;

  const repo = values.repo!;
  const branch = values.branch!;
  const base = values.base!;
  const schemasDir = path.resolve(import.meta.dir, "../../..", values["schemas-dir"]!);

  const schemas = yield* discoverCurrentSchemas(schemasDir);
  yield* Effect.forEach(schemas, validateCurrentSchema);

  if (values["dry-run"]) {
    const files = schemas.map(({ name, version }) => `${name}/v${version}.json`).join(", ");
    yield* Console.log(`Would publish ${files} to ${repo}:${PUBLISHED_PATH} on branch ${branch}`);
    return;
  }

  yield* publishPullRequest({
    repo,
    base,
    branch,
    stagedPath: PUBLISHED_PATH,
    write: (checkoutDir) => writeCurrentSchemas(repo, base, branch, schemas, checkoutDir),
    commitMessage: `chore: update cli config schemas to v${version}`,
    pullRequestTitle: "chore: update cli config schemas",
    pullRequestBody: [
      "Updates the published JSON Schemas from the supabase/cli release workflow.",
      "",
      "Generated by `scripts/publish-schemas.ts` in supabase/cli from",
      "`apps/docs/public/schemas` — edit the schemas there rather than this folder.",
      "Published versions below the current one are frozen and never rewritten.",
      "",
      "Auto-merge is enabled: the PR squash-merges once a reviewer approves it.",
    ].join("\n"),
    autoMerge: true,
  });
});

await Effect.runPromise(
  main.pipe(
    Effect.catchTag("PublishRefused", ({ reason }) =>
      Console.error(`Refusing to publish: ${reason}`).pipe(
        Effect.andThen(Effect.sync(() => process.exit(1))),
      ),
    ),
    Effect.provide(Layer.mergeAll(BunFileSystem.layer, BunPath.layer)),
    Effect.catch((error) => Effect.die(error.cause ?? error)),
  ),
);
