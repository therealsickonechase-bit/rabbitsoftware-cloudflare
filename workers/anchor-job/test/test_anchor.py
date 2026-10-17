import hashlib
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


def fake_tsr(digest):
    """A DER-shaped TimeStampResp: SEQUENCE { SEQUENCE { INTEGER 0 (granted) } ... the digest ... }."""
    inner = bytes.fromhex("3003020100") + bytes([0x04, 0x20]) + digest + bytes(80)
    return bytes([0x30, 0x82]) + len(inner).to_bytes(2, "big") + inner


def no_snapshots(url):
    return None


def go(bucket, now=NOW, tsa_fn=fake_tsr, fetch_bytes=no_snapshots):
    return A.run(bucket=bucket, fetch_json=fetch, now=now, stamp_fn=lambda d: A.stamp(d, calendars=("https://cal.one", "https://cal.two"), make_calendar=FakeCalendar, nonce=b"n" * 16),
                 upgrade_fn=lambda o: A.upgrade(o, make_calendar=FakeCalendar), tsa_fn=tsa_fn, fetch_bytes=fetch_bytes)


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

RA_BLOCKS = [{"index": 0, "hash": "a" * 64, "transactions": [{"sender": "MAXWELL_GENESIS"}]},
             {"index": 1, "hash": "b" * 64, "transactions": [{"sender": "RESEARCH_ANCHOR", "root": "r" * 64, "count": 3}]},
             {"index": 2, "hash": "c" * 64, "transactions": [{"sender": "RABBITWEB_MINER"}]},
             {"index": 3, "hash": "d" * 64, "transactions": [{"sender": "RESEARCH_ANCHOR", "root": "s" * 64, "count": 4}]}]
FILES = {"https://my-ledger.storage.googleapis.com/maxwell/snapshots/block-0001.ndjson.gz": b"one", "https://my-ledger.storage.googleapis.com/maxwell/snapshots/block-0003.ndjson.gz": b"three"}


class SnapshotCommitment(unittest.TestCase):
    def setUp(self):
        FakeCalendar.confirmed = set()

    def test_the_manifest_can_be_recomputed_by_anyone(self):
        files = {"0001": hashlib.sha256(b"one").hexdigest(), "0003": hashlib.sha256(b"three").hexdigest()}
        m = A.manifest_of(files)
        self.assertEqual((m["count"], m["upTo"]), (2, 3))
        self.assertEqual(A.manifest_of({"0001": "a" * 64, "0003": "b" * 64})["manifest"], "c6867caacb63ad03604780cc5ca64c0a2cb7bbffe603bfaa0bc7562fe017b3d4")   # pinned: scripts/verify-anchor.py must agree
        expected = hashlib.sha256((f"0001 {files['0001']}\n" + f"0003 {files['0003']}\n").encode()).hexdigest()
        self.assertEqual(m["manifest"], expected)
        self.assertEqual(A.manifest_of(dict(reversed(list(files.items()))))["manifest"], expected)          # block order, not insertion order
        self.assertNotEqual(A.manifest_of({**files, "0003": "0" * 64})["manifest"], expected)               # any changed file changes it

    def test_only_research_anchor_blocks_are_looked_up_and_known_hashes_are_not_fetched_again(self):
        asked = []
        def fetch_bytes(url):
            asked.append(url)
            return FILES.get(url)
        got = A.collect_snapshots(RA_BLOCKS, {}, "https://my-ledger.storage.googleapis.com", fetch_bytes)
        self.assertEqual(sorted(got), ["0001", "0003"])
        self.assertEqual(len(asked), 2)                                                                       # blocks 0 and 2 are not research anchors
        asked.clear()
        again = A.collect_snapshots(RA_BLOCKS, got, "https://my-ledger.storage.googleapis.com", fetch_bytes)
        self.assertEqual((again, asked), (got, []))
        def broken(url):
            raise OSError("down")
        self.assertEqual(A.collect_snapshots(RA_BLOCKS, {"0001": got["0001"]}, "https://x", broken), {"0001": got["0001"]})   # a failure keeps what is known

    def test_a_document_without_snapshots_is_unchanged_and_with_them_commits_to_the_manifest(self):
        plain = A.build_document(HEAD, BLOCKS, NOW)
        self.assertNotIn("snapshots", plain)
        files = {"0001": "a" * 64}
        doc = A.build_document(HEAD, BLOCKS, NOW, files)
        self.assertEqual(doc["snapshots"], A.manifest_of(files))
        self.assertNotEqual(A.digest_of(doc), A.digest_of(plain))
        self.assertNotEqual(A.inputs_key(doc), A.inputs_key(plain))                                           # new snapshots are a reason to anchor

    def test_a_run_publishes_the_snapshot_hashes_and_anchors_the_manifest_once(self):
        def fetch_chain(url):
            return HEAD if url.endswith("/api/chain/head") else {"blocks": RA_BLOCKS}
        b = FakeBucket()
        b.name = "my-ledger"
        def run_once(now):
            return A.run(bucket=b, fetch_json=fetch_chain, now=now, stamp_fn=lambda d: A.stamp(d, calendars=("https://cal.one",), make_calendar=FakeCalendar, nonce=b"n" * 16),
                         upgrade_fn=lambda o: A.upgrade(o, make_calendar=FakeCalendar), tsa_fn=fake_tsr, fetch_bytes=FILES.get)
        self.assertEqual(run_once(NOW), 0)
        listing = json.loads(b.objects["anchors/snapshots.json"])
        self.assertEqual(sorted(listing["files"]), ["0001", "0003"])
        index = json.loads(b.objects["anchors/index.json"])
        doc = json.loads(b.objects[f"anchors/{index[0]['id']}/anchor.json"])
        self.assertEqual(doc["snapshots"], {"count": 2, "upTo": 3, "manifest": listing["manifest"]})
        self.assertEqual(index[0]["snapshots"], 2)
        self.assertEqual(run_once(datetime(2026, 10, 15, 22, 0, tzinfo=timezone.utc)), 0)                     # nothing changed: no second anchor
        self.assertEqual(len(json.loads(b.objects["anchors/index.json"])), 1)


