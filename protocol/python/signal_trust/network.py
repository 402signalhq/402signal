"""Explicit immutable Algorand consensus identities for offline verification."""
from __future__ import annotations
from dataclasses import dataclass

@dataclass(frozen=True)
class NetworkConfig:
    name: str
    genesis_id: str
    genesis_hash: str

PROTOCOL_BASE_MIN = 1000

FALCON_EXTRA_MIN_MULT = 2

MAX_FEE = 30000

FALCON_F1_PK_LEN = 1793

FALCON_F1_SIG_MAX = 1423

FALCON_F1_SIG_MIN = 2

FALCON_F1_SIG_HEADER = 0xBA

FALCON_F1_SIG_SALT_VERSION = 0

TESTNET_GENESIS_ID = "testnet-v1.0"

MAINNET_GENESIS_ID = "mainnet-v1.0"

TESTNET_GENESIS_HASH = "SGO1GKSzyE7IEPItTxCByw9x8FmnrCDexi9/cOUJOiI="

MAINNET_GENESIS_HASH = "wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8="

class UnknownNetwork(ValueError):
    """Fail closed: name is not an explicit configured network."""

def get_network(name: str) -> NetworkConfig:
    key = (name or "").strip().lower()
    cfg = NETWORKS.get(key)
    if cfg is None:
        raise UnknownNetwork("unknown network")
    return cfg

def network_for_genesis_id(genesis_id: str) -> NetworkConfig | None:
    gen = (genesis_id or "").strip()
    for cfg in NETWORKS.values():
        if cfg.genesis_id == gen:
            return cfg
    return None

NETWORKS = {
    "testnet": NetworkConfig("testnet", TESTNET_GENESIS_ID, TESTNET_GENESIS_HASH),
    "mainnet": NetworkConfig("mainnet", MAINNET_GENESIS_ID, MAINNET_GENESIS_HASH),
}
