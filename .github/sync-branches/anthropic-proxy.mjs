// Forwards the sync agent's Anthropic API requests and adds the real key, so the agent's container never holds it.
import { createServer } from "node:http";

const key = process.env.ANTHROPIC_API_KEY;
const upstream = "https://api.anthropic.com";
const dropped = new Set(["host", "content-length", "connection", "authorization", "x-api-key"]);
const unforwarded = new Set([
  "content-encoding",
  "content-length",
  "transfer-encoding",
  "connection",
]);

createServer(async (request, response) => {
  if (!request.url?.startsWith("/v1/")) {
    response.writeHead(404).end();
    return;
  }
  try {
    const chunks = [];
    for await (const chunk of request) {
      chunks.push(chunk);
    }
    const headers = Object.fromEntries(
      Object.entries(request.headers).filter(([name]) => !dropped.has(name)),
    );
    const reply = await fetch(`${upstream}${request.url}`, {
      method: request.method,
      headers: { ...headers, "x-api-key": key },
      body:
        request.method === "GET" || request.method === "HEAD" ? undefined : Buffer.concat(chunks),
    });
    response.writeHead(
      reply.status,
      Object.fromEntries([...reply.headers].filter(([name]) => !unforwarded.has(name))),
    );
    if (reply.body) {
      for await (const chunk of reply.body) {
        response.write(chunk);
      }
    }
    response.end();
  } catch (error) {
    response.writeHead(502).end(String(error));
  }
}).listen(8080, () => console.log("proxy listening"));
