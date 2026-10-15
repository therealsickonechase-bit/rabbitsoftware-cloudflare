import { serve } from './failover.mjs'

export default {
  async fetch(request, env) {
    return serve(request, {
      primary: env.PRIMARY,
      standby: env.STANDBY,
      fetchImpl: fetch,
      timeoutMs: Number(env.TIMEOUT_MS) || 5000,
    })
  },
}
