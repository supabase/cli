Deno.serve(async () => {
  const text = await Deno.readTextFile(new URL("./static/note.txt", import.meta.url));
  return Response.json({
    case: "deploy-e2e-static-in-fn",
    ok: true,
    static: text.trim(),
  });
});
