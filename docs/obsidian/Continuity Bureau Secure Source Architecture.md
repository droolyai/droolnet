---
title: Continuity Bureau Secure Source Architecture
tags:
  - continuity-bureau
  - secure-drop
  - e2ee
  - source-safety
  - journalism
status: architecture-approved-for-research
updated: 2026-08-04
---

# Continuity Bureau Secure Source Architecture

## Decision

Continuity Bureau will separate source protection into three independently verified layers: anonymous access, end-to-end encrypted intake, and hardened newsroom plaintext handling. Browser encryption on a normal clearnet/Vercel origin must never be described as anonymous.

The near-term public interface is a source-safety and research page. A production anonymous submission claim requires a dedicated Tor v3 onion service, isolated source interface, reviewed recipient-envelope cryptography, hardened journalist retrieval and viewing, operational/legal policy, independent audit, and externally verified status.

## Protocol direction

- Fresh random content key per submission.
- Fixed-size encrypted chunks with authenticated sequence and manifest context.
- One independent RFC 9180 HPKE envelope per authorized journalist recipient.
- Offline-root-signed, append-only recipient manifests with short key epochs, independent witnesses, rotation, revocation, and rollback protection.
- No shared universal journalist private key and no server authority to add recipients.
- Optional coarse, local-only acceptance receipts; a receipt proves accepted ciphertext bytes, not truth or publication.
- Confidential intake is technically isolated from public WOKE.NET publishing and replication.

## Anonymity and metadata boundary

- No analytics, wallet, account, CAPTCHA, third-party assets, cookies, push, embeds, or persistent identifiers on the source interface.
- No claim that encryption removes metadata inside submitted documents.
- Upload padding reduces exact-size leakage but does not eliminate traffic analysis.
- Tor can hide destination from ordinary local observers, while Tor use itself may remain visible; global traffic correlation and compromised endpoints remain residual risks.
- Browser JavaScript is part of the trusted endpoint. A compromised origin can steal plaintext before encryption; reproducible builds, independent monitoring, and onion deployment reduce but do not erase that risk.

## Forward secrecy boundary

The one-shot v1 envelope is not forward secret. Later compromise of a recipient's retained static private key can expose retained submissions from that key's epoch. Rotating and destroying expired keys narrows the window but does not create per-message forward secrecy. Any future reply channel needs a separately audited prekey/ratchet or MLS design and its own threat model.

## Newsroom and abuse boundary

- Every decrypted file is hostile and opens only in a disposable network-isolated viewing environment.
- Preserve encrypted original, read-only decrypted original, and distinct sanitized/working derivatives with custody records.
- No automatic publication and no external AI/cloud processing of confidential material by default.
- Human legal/editorial/safety review handles malware, imminent threats, extortion, doxxing, non-consensual intimate imagery, child sexual abuse material, credentials, copyright, retention, legal holds, and required reporting.
- Aggregate transparency reporting must not create small-group source inference.

## Editorial voice

The newsroom voice is an original brave city desk: empathetic to sources, urgent when public safety requires it, evidence-first, skeptical of power, and focused on the public interest. “Superhero newsroom” energy comes from duty, courage, witnesses, signals, and records. It must not use Flash, Iris, DC names, quotes, plots, logos, sets, or copied trade dress, and it must never pressure a source with heroic rhetoric.

## Truthful status language

- Now: “secure submission architecture / research.”
- Clearnet encrypted pilot: “client-encrypted; not anonymous.”
- Onion pilot: “anonymous-access pilot” only after external reachability and configuration verification.
- Production: “E2EE anonymous source system” only after independent audit, newsroom drills, legal policy, incident response, and verified production checks.
- WOKE.NET remains research/foundation and is not a deployed anonymous source network.

## Domain and prototype receipt — 2026-08-04

- `woke.social` and `www.woke.social` now return a Vercel domain-layer 308 to `https://www.continuitybureau.com/` with path and query preserved.
- The isolated browser prototype is fail-closed because no production recipient key or intake backend has been configured.
- The prototype creates an encrypted package locally and does not upload, send, publish, or claim anonymous delivery.
- A separate clean Vercel project named `continuity-bureau` has been created for the reviewed production cutover; the custom domains remain on the existing project until final integration and verification complete.
- The founder-selected primary mark is a closed triangular eye-and-signal loop with no gap.

## Source of truth

Full technical design: [[../CONTINUITY_BUREAU_SECURE_DROP|Continuity Bureau secure submission architecture]].
