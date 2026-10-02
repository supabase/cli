export default {
  fetch(request: Request): Response {
    const { pathname } = new URL(request.url);
    return Response.json({
      compute: "hello-deno",
      path: pathname,
      greeting: Deno.env.get("GREETING") ?? null,
    });
  },
};
