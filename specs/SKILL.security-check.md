---
name: security-check
description: Deeper security-focused review pass. Load only when the diff touches auth, crypto, payments, input handling, dependencies, CI, IaC, or database migrations. Complements review-rubric; does not replace it.
---

# Security Check

This pass runs only when the diff touches a security-sensitive surface. Assume an adversary
controls every input. Your job is to find the specific line where a trust boundary is
crossed without a check — not to give a generic security lecture.

## Trust-boundary checklist

Walk the changed code and ask, for each external input:

- **Injection** — Is user-controlled data concatenated into SQL, shell commands, HTML,
  templates, regex, or file paths without parameterization/escaping? Flag the exact line.
- **AuthN / AuthZ** — Does a new endpoint, route, or handler verify identity AND
  permissions? Look for missing ownership checks (IDOR: can user A act on user B's resource
  by changing an ID?).
- **Secrets** — Any API key, token, password, private key, or connection string hardcoded
  or logged? Any secret added to a non-secret config file?
- **Input validation** — Are size, type, range, and format validated before use? Unbounded
  input → DoS. Unvalidated redirects/URLs → SSRF / open redirect.
- **Deserialization & parsing** — Untrusted data into `eval`, `Function`, YAML/pickle
  loaders, or XML parsers with external entities?
- **Path traversal** — User input in file paths without normalization + allowlist?
- **Crypto** — Home-rolled crypto, weak/legacy algorithms, missing randomness, predictable
  tokens, comparison of secrets with non-constant-time equality?
- **Dependencies** — New dependency added: is it reputable and pinned? Manifest change that
  widens version ranges or pulls an unmaintained package?
- **CI / IaC / Docker** — New workflow running untrusted PR code with secrets in scope?
  `pull_request_target` misuse? Overly broad cloud IAM? Container running as root, secrets
  baked into image layers?
- **Migrations** — Destructive or non-reversible schema change? Data exposure via a new
  column/table without access control?

## Reporting

Use the same JSON output format as `review-rubric`. For each security finding:

- Severity is almost always `critical` or `major`. Reserve `critical` for exploitable issues
  (clear path from attacker input to impact) and confirmed secret exposure.
- In `body`, state the **attack**: "An attacker who controls X can do Y because Z is not
  checked." Concrete, not theoretical.
- In `suggestion`, give the specific mitigation (parameterized query, authz check location,
  validation, constant-time compare), not "sanitize the input".

## Restraint

Do not flag defense-in-depth nice-to-haves as `critical`. Do not invent threats that the
surrounding architecture already mitigates if you can see it does. If you cannot see enough
context to confirm a real exploit path, mark the finding `major` and set overall
`confidence: low` so a stronger model double-checks before it's posted.
