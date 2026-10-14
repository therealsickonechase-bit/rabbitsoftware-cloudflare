export function rewriteLocation(value, origin, publicHost) {
  if (!value) return value;
  const originHost = new URL(origin).host;
  try {
    const url = new URL(value);
    if (url.host !== originHost) return value;
    url.protocol = "https:";
    url.host = publicHost;
    return url.toString();
  } catch {
    return value;
  }
}

export default {
  async fetch(request, env) {
    const incoming = new URL(request.url);
    if (incoming.host !== env.PUBLIC_HOST) return new Response("Not found", { status: 404 });
    const target = new URL(incoming.pathname + incoming.search, env.ORIGIN);
    const headers = new Headers(request.headers);
    headers.set("x-forwarded-host", incoming.host);
    headers.delete("cf-connecting-ip");
    const response = await fetch(new Request(target, {
      method: request.method,
      headers,
      body: request.method === "GET" || request.method === "HEAD" ? undefined : request.body,
      redirect: "manual",
    }));
    const out = new Response(response.body, response);
    const location = out.headers.get("location");
    if (location) out.headers.set("location", rewriteLocation(location, env.ORIGIN, env.PUBLIC_HOST));
    return out;
  },
};
