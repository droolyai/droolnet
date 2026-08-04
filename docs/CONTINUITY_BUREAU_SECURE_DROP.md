# Continuity Bureau secure submission architecture

Status: security design and production gate specification. Nothing in this document means that an anonymous drop, onion service, end-to-end encrypted newsroom, decentralized news network, or source-protection system is live.

Last reviewed: 2026-08-04

## Executive decision

Continuity Bureau must treat confidential submission as three separate systems:

1. **Anonymous access** minimizes who can learn that a source contacted the Bureau.
2. **End-to-end encrypted intake** prevents the delivery service and storage providers from reading a submission.
3. **Hardened newsroom operations** protect plaintext after a journalist opens it.

Shipping only browser encryption on a conventional HTTPS/Vercel page does **not** create an anonymous tip line. The origin, CDN, DNS path, source ISP, browser, endpoint, and timing observers may still learn metadata. The production target is a dedicated, independently audited SecureDrop-class deployment with a v3 onion service and an isolated journalist workflow. A custom WOKE.NET protocol can be researched beside that deployment, but it must not replace a mature source-safety path until it survives external review and adversarial exercises.

The safest near-term public action is therefore a static source-safety page that clearly labels the custom system **staged**, offers non-sensitive contact options with their risks, and links to the audited anonymous channel only after that channel exists and has been independently verified.

## Security objectives

### Required

- A delivery server or object-storage operator cannot decrypt submitted content.
- Every accepted ciphertext is authenticated, bounded, replay-resistant, and bound to an explicit recipient-key epoch.
- Compromise of one journalist device does not silently add a new recipient or rewrite the published intake key set.
- Recipient removal rotates keys and prevents that recipient from opening later submissions.
- The public interface minimizes logs, cookies, third-party requests, fingerprinting, and persistent identifiers.
- Source-facing language distinguishes confidentiality from anonymity and describes residual risk.
- Plaintext processing happens only in a hardened, access-controlled newsroom environment.
- A receipt proves only that particular encrypted bytes were accepted; it never implies authenticity, truth, ownership, publication, or legal privilege.

### Explicitly not guaranteed by the proposed browser v1

- Anonymity on the public clearnet origin.
- Protection from a compromised source device, malicious browser extension, hostile operating system, or modified JavaScript served by a compromised origin.
- Forward secrecy for one-shot submissions encrypted to long-lived recipient public keys.
- Resistance to a truly global passive adversary correlating source and newsroom traffic.
- Removal of metadata embedded inside uploaded documents.
- Prevention of an authorized journalist photographing, copying, or leaking plaintext.
- Legal privilege, shield-law coverage, publication, payment, or immunity from investigation.

## Actors and trust boundaries

| Actor/system | Trust | What it may learn |
| --- | --- | --- |
| Source | Trusted for its own choices, not assumed technically expert | Plaintext, local file metadata, optional reply secret |
| Source device/browser | High-risk endpoint | Plaintext before encryption, key material during the session |
| Clearnet CDN/origin | Untrusted for confidentiality | IP/network metadata, timing, byte counts, ciphertext unless an onion path removes it from the route |
| Onion service and Tor network | Untrusted transport | Traffic patterns; no single ordinary relay should learn both source and destination |
| Intake/delivery service | Untrusted for content | Ciphertext, padded size class, key epoch, coarse receive epoch, abuse-control state |
| Object store/replicas | Untrusted | Ciphertext and content-addressed identifiers |
| Key-transparency publisher | Untrusted but verifiable | Public recipient key manifests and append-only history |
| Journalist workstation | Trusted only while uncompromised | Decrypted submission and source dialogue |
| Secure viewing/sanitization station | Most sensitive endpoint | Original plaintext and potentially hostile files |
| Editors/legal/safety team | Authorized case-by-case | Minimum necessary plaintext and custody records |
| Public/index relays | Not part of confidential intake | Only redacted, explicitly published stories and public evidence |

## Adversaries

- Global or regional network observer performing timing and volume correlation.
- Source employer, school, ISP, mobile carrier, or managed-device administrator.
- Compromised CDN, origin, DNS account, certificate issuance path, build pipeline, dependency, or administrator.
- Malicious submission sender delivering exploits, malware, tracking documents, illegal material, spam, or coercive content.
- Compromised or malicious journalist, editor, recipient device, or insider.
- Storage provider or relay attempting deletion, rollback, replay, substitution, or selective availability.
- Key-directory attacker serving a substituted or stale newsroom key.
- Legal seizure, compelled disclosure, civil discovery, preservation demand, or physical device seizure.
- Sybil/denial-of-service actor exhausting storage or journalist attention while trying to force identity-bearing rate limits.
- Well-intentioned operator error, including unsafe copy/paste, cloud preview, notifications, backups, analytics, screenshots, and accidental publication.

