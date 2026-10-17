import hashlib
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
        report = va.verify(ANCHOR, ots, lookup=lambda h: (root, "blockhash", "api"))
        self.assertTrue(report["verified"] and report["digest_matches_anchor"])
        self.assertEqual(report["attestations"][1]["height"], 100)

    def test_wrong_root_wrong_anchor_and_garbage_fail(self):
        digest, ots, merged = self.build(height=100)
        report = va.verify(ANCHOR, ots, lookup=lambda h: ("00" * 32, "b", "api"))
        self.assertFalse(report["verified"])
        root = merged[::-1].hex()
        report = va.verify(ANCHOR + b" ", ots, lookup=lambda h: (root, "b", "api"))
        self.assertFalse(report["verified"])                       # the anchor file was changed
        for bad in (b"", b"not a proof", ots[:40], ots[:-1]):
            with self.assertRaises(ValueError):
                va.parse_ots(bad)

    def test_pending_only_is_not_verified(self):
        digest = hashlib.sha256(ANCHOR).digest()
        pending = b"\x00" + va.PENDING + varbytes(varbytes(b"https://alice.btc.calendar.opentimestamps.org"))
        report = va.verify(ANCHOR, proof(digest, pending), lookup=lambda h: ("", "", ""))
        self.assertFalse(report["verified"])
        self.assertEqual(report["attestations"][0]["type"], "pending")


if __name__ == "__main__":
    unittest.main()
