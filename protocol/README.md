# Public verification formats

`capabilities.json` and `trust_root.v1.json` / `trust_root.v2.json` are versioned
contract snapshots. They do not replace a deliberately chosen current log-key
pin or independently establish live service status.

The JavaScript receipt verifier is in `../sdk/route-guard`; Python receipt
verification is in `../sdk/python`. Both are independent of the hosted service.
Their checks bind retained evidence to its salted commitment, public leaf,
Merkle inclusion proof, signed Ed25519 checkpoint, and trusted log key.

`python/signal_trust` retains the existing public format primitives:

- `jcs`: canonical JSON used by the log.
- `merkle`: RFC 6962 inclusion and append-only consistency verification.
- `checkpoint`: C2SP signed-note and Ed25519 checkpoint verification.
- `algo_tx`: pure Algorand address/MessagePack/transaction ID codecs.
- `anchor`: PQ1 note decoding and strict matching of a caller-supplied fetched
  Algorand transaction to an expected origin, size, root, address, network, and
  transaction ID. The expected network is mandatory; no service configuration
  or environment is consulted.

Install `cryptography>=42`, set `PYTHONPATH=protocol/python`, and run
`python -m unittest discover -s protocol/tests` from this repository root.
These modules never fetch a chain, sign an authorization, submit a transaction,
or access the service database. Synthetic/archived test data requires no keys.

## Verifying a later chain anchor

First verify the receipt and its trusted Ed25519 checkpoint. For a later
checkpoint, verify the append-only consistency proof from the receipt's tree
size/root to that checkpoint. Obtain the claimed Algorand transaction from a
chain reader you independently trust, decode it with `anchor.decode_chain_txn`,
and pass it with your expected pins to `anchor.verify_fetched_anchor`.
Check the returned `indexer_missing_fields`: an incomplete chain response can
be matched semantically but does not permit complete transaction ID reconstruction.

The anchor helper checks existing wire shape and semantic correspondence. It
does **not** independently execute Falcon signature mathematics or verify
Algorand consensus/state proofs. Confirmation metadata is supplied by the
chosen chain reader. Algorand's transaction validation and that reader remain
part of the trust boundary; the Ed25519 log receipt itself is not post-quantum.
No verifier establishes that proprietary ranking code executed, that all
possible sellers were considered, or that a seller delivered its promised work.

`SOURCE_PROVENANCE.json` records the original revision and retained format
sources. Historical package archive digests are verified separately; rebuilding
a package after the source split does not redefine a published release.
