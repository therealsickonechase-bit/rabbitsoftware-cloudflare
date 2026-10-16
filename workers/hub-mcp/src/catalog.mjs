// Command catalog for the hub, per role. Pure functions over the exported data (data/commands.json, made by rabbit-web/scripts/export-command-catalog.mjs).
//   guest  = the public sandbox at /cloudshell-public: only 'public' commands
//   owner  = the owner's own machine and owner shell: 'owner' and 'public' commands
// "Writing" a command means DRAFTING it: the draft is checked and labelled, never executed. A person runs it, and the owner's risky commands only on their computer.

export const ROLES = ['guest', 'owner']
export const GUEST_URL = 'https://app.rabbitsoftware.io/cloudshell-public'
export const OWNER_SHELL_URL = 'https://rabbit-web-cloud-access.rabbitsoftware-gateway.workers.dev/cloudshell'
export const HOSTS_GUEST_CAN_REACH = Object.freeze(['registry.npmjs.org', 'registry.yarnpkg.com', 'pypi.org', 'files.pythonhosted.org', 'github.com', 'raw.githubusercontent.com', 'codeload.github.com',
  'objects.githubusercontent.com', 'api.anthropic.com', 'generativelanguage.googleapis.com', 'api.githubcopilot.com', 'api.github.com', 'app.rabbitsoftware.io', 'rabbitos-hub-mcp-vxx5lz7c5a-wl.a.run.app', 'rabbitsoftware-io-ledger-public.storage.googleapis.com'])

// The toolbox (data/toolbox.json, made by rabbit-web/scripts/toolbox-publish.mjs and baked into the image): which files each command uses, and what each agent can do.
// A guest gets only files of the two PUBLIC repositories, as GitHub links; a hub key also sees the private paths. Nothing here is file content.
export const PUBLIC_REPOS = Object.freeze(['rabbit-web', 'rabbitsoftware-cloudflare'])
const GITHUB = 'https://github.com/therealsickonechase-bit/'
const fileLink = (f) => `${GITHUB}${f.repo}/blob/main/${f.path.split('/').map(encodeURIComponent).join('/')}`

const scopesFor = (role) => (role === 'owner' ? ['public', 'owner'] : ['public'])
const brief = (e) => ({ id: e.id, project: e.project, group: e.group, label: e.label, scope: e.scope, risk: e.risk, runsIn: e.runsIn, needs: e.needs ?? [], command: e.command, description: e.description })

