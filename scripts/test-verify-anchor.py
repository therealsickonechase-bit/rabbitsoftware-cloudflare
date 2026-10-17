import hashlib
import json
import importlib.util
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location("verify_anchor", Path(__file__).with_name("verify-anchor.py"))
va = importlib.util.module_from_spec(spec)
spec.loader.exec_module(va)

ANCHOR = b'{"kind":"rabbitos-anchor","maxwell":{"headIndex":12}}'


def varbytes(b):
    return bytes([len(b)]) + b


def proof(digest, steps_then_leaf):
    return va.MAGIC + b"\x01\x08" + digest + steps_then_leaf


def two(root):
    """What two independent public sources would answer for one block."""
    return [{"source": "mempool.space", "root": root, "block_hash": "ab" * 32}, {"source": "blockstream.info", "root": root, "block_hash": "ab" * 32}]


def replay(digest, salt):
    return hashlib.sha256(digest + salt).digest()


class Verify(unittest.TestCase):
    def build(self, height=500000):
        digest = hashlib.sha256(ANCHOR).digest()
        salt = b"salt"
        # append salt, sha256, then a Bitcoin attestation for `height`; plus a fork holding a pending calendar attestation
        bitcoin = b"\x00" + va.BITCOIN + varbytes(bytes([0xE0, 0xA7, 0x1F]))   # 3-byte varuint is wrong for any real height, so use a single-byte payload below
        bitcoin = b"\x00" + va.BITCOIN + varbytes(bytes([height & 0x7F]))
        pending = b"\x00" + va.PENDING + varbytes(varbytes(b"https://alice.btc.calendar.opentimestamps.org"))
        body = b"\xff" + pending + b"\xf0" + varbytes(salt) + b"\x08" + bitcoin
        return digest, proof(digest, body), replay(digest, salt)

    def test_parse_and_verify_against_the_block_root(self):
        digest, ots, merged = self.build(height=100)
        _, leaves = va.parse_ots(ots)
        self.assertEqual([k for k, _, _ in leaves], ["pending", "bitcoin"])
        root = merged[::-1].hex()
        report = va.verify(ANCHOR, ots, lookup=lambda h: two(root))
        self.assertTrue(report["verified"] and report["digest_matches_anchor"])
        self.assertEqual(report["attestations"][1]["height"], 100)
        self.assertEqual(report["attestations"][1]["sources"], ["blockstream.info", "mempool.space"])

    def test_wrong_root_wrong_anchor_and_garbage_fail(self):
        digest, ots, merged = self.build(height=100)
        report = va.verify(ANCHOR, ots, lookup=lambda h: two("00" * 32))
        self.assertFalse(report["verified"])
        root = merged[::-1].hex()
        report = va.verify(ANCHOR + b" ", ots, lookup=lambda h: two(root))
        self.assertFalse(report["verified"])                       # the anchor file was changed
        for bad in (b"", b"not a proof", ots[:40], ots[:-1]):
            with self.assertRaises(ValueError):
                va.parse_ots(bad)

    def test_pending_only_is_not_verified(self):
        digest = hashlib.sha256(ANCHOR).digest()
        pending = b"\x00" + va.PENDING + varbytes(varbytes(b"https://alice.btc.calendar.opentimestamps.org"))
        report = va.verify(ANCHOR, proof(digest, pending), lookup=lambda h: [])
        self.assertFalse(report["verified"])
        self.assertEqual(report["attestations"][0]["type"], "pending")

    def test_one_source_is_not_enough_and_two_that_disagree_are_a_red_flag(self):
        digest, ots, merged = self.build(height=100)
        root = merged[::-1].hex()
        one = va.verify(ANCHOR, ots, lookup=lambda h: two(root)[:1])
        self.assertFalse(one["verified"])
        self.assertIn("only 1 Bitcoin source", one["attestations"][1]["problem"])
        self.assertTrue(va.verify(ANCHOR, ots, lookup=lambda h: two(root)[:1], min_sources=1)["verified"])      # the reader may lower the bar on purpose
        split = va.verify(ANCHOR, ots, lookup=lambda h: [two(root)[0], two("11" * 32)[1]])
        self.assertFalse(split["verified"])
        self.assertFalse(split["attestations"][1]["sources_agree"])
        self.assertIn("disagree", split["attestations"][1]["problem"])
        none = va.verify(ANCHOR, ots, lookup=lambda h: [])                                                       # no source answered at all
        self.assertFalse(none["verified"])

    def test_your_own_bitcoin_core_counts_as_a_source(self):
        calls = []
        def post(url, body):
            req = json.loads(body); calls.append(req["method"])
            return {"result": "ab" * 32} if req["method"] == "getblockhash" else {"result": {"merkleroot": "cd" * 32}}
        a = va.core_answer("http://127.0.0.1:8332", 100, post=post)
        self.assertEqual((a["source"], a["root"], a["block_hash"], calls), ("your Bitcoin Core", "cd" * 32, "ab" * 32, ["getblockhash", "getblockheader"]))
        digest, ots, merged = self.build(height=100)
        root = merged[::-1].hex()
        mixed = va.verify(ANCHOR, ots, lookup=lambda h: [two(root)[0], {"source": "your Bitcoin Core", "root": root, "block_hash": "ab" * 32}])
        self.assertTrue(mixed["verified"])
        self.assertEqual(mixed["attestations"][1]["sources"], ["mempool.space", "your Bitcoin Core"])


