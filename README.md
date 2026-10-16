# Phoenixd L402 SDK

Create Lightning invoices and verify L402 credentials against a Phoenixd node. The SDK verifies payment proof; your application records payments and controls resource access. Use Node.js 22.12 or later.

## Install

```sh
npm install @nodana/phoenixd-l402-sdk @nodana/phoenixd-ts
```

## Verify payment for a request

Set `PHOENIXD_URL` to your node's HTTPS endpoint and `PHOENIXD_PASSWORD` to its restricted password (`http-password-limited-access`). Generate an application secret with `openssl rand -hex 32` and save it as `L402_SECRET_KEY` in your backend. Retain the secret across deployments and application instances.

This example grants one request per payment using an application-owned database operation:

```ts
import { Phoenixd } from "@nodana/phoenixd-ts";
import { L402 } from "@nodana/phoenixd-l402-sdk";
import { db } from "./database"; // Your application's database functions.

const node = new Phoenixd(
  process.env.PHOENIXD_URL!,
  process.env.PHOENIXD_PASSWORD!,
);
const payments = L402.create({
  client: node,
  secretKey: process.env.L402_SECRET_KEY!,
});
const check = payments.charge({ amount: "100", description: "Weather report" });

export async function handler(request: Request): Promise<Response> {
  const proof = await check(request);
  if (proof.status === 402) return proof.challenge;

  // A unique payment-hash insert makes each payment usable once in this application.
  const recorded = await db.recordPaymentOnce(proof.payment.paymentHash);
  if (!recorded) return new Response("Payment already used", { status: 409 });

  return Response.json(
    { weather: "sunny" },
    { headers: { "Cache-Control": "no-store" } },
  );
}
```

`db.recordPaymentOnce` is your application's database function. Implement it with a unique payment-hash insert: return `true` when inserted, `false` for an existing payment, and throw on other database errors. Run your protected operation only after the database operation succeeds.

## Choose your access policy

A verified proof confirms payment for the configured price and matching request. The SDK does not record whether it has been used. Your application can grant one request, an entitlement, or prepaid usage according to its own records. L402 credentials can be presented repeatedly until expiry; verification alone does not enforce a charge for every call.

The credential is restricted to the same URL, method and body. Keep application authentication and user-specific permissions in your normal access checks.

## Set invoice and credential expiry

| Setting                  | Purpose                                            | Default     |
| ------------------------ | -------------------------------------------------- | ----------- |
| `invoiceExpirySeconds`   | Time allowed to pay an invoice                     | 300 seconds |
| `challengeExpirySeconds` | Credential verification deadline from issuance     | 300 seconds |
| `network`                | Expected network: `mainnet`, `regtest` or `signet` | `mainnet`   |

Set these options on `L402.create`. Credential expiry is capped to the invoice expiry. Payment does not extend the deadline. Your application's entitlement records determine any access granted after initial payment verification.

## Test and troubleshoot

Probe an endpoint with `curl -i https://api.example.com/weather`. Expect HTTP `402` with an L402 challenge. Pay using an L402-capable client and retry with the token and payment preimage.

Test your application's access policy, including repeated credentials and concurrent requests. If recording a payment fails, return a service error without running the protected operation. Handle recovery if application work fails after the payment has been recorded.

- **Invoice creation fails:** check the endpoint, restricted password, node status and network. The SDK throws `L402Error` with code `invalid_invoice` if the node cannot supply a matching, unexpired invoice.
- **Paid credentials are rejected:** check expiry, current price, request URL, method and body, and the application signing secret.
- **Payment was already recorded:** look up the application's payment record before requesting another payment; the original operation may have completed.

Use HTTPS for API and node connections. Keep passwords, signing secrets and payment credentials in trusted applications and out of logs.

## Reference

- [L402 documentation](https://docs.lightning.engineering/the-lightning-network/l402)
- [Phoenixd HTTP API](https://phoenix.acinq.co/server/api)
- [Development](docs/development.md)