## Recommended production topology

```text
Source in Tor Browser
        |
        | v3 onion service (no clearnet redirect, no third-party assets)
        v
Minimal source interface
  - local encryption
  - local optional receipt secret
  - padded/chunked ciphertext only
        |
        v
Untrusted intake queue -----> encrypted replica A
        |                    -> encrypted replica B
        |                    -> delayed transparency batch
        v
Journalist retrieval gateway (onion-only, strong device/operator auth)
        |
        v
Hardened journalist workstation
        |
        | controlled one-way transfer / quarantine
        v
Secure viewing and sanitization environment
        |
        v
Case workspace with least privilege, custody log, legal/editorial review
        |
        v
Explicit redaction and public export (never automatic)
```

Confidential intake and public WOKE.NET replication must be different namespaces, credentials, services, storage buckets, logs, and deployment accounts. No confidential object becomes public through a CRDT merge, indexing job, AI summarizer, moderation pipeline, or “publish by default” flag.

## Submission envelope protocol

Do not implement cryptographic primitives directly. Use a pinned, reviewed implementation of RFC 9180 HPKE and an audited AEAD/chunking construction. Web Crypto is a low-level primitive API; its own security guidance warns that script injection is equivalent to remote code execution for keys and plaintext and discourages authors from inventing protocols.

### Public recipient manifest

The source interface ships with or retrieves a signed, append-only recipient manifest:

```text
manifest_version
not_before
not_after
key_epoch
envelope_suite
payload_suite
padding_policy
maximum_plaintext_bytes
recipients[] = {
  recipient_id,       // random identifier, not a name or email
  hpke_public_key,
  valid_from,
  valid_until,
  capabilities
}
previous_manifest_hash
manifest_hash
offline_root_signature
```

The offline root key signs short-lived online manifest-signing keys or the manifest itself. The interface rejects expired, not-yet-valid, rollback, unknown-suite, duplicate-recipient, and broken-chain manifests. Publish the same manifest hash through at least two independent channels and an append-only transparency log. A human-readable fingerprint is an additional out-of-band check, not a substitute for signature verification.

### Per-submission encryption

1. Generate a fresh 256-bit content-encryption key (`CEK`) and fresh submission nonce material using the browser CSPRNG.
2. Canonically encode a bounded metadata header. Do not include source account, IP, user-agent, filename, local path, EXIF, wall-clock timestamp, wallet, analytics ID, or stable browser identifier.
3. Split the plaintext package into fixed-size chunks. Encrypt every chunk with an audited misuse-resistant streaming construction or independently derived AEAD key/nonce pairs. Sequence number, total chunk count, protocol version, manifest hash, and padded size class are authenticated associated data.
4. For every currently authorized newsroom recipient, create an independent RFC 9180 HPKE base-mode envelope containing the `CEK`, payload commitment, submission protocol version, key epoch, and expiry policy.
5. Randomize envelope ordering. Keep every envelope the same encoded length so storage cannot infer recipient role. Do not place recipient names in the envelope.
6. Upload a canonical package containing header, recipient envelopes, encrypted chunks, and the ciphertext commitment.
7. Zero application buffers on a best-effort basis and clearly disclose that browsers do not guarantee memory zeroization.

Recommended initial HPKE suite, subject to interoperability and independent audit: `DHKEM(X25519, HKDF-SHA256)` + `HKDF-SHA256` + `ChaCha20-Poly1305`, as registered by RFC 9180. If the chosen browser runtime cannot provide that suite through a pinned audited implementation, stop rather than silently substituting a home-built scheme. Payload encryption may use an audited XChaCha20-Poly1305 secretstream construction; if browser-native AES-256-GCM is chosen instead, the chunk nonce derivation and uniqueness proof must be documented and tested under crash/retry conditions.

### Multi-recipient properties

- Encrypt the payload once; wrap only the random `CEK` separately to each recipient.
- The intake server must not be able to add recipients because it does not possess the offline manifest signing key.
- A removed recipient can still decrypt packages from epochs in which it was authorized. Rotation cannot revoke already delivered ciphertext.
- Recipient additions apply only to later epochs unless an authorized journalist explicitly re-wraps an existing package in the secure environment. Re-wrapping is custody-logged.
- Compromise of one recipient key exposes every retained submission wrapped to that key. It does not reveal the other recipients' private keys.
- Never use a group-shared private decryption key across all staff devices. Independent recipient keys preserve revocation and accountability.

