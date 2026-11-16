import { resolveExperimentalCommandFamily } from "../../../shared/config/experimental-feature.ts";

export const resolveWarehouseEnabled = (input: {
  readonly args: ReadonlyArray<string>;
  readonly cwd: string;
}) => resolveExperimentalCommandFamily({ ...input, feature: "warehouse" });
