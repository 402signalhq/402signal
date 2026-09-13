"""Observed EVM networks beyond Base. Seller side only.

The routing fee is still paid on Base, Solana or Algorand (payment.FEE_RAILS).
These chains extend what a check can observe and normalize: a seller's x402
challenge on Polygon is classified as rail "polygon", its native USDC price
is shown in dollars, its recipient is validated as an EVM address, and
`networks: ["polygon"]` or `networks: ["eip155:137"]` locks a check to it.
Every entry shares Base's payment shape (EIP-3009 USDC, 0x recipients), so
the existing Base code paths apply through `is_evm_rail`.

Native Circle USDC addresses come from Circle's contract-address list
(developers.circle.com, read 2026-09-13). A chain without a Circle USDC
(BNB Smart Chain) is still classified, but its prices stay unnormalized:
never a dollar figure for an asset we do not know.
"""
from __future__ import annotations

# rail, CAIP-2 id, display name, native Circle USDC (None: no Circle USDC)
CHAINS: tuple[tuple[str, str, str, str | None], ...] = (
    ("polygon", "eip155:137", "Polygon", "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359"),
    ("arbitrum", "eip155:42161", "Arbitrum One", "0xaf88d065e77c8cC2239327C5EDb3A432268e5831"),
    ("monad", "eip155:143", "Monad", "0x754704Bc059F8C67012fEd69BC8A327a5aafb603"),
    ("worldchain", "eip155:480", "World Chain", "0x79A02482A880bCe3F13E09da970dC34dB4cD24D1"),
    ("xlayer", "eip155:196", "X Layer", "0xB6CEceAB302E2E4948951eE7843FC24E92933061"),
    ("bnb", "eip155:56", "BNB Smart Chain", None),
    ("hyperevm", "eip155:999", "HyperEVM", "0xb88339CB7199b77E23DB6E890353E22632Ba630f"),
    ("ethereum", "eip155:1", "Ethereum", "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48"),
    ("optimism", "eip155:10", "OP Mainnet", "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85"),
    ("avalanche", "eip155:43114", "Avalanche C-Chain", "0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E"),
    # Tempo (Stripe and Paradigm's payments chain, mainnet since 2026-03-18): the
    # home of MPP "tempo" challenges. TIP-20 tokens are ERC-20 shaped with six
    # decimals; no Circle USDC address is confirmed, so prices stay unnormalized.
    ("tempo", "eip155:4217", "Tempo", None),
)

RAILS: tuple[str, ...] = tuple(chain[0] for chain in CHAINS)
_BY_RAIL = {chain[0]: chain for chain in CHAINS}
_BY_NETWORK = {chain[1].lower(): chain for chain in CHAINS}
# Names a v1 challenge or a buyer may use for the chain.
_ALIASES = {
    "polygon": "polygon", "matic": "polygon", "polygon-pos": "polygon",
    "arbitrum": "arbitrum", "arbitrum-one": "arbitrum", "arbitrum_one": "arbitrum",
    "monad": "monad",
    "worldchain": "worldchain", "world": "worldchain", "world-chain": "worldchain", "world_chain": "worldchain",
    "xlayer": "xlayer", "x-layer": "xlayer", "x_layer": "xlayer",
    "bnb": "bnb", "bsc": "bnb", "bnb-smart-chain": "bnb", "binance": "bnb",
    "hyperevm": "hyperevm",
    "ethereum": "ethereum", "eth": "ethereum", "mainnet": "ethereum",
    "optimism": "optimism", "op-mainnet": "optimism", "op": "optimism",
    "avalanche": "avalanche", "avax": "avalanche", "avalanche-c-chain": "avalanche",
}


def rail_of_network(network) -> str | None:
    """Rail for an exact CAIP-2 id (case-insensitive) or a known chain name."""
    if not isinstance(network, str):
        return None
    text = network.strip().lower()
    if not text:
        return None
    chain = _BY_NETWORK.get(text)
    if chain is not None:
        return chain[0]
    return _ALIASES.get(text)


def rail_of_caip2(network) -> str | None:
    """Rail for an exact CAIP-2 id only (v2 challenge validation: no aliases, no case-fold)."""
    if not isinstance(network, str):
        return None
    chain = _BY_NETWORK.get(network.lower())
    if chain is None or chain[1] != network:
        return None
    return chain[0]


def network_of_rail(rail) -> str | None:
    chain = _BY_RAIL.get(str(rail or "").strip().lower())
    return chain[1] if chain else None


def display_name(rail) -> str | None:
    chain = _BY_RAIL.get(str(rail or "").strip().lower())
    return chain[2] if chain else None


def usdc_of_rail(rail) -> str | None:
    chain = _BY_RAIL.get(str(rail or "").strip().lower())
    return chain[3] if chain else None


def is_rail(rail) -> bool:
    return str(rail or "").strip().lower() in _BY_RAIL


def is_evm_rail(rail) -> bool:
    """Base or any chain listed here: 0x recipients, ERC-20 assets, hex case-insensitive."""
    text = str(rail or "").strip().lower()
    return text == "base" or text in _BY_RAIL
