# Open-source readiness audit

Audit scope: tracked files, reachable Git history, release workflows, desktop build configuration, backend deployment, dependencies, container contents, and repository settings.

## Completed hardening

- Gitleaks found no credentials in reachable Git history, pull-request/issue/release metadata, or available Actions logs.
- The deployment origin is configured with `QUICKDROP_PUBLIC_BASE_URL` instead of being embedded in source.
- Tauri builds receive both the deployment origin and updater public key from environment/repository variables.
- Install scripts are rendered by the backend with the configured deployment origin.
- Release verification and updater manifest generation use environment configuration.
- Public GitHub release assets can be proxied anonymously; a token remains supported for private repositories and higher API limits.
- GitHub Actions dependencies are pinned to full commit hashes.
- JavaScript dependency advisories were resolved and Rust dependencies were updated to remove known high-severity vulnerabilities.
- The Docker image now includes every installer and excludes local Rust targets and generated graph artifacts from its build context.
- MIT licensing, a security policy, contribution guidance, and Dependabot configuration were added.

## Expected public values

These values are intentionally public and may be embedded in binaries:

- deployment origin;
- updater public key;
- GitHub release repository;
- product and bundle identifiers.

Private values must remain only in deployment or Actions secrets:

- database and R2 credentials;
- optional GitHub backend token;
- Tauri updater private key and its password.

## Remaining checks before changing visibility

1. Review the author email addresses stored in historical commit metadata. At least one commit uses a personal mailbox rather than a GitHub no-reply address. `.mailmap` can improve display but cannot remove raw metadata; complete removal requires a disruptive history rewrite.
2. Remove stale remote branches that are no longer needed. Preserve any unmerged roadmap branch intentionally.
3. Confirm that the MIT license is the desired project license.
4. Change repository visibility, then enable branch protection, private vulnerability reporting, secret scanning/push protection, and approval for workflows from first-time external contributors.
5. Verify fork pull requests cannot access release secrets. Current workflows do not use `pull_request_target`; the signing secret is limited to tag/manual release builds.
6. After releases become public and the backend deployment is updated, remove `QUICKDROP_GITHUB_TOKEN` from production unless authenticated API capacity is still desired.
7. Publish and validate a new signed desktop release. Existing public updater builds must continue using the same private signing key.

## Residual dependency notices

`cargo audit` reports no blocking Rust vulnerabilities after the lockfile update. It still reports warnings inherited from upstream UI stacks, including unmaintained GTK3 bindings used by Tauri on Linux and `lru`/`paste` through Ratatui. Replacing these requires upstream framework migrations and is not treated as an immediate disclosure blocker.
