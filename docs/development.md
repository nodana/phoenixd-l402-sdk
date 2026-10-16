# Development

## Checks

Use Node.js 22.12 or later. Run `npm ci` followed by `npm test`. Tests cover macaroon serialization/signatures, proof and request validation, price, expiry, attenuation, independent instances, application-owned recording and ESM/CommonJS consumer declarations. The Phoenixd HTTP integration uses mocked node responses and simulated settlement; perform a funded regtest payment with a separate client before production release.

## Architecture

The package only issues challenges and verifies credentials. It has no payment records, replay set, storage interface or adapters. `@nodana/phoenixd-ts` creates/decodes invoices against any configured node; `macaroon` handles standard V2 macaroons. No Nodana service or node modification is required.

A version-0 L402 identifier contains the two-byte version, 32-byte invoice payment hash and a random 32-byte token ID. Per-token root keys are derived with HMAC-SHA256 from the application's signing secret, the domain separator `phoenixd-l402-sdk:root:v1\0` and the identifier. Rotating the application secret invalidates every credential.

Signed caveats bind the credential to the price, expiry and SHA-256 hash of a JSON array containing the URL, method and SHA-256 body hash. All required caveats must be present and satisfied. Unknown and third-party caveats are rejected. Supported appended caveats only restrict access; a matching preimage caveat is accepted. The colon-separated proof remains required.

Challenges use `WWW-Authenticate: L402 macaroon="...", invoice="..."`. Credentials accept L402 and legacy LSAT, standard base64 or unpadded base64url, and a hex preimage. The signature and SHA-256 proof must both verify. Verification makes no node calls and may succeed repeatedly for the same credential.

`challengeExpirySeconds` starts at issuance and is capped to the invoice's expiry. Both default lifetimes are 300 seconds. Payment does not extend the deadline. Prices are integer satoshi strings parsed with BigInt and bounded before exact conversion to Phoenixd's numeric HTTP API values.

## Application responsibilities

A result with `status: 200` means the proof verified, not that the application has granted access or recorded a purchase. The application owns its payment history, entitlements, usage accounting and redemption policy. For one request per payment, perform an atomic unique payment-hash insert before invoking the protected operation; a separate read then write is insufficient under concurrency. Throw database errors rather than treating them as successful or duplicate payments.

The README's database function is application-owned. Keep enough history to enforce the chosen policy and recover from failed delivery. A credential's expiry does not erase the application's record of the purchase. A post-purchase operation can fail after recording; implement recovery/idempotency in the application.

Body hashing buffers a request clone. Apply normal request-size limits before the handler. Credentials bind URL, method and body, not application headers. Enforce application authorization separately. Challenge responses set Cache-Control: no-store; apply an equivalent policy to protected results. Rate-limit unpaid requests because each creates an invoice. Use HTTPS and never log preimages or node credentials.

## Release

1. Set matching versions in `package.json` and `package-lock.json`.
2. Run `npm test` and inspect `npm pack --dry-run`.
3. Commit and push the package to its repository.
4. Publish a GitHub Release tagged with the exact version, for example `v0.1.0`.

The included workflow installs dependencies, runs the checks and publishes to npm with provenance. Configure an npm trusted publisher for repository `nodana/phoenixd-l402-sdk` and workflow `npm-publish.yml` before the first automated release. The workflow alone does not configure npm permissions. GitHub prereleases use the `next` dist-tag; stable releases use `latest`.
