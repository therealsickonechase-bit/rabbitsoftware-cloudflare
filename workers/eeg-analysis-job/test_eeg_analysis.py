import json
import unittest

import numpy as np

import eeg_analysis as ea


class BandTests(unittest.TestCase):
    def test_a_10_hz_wave_is_alpha(self):
        fs = 160.0
        t = np.arange(0, 20, 1 / fs)
        sig = np.vstack([np.sin(2 * np.pi * 10 * t), np.sin(2 * np.pi * 10 * t + 1)])
        p = ea.band_powers(sig, fs)
        self.assertGreater(p["alpha"], 0.9)
        self.assertAlmostEqual(sum(p.values()), 1.0, delta=0.05)

    def test_a_20_hz_wave_is_beta_and_a_2_hz_wave_is_delta(self):
        fs = 160.0
        t = np.arange(0, 20, 1 / fs)
        self.assertGreater(ea.band_powers(np.sin(2 * np.pi * 20 * t)[None, :], fs)["beta"], 0.9)
        self.assertGreater(ea.band_powers(np.sin(2 * np.pi * 2 * t)[None, :], fs)["delta"], 0.9)


class ConditionTests(unittest.TestCase):
    def test_alpha_ratio_for_eyes_closed_over_open(self):
        rp = lambda a: {b: (a if b == "alpha" else 0.1) for b in ea.BANDS}
        rows = [{"run": "R01", "relative_power": rp(0.2)}, {"run": "R01", "relative_power": rp(0.2)}, {"run": "R02", "relative_power": rp(0.4)}, {"run": "R04", "relative_power": rp(0.9)}]
        c = ea.condition_summary(rows)
        self.assertEqual(c["alpha_eyes_closed_over_open"], 2.0)
        self.assertEqual(c["eyes_open"]["recordings"], 2)
        self.assertNotIn("R04", json.dumps(c))


class FakeStore:
    def __init__(self, files):
        self.files, self.put_names = files, []

    def get(self, name):
        return self.files.get(name)

    def put(self, name, body, ct):
        self.put_names.append((name, body))


class RunTests(unittest.TestCase):
    def test_run_reads_only_present_files_and_writes_only_the_summary(self):
        base = ea.EDF_PREFIX
        files = {f"{base}/S001/S001R01.edf": b"open", f"{base}/S001/S001R02.edf": b"closed", "maxwell/current/eeg_runs/metrics.json": b'{"held_out_accuracy": 0.53}'}

        def fake(path):
            closed = open(path, "rb").read() == b"closed"
            return {"channels": 2, "sampling_hz": 160.0, "seconds": 60.0, "relative_power": {"delta": 0.1, "theta": 0.1, "alpha": 0.5 if closed else 0.25, "beta": 0.1, "gamma": 0.05}}

        store = FakeStore(files)
        code = ea.run(store, max_subjects=2, analyse=fake)
        self.assertEqual(code, 0)
        self.assertEqual([n for n, _ in store.put_names], ["analysis/eeg/summary.json", "analysis/eeg/latest.txt"])
        summary = json.loads(store.put_names[0][1])
        self.assertEqual(summary["recordings"], 2)
        self.assertEqual(summary["conditions"]["alpha_eyes_closed_over_open"], 2.0)
        self.assertEqual(summary["classifier"]["held_out_accuracy"], 0.53)

    def test_nothing_readable_fails(self):
        self.assertEqual(ea.run(FakeStore({}), max_subjects=1), 1)

    def test_the_store_refuses_other_paths(self):
        s = ea.Store("some-bucket", lambda: "t", opener=lambda *a, **k: None)
        with self.assertRaises(ValueError):
            s.get("vault/secret.md")
        with self.assertRaises(ValueError):
            s.put("maxwell/current/eeg_data/x", b"", "text/plain")
        with self.assertRaises(ValueError):
            s.get("maxwell/current/eeg_data/../../x")





def make_edf(signals, fs, labels=None, rec_seconds=1.0, annotations=True):
    """A small EDF(+) writer for tests: signals is a list of 1-D arrays; each record holds rec_seconds of each signal."""
    ns = len(signals) + (1 if annotations else 0)
    spr = int(fs * rec_seconds)
    nrec = len(signals[0]) // spr
    names = labels or [f"EEG{i}" for i in range(len(signals))]
    def pad(v, w):
        return str(v).ljust(w)[:w].encode()
    head = pad("0", 8) + pad("x", 80) + pad("x", 80) + pad("01.01.26", 8) + pad("00.00.00", 8) + pad(256 + ns * 256, 8) + pad("EDF+C", 44) + pad(nrec, 8) + pad(rec_seconds, 8) + pad(ns, 4)
    allnames = names + (["EDF Annotations"] if annotations else [])
    sig_samples = [spr] * len(signals) + ([20] if annotations else [])
    h = b"".join(pad(n, 16) for n in allnames) + b"".join(pad("", 80) for _ in range(ns)) + b"".join(pad("uV", 8) for _ in range(ns))
    h += b"".join(pad(-1000, 8) for _ in range(ns)) + b"".join(pad(1000, 8) for _ in range(ns)) + b"".join(pad(-32768, 8) for _ in range(ns)) + b"".join(pad(32767, 8) for _ in range(ns))
    h += b"".join(pad("", 80) for _ in range(ns)) + b"".join(pad(s, 8) for s in sig_samples) + b"".join(pad("", 32) for _ in range(ns))
    body = b""
    for r in range(nrec):
        for sg in signals:
            seg = sg[r * spr : (r + 1) * spr]
            body += np.round(seg / 1000 * 32767).astype("<i2").tobytes()
        if annotations:
            body += b"\x00" * 40
    return head + h + body


class EdfTests(unittest.TestCase):
    def test_reads_signals_scales_them_and_skips_the_annotation_channel(self):
        fs = 160.0
        t = np.arange(0, 10, 1 / fs)
        sig = 100 * np.sin(2 * np.pi * 10 * t)
        sig2 = 50 * np.sin(2 * np.pi * 10 * t + 0.5)
        data = make_edf([sig, sig2], fs)
        got, rate = ea.read_edf(data)
        self.assertEqual(rate, fs)
        self.assertEqual(got.shape, (2, len(t)))
        self.assertAlmostEqual(float(got[0].max()), 100.0, delta=1.0)

    def test_analyse_edf_finds_alpha_in_a_10_hz_recording(self):
        import os
        import tempfile
        fs = 160.0
        t = np.arange(0, 20, 1 / fs)
        with tempfile.NamedTemporaryFile(suffix=".edf", delete=False) as tmp:
            tmp.write(make_edf([200 * np.sin(2 * np.pi * 10 * t)], fs))
        try:
            r = ea.analyse_edf(tmp.name)
        finally:
            os.unlink(tmp.name)
        self.assertEqual(r["channels"], 1)
        self.assertGreater(r["relative_power"]["alpha"], 0.9)
        self.assertEqual(r["seconds"], 20.0)


if __name__ == "__main__":
    unittest.main()
