// A user image serves plain HTTP on $PORT; the injected launcher wraps the
// image's CMD and provides it.
import { createServer } from "node:http";

const port = Number(process.env.PORT ?? 8080);
createServer((req, res) => {
  res.setHeader("content-type", "application/json");
  res.end(
    JSON.stringify({
      worker: "hello-dockerfile",
      path: new URL(req.url, "http://localhost").pathname,
      greeting: process.env.GREETING ?? null,
    }),
  );
}).listen(port);
