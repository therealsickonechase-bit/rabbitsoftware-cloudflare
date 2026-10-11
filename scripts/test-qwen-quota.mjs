import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "esbuild";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";

test("durable Qwen quota enforces exact hourly/daily caps and survives restart", async () => {
  const directory = await mkdtemp(join(tmpdir(), "rabbit-qwen-quota-"));
  const result = await build({
    stdin: {
      contents: `import { QwenLimits } from "./workers/qwen/src/index.js";
        export { QwenLimits };
        export default { async fetch(request, env) {
          return Response.json(await env.QWEN_LIMITS.getByName("budget").reserve(new URL(request.url).searchParams.get("client")));
        }};`,
      resolveDir: process.cwd(),
    },
    bundle: true, write: false, format: "esm", external: ["cloudflare:workers"],
  });
  const options = {
    name: "qwen-quota-test", modules: true, script: result.outputFiles[0].text, compatibilityDate: "2026-10-11",
    durableObjects: { QWEN_LIMITS: { className: "QwenLimits", useSQLite: true } },
    bindings: { DAILY_LIMIT: "3", PER_CLIENT_PER_HOUR: "2" },
  };
  let runtime;
  const configuration = {
    ...convertV4MiniflareOptions({ workers: [options] }),
    resourcePersistencePath: directory,
  };
  try {
    runtime = new Miniflare(configuration);
    const reserve = async client => (await runtime.dispatchFetch(`http://test/?client=${client}`)).json();
    assert.equal((await reserve("a")).ok, true);
    assert.equal((await reserve("a")).ok, true);
    assert.match((await reserve("a")).error, /hourly/);
    assert.equal((await reserve("b")).ok, true);
    assert.match((await reserve("c")).error, /daily/);
    await runtime.dispose();
    runtime = new Miniflare(configuration);
    assert.match((await reserve("fresh")).error, /daily/);
  } finally {
    await runtime?.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});
