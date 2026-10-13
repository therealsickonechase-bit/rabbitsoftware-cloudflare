import { ProxyAgent, fetch as proxyFetch } from "undici";
import { networkInterfaces } from "node:os";
import { Resolver } from "node:dns/promises";
import { isIP } from "node:net";
import { adapterName } from "./task-protocol.mjs";

export function proxySettings(value) {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)
      || Object.keys(value).some(key => !["url", "tokenEnv"].includes(key))) throw new Error("Proxy needs exact url and optional tokenEnv fields.");
  let url;
  try { url = new URL(value.url); } catch { throw new Error("Configure a valid proxy origin without credentials."); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash
      || url.pathname !== "/") throw new Error("Configure a credential-free HTTP/HTTPS CONNECT proxy origin.");
  if (value.tokenEnv !== undefined && (typeof value.tokenEnv !== "string" || !/^[A-Z][A-Z0-9_]{0,99}$/.test(value.tokenEnv))) throw new Error("Proxy credentials need a tokenEnv reference, not embedded secrets.");
  return { url: url.origin, ...(value.tokenEnv ? { tokenEnv: value.tokenEnv } : {}) };
}

export async function networkFetch(url, options = {}, proxy) {
  const settings = proxySettings(proxy);
  if (!settings) return fetch(url, options);
  if (new URL(url).protocol !== "https:") throw new Error("Explicit proxy routing is restricted to HTTPS targets; no insecure fallback.");
  const token = settings.tokenEnv ? process.env[settings.tokenEnv] : undefined;
  if (settings.tokenEnv && (typeof token !== "string" || !token.trim() || token.length > 4096 || /[^\x20-\x7e]/.test(token))) throw new Error("Configured proxy credential environment variable is missing or invalid.");
  const agent = new ProxyAgent({ uri: settings.url, ...(token ? { token } : {}), connections: 1 });
  let response;
  try { response = await proxyFetch(url, { ...options, redirect: "error", dispatcher: agent }); }
  catch (error) {
    await agent.destroy();
    // Transport failures must not print credential-bearing library diagnostics.
    throw new TypeError(`Configured proxy transport failed (${error.name}); no direct fallback was attempted.`);
  }
  if (!response.body) {
    await agent.close();
    return new Response(null, { status: response.status, statusText: response.statusText, headers: response.headers });
  }
  const reader = response.body.getReader();
  const body = new ReadableStream({
    async pull(controller) {
      try {
        const part = await reader.read();
        if (part.done) { await agent.close(); controller.close(); }
        else controller.enqueue(part.value);
      } catch (error) {
        await agent.destroy();
        controller.error(new TypeError(`Configured proxy response interrupted (${error.name}).`));
      }
    },
    async cancel(reason) {
      try { await reader.cancel(reason); } finally { await agent.destroy(); }
    },
  });
  return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
}

export async function diagnoseNetworks(config = {}, resolveDns = false) {
  if (!config || typeof config !== "object" || Array.isArray(config)) throw new Error("Diagnostics need an adapter configuration object.");
  if (config.adapters !== undefined && (!Array.isArray(config.adapters) || config.adapters.length > 16)) throw new Error("Diagnostics accept at most 16 configured adapters.");
  const interfaces = Object.entries(networkInterfaces()).slice(0, 32).map(([name, addresses]) => ({
    name: name.slice(0, 128), families: [...new Set((addresses ?? []).map(address => address.family))],
    nonLoopback: (addresses ?? []).some(address => !address.internal),
  }));
  const routes = [];
  for (const entry of config.adapters ?? []) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error("Diagnostics need adapter entries as objects.");
    if (!["agent-http", "cloud-shell-http", "cloudflare-jobs", "model"].includes(entry.type)) continue;
    adapterName(entry.id);
    const proxy = proxySettings(entry.proxy);
    let url;
    if (entry.type === "model") {
      routes.push({ adapter: entry.id, type: entry.type, proxyConfigured: Boolean(proxy),
        available: "not-probed", reason: "Model endpoint is in its provider config; inspect that approved config separately." });
      continue;
    }
    url = new URL(entry.url);
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) throw new Error("Diagnostics require configured credential-free HTTPS endpoints.");
    const lookupHost = (proxy ? new URL(proxy.url).hostname : url.hostname).replace(/^\[|\]$/g, "");
    const route = { adapter: entry.id, type: entry.type, targetHost: url.hostname,
      proxyConfigured: Boolean(proxy), dnsHost: lookupHost, dns: "not-probed",
      credentialConfigured: typeof entry.tokenEnv === "string" && Boolean(process.env[entry.tokenEnv]),
      proxyCredentialConfigured: !proxy?.tokenEnv || Boolean(process.env[proxy.tokenEnv]) };
    if (isIP(lookupHost)) route.dns = "ip-literal-no-dns";
    else if (resolveDns) {
      const resolver = new Resolver({ timeout: 2000, tries: 1 });
      const timer = setTimeout(() => resolver.cancel(), 3000);
      try {
        const results = await Promise.allSettled([resolver.resolve4(lookupHost), resolver.resolve6(lookupHost)]);
        route.dns = results.some(result => result.status === "fulfilled" && result.value.length) ? "resolved" : "unresolved";
        if (route.dns === "unresolved") route.dnsErrors = results.map(result => result.status === "rejected" ? result.reason.code ?? "DNS_ERROR" : "EMPTY");
      } finally { clearTimeout(timer); }
    }
    routes.push(route);
  }
  return { version: 1, transport: "os-managed-ip", interfaces, routes, dnsProbed: resolveDns,
    proxyEnvironmentPresent: ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY"].filter(name => Boolean(process.env[name])),
    automaticProxyEnvironmentUse: false, hardwareControl: false, connectedProviders: [],
    limitation: "Interface presence or DNS resolution does not prove internet access, carrier type, terminal availability, or successful authenticated delivery. Cellular/satellite/tethering must already supply OS-managed IP connectivity." };
}
