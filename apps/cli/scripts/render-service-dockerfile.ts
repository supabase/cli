// Rewrites the slim-capable `FROM ... AS <alias>` lines of
// apps/cli/src/shared/services/Dockerfile (and its byte-identical Go copy,
// apps/cli-go/pkg/config/templates/Dockerfile) in place, from the stack catalog
// (packages/stack/src/Artifacts.ts): each such line's tag comes from that service's catalog pin
// `upstreamImage`. Every other line — comments, kong, the Postgres 14 pin (no slim build), and
// the one-shot job images — is hand- or Dependabot-managed and left byte-for-byte untouched.
//
//   bun apps/cli/scripts/render-service-dockerfile.ts          # writes both files
//   bun apps/cli/scripts/render-service-dockerfile.ts --check  # fails on drift, writes nothing
//
// The `--check` mode is what CI runs (as a `render-service-dockerfile.unit.test.ts` assertion) to
// catch a hand-edited generated line, or a catalog change that hasn't been regenerated yet.
import { fileURLToPath } from "node:url";
import {
  catalogPins,
  isOrioledbVersion,
  type ArtifactPin,
} from "@supabase/stack/internal/artifacts";

// Resolved from this module's own URL, so both the CLI invocation (cwd = repo root) and the
// vitest unit test (cwd = apps/cli) read the same files.
export const TS_DOCKERFILE_PATH = fileURLToPath(
  new URL("../src/shared/services/Dockerfile", import.meta.url),
);
export const GO_DOCKERFILE_PATH = fileURLToPath(
  new URL("../../cli-go/pkg/config/templates/Dockerfile", import.meta.url),
);

type CatalogEntry = ReturnType<typeof catalogPins>[number];

/**
 * Dockerfile repository overrides, for the one documented exception to the repository rule
 * below. Keep this list to that exception; add a reason alongside any addition.
 */
const REPOSITORY_OVERRIDES: Readonly<Record<string, string>> = {
  // slim-services mirrors ghcr.io/imgproxy/imgproxy (its `upstreamImage`), but the Dockerfile —
  // and `mirror-template-images.yml` and the docker.io registry rewrite — keep darthsim/imgproxy,
  // which carries the same tags on Docker Hub.
  imgproxy: "darthsim/imgproxy",
};

interface SlimAliasSpec {
  readonly sourceService: string;
  /**
   * Selects the catalog's default pin (every alias but `pg15`) or its lone additional stock pin;
   * OrioleDB pins have no Dockerfile alias.
   */
  readonly wantDefault: boolean;
}

/** Every slim-capable Dockerfile alias, mapped to the catalog pin it tracks. */
const SLIM_ALIAS_SPECS: ReadonlyMap<string, SlimAliasSpec> = new Map([
  ["pg", { sourceService: "postgres", wantDefault: true }],
  ["pg15", { sourceService: "postgres", wantDefault: false }],
  ["mailpit", { sourceService: "mailpit", wantDefault: true }],
  ["postgrest", { sourceService: "postgrest", wantDefault: true }],
  ["pgmeta", { sourceService: "pgmeta", wantDefault: true }],
  ["studio", { sourceService: "studio", wantDefault: true }],
  ["imgproxy", { sourceService: "imgproxy", wantDefault: true }],
  ["edgeruntime", { sourceService: "edge-runtime", wantDefault: true }],
  ["vector", { sourceService: "vector", wantDefault: true }],
  ["supavisor", { sourceService: "pooler", wantDefault: true }],
  ["gotrue", { sourceService: "auth", wantDefault: true }],
  ["realtime", { sourceService: "realtime", wantDefault: true }],
  ["storage", { sourceService: "storage", wantDefault: true }],
  ["logflare", { sourceService: "analytics", wantDefault: true }],
]);

function selectPin(
  alias: string,
  spec: SlimAliasSpec,
  pins: ReadonlyArray<CatalogEntry>,
): ArtifactPin {
  const candidates = pins.filter(
    (entry) =>
      entry.sourceService === spec.sourceService &&
      entry.isDefault === spec.wantDefault &&
      !isOrioledbVersion(entry.pin.upstreamVersion),
  );
  if (candidates.length !== 1) {
    throw new Error(
      `expected exactly one ${spec.wantDefault ? "default" : "additional"} catalog pin for ` +
        `'${spec.sourceService}' (alias '${alias}'), found ${candidates.length}`,
    );
  }
  return candidates[0]!.pin;
}

