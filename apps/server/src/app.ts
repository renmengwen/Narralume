import Fastify from "fastify";

export function buildApp() {
  const app = Fastify({ logger: true });

  app.get("/api/health", async () => ({
    ok: true,
    service: "narralume",
  }));

  return app;
}
