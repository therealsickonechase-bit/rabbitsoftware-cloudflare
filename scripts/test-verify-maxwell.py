import hashlib
import importlib.util
import json
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location("verify_maxwell", Path(__file__).with_name("verify-maxwell.py"))
vm = importlib.util.module_from_spec(spec)
spec.loader.exec_module(vm)


def mine(index, timestamp, transactions, previous_hash, difficulty=2):
    block = {"index": index, "timestamp": timestamp, "transactions": transactions, "previous_hash": previous_hash, "nonce": 0}
    block["hash"] = vm.block_hash(block)
    while not block["hash"].startswith("0" * difficulty):
        block["nonce"] += 1
        block["hash"] = vm.block_hash(block)
    return block


def rows(n, offset=0):
    return [{"id": f"pubmed:{i}", "source": "pubmed", "title": f"Paper {i}", "url": f"https://pubmed.ncbi.nlm.nih.gov/{i}/", "topic_id": None, "run_id": None,
             "first_seen_at": f"2026-10-16T10:{i % 60:02d}:00+00:00"} for i in range(offset, offset + n)]


def chain_with_anchor(recs, when=1792170000.0):
    genesis = {"index": 0, "timestamp": 1792000000.0, "transactions": [{"sender": "MAXWELL_GENESIS", "immutable_anchor_sha": vm.HELLO_WORLD}], "previous_hash": "0" * 64, "nonce": 0}
    genesis["hash"] = vm.block_hash(genesis)
    root, count = vm.merkle_root(recs)
    b1 = mine(1, when, [{"sender": "RESEARCH_ANCHOR", "root": root, "count": count}], genesis["hash"])
    return {"difficulty": 2, "blocks": [genesis, b1]}


class Maxwell(unittest.TestCase):
    def test_an_honest_chain_and_its_research_anchor_verify(self):
        recs = rows(7)
        data = chain_with_anchor(recs)
        problems, _ = vm.verify_chain(data)
        self.assertEqual(problems, [])
        self.assertTrue(all(a["ok"] for a in vm.verify_research_anchors(data["blocks"], recs)))

    def test_records_added_after_the_block_are_ignored_but_a_changed_record_is_caught(self):
        recs = rows(7)
        data = chain_with_anchor(recs)
        later = rows(3, offset=100)
        for r in later:
            r["first_seen_at"] = "2030-01-01T00:00:00+00:00"
        self.assertTrue(vm.verify_research_anchors(data["blocks"], recs + later)[0]["ok"])
        edited = [dict(r) for r in recs]
        edited[2]["title"] = "Paper 2 (edited)"
        result = vm.verify_research_anchors(data["blocks"], edited)[0]
        self.assertFalse(result["ok"])
        self.assertEqual(result["rebuilt_count"], 7)               # same count, different root: a record was edited in place
        self.assertFalse(vm.verify_research_anchors(data["blocks"], recs[:6])[0]["ok"])    # a record was removed

    def test_tampering_is_found(self):
        base = chain_with_anchor(rows(4))
        # changed contents
        data = json.loads(json.dumps(base)); data["blocks"][1]["transactions"][0]["count"] = 5
        self.assertTrue(any("does not match its contents" in p for p in vm.verify_chain(data)[0]))
        # broken link
        data = json.loads(json.dumps(base)); data["blocks"][1]["previous_hash"] = "f" * 64
        self.assertTrue(any("previous_hash" in p for p in vm.verify_chain(data)[0]))
        # no proof of work
        weak = json.loads(json.dumps(base)); b = weak["blocks"][1]
        while b["hash"].startswith("0"):
            b["nonce"] += 1; b["hash"] = vm.block_hash(b)
        self.assertTrue(any("proof-of-work" in p for p in vm.verify_chain(weak)[0]))
        # wrong genesis anchor, wrong index, empty chain
        data = json.loads(json.dumps(base)); data["blocks"][0]["transactions"][0]["immutable_anchor_sha"] = "0" * 64
        self.assertTrue(any("hello world" in p for p in vm.verify_chain(data)[0]))
        self.assertTrue(vm.verify_chain({"blocks": []})[0])
        self.assertTrue(vm.verify_chain({"blocks": [{"nope": 1}]})[0])

    def test_leaf_rule_is_the_documented_one(self):
        r = {"id": "a:1", "source": "s", "title": "t", "url": None, "topic_id": None, "run_id": None, "first_seen_at": "x", "extra": "ignored"}
        expected = hashlib.sha256(b'{"first_seen_at":"x","id":"a:1","run_id":null,"source":"s","title":"t","topic_id":null,"url":null}').hexdigest()
        self.assertEqual(vm.merkle_root([r])[0], expected)          # a single leaf is its own root
        a, b, c = rows(3)
        left = hashlib.sha256(vm.canonical(a)).digest(); mid = hashlib.sha256(vm.canonical(b)).digest(); right = hashlib.sha256(vm.canonical(c)).digest()
        want = hashlib.sha256(hashlib.sha256(left + mid).digest() + hashlib.sha256(right + right).digest()).hexdigest()   # odd node duplicated
        self.assertEqual(vm.merkle_root([c, a, b])[0], want)         # sorted by id, order of input does not matter


if __name__ == "__main__":
    unittest.main()
