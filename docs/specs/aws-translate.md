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

- `fractal.translate.sourceLang`, `fractal.translate.targetLang`.
- `fractal.translate.region`.
- `fractal.translate.terminologyName`.
- AWS credentials: environment variables or AWS CLI profiles.
