// Validation of what the browser sends over the WebSocket. Text JSON frames only:
//   {"t":"hello","cols":80,"rows":24,"keys":{"ANTHROPIC_API_KEY":"..."}}   first frame, once
//   {"t":"i","d":"ls\r"}                                                   keyboard input
//   {"t":"r","cols":100,"rows":30}                                         resize
import { LIMITS } from './limits.mjs'

const bytes = (s) => new TextEncoder().encode(s).length

const dims = (frame, limits) => {
  const { cols, rows } = frame
  if (!Number.isInteger(cols) || !Number.isInteger(rows)) return null
  if (cols < limits.minCols || cols > limits.maxCols || rows < limits.minRows || rows > limits.maxRows) return null
  return { cols, rows }
}

/**
 * @param {unknown} data   the WebSocket message payload
 * @param {{first: boolean}} state
 * @returns {{ok: true, frame: object} | {ok: false, close: number, error: string}}  close 1009 = too big, 1003 = bad type, 1008 = policy
 */
export function parseClientFrame(data, { first }, limits = LIMITS) {
  if (typeof data !== 'string') return { ok: false, close: 1003, error: 'binary frames are not accepted' }
  if (bytes(data) > (first ? limits.maxHelloBytes : limits.maxFrameBytes)) return { ok: false, close: 1009, error: 'frame too large' }
  let frame
  try { frame = JSON.parse(data) } catch { return { ok: false, close: 1008, error: 'frame is not JSON' } }
  if (!frame || typeof frame !== 'object' || Array.isArray(frame)) return { ok: false, close: 1008, error: 'frame must be an object' }
  if (first) {
    if (frame.t !== 'hello') return { ok: false, close: 1008, error: 'first frame must be hello' }
    const size = dims(frame, limits)
    if (!size) return { ok: false, close: 1008, error: 'bad terminal size' }
    return { ok: true, frame: { t: 'hello', ...size, keys: frame.keys } }
  }
  if (frame.t === 'i') {
    if (typeof frame.d !== 'string' || frame.d.length === 0) return { ok: false, close: 1008, error: 'input must be a non-empty string' }
    if (frame.d.includes('\0')) return { ok: false, close: 1008, error: 'NUL is not accepted' }
    return { ok: true, frame: { t: 'i', d: frame.d } }
  }
  if (frame.t === 'r') {
    const size = dims(frame, limits)
    return size ? { ok: true, frame: { t: 'r', ...size } } : { ok: false, close: 1008, error: 'bad terminal size' }
  }
  return { ok: false, close: 1008, error: 'unknown frame type' }
}

/** Command lines in a chunk of keyboard input: each Enter (CR or LF) counts, capped by the frame size. */
export function countCommands(input) {
  let n = 0
  for (const ch of input) if (ch === '\r' || ch === '\n') n++
  return n
}

/** Sliding one-second input budget, so a client cannot flood the PTY. */
export function inputBudget(state, size, now, limits = LIMITS) {
  if (now - state.windowStart >= 1000) { state.windowStart = now; state.used = 0 }
  if (state.used + size > limits.maxInputBytesPerSecond) return false
  state.used += size
  return true
}
