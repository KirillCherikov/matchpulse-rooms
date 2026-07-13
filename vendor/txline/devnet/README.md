# TxLINE devnet pin

This directory records the exact official artifacts used by the local TxLINE
activation and proof tooling. The IDL and generated type are copied verbatim
from the immutable `txodds/tx-on-chain` commit in `pin.json` and SHA-256 checked
before use. They are program contracts, not third-party sports data.

Upstream repository: <https://github.com/txodds/tx-on-chain>

Pinned files:

- `examples/devnet/idl/txoracle.json` — IDL `1.5.6`;
- `examples/devnet/types/txoracle.ts` — matching generated types.

The current official OpenAPI `1.5.6` document is referenced by URL and digest
in `pin.json`; its endpoint schemas are represented as strict Zod transport
schemas in `src/providers/txline-schemas.ts` rather than vendoring the full
documentation document.

The upstream repository distributes these files under Apache-2.0. No upstream
source is modified or embedded here. The program, mint, API origin, RPC URL,
artifact hashes, and standard Token-2022 program addresses are declarative
provenance only and contain no credentials.
