# aws-translate

Component: [odk:component:translate/aws-translate]

## Responsibilities

- Translate Markdown text via AWS Translate (the AWS CLI).
- Protect code blocks, inline code, math, and HTML comments by splitting into `translate` / `preserve` segments.
- Auto-chunk at 10 KB per request (see [odk:nfr:capacity/translate-chunk]).
- Manage Custom Terminology (`importTerminology`).

## Tech stack

TypeScript, `child_process.spawn`, AWS CLI.

## I/O contract

- Input: Markdown text, source / target language, AWS credentials.
- Output: translated Markdown text.

## Dependencies

- AWS CLI binary ([odk:ext:aws/cli]).
- AWS Translate ([odk:ext:aws/translate]).

## Configuration

- `fractal.translateSourceLang`, `fractal.translateTargetLang` — default source / target language.
- `fractal.transRegion` — AWS region for Amazon Translate.
- `fractal.translateTerminologyFile`, `fractal.translateTerminologyName` — Custom Terminology file path and name registered in Amazon Translate.
- `fractal.transAccessKeyId`, `fractal.transSecretAccessKey` — optional credentials passed to the spawned `aws` CLI as environment variables (otherwise the user's AWS CLI profile / env vars are used).
- `fractal.showTranslateButtons` — show translate buttons in the editor toolbar / side-panel header.
