# Security

## Auth boundary

N/A — Fractal is a local extension. There are no inbound requests. AWS authentication is delegated to the user's AWS CLI configuration.

## IAM blast-radius

N/A — IAM is not managed by Fractal; the AWS CLI uses whatever profile/role permissions the user already has.

## STRIDE threat model

| Category | Risk | Mitigation |
|---|---|---|
| Tampering | Path traversal: external input (node ID, page ID, file name) used in path construction may escape the directory | Apply `safeResolveUnderDir` (resolve + `is_relative_to` check) to every path operation. See [odk:req:security/path-traversal-guard]. |
| Info disclosure | Webview could read arbitrary local files | VS Code CSP plus `localResourceRoots` constrain what the webview can load |
| Elevation | The extension runs at OS-user level | Sandboxed within the VS Code Extension Host. AWS calls (SDK) use the user's own credentials only |
| Spoofing / Repudiation / DoS | Low risk (single-user, local) | — |

## Secrets management

- **Preferred path**: AWS credentials live in the user's AWS CLI configuration (`~/.aws` profiles, SSO, environment variables). With the access key settings empty, the bundled AWS SDK resolves them with its default chain — the same as the AWS CLI (ADRL-0141). Fractal stores nothing.
- **Optional in-extension settings**: `fractal.awsAccessKeyId` / `fractal.awsSecretAccessKey` (one pair for S3 sync and translation) and `fractal.awsRegion`, passed to the SDK clients as static credentials. Because VS Code (and the desktop app) store user settings as plain JSON in `settings.json`, **these values are not encrypted** (and VS Code Settings Sync, if enabled, syncs them) — the user is responsible for choosing whether to use them. They are not sent anywhere by Fractal except to AWS.
- VS Code `globalState` only stores the list of registered Notes folder paths (non-sensitive).

## Network boundary

N/A — there is no VPC or network control. The only outbound traffic is the AWS SDK's calls to S3 / Translate (and, with the default chain, to SSO / STS / instance metadata when the user's AWS configuration uses them).
