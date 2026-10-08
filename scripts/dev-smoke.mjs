// Signed round-trip smoke test against the DEV sync Worker only.
// Usage: SIGNUP_KEY=... node scripts/dev-smoke.mjs   (never point this at prod)
import { generateKeyPairSync, sign, createHash } from "node:crypto";
const BASE = "https://api-dev.rabbitsoftware.io";
const sha = (b) => createHash("sha256").update(b).digest("hex");
const raw = (k) => k.export({ type: "spki", format: "der" }).subarray(-32);
const mk = () => { const { publicKey, privateKey } = generateKeyPairSync("ed25519"); return { priv: privateKey, pub: raw(publicKey).toString("base64"), id: sha(raw(publicKey)).slice(0, 32) }; };
const acct = mk(), dev = mk(), time = Date.now(), name = "smoke-test";
const sig = (k, m) => sign(null, Buffer.from(m), k).toString("base64");
const show = async (label, r) => console.log(label, r.status, await r.text());

const reg = { account_key: acct.pub, device_key: dev.pub, name, time, signature: sig(acct.priv, `register\n${acct.id}\n${dev.pub}\n${name}\n${time}`) };
await show("register (no key)  ", await fetch(`${BASE}/v1/devices`, { method: "POST", body: JSON.stringify(reg) }));
await show("register (with key)", await fetch(`${BASE}/v1/devices`, { method: "POST", headers: { "X-Signup-Key": process.env.SIGNUP_KEY }, body: JSON.stringify(reg) }));

async function call(method, path, bodyObj) {
  const body = bodyObj ? JSON.stringify(bodyObj) : "";
  const t = String(Date.now());
  const msg = `${method}\n${path}\n${t}\n${sha(Buffer.from(body))}`;
  return fetch(BASE + path, { method, body: body || undefined, headers: { ...(body ? { "Content-Type": "application/json" } : {}), "X-Account": acct.id, "X-Device": dev.id, "X-Time": t, "X-Signature": sig(dev.priv, msg) } });
}
await show("POST corpus        ", await call("POST", "/v1/corpus", { records: [{ source: "smoke", external_id: "1", title: "Dev smoke record", source_url: "https://example.com/1" }] }));
await show("GET history        ", await call("GET", "/v1/history"));
await show("GET corpus stats   ", await fetch(`${BASE}/v1/corpus/stats`));
