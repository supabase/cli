Deno.serve(async () => {
  const svg = await Deno.readTextFile(new URL("../assets/badge.svg", import.meta.url));
  return Response.json({
    case: "deploy-e2e-static-asset",
    ok: true,
    static: svg.includes("outside-static") || svg.includes("<svg"),
  });
});
