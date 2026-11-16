import { resolveExperimentalCommandFamily } from "../../../shared/config/experimental-feature.ts";

export const resolveComputeEnabled = (input: {
  readonly args: ReadonlyArray<string>;
  readonly cwd: string;
}) => resolveExperimentalCommandFamily({ ...input, feature: "compute" });
