// Pure helpers for the cloud backup job: names, the Supabase connection string fix, and scrubbing secrets out of anything that is logged.

/** Objects are written under platform-cloud/<date>/ only. The local backup keeps its own platform/<date>/ prefix, so the two never overwrite each other. */
export const PREFIX = 'platform-cloud'

export function today(now = new Date()) { return now.toISOString().slice(0, 10) }

/** A safe object name: platform-cloud/2026-10-15/<part>/<file>. Parts and files are plain names; nothing can climb out of the prefix. */
export function objectName(date, part, file) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('bad date')
  if (!/^[a-z0-9-]{1,40}$/.test(part)) throw new Error('bad part')
  const clean = String(file).replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+/, '_').slice(0, 120)
  if (!clean) throw new Error('bad file name')
  return `${PREFIX}/${date}/${part}/${clean}`
}

/**
 * Supabase's pooler wants the user as postgres.<project-ref> and requires SSL (the same fix Backup-Platform.ps1 applies).
 * `ref` is the public project ref from NEXT_PUBLIC_SUPABASE_URL.
 */
export function normalizeDbUrl(url, ref) {
  let out = String(url).trim()
  if (/@[^/]*pooler\.supabase\.com/.test(out) && ref && /^postgres(ql)?:\/\/postgres:/.test(out)) out = out.replace(/^(postgres(?:ql)?:\/\/)postgres:/, `$1postgres.${ref}:`)
  if (!/sslmode=/.test(out)) out += out.includes('?') ? '&sslmode=require' : '?sslmode=require'
  return out
}

export function projectRef(supabaseUrl) {
  const m = /^https?:\/\/([a-z0-9]+)\./i.exec(String(supabaseUrl ?? ''))
  return m ? m[1] : null
}

/** Removes connection strings, bearer tokens and long token-like strings from text before it reaches a log. */
export function scrub(text) {
  return String(text)
    .replace(/postgres(ql)?:\/\/\S+/gi, 'postgres://<hidden>')
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/g, 'Bearer <hidden>')
    .replace(/\b[A-Za-z0-9_-]{40,}\b/g, '<hidden>')
}

export const MAX_OBJECT_BYTES = 500 * 1024 * 1024
