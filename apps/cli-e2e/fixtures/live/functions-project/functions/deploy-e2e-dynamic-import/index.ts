Deno.serve(async () => {
  const { value } = await import("./lazy.ts");
  return Response.json({ case: "deploy-e2e-dynamic-import", ok: true, value });
});
