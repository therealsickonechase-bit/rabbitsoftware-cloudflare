// The logic behind proof.html: what the two public files say (status/proof-live.json and status/digest.json in the Google Cloud status bucket), and how fresh they are. Pure, so tests can run it.
// The files are rewritten by the status job every five minutes, so a new anchor or a re-check shows up WITHOUT deploying the website. They hold public facts only and the page draws them as
// plain text; links go only to the project's own public bucket, mempool.space blocks, or known research hosts (safeLink).
import { safeLink } from './research-live-view.mjs'
import { ageMinutes, ageText } from './status-view.mjs'

const BASE = 'https://rabbitsoftware-io-status-public.storage.googleapis.com/status/'
export const PROOF_URL = BASE + 'proof-live.json'
export const DIGEST_URL = BASE + 'digest.json'
const LEDGER = 'https://rabbitsoftware-io-ledger-public.storage.googleapis.com/anchors/'
export const STALE_AFTER_MIN = 45
const ID_RE = /^\d{4}-\d{2}-\d{2}T\d{6}Z$/

const whole = (n) => (Number.isInteger(n) && n >= 0 ? n : null)

/** @returns {{state: 'ok'|'stale'|'unknown', when: string, headline: string, witnesses: string[], notYet: string[], anchors: object[]}} */
export function proofView(data, now = Date.now()) {
  if (!data || data.version !== 1 || !Array.isArray(data.anchors) || !data.summary) {
    return { state: 'unknown', when: 'The proof list could not be read just now. Nothing is shown rather than guessing.', headline: '', witnesses: [], notYet: [], anchors: [] }
  }
  const s = data.summary
  const fresh = ageMinutes(data.generatedAt, now) <= STALE_AFTER_MIN
  const verified = whole(s.verified) ?? 0, failed = whole(s.failed) ?? 0, confirmed = whole(s.confirmed) ?? 0
  let headline = `${verified} of the last ${whole(s.anchors) ?? data.anchors.length} anchors were re-checked by our status job against the real Bitcoin blocks`
  if (failed) headline += `, and ${failed} did NOT match (see below)`
  headline += '.'
  if (confirmed > verified + failed) headline += ` ${confirmed - verified - failed} confirmed anchor${confirmed - verified - failed === 1 ? ' is' : 's are'} waiting for its check.`
  const anchors = data.anchors.filter((a) => a && ID_RE.test(String(a.id))).slice(0, 12).map((a) => {
    const height = whole(a.bitcoinHeight)
    const verdict = a.verified === true ? 'matches Bitcoin' : a.verified === false ? 'DOES NOT MATCH' : a.status === 'confirmed' ? 'not checked yet' : 'waiting for Bitcoin'
    return {
      id: a.id,
      state: a.verified === true ? 'ok' : a.verified === false ? 'bad' : 'wait',
      verdict,
      detail: String(a.reason ?? '').slice(0, 200),
      block: height,
      blockLink: height ? `https://mempool.space/block/${height}` : null,
      files: { anchor: `${LEDGER}${a.id}/anchor.json`, proof: `${LEDGER}${a.id}/anchor.json.ots`, tsa: a.tsa === 'freetsa.org' ? `${LEDGER}${a.id}/anchor.json.tsr` : null },
      maxwell: whole(a.maxwellLength), ledger: whole(a.ledgerLength),
      checked: a.checkedAt ? ageText(a.checkedAt, now) : null,
    }
  })
  return {
    state: fresh ? 'ok' : 'stale',
    when: fresh ? `Updated ${ageText(data.generatedAt, now)}. The status job re-reads the anchors every five minutes.` : `This list was last refreshed ${ageText(data.generatedAt, now)}, so it may be out of date.`,
    headline,
    witnesses: Array.isArray(s.witnesses) ? s.witnesses.map((w) => String(w).slice(0, 60)).slice(0, 4) : [],
    notYet: Array.isArray(data.notYetOn) ? data.notYetOn.map((w) => String(w).slice(0, 40)).slice(0, 4) : [],
    heads: data.heads ? { maxwellIndex: whole(data.heads.maxwellHeadIndex), ledgerLength: whole(data.heads.ledgerLength) } : null,
    anchors,
  }
}

