import { serve } from "bun";
import { findRoute, proxyRequest } from "./proxy.ts";

serve({
  port: 8888,
  async fetch(req) {
    const t0 = performance.now();
    const url = new URL(req.url);
    const method = req.method;

    try {
      const route = findRoute(url.pathname);

      if (!route) {
        console.log(`[404] ${method} ${url.pathname}`);
        return new Response("Not Found", { status: 404 });
      }

      console.log(`[→] ${method} ${url.pathname}  → ${route.target}`);

      const res = await proxyRequest(req, route);
      const elapsed = (performance.now() - t0).toFixed(0);
      const isSSE = res.headers.get("content-type")?.includes("text/event-stream");
      console.log(`[←] ${res.status} ${isSSE ? "SSE" : "JSON"}  ${elapsed} ms`);

      return res;
    } catch (err) {
      const elapsed = (performance.now() - t0).toFixed(0);
      console.error(`[✗] ${method} ${url.pathname}  ${elapsed} ms`, err);
      return Response.json(
        { error: { message: String(err), type: "proxy_error" } },
        { status: 502 }
      );
    }
  },
});

console.log("Bun proxy running on port 8888");