function tagOf(upstreamImage: string): string {
  const sep = upstreamImage.lastIndexOf(":");
  if (sep === -1) throw new Error(`upstreamImage has no tag: ${upstreamImage}`);
  return upstreamImage.slice(sep + 1);
}

function repositoryOf(upstreamImage: string): string {
  const sep = upstreamImage.lastIndexOf(":");
  if (sep === -1) throw new Error(`upstreamImage has no tag: ${upstreamImage}`);
  return upstreamImage.slice(0, sep);
}

/** Matches a `FROM <repository>:<tag> AS <alias>` line, keeping every other byte for reuse. */
const FROM_LINE = /^(FROM\s+)(.+):([^:\s]+)(\s+AS\s+)([^\s#]+)(.*)$/i;

/**
 * Rewrites only the slim-capable `FROM ... AS <alias>` lines of `currentDockerfile`, in place:
 * the repository is read from the existing line (and asserted to still match the catalog pin's
 * `upstreamImage` repository, except for `REPOSITORY_OVERRIDES`); only the tag is replaced, from
 * that pin's `upstreamImage`. Every other line — comments, kong, `pg14`, the job images — passes
 * through untouched. A slim-capable alias missing from the file is an error; the generator never
 * inserts a line.
 */
export function renderDockerfile(currentDockerfile: string): string {
  const pins = catalogPins();
  const seen = new Set<string>();

  const lines = currentDockerfile.split("\n").map((line) => {
    const match = FROM_LINE.exec(line);
    if (match === null) return line;
    const [, fromKeyword, repository, , asKeyword, alias, rest] = match as unknown as [
      string,
      string,
      string,
      string,
      string,
      string,
      string,
    ];
    const spec = SLIM_ALIAS_SPECS.get(alias);
    if (spec === undefined) return line;
    seen.add(alias);

    const pin = selectPin(alias, spec, pins);
    const pinRepository = repositoryOf(pin.upstreamImage);
    const override = REPOSITORY_OVERRIDES[alias];
    if (override === undefined) {
      if (repository !== pinRepository) {
        throw new Error(
          `${alias}'s Dockerfile repository '${repository}' no longer matches the catalog's ` +
            `'${pinRepository}'. If this is intentional, add '${alias}' to REPOSITORY_OVERRIDES with a reason.`,
        );
      }
    } else if (repository !== override) {
      throw new Error(
        `${alias}'s Dockerfile repository '${repository}' no longer matches its ` +
          `REPOSITORY_OVERRIDES entry '${override}'. Update the override if this is intentional.`,
      );
    }

    return `${fromKeyword}${repository}:${tagOf(pin.upstreamImage)}${asKeyword}${alias}${rest}`;
  });

  for (const alias of SLIM_ALIAS_SPECS.keys()) {
    if (!seen.has(alias)) {
      throw new Error(
        `no Dockerfile line for slim-capable alias '${alias}'; the generator never inserts one`,
      );
    }
  }

  return lines.join("\n");
}

async function main(argv: ReadonlyArray<string>): Promise<void> {
  const check = argv.includes("--check");
  const current = await Bun.file(TS_DOCKERFILE_PATH).text();
  const rendered = renderDockerfile(current);

  if (check) {
    const go = await Bun.file(GO_DOCKERFILE_PATH).text();
    let failed = false;
    if (current !== rendered) {
      console.log(
        `::error ::${TS_DOCKERFILE_PATH} has drifted from packages/stack/src/Artifacts.ts. Run ` +
          "`bun apps/cli/scripts/render-service-dockerfile.ts` and commit the result.",
      );
      failed = true;
    }
    if (go !== rendered) {
      console.log(
        `::error ::${GO_DOCKERFILE_PATH} is not a byte copy of ${TS_DOCKERFILE_PATH}. Run ` +
          "`bun apps/cli/scripts/render-service-dockerfile.ts` and commit the result.",
      );
      failed = true;
    }
    if (failed) {
      process.exit(1);
    }
    console.log("Both Dockerfiles match the catalog.");
    return;
  }

  await Bun.write(TS_DOCKERFILE_PATH, rendered);
  await Bun.write(GO_DOCKERFILE_PATH, rendered);
  console.log(`Regenerated ${TS_DOCKERFILE_PATH} and ${GO_DOCKERFILE_PATH} from the catalog.`);
}

if (import.meta.main) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    console.log(`::error ::${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