class SecondWitness(unittest.TestCase):
    def setUp(self):
        FakeCalendar.confirmed = set()

    def test_the_request_is_a_valid_rfc3161_query_for_the_digest(self):
        d = bytes(range(32))
        q = A.tsa_request(d)
        self.assertEqual(len(q), 59)
        self.assertEqual(q[:2], bytes([0x30, 0x39]))
        self.assertTrue(q.endswith(bytes.fromhex("0101ff")))
        self.assertIn(d, q)
        with self.assertRaises(ValueError):
            A.tsa_request(b"short")

    def test_only_a_granted_reply_naming_the_digest_is_accepted(self):
        d = bytes(range(32))
        self.assertTrue(A.tsa_response_ok(fake_tsr(d), d))
        self.assertFalse(A.tsa_response_ok(fake_tsr(bytes(32)), d))                    # reply for a different digest
        rejected = bytearray(fake_tsr(d)); rejected[8] = 2                              # PKIStatus: rejection
        self.assertFalse(A.tsa_response_ok(bytes(rejected), d))
        for bad in (b"", b"<html>error</html>" * 20, fake_tsr(d)[:50]):
            self.assertFalse(A.tsa_response_ok(bad, d))

    def test_tsa_stamp_posts_the_query_and_refuses_a_bad_reply(self):
        d = bytes(range(32))
        sent = {}
        def ok(url, body):
            sent["url"], sent["body"] = url, body
            return fake_tsr(d)
        self.assertEqual(A.tsa_stamp(d, post=ok), fake_tsr(d))
        self.assertEqual((sent["url"], sent["body"]), (A.TSA_URL, A.tsa_request(d)))
        with self.assertRaises(ValueError):
            A.tsa_stamp(d, post=lambda u, b: b"nope")

    def test_every_new_anchor_gets_a_tsr_and_the_index_says_so(self):
        b = FakeBucket()
        self.assertEqual(go(b), 0)
        index = json.loads(b.objects["anchors/index.json"])
        self.assertEqual(index[0]["tsa"], "freetsa.org")
        self.assertIn(f"anchors/{index[0]['id']}/anchor.json.tsr", b.objects)
        digest = bytes.fromhex(index[0]["digest"])
        self.assertTrue(A.tsa_response_ok(b.objects[f"anchors/{index[0]['id']}/anchor.json.tsr"], digest))

    def test_a_dead_authority_never_blocks_the_bitcoin_anchor(self):
        def down(d):
            raise OSError("freetsa is down")
        b = FakeBucket()
        self.assertEqual(go(b, tsa_fn=down), 0)
        index = json.loads(b.objects["anchors/index.json"])
        self.assertIsNone(index[0]["tsa"])
        self.assertIn(f"anchors/{index[0]['id']}/anchor.json.ots", b.objects)
        self.assertNotIn(f"anchors/{index[0]['id']}/anchor.json.tsr", b.objects)



if __name__ == "__main__":
    unittest.main()