PINNED = "c6867caacb63ad03604780cc5ca64c0a2cb7bbffe603bfaa0bc7562fe017b3d4"      # the same vector is pinned in workers/anchor-job/test/test_anchor.py


class SnapshotCommitment(unittest.TestCase):
    files = {"0001": "a" * 64, "0003": "b" * 64}

    def doc(self, **over):
        m = va.manifest_of(self.files)
        return {"snapshots": {**m, **over}}

    def test_the_manifest_rule_matches_the_anchor_job(self):
        self.assertEqual(va.manifest_of(self.files)["manifest"], PINNED)

    def test_a_matching_list_and_matching_files_pass(self):
        listing = {"files": {**self.files, "0007": "c" * 64}}               # a newer block beyond upTo is not covered by this anchor
        bodies = {1: b"one", 3: b"three"}
        files = {"0001": hashlib.sha256(b"one").hexdigest(), "0003": hashlib.sha256(b"three").hexdigest()}
        doc = {"snapshots": va.manifest_of(files)}
        r = va.check_snapshot_commitment(doc, {"files": {**files, "0007": "c" * 64}}, bodies.get)
        self.assertEqual((r["committed"], r["ok"], r["count"], r["problems"]), (True, True, 2, []))
        self.assertEqual(va.check_snapshot_commitment({"v": 1}, listing)["committed"], False)      # an older anchor commits to nothing and is not penalised

    def test_a_changed_list_a_changed_file_and_a_missing_file_are_caught(self):
        files = {"0001": hashlib.sha256(b"one").hexdigest(), "0003": hashlib.sha256(b"three").hexdigest()}
        doc = {"snapshots": va.manifest_of(files)}
        swapped = va.check_snapshot_commitment(doc, {"files": {**files, "0003": "0" * 64}})
        self.assertFalse(swapped["ok"])                                      # the list was altered after anchoring
        tampered = va.check_snapshot_commitment(doc, {"files": files}, {1: b"one", 3: b"EDITED"}.get)
        self.assertFalse(tampered["ok"])
        self.assertIn("does not match its hash", tampered["problems"][0])
        missing = va.check_snapshot_commitment(doc, {"files": files}, {1: b"one"}.get)
        self.assertIn("missing", missing["problems"][0])


if __name__ == "__main__":
    unittest.main()
