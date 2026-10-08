import type { ServiceEndpoint } from "../../src/services/Recipe.ts";

/** The host to dial for an HTTP-readiness endpoint, which is always TCP in practice. */
export const httpHost = (endpoint: ServiceEndpoint): string =>
  endpoint.kind === "unix" ? endpoint.path : (endpoint.host ?? "127.0.0.1");
