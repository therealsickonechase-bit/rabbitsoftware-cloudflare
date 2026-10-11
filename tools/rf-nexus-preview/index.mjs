const files = new Set([
  '/assets/index-drmRIFDg.js',
  '/assets/index--vzZ5AZu.css',
])

const headers = {
  'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), usb=(), serial=(), bluetooth=()',
  'X-Robots-Tag': 'noindex, nofollow',
  'Cache-Control': 'no-store',
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url)
    if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/port/')
        || request.headers.get('Upgrade')?.toLowerCase() === 'websocket') {
      return Response.json({
        error: 'Static RF Nexus preview only. The original backend is not available; no data or credentials are accepted.',
      }, { status: 503, headers })
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return new Response('Read-only static preview.', {
        status: 405, headers: { ...headers, Allow: 'GET, HEAD' },
      })
    }
    if (!files.has(url.pathname) && url.pathname !== '/' && url.pathname !== '/index.html') {
      return new Response('Not included in the static export.', { status: 404, headers })
    }
    const asset = await env.ASSETS.fetch(request)
    const response = new Response(asset.body, asset)
    for (const [name, value] of Object.entries(headers)) response.headers.set(name, value)
    if (!asset.ok || !asset.headers.get('Content-Type')?.includes('text/html')) return response
    return new HTMLRewriter()
      .on('script[data-pplx-inline-edit]', { element(element) { element.remove() } })
      .on('body', {
        element(element) {
          element.prepend('<aside role="status" style="position:relative;z-index:2147483647;padding:16px;background:#fff3cd;color:#332701;font:16px sans-serif">RF Nexus static export preview only. Backend, sign-in, live data, wallet actions and recording are unavailable. Do not enter credentials or personal data. This is not the RabbitOS production console.</aside>', { html: true })
        },
      })
      .transform(response)
  },
}
