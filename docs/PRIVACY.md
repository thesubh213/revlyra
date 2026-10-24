# Privacy

Revlyra is designed as a **processor-style** component: it runs in the customer's
infrastructure and the customer remains the data controller.

## Data minimization

Default behavior:
- Reviewer, item, review, IP, and actor identifiers → tenant-scoped HMACs.
- Raw IP is used transiently for subnet/country/ASN features and is **not stored**.
- Subnets are truncated to /24 (IPv4) or /48 (IPv6).
- Device IDs and email domains are HMACs.
- Contact details are masked before evidence is stored.
- Media files are not stored; only hashes, dimensions, MIME, and selected EXIF.
- Source credentials are environment references, not database rows.
- No telemetry by default; opt-in only, aggregate counts only.

### Identity-key scrubbing (Glassdoor guardrail — report §2.3)

Retroactively linking real-world identity to an anonymous account without
explicit granular consent is the documented Glassdoor failure mode. Revlyra
defends against reintroduction through call payloads:
- `REVLYRA_IDENTITY_MINIMIZATION` (default `1`) strips identity-shaped keys —
  real-name, resume/CV, DOB, national-ID/passport/SSN-shaped keys, profile
  URLs (`facebook/…/linkedin/violating social profile links`) — from reviewer
  stats and item attributes before persistence.
- Every strip is auditable (`review.identity_keys_stripped`) so tenants stay
  accountable for what was dropped.
- The engine never enriches reviewer profiles with third-party identity
  sources, and pseudonymous reviewers must not be re-linked retroactively by
  the hosting platform without an explicit, granular, separately-consented
  legal basis (GDPR Art. 6 + purpose limitation).

## Retention

| Data                   | Default                             |
| ---------------------- | ----------------------------------- |
| Review normalized text | 180 days (`REVLYRA_RETENTION_DAYS`) |
| Network context        | 30 days                             |
| Signals and scores     | Same as review                      |
| Media hashes           | Same as review                      |
| Audit log              | 2 years                             |
| License usage counters | 24 months                           |
| Notices (claim text)   | Follows the review's retention      |
| Appeals metadata       | Follows the review's retention      |

`revlyra worker --once` runs the retention handler when a retention job exists.
Purges remove reviews, signals, text fingerprints, media hashes, and graph edges.
Use Postgres partitioning or scheduled jobs for very large stores.

Privacy-first deployments can set `REVLYRA_STORE_RAW_TEXT=false` (default) to keep
only normalized/redacted text, or implement an ephemeral text store by extending
`ReviewService`.

## GDPR / UK GDPR

Recommended posture:
- **Lawful basis:** legitimate interest in fraud prevention and platform integrity,
  or contract performance where applicable.
- **Purpose limitation:** review integrity, not advertising or unrelated profiling.
- **Transparency:** publish a notice explaining automated review screening, the
  categories of data used, retention, and appeal rights.
- **Data minimization:** HMAC identifiers, no special-category data, no raw IPs.
- **Article 22:** review removal or account restrictions can have significant
  effects. Keep a human decision-maker for adverse actions and provide an appeal.
- **DPIA:** complete one for large-scale profiling; document the LIA, safeguards,
  false-positive monitoring, and retention.
- **Processor terms:** include a DPA, sub-processor list (license server, optional
  model host), and international transfer mechanism if applicable.
- **Rights:** support access, rectification, erasure, restriction, and objection
  by reviewer HMAC. `purgeOlderThan` supports deletion by time; add a targeted
  deletion job for individual requests.

## CCPA / CPRA

- No sale or sharing of personal information for cross-context behavioral ads.
- Support access and deletion requests by reviewer HMAC.
- Document the business purpose (fraud prevention/security).

## Fairness

- Language, review length, account age, and region are monitored for false-positive
  disparities.
- Typo rate and non-native phrasing are capped and never strong evidence.
- Appeals that overturn a reason code more than ~5% of the time should trigger a
  weight/threshold review.
- Publish an internal model card for any shipped classifier: training data,
  limitations, calibration, and known failure modes.

## Data subject requests

1. Resolve the reviewer's external ID to the tenant-scoped HMAC.
2. Export stored reviews/signals/feedback by reviewer.
3. Delete reviews, signals, fingerprints, media hashes, graph edges, and feedback;
   keep only the minimum audit record required by law.
4. Verify the audit chain after deletion.

## Model and LLM providers

- The optional transformer tier runs locally; no review text leaves the host by
  default.
- If a customer enables a third-party LLM plugin, only the injection-sanitized
  copy (`normalized.modelText`) may be sent, with a DPA and explicit
  configuration. Prompt-injection phrases are neutralized before they can
  reach any model tier. Revlyra does not ship an LLM provider enabled by
  default.
- Model downloads require explicit consent and use a checksum-pinned cache.
