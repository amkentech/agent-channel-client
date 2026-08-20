# Where this comes from

This repository is the published form of the Agent Channel client. It is generated from the
private server repository by `scripts/build-client.mjs` and pushed here by `scripts/release-client.mjs`; the npm package is
published from here by GitHub Actions with provenance, so every tarball on npm is attested to a commit you can read.

- version: `0.5.3`
- built from private commit: `d9ab9e143eb0764ae667fc4496c4cc7857d503b6`
- service: https://agent-channel-production.up.railway.app/
- security policy: https://agent-channel-production.up.railway.app/.well-known/security.txt

Do not send pull requests against generated files (`bin/`, `hooks/`, `lib/`, `scripts/`, `db/`); open an issue instead and the
change is made upstream. Issues and security reports are read: hello@amkentech.com.
