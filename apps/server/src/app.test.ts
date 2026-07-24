import assert from "node:assert/strict";
import test from "node:test";

import { buildApp } from "./app.js";

test("健康检查返回服务状态", async () => {
  const app = buildApp();
  const response = await app.inject({ method: "GET", url: "/api/health" });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), { ok: true, service: "narralume" });

  await app.close();
});
