"""Independently verify a RabbitOS anchor against Bitcoin, with no account, key or funds.

An anchor is a small anchor.json (the head hashes of the RabbitOS ledger and the Maxwell chain). The anchor job sends sha256(anchor.json) to the free OpenTimestamps calendars and keeps the
proof as anchor.json.ots. This script:
  1. checks that sha256(anchor.json) equals the digest the proof is for,
  2. replays the proof's hash steps (sha256 / append / prepend ...) from that digest,
  3. finds the Bitcoin attestation (block height) and compares the replayed value with the Merkle root of that block, fetched from a public Bitcoin API (Blockstream, mempool.space).
No private data is involved: only a hash and a block height go to the Bitcoin API.

    python verify-anchor.py 2026-10-17T070013Z                    # downloads anchor.json and .ots from the public ledger bucket
    python verify-anchor.py --json anchor.json --ots anchor.json.ots
"""

import argparse
import hashlib
import json
import sys
import urllib.request

BUCKET = "https://rabbitsoftware-io-ledger-public.storage.googleapis.com/anchors"
MAGIC = bytes.fromhex("004f70656e54696d657374616d7073000050726f6f6600bf89e2e884e89294")
BITCOIN = bytes.fromhex("0588960d73d71901")
PENDING = bytes.fromhex("83dfe30d2ef90c8e")
HASH_OPS = {0x02: "sha1", 0x03: "ripemd160", 0x08: "sha256"}
APIS = ["https://blockstream.info/api", "https://mempool.space/api"]


class Reader:
    def __init__(self, data):
        self.data, self.pos = data, 0

    def byte(self):
        if self.pos >= len(self.data):
            raise ValueError("proof ends unexpectedly")
        self.pos += 1
        return self.data[self.pos - 1]

    def take(self, n):
        if self.pos + n > len(self.data):
            raise ValueError("proof ends unexpectedly")
        self.pos += n
        return self.data[self.pos - n:self.pos]

    def varuint(self):
        value, shift = 0, 0
        while True:
            b = self.byte()
            value |= (b & 0x7F) << shift
            if not b & 0x80:
                return value
            shift += 7

    def varbytes(self):
        return self.take(self.varuint())

    @property
    def done(self):
        return self.pos >= len(self.data)


def walk(reader, message, leaves, depth=0):
    """Replays one timestamp tree. leaves gets (kind, replayed message, detail) for every attestation."""
    if depth > 200:
        raise ValueError("proof is nested too deeply")
    while True:
        tag = reader.byte()
        if tag == 0xFF:                      # a fork: this branch, then the next one
            walk(reader, message, leaves, depth + 1)
            continue
        if tag == 0x00:                      # an attestation
            kind, payload = reader.take(8), Reader(reader.varbytes())
            if kind == BITCOIN:
                leaves.append(("bitcoin", message, payload.varuint()))
            elif kind == PENDING:
                leaves.append(("pending", message, payload.varbytes().decode("utf-8", "replace")))
            else:
                leaves.append(("unknown", message, kind.hex()))
            return
        if tag in HASH_OPS:
            message = hashlib.new(HASH_OPS[tag], message).digest()
        elif tag == 0xF0:
            message = message + reader.varbytes()
        elif tag == 0xF1:
            message = reader.varbytes() + message
        elif tag == 0xF2:
            message = message[::-1]
        elif tag == 0xF3:
            message = message.hex().encode()
        else:
            raise ValueError(f"unknown operation 0x{tag:02x}")
        if reader.done:
            return


def parse_ots(data):
    reader = Reader(data)
    if reader.take(len(MAGIC)) != MAGIC:
        raise ValueError("not an OpenTimestamps proof")
    if reader.varuint() != 1:
        raise ValueError("unsupported proof version")
    if reader.byte() != 0x08:
        raise ValueError("proof is not for a sha256 digest")
    digest = reader.take(32)
    leaves = []
    walk(reader, digest, leaves)
    return digest, leaves


def fetch(url, binary=False):
    request = urllib.request.Request(url, headers={"user-agent": "rabbitos-verify-anchor/1.0"})
    body = urllib.request.urlopen(request, timeout=30).read()
    return body if binary else body.decode()


def block_merkle_root(height):
    last = None
    for api in APIS:
        try:
            block_hash = fetch(f"{api}/block-height/{height}").strip()
            return json.loads(fetch(f"{api}/block/{block_hash}"))["merkle_root"], block_hash, api
        except Exception as error:  # try the next public API
            last = error
    raise RuntimeError(f"no Bitcoin API answered: {last}")


def verify(anchor_bytes, ots_bytes, lookup=block_merkle_root):
    digest, leaves = parse_ots(ots_bytes)
    report = {"digest": digest.hex(), "digest_matches_anchor": hashlib.sha256(anchor_bytes).digest() == digest, "attestations": []}
    for kind, message, detail in leaves:
        if kind == "bitcoin":
            root, block_hash, api = lookup(detail)
            report["attestations"].append({"type": "bitcoin", "height": detail, "block_hash": block_hash, "merkle_root_in_block": root,
                                           "replayed": message[::-1].hex(), "matches": message[::-1].hex() == root})
        else:
            report["attestations"].append({"type": kind, "detail": detail})
    bitcoin = [a for a in report["attestations"] if a["type"] == "bitcoin"]
    report["verified"] = report["digest_matches_anchor"] and bool(bitcoin) and all(a["matches"] for a in bitcoin)
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("anchor_id", nargs="?")
    parser.add_argument("--json")
    parser.add_argument("--ots")
    args = parser.parse_args()
    if args.anchor_id:
        anchor_bytes = fetch(f"{BUCKET}/{args.anchor_id}/anchor.json", True)
        ots_bytes = fetch(f"{BUCKET}/{args.anchor_id}/anchor.json.ots", True)
    elif args.json and args.ots:
        anchor_bytes, ots_bytes = open(args.json, "rb").read(), open(args.ots, "rb").read()
    else:
        parser.error("give an anchor id, or --json and --ots")
    report = verify(anchor_bytes, ots_bytes)
    print(json.dumps(report, indent=1))
    return 0 if report["verified"] else 1


if __name__ == "__main__":
    sys.exit(main())