## Key lifecycle

### Root and online keys

- Keep the offline manifest root in an HSM or dedicated offline hardware with dual control.
- Give each journalist device a non-exportable hardware-backed identity/decryption key where the audited client supports it.
- Use short recipient-key epochs; rotate routinely and immediately for staff/device loss, role change, suspected compromise, or dependency incident.
- Require two authorized operators for manifest publication and recipient-set changes.
- Maintain signed revocation statements and rollback-resistant manifest history.
- Back up only what policy requires, using split custody. A universal escrow key destroys compartmentalization.

### Forward secrecy limitation

A one-shot anonymous sender cannot establish ordinary forward secrecy merely by generating an ephemeral HPKE sender key. If an attacker later obtains a recipient's static HPKE private key and retained ciphertext, the attacker can decapsulate prior envelopes. Deleting expired recipient private keys after every message in that epoch has been processed limits retrospective exposure, but long retention and offline recipients enlarge the compromise window.

Do not label v1 “forward secret.” A future reply channel should adopt an externally reviewed asynchronous messaging protocol with one-time prekeys and a ratchet, or MLS where an actual multi-member conversation requires it. RFC 9420 describes forward secrecy and post-compromise security for group messaging but also requires correct epoch updates and deletion of consumed secrets. It is not a drop-in replacement for anonymous file intake. Any reply-channel design needs a separate threat model, unlinkable retrieval, recovery behavior, and independent audit.

## Source anonymity and metadata minimization

### Clearnet

The public `www.continuitybureau.com` site may explain the program but must not claim anonymous submission. A CDN or hosting platform ordinarily receives source IP addresses and request metadata. The secure-drop application must run on a dedicated origin with:

- no analytics, ads, telemetry, session replay, social embeds, wallet connection, CAPTCHA, push, email pixels, web fonts, or third-party JavaScript;
- no cookies or local persistence unless the source explicitly chooses a reply/receipt capability;
- `Referrer-Policy: no-referrer`, restrictive `Permissions-Policy`, `Cache-Control: no-store`, and a locked CSP with no inline/eval/network dependencies;
- no service worker, speculative prefetch, DNS prefetch, link preconnect, background sync, notifications, or cross-origin resource loads;
- uniform error bodies and bounded timing differences;
- short, minimized server logs with no IP/user-agent persistence, subject to verified host behavior and legal requirements;
- no source account, phone, email, wallet, social identity, or payment requirement.

Self-hosting the page's JavaScript does not solve a malicious-build or compromised-origin attack: the server can deliver targeted code that reads plaintext before encryption. Reproducible builds, signed release artifacts, public build hashes, independent monitoring, a separately distributed native/Tor client, and a mature onion deployment reduce this risk; they do not make browsers trusted.

### Onion service path

The anonymity target is a dedicated Tor v3 onion service. It should be published and verified through independent official channels, monitored from outside the hosting environment, and isolated from the clearnet administration plane. Onion access hides the source/destination relationship from ordinary single-hop observers, but it does not defeat all global traffic correlation, compromised endpoints, stylometry, rare Tor-use visibility, or an observer who controls enough relevant vantage points. Public instructions must warn that an ISP or workplace may be able to tell that Tor is being used even when it cannot see the destination.

Bridges/pluggable transports and a verified SecureDrop-style source workflow belong in the future operations plan. Never auto-redirect a source from clearnet to onion: that leaks the initial visit. Publish the onion address and verification instructions for deliberate use in Tor Browser.

### Upload characteristics

- Bucket ciphertext into documented padded size classes and use fixed-size chunks.
- Avoid exact upload timestamps in receipts and journalist notifications; batch notifications and transparency commitments.
- Do not preserve source-provided filenames by default. Store a local-only display name if needed, separate from the encrypted evidence package.
- Apply per-session storage limits and proof-of-work/anonymous abuse controls without durable browser fingerprinting.
- Do not promise that padding hides timing, total transfer duration, repeated visits, or unusually large submissions.

### Document metadata

Encryption hides embedded metadata from the delivery server, not from the journalist who decrypts the file. Documents can contain authors, revision history, printer marks, GPS/EXIF, organization IDs, hidden sheets, tracked changes, thumbnails, cloud URLs, and unique content. The source page must explain this risk before upload.

