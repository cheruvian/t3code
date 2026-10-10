import * as NodeURL from "node:url";
import sirv from "sirv";
import type { Plugin } from "vite-plus";

/** Serve the independently exported native web client alongside the Vite app. */
export function nativeWebEndpoint(): Plugin {
  const root = NodeURL.fileURLToPath(new URL("../../mobile/.web-experiment", import.meta.url));
  return {
    name: "native-web-endpoint",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        if (request.url?.split("?")[0] !== "/native") return next();
        response.writeHead(307, { Location: "/native/" });
        response.end();
      });
      server.middlewares.use("/native", (_request, response, next) => {
        // Expo SQLite's web worker requires a cross-origin-isolated document.
        response.setHeader("Cross-Origin-Opener-Policy", "same-origin");
        response.setHeader("Cross-Origin-Embedder-Policy", "credentialless");
        next();
      });
      server.middlewares.use("/native", sirv(root, { dev: true, single: true }));
    },
  };
}
