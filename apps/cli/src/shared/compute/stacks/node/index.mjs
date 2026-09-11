export default {
  fetch(request) {
    const { pathname } = new URL(request.url);
    return Response.json({
      compute: "hello-node",
      path: pathname,
      greeting: process.env.GREETING ?? null,
    });
  },
};