Do not silently “sanitize” and replace source evidence in the browser. Sanitization can fail, destroy probative material, or create a false safety claim. Offer message-only submission, clear source guidance, and an optional separately generated sanitized derivative while preserving the encrypted original. Journalists open originals only inside the quarantined viewing workflow.

## Receipt and evidence design

Receipts are optional because possession can identify a source during device seizure.

### Local receipt

```text
protocol_version
receipt_secret             // generated and retained only by source
ciphertext_commitment      // SHA-256 or approved equivalent
padded_size_class
key_epoch
coarse_acceptance_epoch    // e.g. UTC day, not exact time
intake_signature
transparency_batch_id      // available after delayed batching
```

The intake signs a domain-separated statement over the commitment, key epoch, size class, and coarse acceptance epoch. A delayed Merkle batch can later provide an inclusion proof without publishing the source secret or plaintext hash. The UI offers “verify locally,” “save receipt,” and “continue without receipt.” It warns against cloud-synced screenshots, password-manager notes, or posting a receipt publicly.

The ciphertext hash can prove that stored bytes match accepted bytes. It cannot prove who submitted them, when the underlying event occurred, that the plaintext is true, or that the newsroom will publish. A plaintext evidence hash should be created only inside the secure viewing environment and linked to a custody record. Public release uses a separately reviewed evidence manifest containing only deliberately disclosed hashes and redactions.

## Hardened newsroom workflow

1. Retrieve ciphertext through an authenticated journalist interface over its dedicated private/onion path.
2. Keep decryption keys off the public intake server and general-purpose newsroom laptops.
3. Verify manifest epoch, envelopes, AEAD authentication, ciphertext commitment, and intake receipt before rendering anything.
4. Treat every submission as hostile. Open files in a disposable, network-isolated environment with previews, macros, active content, links, fonts, and outbound networking disabled.
5. Preserve the encrypted original and a read-only decrypted original; create working/sanitized derivatives separately.
6. Record access, export, re-wrap, redaction, deletion, and publication actions in an append-only custody log. Logs identify authorized staff but do not copy source plaintext.
7. Use least privilege and case-level assignment. Editors, legal counsel, and safety specialists receive only necessary access.
8. Never feed source material to external AI models, transcription services, antivirus clouds, cloud document viewers, consumer sync drives, or collaboration tools without explicit policy, source-risk analysis, and approved isolated processing.
9. Require human editorial and legal review before any public export.

## Abuse, moderation, and legal process

E2EE prevents the intake service from pre-screening plaintext. The design therefore needs layered controls that do not turn into source identification:

- strict ciphertext size/count limits, queue quotas, anonymous proof-of-work on onion, and bounded retention for unopened spam;
- authenticated, least-privilege journalist access and malware-isolated review;
- a written protocol for imminent threats, targeted harassment, extortion, doxxing, non-consensual intimate imagery, child sexual abuse material, stolen credentials, malware, and copyrighted materials;
- escalation to trained safety/legal staff, preserving minimum necessary evidence and jurisdiction-specific reporting obligations;
- no automatic publication and no AI-only credibility, legality, or identity decision;
- documented rejection, quarantine, retention, deletion, litigation-hold, and appeal rules;
- a transparency report with aggregate counts only where the group size is large enough to avoid source inference;
- warrant/civil-demand handling by qualified counsel, data-minimization by design, and an accurate privacy notice. Do not promise the organization can resist an order, identify no one, or protect privilege in every jurisdiction.

Moderation labels, journalist notes, source-risk classifications, and legal holds are private newsroom objects. Public stories are newly created, redacted, signed publications with an explicit provenance link only when disclosure is safe.

## Editorial voice and source care

The public newsroom voice should feel like an original brave city desk: empathetic to sources, urgent when public safety requires it, evidence-first, skeptical of power, and committed to the public interest. A restrained “superhero newsroom” energy can come from language about signals, witnesses, records, duty, and courage—not from imitating a fictional newsroom.

Do not use Flash, Iris, DC character or organization names, quotes, plots, logos, newsroom sets, color systems, or copied trade dress. Never pressure a source with heroic rhetoric. Safety copy must remain calm, plain, and specific about risk; story copy can carry the urgency.

## Staged delivery plan

