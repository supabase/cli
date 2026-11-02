import { Data } from "effect";

import {
  actionability,
  type CliErrorActionabilityDeclaration,
  ErrorActionabilityId,
} from "../shared/telemetry/error-actionability.ts";
import type { PgConnInput } from "./db-connection.service.ts";

export class HostPostgresClientError extends Data.TaggedError("HostPostgresClientError")<{
  readonly message: string;
  readonly suggestion?: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.provideFlags;
  }
}

/** Empty `--network-id` and Docker's `host` network both put the tool in the host netns. */
export const toolContainerUsesHostNetwork = (networkId: string | undefined): boolean =>
  networkId === undefined || networkId.length === 0 || networkId === "host";

/** Native-engine dumps talk to loopback; container tools may need Docker Desktop's host alias. */
export const rewriteDumpHostForToolContainer = (
  host: string,
  opts: { readonly platform: string; readonly usesHostNetwork: boolean },
): string => {
  if (host !== "127.0.0.1" && host !== "localhost") return host;
  if (opts.platform !== "linux" || !opts.usesHostNetwork) return "host.docker.internal";
  return host;
};

export const dumpConnForHostClient = (conn: PgConnInput): PgConnInput => ({
  ...conn,
  host: "127.0.0.1",
});
