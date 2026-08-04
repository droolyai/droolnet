# @wokenet/feed

Deterministic, user-owned feed ranking for WOKE.NET clients.

The package accepts signed-object projections plus local preferences, filters blocks, mutes, and content labels before scoring, uses fixed integer weights, enforces author diversity, and returns cryptographic receipts for the input set, preferences, policy version, and ordered output.

It deliberately accepts no likes, follower counts, watch-time telemetry, paid boosts, or private platform features. The same inputs always produce the same output, so a browser, relay, auditor, or competing client can reproduce the feed without trusting the operator.

Status: implemented research package. It is not yet connected to a production social-object index or independent relay network.
