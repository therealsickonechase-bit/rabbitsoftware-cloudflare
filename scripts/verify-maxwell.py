"""Independently verify the public Maxwell chain: every hash, every link, the proof of work, and the research anchors. Standard library only; no account, key or funds.

Checks, in order:
  1. Genesis: the anchor really is sha256("hello world") and block 0 carries it.
  2. Every block: recompute its SHA-256 from index, timestamp, transactions, previous_hash and nonce; it must equal the stored hash.
  3. Every link: previous_hash is the hash of the block before; indexes count up; timestamps never go backwards.
  4. Proof of work: each hash starts with `difficulty` zero hex digits (the chain's difficulty is 2, so this is a light, nominal work step: it makes
     rewriting history cost a little and makes the chain tamper-evident, it is NOT Bitcoin-grade security. The Bitcoin anchors are what give an outside witness.)
  5. Research anchors (blocks with a RESEARCH_ANCHOR transaction): rebuild the Merkle root from the public research records that existed at the block's time
     (first_seen_at <= block time) and compare the root and the count. Rule: leaf = sha256(canonical JSON of id, source, title, url, topic_id, run_id,
     first_seen_at), sorted by id, an odd node is duplicated. Skip with --no-records.

    python verify-maxwell.py                        # the public mirror in Google Cloud, and the public research records
    python verify-maxwell.py --chain maxwell_chain.json --no-records
"""

import argparse
import hashlib
import json
import sys
import urllib.parse
import urllib.request
from datetime import datetime, timezone

CHAIN_URL = "https://rabbitsoftware-io-ledger-public.storage.googleapis.com/maxwell/maxwell_chain.json"
RECORDS_URL = "https://app.rabbitsoftware.io/api/data/research_records"
HELLO_WORLD = "b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9"
STABLE_FIELDS = ("id", "source", "title", "url", "topic_id", "run_id", "first_seen_at")


def block_hash(block):
    payload = {k: block[k] for k in ("index", "timestamp", "transactions", "previous_hash", "nonce")}
    return hashlib.sha256(json.dumps(payload, sort_keys=True).encode()).hexdigest()


def canonical(row):
    return json.dumps({k: row[k] for k in STABLE_FIELDS if k in row}, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")


def merkle_root(rows):
    keyed = sorted(((str(r["id"]), hashlib.sha256(canonical(r)).digest()) for r in rows), key=lambda t: t[0])
    if not keyed:
        raise ValueError("no records")
    level = [h for _, h in keyed]
    while len(level) > 1:
        if len(level) % 2:
            level.append(level[-1])
        level = [hashlib.sha256(level[i] + level[i + 1]).digest() for i in range(0, len(level), 2)]
    return level[0].hex(), len(keyed)


def verify_chain(data):
    """Returns (problems, notes). Problems are hard failures; notes are things worth knowing."""
    problems, notes = [], []
    blocks = data.get("blocks") or []
    difficulty = data.get("difficulty", 2)
    if not blocks:
        return ["the chain has no blocks"], notes
    if hashlib.sha256(b"hello world").hexdigest() != HELLO_WORLD:
        problems.append("internal: the reference hash is wrong")
    tx0 = (blocks[0].get("transactions") or [{}])[0]
    if tx0.get("immutable_anchor_sha") != HELLO_WORLD:
        problems.append("block 0 does not carry the sha256('hello world') anchor")
    for i, b in enumerate(blocks):
        tag = f"block {b.get('index')}"
        try:
            if b["index"] != i:
                problems.append(f"{tag}: index should be {i}")
            if block_hash(b) != b["hash"]:
                problems.append(f"{tag}: the stored hash does not match its contents")
            if i and b["previous_hash"] != blocks[i - 1]["hash"]:
                problems.append(f"{tag}: previous_hash is not the hash of block {i - 1}")
            if i and b["timestamp"] < blocks[i - 1]["timestamp"]:
                notes.append(f"{tag}: timestamp is earlier than the block before")
            if i and not b["hash"].startswith("0" * difficulty):
                problems.append(f"{tag}: the hash does not meet the proof-of-work target ({difficulty} leading zeros)")
        except (KeyError, TypeError) as error:
            problems.append(f"{tag}: malformed ({error.__class__.__name__})")
    return problems, notes


def to_epoch(text):
    try:
        return datetime.fromisoformat(str(text).replace("Z", "+00:00")).astimezone(timezone.utc).timestamp()
    except ValueError:
        return None


def verify_research_anchors(blocks, rows):
    """For every RESEARCH_ANCHOR block, rebuild the Merkle root from the records first seen at or before the block's time."""
    results = []
    stamped = [(to_epoch(r.get("first_seen_at")), r) for r in rows]
    for b in blocks:
        tx = next((t for t in b.get("transactions", []) if isinstance(t, dict) and t.get("sender") == "RESEARCH_ANCHOR"), None)
        if not tx:
            continue
        subset = [r for t, r in stamped if t is not None and t <= b["timestamp"]]
        entry = {"block": b["index"], "claimed_count": tx.get("count"), "claimed_root": tx.get("root")}
        if not subset:
            entry.update(ok=False, reason="no public records existed at that time")
        else:
            root, count = merkle_root(subset)
            entry.update(rebuilt_count=count, rebuilt_root=root, ok=(root == tx.get("root") and count == tx.get("count")))
            if not entry["ok"]:
                entry["reason"] = "records were added, changed or removed since, or the rule differs" if count != tx.get("count") else "the root does not match"
        results.append(entry)
    return results


def fetch(url, want_headers=False):
    request = urllib.request.Request(url, headers={"user-agent": "rabbitos-verify-maxwell/1.0"})
    with urllib.request.urlopen(request, timeout=60) as response:
        body = response.read().decode("utf-8")
        return (body, dict(response.headers)) if want_headers else body


def fetch_records(base=RECORDS_URL, max_pages=200):
    rows, cursor = [], None
    for _ in range(max_pages):
        query = {"format": "ndjson", "limit": "200", **({"cursor": cursor} if cursor else {})}
        body, headers = fetch(base + "?" + urllib.parse.urlencode(query), True)
        rows += [json.loads(line) for line in body.splitlines() if line.strip()]
        cursor = {k.lower(): v for k, v in headers.items()}.get("x-next-cursor")
        if not cursor:
            return rows
    raise RuntimeError("too many pages")


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--chain", help="a local maxwell_chain.json instead of the public mirror")
    parser.add_argument("--no-records", action="store_true", help="skip rebuilding the research Merkle roots")
    args = parser.parse_args()
    data = json.load(open(args.chain, encoding="utf-8")) if args.chain else json.loads(fetch(CHAIN_URL))
    problems, notes = verify_chain(data)
    blocks = data.get("blocks", [])
    print(f"chain: {len(blocks)} blocks, difficulty {data.get('difficulty')}, head {blocks[-1]['hash'][:16] if blocks else '-'}")
    print("hashes, links and proof of work:", "OK" if not problems else "PROBLEMS")
    for line in problems + notes:
        print("  -", line)
    anchors = []
    if not args.no_records:
        anchors = verify_research_anchors(blocks, fetch_records())
        for a in anchors:
            print(f"research anchor, block {a['block']}: {'OK' if a['ok'] else 'DOES NOT MATCH'} (claimed {a['claimed_count']} records, rebuilt {a.get('rebuilt_count')})" + ("" if a["ok"] else f" - {a.get('reason')}"))
    return 1 if problems or any(not a["ok"] for a in anchors) else 0


if __name__ == "__main__":
    sys.exit(main())
