import { type ProjectConfigMappingRow } from "./registry-row.ts";
/**
 * The full API↔`CliConfig` mapping table: this file's non-auth rows plus
 * `./registry-auth.ts`'s auth rows. `fromApiProjectConfig`/
 * `unmappedApiFields` (`./project-config.ts`) are the only consumers.
 */
export declare const projectConfigMappingRows: ReadonlyArray<ProjectConfigMappingRow>;
