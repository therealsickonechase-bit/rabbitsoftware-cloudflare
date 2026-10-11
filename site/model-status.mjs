export function modelUnavailableMessage(status) {
  if (status !== 503) return null;
  return "The model is temporarily unavailable (HTTP 503). It may be waking after 15 idle minutes, or experiencing another service issue. Wait a few minutes, then approve a manual retry. Your question has been kept; no automatic retry is made. If this persists, contact contact@rabbitsoftware.io.";
}
