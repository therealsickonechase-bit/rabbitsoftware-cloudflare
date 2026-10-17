"""
anchor.py
=========
Bitcoin anchoring for the RabbitOS chains through OpenTimestamps, as a Cloud Run job. No wallet, no fees, no keys.

What gets anchored: ONE SHA-256 digest of a small public JSON document ("the anchor"): the head of the public ledger, the head and length of the Maxwell chain, and the date.
The digest is sent to the public OpenTimestamps calendars, which batch many digests into one Bitcoin transaction. The returned proof (.ots) first holds a "pending" promise and,
after the transaction is mined (usually within hours), is UPGRADED to a proof that names a Bitcoin block. Anyone with the anchor.json and the .ots can verify it with the
standard `ots verify` tool and a Bitcoin node. What is proved: this exact document existed no later than that Bitcoin block. It does not prove the contents are true.

Files, all public, in gs://<ledger bucket>/anchors/ :
  anchors/<id>/anchor.json   the document
  anchors/<id>/anchor.json.ots  the proof (replaced once, when it is upgraded)
  anchors/<id>/anchor.json.tsr  a second, independent witness: an RFC 3161 timestamp from the free FreeTSA authority (best effort; not a blockchain)
  anchors/index.json         newest first: id, digest, status ("pending" | "confirmed"), bitcoinHeight
  anchors/latest.json        the newest entry

Exit codes: 0 ok / nothing to do, 1 a source or the bucket could not be reached.
"""

from __future__ import annotations
import hashlib
import io
import json
import os
import re
import sys
import urllib.error
import urllib.request
from datetime import datetime, timezone

from opentimestamps.calendar import RemoteCalendar
from opentimestamps.core.notary import BitcoinBlockHeaderAttestation, PendingAttestation
from opentimestamps.core.op import OpAppend, OpSHA256
from opentimestamps.core.serialize import StreamDeserializationContext, StreamSerializationContext
from opentimestamps.core.timestamp import DetachedTimestampFile, Timestamp

CALENDARS = ("https://alice.btc.calendar.opentimestamps.org", "https://bob.btc.calendar.opentimestamps.org", "https://finney.calendar.eternitywall.com")
APP = "https://app.rabbitsoftware.io"
TSA_URL = "https://freetsa.org/tsr"
TSA_NAME = "freetsa.org"
# DER prefix of an RFC 3161 TimeStampReq for a SHA-256 digest (version 1, hash algorithm sha256, 32-byte imprint) and its suffix (certReq = TRUE).
TSQ_PREFIX = bytes.fromhex("30390201013031300d060960864801650304020105000420")
TSQ_SUFFIX = bytes.fromhex("0101ff")
MAX_INDEX = 90
ID_RE = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{6}Z$")


# ------------------------------------------------------------ the document and its digest

def build_document(ledger_head: dict, maxwell_blocks: list, now: datetime) -> dict:
    """Only public facts, nothing time-dependent except the date. Identical inputs give an identical digest."""
    last = maxwell_blocks[-1]
    return {
        "v": 1, "kind": "rabbitos-anchor", "date": now.strftime("%Y-%m-%d"),
        "ledger": {"length": ledger_head["length"], "headHash": ledger_head["headHash"]},
        "maxwell": {"length": len(maxwell_blocks), "headHash": last["hash"], "headIndex": last["index"]},
    }


