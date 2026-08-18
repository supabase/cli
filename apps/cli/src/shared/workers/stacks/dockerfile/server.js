// Starter for the "dockerfile" runtime — edit before deploying.
// The Dockerfile's CMD runs this file; it binds the port itself, unlike the
// catalog runtimes where the base image does the binding.
import { createServer } from "node:http";

const port = Number(process.env.PORT ?? 8080);

createServer((_request, response) => {
  response.writeHead(200, { "content-type": "text/plain" });
  response.end("hello from supabase workers\n");
}).listen(port, () => {
  console.log(`listening on ${port}`);
});
