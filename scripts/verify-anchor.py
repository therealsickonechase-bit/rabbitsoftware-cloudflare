"""Independently verify a RabbitOS anchor against Bitcoin, with no account, key or funds.

An anchor is a small anchor.json (the head hashes of the RabbitOS ledger and the Maxwell chain). The anchor job sends sha256(anchor.json) to the free OpenTimestamps calendars and keeps the
proof as anchor.json.ots. This script:
  1. checks that sha256(anchor.json) equals the digest the proof is for,
  2. replays the proof's hash steps (sha256 / append / prepend ...) from that digest,
  3. finds the Bitcoin attestation (block height) and compares the replayed value with the Merkle root of that block. The root is asked of EVERY source (mempool.space, Blockstream
     and, if you give --bitcoin-rpc, your own Bitcoin Core) and at least --min-sources (default 2) different sources must answer and agree; one lying or broken site cannot decide it.
  4. Newer anchors also commit to the saved research-record sets (maxwell/snapshots/block-NNNN.ndjson.gz): the script recomputes the manifest hash from
     anchors/snapshots.json, compares it with the one inside anchor.json, and re-downloads every covered file to check its SHA-256. So Bitcoin vouches for
     those record sets too, not only for the chain heads.
No private data is involved: only a hash and a block height go to the Bitcoin API.

    python verify-anchor.py 2026-10-17T070013Z                    # downloads anchor.json and .ots from the public ledger bucket
    python verify-anchor.py --json anchor.json --ots anchor.json.ots
"""

import argparse
import hashlib
import json
import os
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


def manifest_of(files):
    """Same rule as the anchor job: SHA-256 of the lines "<block> <sha256>\n" in block order."""
    lines = "".join(f"{k} {files[k]}\n" for k in sorted(files))
    return {"count": len(files), "upTo": int(max(files)) if files else None, "manifest": hashlib.sha256(lines.encode()).hexdigest()}


def check_snapshot_commitment(doc, listing, fetch_file=None):
    """doc: the parsed anchor.json. listing: anchors/snapshots.json. Returns {committed, ok, problems}. `fetch_file(block)` returns the file bytes (or None) to re-hash each one."""
    commit = doc.get("snapshots")
    if not commit:
        return {"committed": False, "ok": True, "problems": []}
    problems = []
    covered = {k: v for k, v in (listing.get("files") or {}).items() if int(k) <= commit.get("upTo", -1)}
    if manifest_of(covered) != {"count": commit.get("count"), "upTo": commit.get("upTo"), "manifest": commit.get("manifest")}:
        problems.append("the published list of snapshot hashes does not reproduce the manifest inside anchor.json")
    if fetch_file:
        for k, want in sorted(covered.items()):
            body = fetch_file(int(k))
            if body is None:
                problems.append(f"block {k}: the saved record set is missing")
            elif hashlib.sha256(body).hexdigest() != want:
                problems.append(f"block {k}: the saved record set does not match its hash")
    return {"committed": True, "ok": not problems, "count": len(covered), "problems": problems}


def fetch(url, binary=False):
    request = urllib.request.Request(url, headers={"user-agent": "rabbitos-verify-anchor/1.0"})
    body = urllib.request.urlopen(request, timeout=30).read()
    return body if binary else body.decode()


def rest_answer(api, height, getter=None):
    """One public REST source (mempool.space / Esplora style): {"source", "root", "block_hash"}."""
    getter = getter or fetch
    block_hash = getter(f"{api}/block-height/{height}").strip()
    return {"source": api.split("//")[1].split("/")[0], "root": json.loads(getter(f"{api}/block/{block_hash}"))["merkle_root"], "block_hash": block_hash}


def core_answer(url, height, post=None, user=None, password=None):
    """Your own Bitcoin Core, over its JSON-RPC (getblockhash, getblockheader). Credentials come from BITCOIN_RPC_USER / BITCOIN_RPC_PASSWORD or the arguments, never from the command line."""
    import base64
    def call(method, params):
        body = json.dumps({"jsonrpc": "1.0", "id": "verify-anchor", "method": method, "params": params}).encode()
        if post:
            return post(url, body)
        request = urllib.request.Request(url, body, {"content-type": "application/json", "user-agent": "rabbitos-verify-anchor/1.0"})
        u, pw = user or os.environ.get("BITCOIN_RPC_USER"), password or os.environ.get("BITCOIN_RPC_PASSWORD")
        if u:
            request.add_header("authorization", "Basic " + base64.b64encode(f"{u}:{pw or ''}".encode()).decode())
        with urllib.request.urlopen(request, timeout=30) as response:
            return json.loads(response.read().decode())
    block_hash = call("getblockhash", [height])["result"]
    header = call("getblockheader", [block_hash, True])["result"]
    return {"source": "your Bitcoin Core", "root": header["merkleroot"], "block_hash": block_hash}


