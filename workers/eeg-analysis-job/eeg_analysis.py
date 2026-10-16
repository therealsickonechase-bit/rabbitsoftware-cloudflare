"""
eeg_analysis.py
===============
Private band-power analysis of the PhysioNet "EEG Motor Movement/Imagery" recordings (public sample data: volunteers S001..., runs R01..R14, EDF files) that the nightly backup keeps in the
PRIVATE backups bucket under maxwell/current/eeg_data/. It also reads eeg_runs/metrics.json (the held-out accuracy of the state classifier trained on them).

Output, in the same private bucket: analysis/eeg/summary.json (and analysis/eeg/latest.txt, a short plain-text version).
  per recording: channels, sampling rate, seconds, mean relative power in delta/theta/alpha/beta/gamma
  per condition: eyes open (R01) and eyes closed (R02) averages and the alpha eyes-closed/eyes-open ratio, which should be above 1 (the classic alpha rise with closed eyes)

Access: the service account may read ONLY objects under maxwell/current/eeg_data/ and maxwell/current/eeg_runs/ and write ONLY under analysis/eeg/. The job never lists the bucket: it asks for the
file names PhysioNet uses. No URL, no listing in the Agent Registry, no personal recordings (the owner's own EEG notes live in the vault and are not in this bucket).
Environment: BACKUP_BUCKET (default rabbitsoftware-io-backups), MAX_SUBJECTS (default 40).  Exit codes: 0 ok, 1 nothing could be read or written.
"""

from __future__ import annotations

import json
import os
import re
import sys
import tempfile
import urllib.error
import urllib.parse
import urllib.request

import numpy as np

BANDS = {"delta": (1.0, 4.0), "theta": (4.0, 8.0), "alpha": (8.0, 13.0), "beta": (13.0, 30.0), "gamma": (30.0, 45.0)}
CONDITIONS = {"R01": "eyes_open", "R02": "eyes_closed"}
EDF_PREFIX = "maxwell/current/eeg_data/MNE-eegbci-data/files/eegmmidb/1.0.0"
BUCKET_RE = re.compile(r"^[a-z0-9][a-z0-9._-]{2,62}$")
_trapz = getattr(np, "trapezoid", None) or np.trapz


def log(event: str, **fields) -> None:
    print(json.dumps({"severity": "ERROR" if event.endswith("_failed") else "INFO", "event": event, **fields}), flush=True)


def band_powers(signal: np.ndarray, fs: float) -> dict[str, float]:
    """Mean relative power per band across channels. signal has shape (channels, samples)."""
    from scipy.signal import welch

    nper = int(min(signal.shape[1], max(256, round(fs * 2))))
    freqs, psd = welch(signal, fs=fs, nperseg=nper, axis=-1)
    full = (freqs >= 1.0) & (freqs <= 45.0)
    total = _trapz(psd[:, full], freqs[full], axis=-1)
    out = {}
    for name, (a, b) in BANDS.items():
        m = (freqs >= a) & (freqs < b)
        part = _trapz(psd[:, m], freqs[m], axis=-1)
        out[name] = float(np.mean(part / np.where(total > 0, total, 1)))
    return out


def condition_summary(rows: list[dict]) -> dict:
    by: dict[str, list[dict]] = {}
    for r in rows:
        c = CONDITIONS.get(r["run"])
        if c:
            by.setdefault(c, []).append(r)
    avg: dict = {}
    for c, rs in by.items():
        avg[c] = {b: float(np.mean([r["relative_power"][b] for r in rs])) for b in BANDS}
        avg[c]["recordings"] = len(rs)
    if "eyes_open" in avg and "eyes_closed" in avg and avg["eyes_open"]["alpha"] > 0:
        avg["alpha_eyes_closed_over_open"] = round(avg["eyes_closed"]["alpha"] / avg["eyes_open"]["alpha"], 3)
    return avg


def read_edf(data: bytes) -> tuple[np.ndarray, float]:
    """Minimal EDF/EDF+ reader (numpy only): returns (signals[channels, samples], sampling_hz) for the signals that share the first signal's rate. Annotation channels are skipped."""
    ns = int(data[252:256])
    nrec = int(data[236:244])
    rec_dur = float(data[244:252])
    base = 256
    f = lambda off, w: [data[base + off + i * w : base + off + (i + 1) * w].decode("ascii", "replace").strip() for i in range(ns)]
    labels = f(0, 16)
    # field widths per signal: label16 transducer80 dimension8 phys_min8 phys_max8 dig_min8 dig_max8 prefilter80 samples8 reserved32
    offs = {"phys_min": 16 + 80 + 8, "phys_max": 16 + 80 + 8 + 8, "dig_min": 16 + 80 + 8 + 16, "dig_max": 16 + 80 + 8 + 24}
    pmin = [float(x) for x in [data[base + ns * offs["phys_min"] + i * 8 : base + ns * offs["phys_min"] + (i + 1) * 8] for i in range(ns)]]
    pmax = [float(x) for x in [data[base + ns * offs["phys_max"] + i * 8 : base + ns * offs["phys_max"] + (i + 1) * 8] for i in range(ns)]]
    dmin = [float(x) for x in [data[base + ns * offs["dig_min"] + i * 8 : base + ns * offs["dig_min"] + (i + 1) * 8] for i in range(ns)]]
    dmax = [float(x) for x in [data[base + ns * offs["dig_max"] + i * 8 : base + ns * offs["dig_max"] + (i + 1) * 8] for i in range(ns)]]
    spr_off = ns * (16 + 80 + 8 + 8 + 8 + 8 + 8 + 80)
    spr = [int(data[base + spr_off + i * 8 : base + spr_off + (i + 1) * 8]) for i in range(ns)]
    header_len = 256 + ns * 256
    rec_samples = sum(spr)
    raw = np.frombuffer(data, dtype="<i2", count=rec_samples * nrec, offset=header_len).reshape(nrec, rec_samples)
    starts = np.concatenate([[0], np.cumsum(spr)])
    fs0 = spr[0] / rec_dur
    keep = [i for i in range(ns) if "annotation" not in labels[i].lower() and abs(spr[i] / rec_dur - fs0) < 1e-6]
    out = []
    for i in keep:
        dig = raw[:, starts[i] : starts[i] + spr[i]].reshape(-1).astype(np.float64)
        scale = (pmax[i] - pmin[i]) / (dmax[i] - dmin[i]) if dmax[i] != dmin[i] else 1.0
        out.append((dig - dmin[i]) * scale + pmin[i])
    return np.vstack(out), fs0