def canonical(doc: dict) -> bytes:
    return json.dumps(doc, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")


def digest_of(doc: dict) -> bytes:
    return hashlib.sha256(canonical(doc)).digest()


def inputs_key(doc: dict) -> str:
    """The part that decides whether a new anchor is worth making: the date is left out."""
    return hashlib.sha256(canonical({k: v for k, v in doc.items() if k != "date"})).hexdigest()


# ------------------------------------------------------------ OpenTimestamps

def stamp(digest: bytes, calendars=CALENDARS, make_calendar=RemoteCalendar, nonce: bytes | None = None, timeout: int = 20) -> tuple:
    """Returns (ots_bytes, calendars_that_answered). A random nonce keeps the submitted value from revealing the digest."""
    detached = DetachedTimestampFile(OpSHA256(), Timestamp(digest))
    committed = detached.timestamp.ops.add(OpAppend(nonce if nonce is not None else os.urandom(16))).ops.add(OpSHA256())
    ok = []
    for url in calendars:
        try:
            committed.merge(make_calendar(url).submit(committed.msg, timeout=timeout))
            ok.append(url)
        except Exception:  # one calendar being down must not stop the others
            continue
    if not ok:
        raise ConnectionError("no OpenTimestamps calendar accepted the digest")
    return serialize(detached), ok


def tsa_request(digest: bytes) -> bytes:
    if len(digest) != 32:
        raise ValueError("a SHA-256 digest is 32 bytes")
    return TSQ_PREFIX + digest + TSQ_SUFFIX


def tsa_response_ok(resp: bytes, digest: bytes) -> bool:
    """A cheap sanity check, not a signature check: a DER SEQUENCE whose PKIStatus is granted (0) or grantedWithMods (1) and that names our digest.
    Full verification is `openssl ts -verify` against the FreeTSA certificates (docs/anchoring.md)."""
    try:
        if len(resp) < 100 or resp[0] != 0x30:
            return False
        i = 2 if resp[1] < 0x80 else 2 + (resp[1] & 0x7F)          # skip the outer SEQUENCE header
        if resp[i] != 0x30:
            return False
        j = i + 2 if resp[i + 1] < 0x80 else i + 2 + (resp[i + 1] & 0x7F)  # skip the PKIStatusInfo header
        if resp[j:j + 2] != b"" or resp[j + 2] not in (0, 1):
            return False
        return digest in resp
    except IndexError:
        return False


def tsa_stamp(digest: bytes, url: str = TSA_URL, timeout: int = 20, post=None) -> bytes:
    """Asks the free TSA for a signed timestamp of the digest. Returns the DER reply, or raises."""
    if post is None:
        def post(u, body):
            req = urllib.request.Request(u, body, {"Content-Type": "application/timestamp-query", "User-Agent": "rabbitos-anchor/1.0"})
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return r.read(200_000)
    resp = post(url, tsa_request(digest))
    if not tsa_response_ok(resp, digest):
        raise ValueError("the timestamp authority did not grant a timestamp for this digest")
    return resp


def serialize(detached: DetachedTimestampFile) -> bytes:
    buf = io.BytesIO()
    detached.serialize(StreamSerializationContext(buf))
    return buf.getvalue()


def load(ots: bytes) -> DetachedTimestampFile:
    return DetachedTimestampFile.deserialize(StreamDeserializationContext(io.BytesIO(ots)))


def _subtimestamps(ts: Timestamp):
    yield ts
    for sub in ts.ops.values():
        yield from _subtimestamps(sub)


def bitcoin_height(detached: DetachedTimestampFile):
    heights = [a.height for _, a in detached.timestamp.all_attestations() if isinstance(a, BitcoinBlockHeaderAttestation)]
    return min(heights) if heights else None


def upgrade(ots: bytes, make_calendar=RemoteCalendar, timeout: int = 20) -> tuple:
    """Asks each calendar named in the pending attestations whether Bitcoin has confirmed. Returns (ots_bytes, changed, bitcoin_height_or_None)."""
    detached = load(ots)
    changed = False
    for sub in list(_subtimestamps(detached.timestamp)):
        for att in list(sub.attestations):
            if not isinstance(att, PendingAttestation):
                continue
            try:
                upgraded = make_calendar(att.uri).get_timestamp(sub.msg, timeout=timeout)
            except Exception:  # still pending, or the calendar is unreachable: try again next run
                continue
            if any(isinstance(a, BitcoinBlockHeaderAttestation) for _, a in upgraded.all_attestations()):
                sub.merge(upgraded)
                sub.attestations.discard(att)
                changed = True
    return (serialize(detached) if changed else ots), changed, bitcoin_height(detached)


# ------------------------------------------------------------ bucket (public ledger bucket, anchors/ prefix only)

class Bucket:
    def __init__(self, name: str, token_fn, opener=urllib.request.urlopen):
        if not re.match(r"^[a-z0-9][a-z0-9._-]{2,62}$", name):
            raise ValueError("bad bucket name")
        self.name, self.token_fn, self.opener = name, token_fn, opener

    def _check(self, obj: str) -> str:
        if not obj.startswith("anchors/") or ".." in obj or len(obj) > 200:
            raise ValueError("objects may only be written under anchors/")
        return obj

    def get(self, obj: str):
        url = f"https://storage.googleapis.com/storage/v1/b/{self.name}/o/{urllib.request.quote(self._check(obj), safe='')}?alt=media"
        req = urllib.request.Request(url, headers={"Authorization": f"Bearer {self.token_fn()}"})
        try:
            return self.opener(req, timeout=30).read()
        except urllib.error.HTTPError as e:
            if e.code == 404:
                return None
            raise

    def put(self, obj: str, body: bytes, content_type: str) -> None:
        url = f"https://storage.googleapis.com/upload/storage/v1/b/{self.name}/o?uploadType=media&name={urllib.request.quote(self._check(obj), safe='')}"
        req = urllib.request.Request(url, data=body, method="POST", headers={"Authorization": f"Bearer {self.token_fn()}", "Content-Type": content_type, "Cache-Control": "no-cache"})
        self.opener(req, timeout=60).read()


def metadata_token() -> str:
    req = urllib.request.Request("http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token", headers={"Metadata-Flavor": "Google"})
    with urllib.request.urlopen(req, timeout=5) as resp:
        return json.load(resp)["access_token"]


def http_json(url: str):
    sep = "&" if "?" in url else "?"
    req = urllib.request.Request(f"{url}{sep}cb={int(datetime.now(timezone.utc).timestamp())}", headers={"user-agent": "rabbitos-anchor/1.0 (+https://rabbitsoftware.io)"})
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.load(resp)


# ------------------------------------------------------------ one run

def log(event: str, **fields) -> None:
    print(json.dumps({"severity": "ERROR" if event.endswith("_failed") else "INFO", "event": event, **fields}), flush=True)


def run(*, bucket: Bucket, fetch_json=http_json, now: datetime | None = None, stamp_fn=stamp, upgrade_fn=upgrade, tsa_fn=tsa_stamp, ledger_bucket_url: str | None = None) -> int:
    now = now or datetime.now(timezone.utc)
    ledger_url = ledger_bucket_url or f"https://{bucket.name}.storage.googleapis.com"
    try:
        head = fetch_json(f"{APP}/api/chain/head")
        maxwell = fetch_json(f"{ledger_url}/maxwell/maxwell_chain.json")["blocks"]
    except (urllib.error.URLError, OSError, KeyError, ValueError) as e:
        log("anchor_failed", reason="could not read the public chains: " + e.__class__.__name__)
        return 1

    index_raw = bucket.get("anchors/index.json")
    index = json.loads(index_raw) if index_raw else []

    # 1. upgrade proofs that are still pending
    upgraded_ids = []
    for entry in index:
        if entry.get("status") != "pending":
            continue
        ots = bucket.get(f"anchors/{entry['id']}/anchor.json.ots")
        if not ots:
            continue
        new_ots, changed, height = upgrade_fn(ots)
        if changed and height is not None:
            bucket.put(f"anchors/{entry['id']}/anchor.json.ots", new_ots, "application/octet-stream")
            entry["status"], entry["bitcoinHeight"] = "confirmed", height
            upgraded_ids.append(entry["id"])

    # 2. make a new anchor if the public heads changed since the last one
    doc = build_document(head, maxwell, now)
    key = inputs_key(doc)
    created = None
    if not index or index[0].get("inputs") != key:
        run_id = now.strftime("%Y-%m-%dT%H%M%SZ")
        digest = digest_of(doc)
        ots, answered = stamp_fn(digest)
        bucket.put(f"anchors/{run_id}/anchor.json", canonical(doc), "application/json")
        bucket.put(f"anchors/{run_id}/anchor.json.ots", ots, "application/octet-stream")
        tsa = None
        try:   # the second witness is best effort: if the authority is down the Bitcoin anchor still goes ahead
            bucket.put(f"anchors/{run_id}/anchor.json.tsr", tsa_fn(digest), "application/timestamp-reply")
            tsa = TSA_NAME
        except Exception as e:
            log("tsa_failed", reason=e.__class__.__name__ + ": " + str(e)[:100])
        created = {"id": run_id, "digest": digest.hex(), "inputs": key, "status": "pending", "bitcoinHeight": None, "calendars": answered,
                   "ledgerLength": doc["ledger"]["length"], "maxwellLength": doc["maxwell"]["length"], "tsa": tsa}
        index.insert(0, created)

    index = index[:MAX_INDEX]
    bucket.put("anchors/index.json", json.dumps(index, indent=1).encode(), "application/json")
    if index:
        bucket.put("anchors/latest.json", json.dumps(index[0], indent=1).encode(), "application/json")
    log("anchor_done", created=created["id"] if created else None, upgraded=upgraded_ids, pending=sum(1 for e in index if e["status"] == "pending"), confirmed=sum(1 for e in index if e["status"] == "confirmed"))
    return 0


def main() -> int:
    name = os.environ.get("LEDGER_BUCKET") or "rabbitsoftware-io-ledger-public"
    try:
        return run(bucket=Bucket(name, metadata_token))
    except (urllib.error.URLError, OSError, ConnectionError, ValueError) as e:
        log("anchor_failed", reason=e.__class__.__name__ + ": " + str(e)[:160])
        return 1


if __name__ == "__main__":
    sys.exit(main())