| Stage | Public claim allowed | Required gate |
| --- | --- | --- |
| 0: doctrine | “Secure submission research” | This threat model; static safety guidance; no upload control |
| 1: non-sensitive tips | “Confidentiality-limited contact” | Separate inbox/workflow, retention policy, clear no-anonymity warning |
| 2: encrypted clearnet pilot | “Client-encrypted pilot; not anonymous” | Reviewed envelope library, isolated origin, no telemetry, key transparency, hardened journalist path, external test |
| 3: onion pilot | “Anonymous-access pilot” | Dedicated v3 onion, verified addresses, reproducible build, operational runbooks, source training, red team |
| 4: production | “E2EE anonymous source system” with named limitations | Independent cryptography/infrastructure audit, newsroom drills, legal policies, incident response, backup/restore tests, monitoring, published audit status |
| 5: WOKE.NET replication research | “Encrypted replicated intake research” | Multiple independent storage nodes, deletion/availability/rollback tests, metadata study, audit; never replace Stage 4 on aspiration alone |

The website must expose a machine-readable status document with booleans or enums for `clearnet_intake`, `client_encryption`, `onion_service`, `key_transparency`, `journalist_isolation`, `independent_audit`, `public_replication`, and `last_verified_at`. A feature is live only when its production check passes from outside the deployment.

## Production acceptance tests

- Test vectors for canonical encoding, manifest validation, HPKE envelopes, chunk encryption, tampering, truncation, reordering, duplication, rollback, expiry, and cross-protocol confusion.
- Property tests proving nonce uniqueness under retry, crash, resume, concurrent tabs, and large files.
- Recipient add/remove/rotate/revoke/expiry drills, including a compromised-key exercise.
- Build compromise exercise: verify independent monitors detect a targeted JavaScript/hash change.
- Browser matrix with third-party requests, storage, service workers, referrers, DNS prefetch, CSP violations, and cache inspected.
- Network capture confirming no plaintext, filenames, stable IDs, precise timestamps, or hidden analytics leave the source interface.
- Tor/onion reachability and configuration assessment, traffic-analysis review, and denial-of-service exercise.
- Malicious file corpus handled only in isolated viewing; outbound callbacks demonstrably fail.
- Seizure tabletop for source device, journalist device, intake server, object store, DNS/CDN account, and offline root.
- Custody-log verification, retention deletion, backup restore, key destruction, legal hold, and incident-notification drills.
- Independent security audit findings remediated and published at an appropriate level before the production claim.

## Implementation work packages

1. Select or deploy mature SecureDrop infrastructure; assign trained administrators, journalists, security owner, and counsel.
2. Build the isolated static source-safety page and status manifest—without an upload feature.
3. Specify canonical binary wire format and generate cross-language test vectors.
4. Select an audited HPKE and streaming-AEAD implementation; perform dependency and reproducible-build review.
5. Implement offline-root recipient manifests, transparency witnesses, rotation/revocation tooling, and dual-control runbooks.
6. Implement ciphertext intake with bounded anonymous abuse controls and optional coarse receipts.
7. Establish hardened retrieval, quarantine, secure viewing, custody, redaction, and public-export environments.
8. Deploy and independently verify a v3 onion service; publish its address through multiple authenticated channels.
9. Conduct cryptography, web, infrastructure, Tor, newsroom-operations, and legal reviews.
10. Only then change the public status from staged to pilot or production.

## Primary references

- [SecureDrop threat model](https://docs.securedrop.org/en/latest/appendices/threat_model/threat_model.html) — Freedom of the Press Foundation's explicit actor, adversary, system, seizure, and network model.
- [Security considerations for confidential tip pages](https://freedom.press/digisec/blog/security-confidential-tip-pages/) — source-channel tradeoffs, Tor visibility, embedded document metadata, and isolated viewing.
- [Tor Project: What are onion services?](https://support.torproject.org/about-tor/onion-services/what-is-a-dot-onion/) and [onion service protocol overview](https://community.torproject.org/onion-services/overview/index.html) — official anonymity-path background.
- [W3C Web Cryptography Level 2](https://www.w3.org/TR/webcrypto/) — browser cryptographic primitives and explicit script-injection, storage, zeroization, and protocol-design cautions.
- [RFC 9180: Hybrid Public Key Encryption](https://www.rfc-editor.org/rfc/rfc9180.html) — standardized recipient-envelope construction and registered suites.
- [RFC 9420: Messaging Layer Security](https://www.rfc-editor.org/rfc/rfc9420.html) — group epochs, forward secrecy, post-compromise security, and mandatory secret deletion constraints for a future reply channel.

