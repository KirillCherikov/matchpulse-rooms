# TxLINE API feedback

## What worked for the MVP

The published OpenAPI, devnet IDL/generated types, runnable activation/stream/proof examples, explicit network table, and World Cup free-tier guide were sufficient to complete a real devnet integration without guessing endpoints or program addresses. The dual-header data authentication and 401 guest-JWT renewal behavior are clear in the current reference.

## Requested developer experience improvements

1. Publish an explicit scale/encoding contract for integer odds `Prices`, including market-specific conversion examples. Sentinel currently preserves them rather than inventing decimal odds.
2. Define SSE heartbeat cadence, idle expectations, retry hints, and `Last-Event-ID` retention guarantees as normative contract text.
3. Publish versioned downloadable JSON Schema/OpenAPI snapshots and generated npm types for every supported release.
4. Provide a small license-cleared sanitized fixture/odds/scores recording for deterministic CI and demos.
5. Expose the pricing matrix through a documented read-only API in addition to the on-chain account, with bundle descriptions tied to IDs.

These would reduce the risk of developers guessing contracts and make audited data infrastructure easier to build.
