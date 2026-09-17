import type { BackendEndpoint } from "../gateway/Gateway.ts";

/** A concrete private endpoint published for one workload binding. */
export interface RuntimeBindingPublication {
  readonly workloadId: string;
  readonly recipeId: string;
  readonly binding: string;
  readonly endpoint: BackendEndpoint;
}
