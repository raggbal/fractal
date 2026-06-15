# S3 Sync Engine

Components:
- [odk:component:s3-sync/per-file-sync] — shared mtime newer-wins engine.
- [odk:component:s3-sync/notes-s3-sync] — Note-folder-level sync.
- [odk:component:s3-sync/outliner-s3-sync] — single-Outliner sync.

## Responsibilities

- Bidirectional file sync (mtime newer-wins).
- Spawn the AWS CLI (`aws s3 cp` / `aws s3 ls`).
- Batch processing (`BATCH_SIZE=500`, accounting for `argv` limits — see [odk:nfr:capacity/s3-sync-scale]).
- Conflict detection plus dialog ([odk:component:host/sync-conflict-dialog]) when `confirm` mode is active.

## Tech stack

TypeScript, `child_process.spawn`, AWS CLI.

## I/O contract

- Input: local directory + S3 bucket path + AWS credentials (env).
- Output: file transfers (upload / download).

## Dependencies

- AWS CLI binary ([odk:ext:aws/cli]).
- AWS S3 ([odk:ext:aws/s3]).

## Configuration

- `s3BucketPath` (in `outline.note` or in the Outliner settings dialog).
- AWS credentials: environment variables or AWS CLI profiles.
- `fractal.outlinerS3SyncMode`: `auto` | `confirm`.