def analyse_edf(path: str) -> dict:
    with open(path, "rb") as fh:
        sig, fs = read_edf(fh.read())
    return {"channels": int(sig.shape[0]), "sampling_hz": float(fs), "seconds": round(sig.shape[1] / fs, 1), "relative_power": {k: round(v, 5) for k, v in band_powers(sig, fs).items()}}


class Store:
    def __init__(self, bucket: str, token_fn, opener=urllib.request.urlopen):
        if not BUCKET_RE.match(bucket):
            raise ValueError("bad bucket name")
        self.bucket, self.token_fn, self.opener = bucket, token_fn, opener

    def get(self, name: str):
        if not (name.startswith("maxwell/current/eeg_data/") or name.startswith("maxwell/current/eeg_runs/")) or ".." in name:
            raise ValueError("reads are limited to the eeg_data and eeg_runs backups")
        url = f"https://storage.googleapis.com/storage/v1/b/{self.bucket}/o/{urllib.parse.quote(name, safe='')}?alt=media"
        try:
            return self.opener(urllib.request.Request(url, headers={"Authorization": f"Bearer {self.token_fn()}"}), timeout=60).read()
        except urllib.error.HTTPError as e:
            if e.code in (403, 404):
                return None
            raise

    def put(self, name: str, body: bytes, content_type: str) -> None:
        if not name.startswith("analysis/eeg/") or ".." in name:
            raise ValueError("writes are limited to analysis/eeg/")
        url = f"https://storage.googleapis.com/upload/storage/v1/b/{self.bucket}/o?uploadType=media&name={urllib.parse.quote(name, safe='')}"
        self.opener(urllib.request.Request(url, data=body, method="POST", headers={"Authorization": f"Bearer {self.token_fn()}", "Content-Type": content_type, "Cache-Control": "no-store"}), timeout=60).read()


def metadata_token() -> str:
    req = urllib.request.Request("http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token", headers={"Metadata-Flavor": "Google"})
    with urllib.request.urlopen(req, timeout=5) as resp:
        return json.load(resp)["access_token"]


def run(store, max_subjects: int = 40, analyse=analyse_edf, now=None) -> int:
    from datetime import datetime, timezone

    rows = []
    for s in range(1, max_subjects + 1):
        for r in range(1, 15):
            name = f"S{s:03d}R{r:02d}.edf"
            blob = store.get(f"{EDF_PREFIX}/S{s:03d}/{name}")
            if blob is None:
                continue
            with tempfile.NamedTemporaryFile(suffix=".edf", delete=False) as tmp:
                tmp.write(blob)
                path = tmp.name
            try:
                rows.append({"subject": f"S{s:03d}", "run": f"R{r:02d}", **analyse(path)})
            except Exception as e:  # one unreadable file must not stop the rest
                log("eeg_file_failed", file=name, reason=f"{type(e).__name__}: {str(e)[:100]}")
            finally:
                os.unlink(path)
    if not rows:
        log("eeg_analysis_failed", reason="no recordings could be read from maxwell/current/eeg_data/")
        return 1
    metrics = store.get("maxwell/current/eeg_runs/metrics.json")
    summary = {
        "generatedAt": (now or datetime.now(timezone.utc)).isoformat(),
        "dataset": "PhysioNet EEG Motor Movement/Imagery (public sample data)",
        "recordings": len(rows),
        "subjects": len({r["subject"] for r in rows}),
        "conditions": condition_summary(rows),
        "classifier": json.loads(metrics) if metrics else None,
        "per_recording": rows,
    }
    ratio = summary["conditions"].get("alpha_eyes_closed_over_open")
    acc = summary["classifier"].get("held_out_accuracy") if summary["classifier"] else None
    text = f"{len(rows)} recordings from {summary['subjects']} volunteers. Alpha power eyes closed / eyes open: {ratio}. Classifier held-out accuracy: {acc}.\n"
    store.put("analysis/eeg/summary.json", json.dumps(summary, indent=1).encode(), "application/json")
    store.put("analysis/eeg/latest.txt", text.encode(), "text/plain")
    log("eeg_analysis_done", recordings=len(rows), subjects=summary["subjects"], alpha_ratio=ratio)
    return 0


def main() -> int:
    try:
        return run(Store(os.environ.get("BACKUP_BUCKET", "rabbitsoftware-io-backups"), metadata_token), int(os.environ.get("MAX_SUBJECTS", "40")))
    except (urllib.error.URLError, OSError, ValueError) as e:
        log("eeg_analysis_failed", reason=f"{type(e).__name__}: {str(e)[:120]}")
        return 1


if __name__ == "__main__":
    sys.exit(main())
