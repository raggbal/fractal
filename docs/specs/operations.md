# Operations / Runbook

Fractal is a local tool. There is no on-call rotation, incident response, or DR plan.

## User troubleshooting

- **S3 Sync fails** → confirm AWS authentication with `aws sts get-caller-identity`.
- **Translate fails** → verify the AWS CLI is installed and the `region` setting is correct.
- **drawio change not reflected** → confirm the file was explicitly saved in drawio Desktop (auto-save is not relied upon).
