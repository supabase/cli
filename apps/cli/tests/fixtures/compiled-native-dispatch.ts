import { runNativeProcessIfDispatched } from "@supabase/stack/internal/supervisor";

if (!(await runNativeProcessIfDispatched(process.argv.slice(2)))) {
  throw new Error("native dispatch probe was not invoked");
}
