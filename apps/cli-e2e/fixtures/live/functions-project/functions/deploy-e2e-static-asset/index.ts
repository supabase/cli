// static_files bundles supabase/assets/*.svg (outside functions/) plus the function-local
// assets/ copy used at runtime (same pattern as deploy-e2e-static-in-fn).
Deno.serve(async () => {
  const svg = await Deno.readTextFile(new URL("./assets/badge.svg", import.meta.url));
  return Response.json({
    case: "deploy-e2e-static-asset",
    ok: true,
    static: svg.includes("outside-static") || svg.includes("<svg"),
  });
});
