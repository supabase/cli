import type { PgLineage, ServiceName } from "../Manifest.ts";

export type Pins = Readonly<Record<"pg" | ServiceName, string>>;

/**
 * Resolve the images to bundle from the CLI's own sources of truth: the
 * Dockerfile template that pins every service image
 * (`apps/cli-go/pkg/config/templates/Dockerfile`, parsed the same way the Go
 * config does) and, for pg15, the frozen lineage constant in `constants.go`.
 */
export const parsePins = (opts: {
  readonly lineage: PgLineage;
  readonly dockerfile: string;
  readonly constantsGo: string;
  readonly postgresImageOverride?: string | undefined;
}): Pins => {
  const fromImage = (alias: string): string => {
    const match = opts.dockerfile.match(new RegExp(`FROM\\s+(\\S+)\\s+AS\\s+${alias}\\b`, "i"));
    if (match?.[1] === undefined) {
      throw new Error(`image alias ${alias} not found in CLI Dockerfile template`);
    }
    return match[1];
  };
  let pg = fromImage("pg");
  if (opts.lineage === "pg15") {
    const match = opts.constantsGo.match(/pg15\s+=\s+"([^"]+)"/);
    if (match?.[1] === undefined) {
      throw new Error("pg15 image not found in CLI constants.go");
    }
    pg = match[1];
  }
  if (opts.postgresImageOverride !== undefined) {
    pg = opts.postgresImageOverride;
  }
  return {
    pg,
    realtime: fromImage("realtime"),
    storage: fromImage("storage"),
    auth: fromImage("gotrue"),
  };
};
