import io
import json
import os
import sys
import unittest
import urllib.error
from datetime import datetime, timezone

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))
import anchor as A
from opentimestamps.core.notary import BitcoinBlockHeaderAttestation, PendingAttestation
from opentimestamps.core.op import OpSHA256
from opentimestamps.core.timestamp import Timestamp

NOW = datetime(2026, 10, 15, 21, 0, 0, tzinfo=timezone.utc)
HEAD = {"length": 8, "headHash": "be17681f" * 8}
BLOCKS = [{"index": 0, "hash": "a" * 64}, {"index": 3, "hash": "b" * 64}]


class FakeCalendar:
    confirmed = set()
    submitted = []

    def __init__(self, url):
        self.url = url

    def submit(self, digest, timeout=None):
        FakeCalendar.submitted.append((self.url, digest))
        ts = Timestamp(digest)
        ts.attestations.add(PendingAttestation(self.url))
        return ts

    def get_timestamp(self, commitment, timeout=None):
        if self.url not in FakeCalendar.confirmed:
            raise KeyError("pending")
        ts = Timestamp(commitment)
        ts.attestations.add(BitcoinBlockHeaderAttestation(812345))
        return ts


class FakeBucket(A.Bucket):
    def __init__(self):
        self.name, self.objects, self.writes = "my-ledger", {}, []

    def get(self, obj):
        self._check(obj)
        return self.objects.get(obj)

    def put(self, obj, body, content_type):
        self._check(obj)
        self.objects[obj] = body
        self.writes.append(obj)


def fetch(url):
    return HEAD if url.endswith("/api/chain/head") else {"blocks": BLOCKS}


def go(bucket, now=NOW):
    return A.run(bucket=bucket, fetch_json=fetch, now=now, stamp_fn=lambda d: A.stamp(d, calendars=("https://cal.one", "https://cal.two"), make_calendar=FakeCalendar, nonce=b"n" * 16),
                 upgrade_fn=lambda o: A.upgrade(o, make_calendar=FakeCalendar))


class Anchor(unittest.TestCase):
    def setUp(self):
        FakeCalendar.confirmed = set()
        FakeCalendar.submitted = []

    def test_the_document_is_public_facts_only_and_the_digest_is_stable(self):
        doc = A.build_document(HEAD, BLOCKS, NOW)
        self.assertEqual(set(doc), {"v", "kind", "date", "ledger", "maxwell"})
        self.assertEqual(A.digest_of(doc), A.digest_of(A.build_document(HEAD, BLOCKS, NOW)))
        later = A.build_document(HEAD, BLOCKS, datetime(2026, 10, 16, tzinfo=timezone.utc))
        self.assertNotEqual(A.digest_of(doc), A.digest_of(later))
        self.assertEqual(A.inputs_key(doc), A.inputs_key(later))  # a new day alone is not a reason to anchor

    def test_stamping_commits_to_the_digest_through_a_nonce_and_survives_a_dead_calendar(self):
        digest = A.digest_of(A.build_document(HEAD, BLOCKS, NOW))

        class Flaky(FakeCalendar):
            def submit(self, d, timeout=None):
                if "dead" in self.url:
                    raise OSError("down")
                return super().submit(d, timeout)

        ots, ok = A.stamp(digest, calendars=("https://dead", "https://alive"), make_calendar=Flaky, nonce=b"n" * 16)
        self.assertEqual(ok, ["https://alive"])
        loaded = A.load(ots)
        self.assertEqual(loaded.file_digest, digest)
        self.assertNotEqual(FakeCalendar.submitted[0][1], digest)  # the calendar never sees the digest itself
        with self.assertRaises(ConnectionError):
            A.stamp(digest, calendars=("https://dead",), make_calendar=Flaky)

    def test_first_run_stores_the_document_and_a_pending_proof(self):
        b = FakeBucket()
        self.assertEqual(go(b), 0)
        index = json.loads(b.objects["anchors/index.json"])
        self.assertEqual(len(index), 1)
        self.assertEqual(index[0]["status"], "pending")
        doc = json.loads(b.objects[f"anchors/{index[0]['id']}/anchor.json"])
        self.assertEqual(A.digest_of(doc).hex(), index[0]["digest"])
        self.assertEqual(json.loads(b.objects["anchors/latest.json"])["id"], index[0]["id"])
        self.assertTrue(all(w.startswith("anchors/") for w in b.writes))

    def test_unchanged_heads_make_no_new_anchor(self):
        b = FakeBucket()
        go(b)
        before = len(json.loads(b.objects["anchors/index.json"]))
        go(b, datetime(2026, 10, 16, 21, 0, 0, tzinfo=timezone.utc))
        self.assertEqual(len(json.loads(b.objects["anchors/index.json"])), before)

    def test_a_confirmed_calendar_upgrades_the_proof_to_a_bitcoin_block(self):
        b = FakeBucket()
        go(b)
        entry = json.loads(b.objects["anchors/index.json"])[0]
        FakeCalendar.confirmed = {"https://cal.one"}
        go(b, datetime(2026, 10, 15, 23, 0, 0, tzinfo=timezone.utc))
        entry = json.loads(b.objects["anchors/index.json"])[0]
        self.assertEqual((entry["status"], entry["bitcoinHeight"]), ("confirmed", 812345))
        loaded = A.load(b.objects[f"anchors/{entry['id']}/anchor.json.ots"])
        self.assertEqual(A.bitcoin_height(loaded), 812345)
        again = A.upgrade(b.objects[f"anchors/{entry['id']}/anchor.json.ots"], make_calendar=FakeCalendar)
        self.assertEqual(again[2], 812345)

    def test_still_pending_proofs_are_left_alone(self):
        b = FakeBucket()
        go(b)
        ots = b.objects[f"anchors/{json.loads(b.objects['anchors/index.json'])[0]['id']}/anchor.json.ots"]
        new, changed, height = A.upgrade(ots, make_calendar=FakeCalendar)
        self.assertEqual((new, changed, height), (ots, False, None))

    def test_only_the_anchors_prefix_can_be_written_and_bad_names_are_refused(self):
        b = FakeBucket()
        for bad in ("maxwell/maxwell_chain.json", "ledger/chain_head.json", "anchors/../maxwell/x", "/anchors/x"):
            with self.assertRaises(ValueError):
                b.put(bad, b"x", "text/plain")
        with self.assertRaises(ValueError):
            A.Bucket("Bad Bucket!", lambda: "t")

    def test_unreadable_chains_are_a_clean_failure_that_writes_nothing(self):
        b = FakeBucket()

        def broken(url):
            raise urllib.error.URLError("down")

        self.assertEqual(A.run(bucket=b, fetch_json=broken, now=NOW), 1)
        self.assertEqual(b.writes, [])


if __name__ == "__main__":
    unittest.main()