/** Commands that are never drafted, for any role: they destroy data, run downloaded code unseen, or take the machine down. */
const BLOCKED = [
  [/\b(curl|wget)\b[^|;&]*\|\s*(sudo\s+)?(ba|z|da)?sh\b/i, 'pipes a download straight into a shell'],
  [/\bbase64\b[^|;&]*(-d|--decode)[^|;&]*\|\s*(ba|z)?sh\b/i, 'decodes and runs hidden code'],
  [/\brm\s+(-[a-z]*r[a-z]*f?|-[a-z]*f[a-z]*r)[a-z]*\s+(--no-preserve-root\s+)?(\/|~|\$HOME|\/\*|~\/\*)(\s|$)/i, 'deletes the root or home folder'],
  [/\bmkfs(\.\w+)?\b|\bdd\b[^;&|]*\bof=\/dev\/|>\s*\/dev\/sd[a-z]/i, 'writes to a disk device'],
  [/:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/, 'is a fork bomb'],
  [/\b(shutdown|reboot|halt|poweroff)\b/i, 'shuts the machine down'],
  [/\bchmod\s+-R\s+0?777\s+\//, 'opens permissions on the whole system'],
  [/\b(nc|ncat|netcat|nmap|masscan|hping3?)\b/i, 'is a network scanner or listener'],
]
const SECRET_LIKE = [/\bsk-[A-Za-z0-9_-]{16,}/, /\brbk_[A-Za-z0-9_-]{20,}/, /\bhub_[A-Za-z0-9_-]{32,}/, /\bgh[pousr]_[A-Za-z0-9]{20,}/, /\bAIza[0-9A-Za-z_-]{30,}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/, /\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\./]
const RISKY = [
  ['deploy', /\bwrangler\s+(deploy|publish)\b|\bnpm\s+run\s+deploy|\bcf\s+deploy\b|\bgcloud\b[^|;&]*\b(deploy|create|delete|update|set-iam|add-iam)\b|\bsupabase\s+(db\s+push|migration|functions\s+deploy)\b|\bgit\s+push\b/i, 'changes something remote'],
  ['secret', /\bwrangler\s+secret\b|\bsecrets?\s+(put|create|set)\b|\b(SERVICE_ROLE|INGEST_SHARED_SECRET|PRIVATE_KEY|API_KEY|TOKEN)\b/, 'uses or sets secrets'],
  ['destructive', /\brm\s+-[a-z]*r|\bdrop\s+(table|database|schema)\b|\btruncate\b|\bgit\s+(reset\s+--hard|clean\s+-[a-z]*f)|\bdelete\b/i, 'deletes data or files'],
  ['network', /\b(curl|wget|npm\s+(ci|install)|pip3?\s+install|git\s+clone|Invoke-(WebRequest|RestMethod))\b/i, 'uses the network'],
]
const RISK_ORDER = ['read', 'local', 'network', 'deploy', 'secret', 'destructive']
const worst = (a, b) => (RISK_ORDER.indexOf(a) >= RISK_ORDER.indexOf(b) ? a : b)

export function makeCatalog(data, toolbox = null) {
  const entries = (data?.entries ?? []).map((e) => Object.freeze({ ...e }))
  const maxBytes = Number(data?.commandMaxBytes) || 4000
  const visible = (role) => entries.filter((e) => scopesFor(role).includes(e.scope))
  const byCommand = new Map(entries.map((e) => [e.command, e]))

  return {
    generatedAt: data?.generatedAt ?? null,
    counts: () => ({ guest: visible('guest').length, owner: visible('owner').length, ownerOnly: entries.filter((e) => e.scope === 'owner').length, total: entries.length }),
    groups(role) {
      const out = new Map()
      for (const e of visible(role)) { const k = `${e.project}/${e.group}`; out.set(k, (out.get(k) ?? 0) + 1) }
      return [...out].map(([group, count]) => ({ group, count }))
    },
    list(role, { project, group, risk, limit = 30 } = {}) {
      return visible(role).filter((e) => (!project || e.project === project) && (!group || e.group === group) && (!risk || e.risk === risk)).slice(0, limit).map(brief)
    },
    search(role, q, limit = 20) {
      const words = String(q).toLowerCase().split(/\s+/).filter(Boolean)
      if (!words.length) return []
      return visible(role).filter((e) => { const hay = `${e.id} ${e.project} ${e.group} ${e.label} ${e.command} ${e.description}`.toLowerCase(); return words.every((w) => hay.includes(w)) }).slice(0, limit).map(brief)
    },
    /** The published files a command uses, for a role. */
    files(role, id) {
      if (!toolbox || !visible(role).some((x) => x.id === id)) return []
      return (toolbox.files?.[id] ?? []).filter((f) => role === 'owner' || PUBLIC_REPOS.includes(f.repo))
        .map((f) => ({ repo: f.repo, path: f.path, sha256: f.sha256, ...(PUBLIC_REPOS.includes(f.repo) ? { url: fileLink(f) } : {}) }))
    },
    /** Which bundle the file lists and agent descriptions come from (root hash and counts), or null if the toolbox data is not loaded. */
    bundle: () => (toolbox ? { root: toolbox.root, counts: toolbox.counts } : null),
    /** What each agent can run and do. The command line for sending it work is only given to a hub key. */
    agents(withHowToSend, only) {
      return (toolbox?.agents ?? []).filter((a) => !only || a.id === only).map((a) => { const { howToSend, ...rest } = a; return withHowToSend ? { ...rest, howToSend } : rest })
    },
    get: (role, id) => { const e = visible(role).find((x) => x.id === id); return e ? brief(e) : null },
    all: (role) => visible(role).map(brief),

    /** Checks and labels one command line. Never runs anything. */
    draft(role, command, why) {
      const no = (reason) => ({ ok: false, executed: false, role, reason })
      if (!ROLES.includes(role)) return no('role must be guest or owner')
      if (typeof command !== 'string' || !command.trim()) return no('the command is empty')
      // Check the RAW input: trimming first would hide a trailing \r or \n, which acts like pressing Enter.
      if (/[^\P{Cc}\t]|[\p{Zl}\p{Zp}]/u.test(command)) return no('a command must be one line of printable characters')
      const text = command.trim()
      if (new TextEncoder().encode(text).length > maxBytes) return no(`a command may be at most ${maxBytes} bytes`)
      for (const [re, what] of BLOCKED) if (re.test(text)) return no(`refused: this ${what}`)
      if (SECRET_LIKE.some((re) => re.test(text))) return no('refused: it contains what looks like a real key or token. Put the secret in an environment variable and refer to the variable by name.')

      const known = byCommand.get(text) ?? null
      if (role === 'guest' && known && known.scope === 'owner') return no(`this is an owner command (${known.id}); it is not available in the guest sandbox`)
      const warnings = []
      let risk = known ? known.risk : 'local'
      for (const [level, re, what] of RISKY.map(([l, r, w]) => [l, r, w])) if (re.test(text)) { risk = worst(risk, level); warnings.push(`${what}`) }
      if (role === 'guest') {
        if (risk === 'deploy') return no(`the guest sandbox has no credentials and cannot change anything remote (${warnings.join('; ')})`)
        if (risk === 'secret') warnings.push('refer to your key by variable name (for example $ANTHROPIC_API_KEY); never type the key itself into a command')
        if (/\bsudo\b/.test(text)) warnings.push('sudo is not available in the sandbox')
        const hosts = [...text.matchAll(/https?:\/\/([A-Za-z0-9.-]+)/g)].map((m) => m[1].toLowerCase())
        for (const h of hosts) if (!HOSTS_GUEST_CAN_REACH.includes(h)) warnings.push(`the sandbox cannot reach ${h}; the network is limited to a fixed allowlist`)
      }
      const runsIn = known ? known.runsIn : role === 'guest' ? 'sandbox' : 'computer'
      const runAt = role === 'guest' || runsIn === 'sandbox'
        ? { where: 'guest sandbox', url: GUEST_URL, how: 'Open the page, tick the human check, start the sandbox, paste the command and press Enter yourself.' }
        : { where: "the owner's computer, from the repo root", url: OWNER_SHELL_URL, how: 'Run it in your own terminal after reading it. The owner shell (Cloudflare Access sign-in) is an alternative for non-deploy commands.' }
      if (role === 'owner' && (risk === 'deploy' || risk === 'secret' || risk === 'destructive')) warnings.push('OWNER ONLY: run this by hand after reading it; nothing in the hub will run it for you')
      return {
        ok: true, executed: false, requiresApproval: true, role, command: text, why: typeof why === 'string' ? why.slice(0, 300) : null, risk,
        catalogId: known ? known.id : null, needs: known?.needs ?? [], warnings, runAt,
      }
    },
  }
}
