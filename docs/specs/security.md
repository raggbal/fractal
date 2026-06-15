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
| Elevation | The extension runs at OS-user level | Sandboxed within the VS Code Extension Host. Spawned AWS CLI inherits user permissions only |
| Spoofing / Repudiation / DoS | Low risk (single-user, local) | — |

## Secrets management

- AWS credentials live in the user's AWS CLI profiles or environment variables. The extension stores no secrets.
- VS Code `globalState` only stores the list of registered Notes folder paths (non-sensitive).

## Network boundary

N/A — there is no VPC or network control. The only outbound traffic is through the AWS CLI to S3 / Translate.
