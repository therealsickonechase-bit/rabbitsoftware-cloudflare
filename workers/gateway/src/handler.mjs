import { DurableObject } from "cloudflare:workers";
import handler, { cleanRequest } from "./index.js";
import { reserveQuota } from "./quota.mjs";

export class Limits extends DurableObject {
  async fetch(request) {
    const verdict = await reserveQuota(this.ctx.storage, await request.json());
    return Response.json(verdict, { headers: { "Cache-Control": "no-store" } });
  }
}

export { cleanRequest };
export default handler;
