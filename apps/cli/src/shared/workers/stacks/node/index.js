// Starter for the "node" runtime — edit before deploying.
// Export a default object with a Web-standard `fetch` handler; the runtime
// binds the port and serves it.
export default {
  fetch() {
    return new Response("hello from supabase workers\n");
  },
};
