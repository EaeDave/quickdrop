# Security policy

## Reporting a vulnerability

Please do not open a public issue for a suspected vulnerability or include private clipboard contents, access tokens, credentials, or signing material in a report.

Use GitHub's **Report a vulnerability** form in the repository Security tab. If private vulnerability reporting is temporarily unavailable, open a minimal issue asking a maintainer to establish a private contact channel without disclosing technical details.

Include the affected version, impact, reproduction steps, and any suggested mitigation. Maintainers will acknowledge the report and coordinate disclosure after a fix is available.

## Supported versions

QuickDrop currently supports the latest published release. Desktop update bundles are accepted only when signed with the private key corresponding to the updater public key embedded at build time.

PIN-protected text rooms issue short-lived access grants. Browsers keep grants in HTTP-only same-origin cookies; native clients keep the equivalent token in memory, and server logs redact both room codes and access tokens.
