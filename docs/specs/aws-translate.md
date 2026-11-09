# aws-translate

Component: [odk:component:translate/aws-translate]

## Responsibilities

- Translate Markdown text via Amazon Translate (AWS SDK for JavaScript v3, ADR-0009).
- Protect code blocks, inline code, math, and HTML comments by splitting into `translate` / `preserve` segments.
- Auto-chunk at 10 KB per request (see [odk:nfr:capacity/translate-chunk]).
- Manage Custom Terminology (`importTerminology`).

## Tech stack

TypeScript, `child_process.spawn`, AWS CLI.

## I/O contract

- Input: Markdown text, source / target language, AWS credentials.
- Output: translated Markdown text.

## Dependencies

- AWS SDK for JavaScript v3 (`@aws-sdk/client-translate`, bundled). The AWS CLI is not needed.
- AWS Translate ([odk:ext:aws/translate]).

## Configuration

- `fractal.awsAccessKeyId`, `fractal.awsSecretAccessKey`, `fractal.awsRegion` — shared with S3 sync (ADRL-0141). Both keys empty = the SDK's default credential chain, the same as the AWS CLI (environment variables, the profile in `~/.aws` — `AWS_PROFILE` or `default` — SSO, credential_process, assume-role, container / instance roles). Only one key = a settings error. Region: the setting → `AWS_REGION` → `AWS_DEFAULT_REGION` → the profile's `region` → `us-east-1` (`src/shared/aws-settings.ts`).
- `fractal.translateTerminology` — Custom Terminology: a CSV / TMX file (uploaded with *Fractal: Update Translate Terminology* under a name made from the file name) or the name of a terminology already in Amazon Translate (`src/shared/translate-terminology.ts`). A missing terminology → translated without it, and the user is told.
- The source / target language chosen last is kept in globalState (`src/shared/translate-langs.ts`), not in settings.
- The settings of earlier versions (`fractal.trans*`, `fractal.translateSourceLang` / `TargetLang`, `fractal.translateTerminologyFile` / `Name`) are moved once at startup (`src/shared/settings-migration.ts`).
- `fractal.showTranslateButtons` — show translate buttons in the editor toolbar / side-panel header.
