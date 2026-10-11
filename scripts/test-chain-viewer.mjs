import assert from "node:assert/strict";
import test from "node:test";
import { findEntries, parseLocal } from "../site/chain-core.mjs";

test("lookup entries are searchable and ordinal lookup is bounded", () => {
  const entries = parseLocal({
    schema: "rabbitsoftware.local-public-lookup.v1", classification: "public",
    entries: [{ topic: "BRCA1", message: "<script>not executable</script>" }, { topic: "Other" }],
  });
  assert.equal(findEntries(entries, "find BRCA1").length, 1);
  assert.equal(findEntries(entries, "show entry 2")[0].index, 1);
  assert.throws(() => findEntries(entries, "show entry 0"), /outside/);
  assert.throws(() => findEntries(entries, "show entry 3"), /outside/);
});

test("DNA account scope and credentials are not displayed", () => {
  const entries = parseLocal({
    name: "my-chain", account: "sensitive-account",
    entries: [{ record: { topic: "Private", classification: "public", account: "nested",
      private_key: "secret", device: "device", text: "Local only" } }],
  });
  assert.equal(entries[0].classification, "private");
  assert.doesNotMatch(JSON.stringify(entries), /sensitive-account|nested|secret|device/);
  assert.match(entries[0].message, /Local only/);
});

test("public archives keep payloads distinct from account envelopes", () => {
  assert.equal(parseLocal({ schema_version: 1, classification: "public",
    chain: [{ block_type: "test", data: { value: 1 } }] })[0].topic, "test");
  assert.equal(parseLocal({ schema_version: 1, classification: "public",
    events: [{ event_type: "citation" }] })[0].topic, "citation");
});

test("unsupported, empty, oversized and malformed records fail explicitly", () => {
  for (const data of [null, [], {}, { account: "x", device: "x", private_key: "x" },
    { schema: "rabbitsoftware.local-public-lookup.v1", classification: "public", entries: [] },
    { schema: "rabbitsoftware.local-public-lookup.v1", classification: "public", entries: Array(1001).fill({}) },
    { name: "x", account: "x", entries: [{}] }]) {
    assert.throws(() => parseLocal(data));
  }
});