def block_merkle_roots(height, rpc_url=None):
    """Asks every source and returns the answers that came back (a source that fails is simply left out)."""
    answers = []
    for api in APIS:
        try:
            answers.append(rest_answer(api, height))
        except Exception:
            pass
    if rpc_url:
        try:
            answers.append(core_answer(rpc_url, height))
        except Exception:
            pass
    return answers


def verify(anchor_bytes, ots_bytes, lookup=block_merkle_roots, min_sources=2):
    """lookup(height) returns a list of answers {"source", "root", "block_hash"}. A Bitcoin attestation counts only if at least `min_sources` different sources
    answered, they all agree, and the replayed proof equals their root."""
    digest, leaves = parse_ots(ots_bytes)
    report = {"digest": digest.hex(), "digest_matches_anchor": hashlib.sha256(anchor_bytes).digest() == digest, "min_sources": min_sources, "attestations": []}
    for kind, message, detail in leaves:
        if kind == "bitcoin":
            answers = lookup(detail)
            sources = sorted({a["source"] for a in answers})
            roots = {a["root"] for a in answers}
            agree = len(roots) == 1
            replayed = message[::-1].hex()
            entry = {"type": "bitcoin", "height": detail, "sources": sources, "sources_agree": agree, "replayed": replayed,
                     "merkle_root_in_block": next(iter(roots)) if agree else None,
                     "block_hash": answers[0]["block_hash"] if answers else None}
            entry["matches"] = agree and replayed in roots
            entry["enough_sources"] = len(sources) >= min_sources
            entry["ok"] = entry["matches"] and entry["enough_sources"]
            if not agree:
                entry["problem"] = "the Bitcoin sources disagree with each other"
            elif not entry["enough_sources"]:
                entry["problem"] = f"only {len(sources)} Bitcoin source(s) answered; {min_sources} must agree"
            elif not entry["matches"]:
                entry["problem"] = "the proof does not match the block's Merkle root"
            report["attestations"].append(entry)
        else:
            report["attestations"].append({"type": kind, "detail": detail})
    bitcoin = [a for a in report["attestations"] if a["type"] == "bitcoin"]
    report["verified"] = report["digest_matches_anchor"] and bool(bitcoin) and all(a["ok"] for a in bitcoin)
    return report


SNAPSHOT_URL = "https://rabbitsoftware-io-ledger-public.storage.googleapis.com/maxwell/snapshots/block-{:04d}.ndjson.gz"


def _try_fetch(url):
    try:
        return fetch(url, True)
    except Exception:
        return None


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("anchor_id", nargs="?")
    parser.add_argument("--json")
    parser.add_argument("--ots")
    parser.add_argument("--bitcoin-rpc", help="URL of your own Bitcoin Core JSON-RPC (for example http://127.0.0.1:8332); credentials from BITCOIN_RPC_USER / BITCOIN_RPC_PASSWORD")
    parser.add_argument("--min-sources", type=int, default=2, help="how many different Bitcoin sources must answer and agree (default 2)")
    args = parser.parse_args()
    if args.anchor_id:
        anchor_bytes = fetch(f"{BUCKET}/{args.anchor_id}/anchor.json", True)
        ots_bytes = fetch(f"{BUCKET}/{args.anchor_id}/anchor.json.ots", True)
    elif args.json and args.ots:
        anchor_bytes, ots_bytes = open(args.json, "rb").read(), open(args.ots, "rb").read()
    else:
        parser.error("give an anchor id, or --json and --ots")
    report = verify(anchor_bytes, ots_bytes, lookup=lambda h: block_merkle_roots(h, args.bitcoin_rpc), min_sources=max(1, args.min_sources))
    doc = json.loads(anchor_bytes.decode("utf-8"))
    if doc.get("snapshots"):
        try:
            listing = json.loads(fetch(f"{BUCKET}/snapshots.json"))
            report["snapshots"] = check_snapshot_commitment(doc, listing, lambda n: _try_fetch(SNAPSHOT_URL.format(n)))
        except Exception as error:
            report["snapshots"] = {"committed": True, "ok": False, "problems": [f"could not read the snapshot list: {error.__class__.__name__}"]}
        report["verified"] = report["verified"] and report["snapshots"]["ok"]
    print(json.dumps(report, indent=1))
    return 0 if report["verified"] else 1


if __name__ == "__main__":
    sys.exit(main())
