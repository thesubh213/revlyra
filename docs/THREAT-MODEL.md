# Threat model (summary)

See [SECURITY.md](SECURITY.md) for controls and deployment hardening.

## Adversaries

1. **Opportunistic fakers** — copy-paste reviews, incentivized batches, new accounts.
2. **Coordinated groups** — sockpuppets, review farms, rating bombs, image reuse.
3. **Sophisticated operators** — residential proxies, aged accounts, paraphrasing,
   original photos, slow drip campaigns.
4. **Adversarial AI attackers** — LLM-generated reviews and embedded prompt
   injections aimed at AI review processors (report §3.2).
5. **Malicious tenants** — trying to access another tenant's data or exceed limits.
6. **Network attackers** — SSRF, injection, credential theft, supply-chain attacks.
7. **Insiders** — tampering with decisions or audit records.

## Detection surface by adversary

| Adversary        | Strong signals                                                          | Weak/absent                |
| ---------------- | ----------------------------------------------------------------------- | -------------------------- |
| Opportunistic    | exact/near duplicates, promo text, bursts, new accounts                 | polished unique text       |
| Coordinated      | co-review graph, shared media, synchronized timing, shared fingerprints | distributed devices        |
| Sophisticated    | behavior/network correlations, long-window heterogeneous graph patterns | paraphrase + fresh devices |
| Adversarial AI   | injection phrase lexicon + graph corroboration                          | flawless human-style prose |
| Malicious tenant | auth scopes, tenant-scoped store, RLS option                            | stolen admin key           |
| Network attacker | SSRF guards, parameterized SQL, input caps                              | compromised host           |
| Insider          | hash-chained audit, least privilege                                     | root access                |

## Assumptions

- TLS terminates at a trusted proxy.
- Source databases are read-only replicas or read-only roles.
- The host, Node runtime, and dependencies are not compromised.
- The customer has a human review and appeal process.
- License keys and peppers are stored in a secret manager.

## Residual risks

- DNS rebinding against media fetchers (mitigated but not eliminated).
- Model drift and adversarial adaptation (injection phrasings mutate).
- False positives harming legitimate reviewers; routed safety reviews and the
  appeal SLA keep the human surface open.
- PII leakage through customer-supplied metadata fields (identity-key scrubbing
  reduces, does not eliminate).
- License bypass by patching client code.
- Cross-tenant leakage if a custom store implementation omits tenant scoping.

These risks should be documented in the customer's DPIA and security review.
