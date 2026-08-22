# Where this comes from

This repository is the published form of the Agent Channel client. It is generated from the
private server repository by `scripts/build-client.mjs` and pushed here by `scripts/release-client.mjs`; the npm package is
published from here by GitHub Actions with provenance, so every tarball on npm is attested to a commit you can read.

- version: `0.6.1`
- built from private commit: `b8cd81b6baf2c9c8524c3204d9dc68dfd9f35395`
- service: https://channel.amkentech.com/
- security policy: https://channel.amkentech.com/.well-known/security.txt

Do not send pull requests against generated files (`bin/`, `hooks/`, `lib/`, `scripts/`, `db/`); open an issue instead and the
change is made upstream. Issues and security reports are read: hello@amkentech.com.