/** @returns {{ok: boolean, text: string, stats: string[], newest: object[]}} */
export function digestView(data, now = Date.now()) {
  if (!data || data.version !== 1 || typeof data.text !== 'string') return { ok: false, text: 'The weekly summary could not be read just now.', stats: [], newest: [] }
  const total = whole(data.total)
  const stats = [
    total !== null ? `${total.toLocaleString('en-US')} public records` : null,
    whole(data.topics?.explored) !== null ? `${data.topics.explored} topics explored` : null,
    data.lastWeek && whole(data.lastWeek.added) !== null ? `${data.lastWeek.added.toLocaleString('en-US')} added last period` : null,
  ].filter(Boolean)
  const newest = (Array.isArray(data.newest) ? data.newest : []).slice(0, 8).map((r) => ({ title: String(r.title ?? '').slice(0, 200), source: String(r.source ?? '').slice(0, 40), link: safeLink(r.url), ago: r.seenAt ? ageText(r.seenAt, now) : '' })).filter((r) => r.title)
  return { ok: true, text: data.text.slice(0, 1200), stats, newest }
}

export const WITNESS_URL = BASE + 'witness.json'
const WITNESS_WORDS = Object.freeze({
  agrees: 'signed the current head',
  behind: 'signed an earlier head that is still part of this chain',
  ahead: 'signed a longer chain than the copy we read (our copy may be a little old)',
  stale: 'its signature is too old to count',
  conflict: 'signed a DIFFERENT history: investigate',
  invalid: 'its signature does not verify',
  missing: 'could not be read just now',
})

/** The independent-witness panel: who re-checked the Maxwell chain on their own and signed the head, and whether enough of them agree. */
export function witnessView(data, now = Date.now()) {
  if (!data || data.version !== 1 || !Array.isArray(data.witnesses) || !data.rule) {
    return { state: 'unknown', headline: 'The witness list could not be read just now.', when: '', rule: '', rows: [] }
  }
  const agreeing = whole(data.agreeing) ?? 0, n = whole(data.rule.n) ?? data.witnesses.length, k = whole(data.rule.k) ?? 2
  const conflict = (whole(data.conflicts) ?? 0) > 0
  const state = conflict || data.chainOk === false ? 'bad' : data.trusted ? 'ok' : 'wait'
  const fresh = ageMinutes(data.generatedAt, now) <= STALE_AFTER_MIN
  return {
    state,
    headline: data.chainOk === false ? 'The chain itself does not verify.'
      : conflict ? 'A witness signed a different history from the one published. Do not trust the head until this is explained.'
        : `${agreeing} of ${n} witnesses signed the current head${data.head && whole(data.head.size) !== null ? ` (${data.head.size} blocks)` : ''}${data.trusted ? `, which meets the rule of ${k}` : `; the rule needs ${k}`}.`,
    when: fresh ? `Updated ${ageText(data.generatedAt, now)}.` : `Last refreshed ${ageText(data.generatedAt, now)}, so it may be out of date.`,
    rule: `A head counts as independently checked when ${k} different registered witnesses have signed it. Each witness downloads the public chain, recomputes every hash, link and work target itself, and signs only what it verified.`,
    rows: data.witnesses.slice(0, 25).filter((w) => w && /^[a-z0-9][a-z0-9._-]{0,39}$/.test(String(w.name))).map((w) => ({
      name: String(w.name), kind: w.kind === 'project' ? 'run by the project' : 'outside peer', keyId: /^[0-9a-f]{16}$/.test(String(w.keyId)) ? w.keyId : '?',
      state: w.status === 'agrees' ? 'ok' : w.status === 'conflict' || w.status === 'invalid' ? 'bad' : 'wait',
      status: WITNESS_WORDS[w.status] ?? 'unknown', size: whole(w.size), signed: w.signedAt ? ageText(w.signedAt, now) : null, note: String(w.note ?? '').slice(0, 160),
    })),
  }
}
