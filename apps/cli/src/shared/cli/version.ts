// The build scripts replace this symbol with the immutable package version in
// released binaries. It intentionally is not read from the runtime
// environment: source execution must remain an unambiguous development build.
declare const SUPABASE_CLI_VERSION: string | undefined;

export const CLI_VERSION =
  typeof SUPABASE_CLI_VERSION === "string" ? SUPABASE_CLI_VERSION : "0.0.0-dev";

/**
 * Where a user goes to get a newer CLI. There is no self-update command, so
 * anything telling a user to upgrade has to send them here rather than name an
 * invocation.
 */
export const CLI_UPGRADE_GUIDE_URL =
  "https://supabase.com/docs/guides/cli/getting-started#updating-the-supabase-cli";

export interface ParsedSemver {
  readonly nums: readonly [string, string, string];
  readonly prerelease: string;
}

/**
 * Parses a bare semver string (no leading `v`); minor and patch may be omitted and build
 * metadata is ignored. Returns `undefined` for anything the semver grammar rejects.
 */
export function parseSemver(version: string): ParsedSemver | undefined {
  const match =
    /^(0|[1-9]\d*)(?:\.(0|[1-9]\d*))?(?:\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?)?(?![\s\S])/.exec(
      version,
    );
  if (match === null) return undefined;
  const prerelease = match[4] ?? "";
  if (
    prerelease
      .split(".")
      .some(
        (identifier) => /^\d+$/.test(identifier) && identifier.length > 1 && identifier[0] === "0",
      )
  ) {
    return undefined;
  }
  return {
    nums: [match[1]!, match[2] ?? "0", match[3] ?? "0"],
    prerelease,
  };
}

/**
 * Which kind of build a CLI version string identifies. `beta` is the `develop` release train,
 * `preview` is a pull-request package, and `development` covers source runs, local builds, and
 * any prerelease identifier the release pipeline does not produce.
 */
export type CliBuildChannel = "stable" | "beta" | "preview" | "development";

export function cliBuildChannel(version: string): CliBuildChannel {
  const parsed = parseSemver(version);
  if (parsed === undefined) return "development";
  if (parsed.prerelease === "") return "stable";
  const identifier = parsed.prerelease.split(".")[0];
  if (identifier === "beta") return "beta";
  if (identifier === "pr") return "preview";
  return "development";
}
