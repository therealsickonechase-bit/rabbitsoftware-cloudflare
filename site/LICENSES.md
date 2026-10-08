# License Scope Map

This file identifies which license declaration applies to which project
artifact. It is an index, not a replacement for the complete applicable terms.

| Artifact | License declaration | Where it is recorded | Authorship and integrity record |
| --- | --- | --- | --- |
| RabbitSoftware repository source and original project documentation | Universal Permissive License 1.0 (`UPL-1.0`) | [`LICENSE`](LICENSE), GitHub repository license metadata, and [`CITATION.cff`](CITATION.cff) | [`NOTICE.md`](NOTICE.md), Git commit, and per-release code manifest |
| Local node chains and shared research ledger | Chase Allen Ringquist; UPL-1.0 applies to project code | [`chain_store.py`](chain_store.py), [`research_ledger.py`](research_ledger.py), [`research_provenance.py`](research_provenance.py), [`network_node.py`](network_node.py) | Code files appear in the per-release hash manifest; ledger payload authorship remains with its contributors |
| Maxwell local proof-of-work chain | Chase Allen Ringquist; UPL-1.0 applies to project code | [`maxwell_chain_agent.py`](maxwell_chain_agent.py), [`maxwell blockchain.py`](maxwell%20blockchain.py) | Local chain implementation; not external network consensus |
| Account-scoped DNA chain adapter | Chase Allen Ringquist; UPL-1.0 applies to project code | [`deploy/cloudflare-sync/src/index.js`](deploy/cloudflare-sync/src/index.js) | Account-scoped chain service; not Bitcoin and not a claim to own user records |
| Legacy Maxwell hash-link archive | Chase Allen Ringquist; UPL-1.0 applies to adapter code | [`deploy/cloudflare-sync/src/index.js`](deploy/cloudflare-sync/src/index.js), [`deploy/cloudflare-sync/README.md`](deploy/cloudflare-sync/README.md) | Archive of legacy fingerprints/linkage, not a separate consensus network |
| Bitcoin public tip and timestamp-anchor reader | Chase Allen Ringquist; UPL-1.0 applies to bridge code | [`external_chain_bridge.py`](external_chain_bridge.py) | Reads public external metadata; does not create or operate the Bitcoin network |
| Ethereum public block-number reader | Chase Allen Ringquist; UPL-1.0 applies to bridge code | [`external_chain_bridge.py`](external_chain_bridge.py) | Reads public external metadata; does not create or operate the Ethereum network |
| `Llama-3.2-3B-RabbitSoftware-GGUF` model weights | Meta Llama 3.2 Community License (`llama3.2`) | [`deploy/huggingface/model-card.md`](deploy/huggingface/model-card.md), based on `meta-llama/Llama-3.2-3B-Instruct` | [`deploy/huggingface/model-versions.json`](deploy/huggingface/model-versions.json) records model SHA-256, Hugging Face revision, source commit, and training details |
| Third-party libraries and assets | Each component's own license | Its upstream package or asset notice | Component-specific provenance where recorded |

“Blockchain-DNA” is the project/research-tool name, not a separate network.
The node and Maxwell chains are project-local implementations; the DNA chain
is an account-scoped service adapter; the legacy Maxwell item is an archive.
Bitcoin and Ethereum are external networks that the project only reads through
the bridge. These authorship records cover project code only, not chain payloads
created by users, the external networks, their blocks, or third-party libraries.

The UPL-1.0 repository license does not replace or relicense the Llama model
weights. Meta's official [`llama3_2/LICENSE`](https://github.com/meta-llama/llama-models/blob/main/models/llama3_2/LICENSE)
is the governing license text for the model family; the official
[Llama 3.2 base-model card](https://huggingface.co/meta-llama/Llama-3.2-3B-Instruct)
declares `llama3.2` and points to that license. Follow Meta's
[Llama 3.2 Acceptable Use Policy](https://llama.meta.com/llama3_2/use-policy).
This repository links to Meta's terms rather than copying or modifying them.

The Bitcoin-related RabbitSoftware authorship recorded here is limited to the
tracked public-chain bridge, attributed to Chase Allen Ringquist under
UPL-1.0. It reads public tip-height data and can use a public block hash as a
timestamp anchor; it does not implement wallet operations.

The editor-provided `.venv/.../bitcoin/wallet.py` is from the environment-only
`python-bitcoinlib` 0.12.2 package, not from this repository or its release
manifest. Its file header credits the python-bitcoinlib developers, and its
installed metadata declares LGPL-3.0-or-later. That third-party module provides
address and private-key classes but says it is not actual wallet support. Its
authorship and license remain with that upstream package; they are not
re-attributed to Chase Allen Ringquist.

## Release Author Ledger

[`scripts/code_fingerprint.py`](scripts/code_fingerprint.py) attaches the
project author, source license, per-file Git-object SHA-256 values, and a
release fingerprint to each GitHub release. Its `license_scopes` field lists
the project chain implementations, external read-only bridge code, and
separate model-license references. [`RELEASING.md`](RELEASING.md) documents the release
manifest and the optional, explicitly confirmed `code_release` chain record.
That chain record stores only the fingerprint; the attached GitHub manifest
contains the file hashes and license-scope references. Neither record changes
the underlying licenses or proves ownership of Meta's model work.
