// Monorepo-internal source bridge: Functions bootstrap dependencies are
// stack-owned and intentionally private from the @supabase/stack export map.
export {
  dirname,
  FUNCTIONS_CONTAINER_ROOT,
  join,
  STATUS_CODE,
  STATUS_TEXT,
  toFileUrl,
} from "../../../../../packages/stack/src/functions/serve-main-deps.ts";
