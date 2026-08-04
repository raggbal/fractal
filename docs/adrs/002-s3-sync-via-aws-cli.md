# ADR-002: S3 Sync via AWS CLI (not SDK)

## Status: Superseded by ADR-0009 (.harness/adr/ADR-0009-aws-sdk-v3-esbuild.md, v1.1.16 — AWS SDK v3 + esbuild へ移植)

Scope: fractal

## Context

Fractal's S3 Sync feature needs to transfer files between the local filesystem and S3. Two approaches exist:

1. Embed `@aws-sdk/client-s3` and implement transfer logic in TypeScript.
2. Spawn AWS CLI (`aws s3 cp` / `aws s3 sync`) as a child process.

## Decision

Use AWS CLI via `child_process.spawn`.

Rationale:

1. **Leverage user's existing AWS CLI authentication** — profiles, SSO, credential chains, MFA — without reimplementing credential resolution in the extension.
2. **Avoid reinventing file sync** — File synchronization is a critical path where bugs cause data loss. AWS CLI's transfer logic (multipart, retry, integrity checks) is battle-tested. Reimplementing it in SDK calls introduces risk with no user-facing benefit.

## Alternatives

- **@aws-sdk/client-s3**: Would require reimplementing credential resolution (SSO, profiles) and transfer reliability (retry, multipart). Large bundle size increase (~2MB+). Risk of subtle sync bugs in custom transfer logic.

## Consequences

- Users must have AWS CLI installed and configured (`aws --version` is checked at runtime).
- Extension bundle size stays small (no AWS SDK dependency).
- Progress reporting is coarser (based on CLI output parsing rather than SDK event streams).
- Per-file mtime comparison is implemented in `s3-per-file-sync.ts` on top of CLI commands (since `aws s3 sync` uses size-only comparison which is insufficient for newer-wins semantics).
