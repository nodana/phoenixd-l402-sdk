import { serializeMacaroon } from "../src/serialize";
import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import macaroon from "macaroon";
import { L402, L402Error } from "../src";
import { fakeNode } from "./helpers";

const secretKey = "a".repeat(64);

const endpoint = "https://api.example.test/query";

const request = (credential?: string, url = endpoint, body = "question") =>
  new Request(url, {
    method: "POST",
    body,
    ...(credential ? { headers: { Authorization: credential } } : {}),
  });

async function setup() {
  const node = fakeNode();

  const payments = L402.create({ client: node, secretKey });

  const handler = payments.charge({ amount: "100", description: "Query" });

  const result = await handler(request());

  if (result.status !== 402) throw new Error("Expected challenge");

  const challenge = (await result.challenge.json()) as {
    macaroon: string;
    invoice: string;
    paymentHash: string;
    amountSat: number;
    expiresAt: number;
  };

  const paid = await node.payInvoice({ invoice: challenge.invoice });

  if (paid.type !== "payment_sent") throw new Error("Expected payment");

  const preimage = paid.paymentPreimage;

  const credential = `L402 ${challenge.macaroon}:${preimage}`;

  return {
    node,
    payments,
    handler,
    result,
    challenge,
    preimage,
    credential,
  };
}

afterEach(() => vi.restoreAllMocks());

describe("L402 access", () => {
  it("issues a standard binary macaroon and invoice, and accepts an external wallet's proof", async () => {
    const { node, handler, result, challenge, credential } = await setup();

    expect(result.challenge.status).toBe(402);

    expect(result.challenge.headers.get("WWW-Authenticate")).toBe(
      `L402 macaroon="${challenge.macaroon}", invoice="${challenge.invoice}"`,
    );

    expect(result.challenge.headers.get("Cache-Control")).toBe("no-store");

    expect(node.createInvoice).toHaveBeenCalledWith({
      amountSat: 100,
      description: "Query",
      expirySeconds: 300,
    });

    const binary = Buffer.from(challenge.macaroon, "base64");

    expect(binary[0]).toBe(2);

    const decoded = macaroon.importMacaroon(binary);

    const identifier = Buffer.from(decoded.identifier);

    expect(identifier.length).toBe(66);

    expect(identifier.readUInt16BE(0)).toBe(0);

    expect(identifier.subarray(2, 34).toString("hex")).toBe(
      challenge.paymentHash,
    );

    // Cross-check the issued signature using Node crypto and the standard macaroon key derivation.
    const root = createHmac("sha256", Buffer.from(secretKey, "hex"))
      .update("phoenixd-l402-sdk:root:v1\0")
      .update(identifier)
      .digest();
    const derived = createHmac("sha256", "macaroons-key-generator")
      .update(root)
      .digest();
    let signature = createHmac("sha256", derived).update(identifier).digest();

    for (const caveat of decoded.caveats)
      signature = createHmac("sha256", signature)
        .update(caveat.identifier)
        .digest();
    expect(Buffer.from(decoded.signature)).toEqual(signature);

    const resultPaid = await handler(request(credential));

    expect(resultPaid).toEqual({
      status: 200,
      payment: {
        paymentHash: challenge.paymentHash,
        amountSat: 100,
        expiresAt: challenge.expiresAt,
      },
    });

    expect(node.createInvoice).toHaveBeenCalledTimes(1);

    expect(node.decodeInvoice).toHaveBeenCalledTimes(1);
  });

  it("verifies the same proof across independent instances without tracking its usage", async () => {
    const { node, handler, credential } = await setup();

    const other = L402.create({ client: node, secretKey }).charge({
      amount: "100",
    });

    const results = await Promise.all([
      handler(request(credential)),
      other(request(credential)),
    ]);

    expect(results.map((r) => r.status)).toEqual([200, 200]);

    expect(node.createInvoice).toHaveBeenCalledTimes(1);
  });

  it("lets the application enforce single use with its own unique payment record", async () => {
    const { handler, credential } = await setup();

    const recordedPayments = new Set<string>();

    const application = async () => {
      const proof = await handler(request(credential));

      if (proof.status === 402) return 402;

      if (recordedPayments.has(proof.payment.paymentHash)) return 409;

      recordedPayments.add(proof.payment.paymentHash);

      return 200;
    };

    expect(await Promise.all([application(), application()])).toEqual([
      200, 409,
    ]);
  });

  it.each(["LSAT", "l402", "lsat"])(
    "accepts %s authorization",
    async (scheme) => {
      const { handler, credential } = await setup();

      expect(
        (await handler(request(credential.replace("L402", scheme)))).status,
      ).toBe(200);
    },
  );

  it.each([
    "L402 nonsense",
    "Bearer ignored",
    `L402 abc:${"0".repeat(64)}`,
    "L402 " + "a".repeat(17000),
  ])("rejects malformed credentials", async (credential) => {
    const { handler } = await setup();

    expect(await handler(request(credential))).toMatchObject({ status: 402 });
  });

  it("rejects the wrong payment preimage", async () => {
    const { handler, challenge } = await setup();

    expect(
      (await handler(request(`L402 ${challenge.macaroon}:${"0".repeat(64)}`)))
        .status,
    ).toBe(402);
  });

  it("binds access to URL, method, body and current price", async () => {
    const { handler, payments, credential } = await setup();

    expect(
      (await handler(request(credential, endpoint + "?other=true"))).status,
    ).toBe(402);

    expect(
      (await handler(request(credential, endpoint, "different"))).status,
    ).toBe(402);

    expect(
      (
        await handler(
          new Request(endpoint, { headers: { Authorization: credential } }),
        )
      ).status,
    ).toBe(402);

    expect(
      (await payments.charge({ amount: "200" })(request(credential))).status,
    ).toBe(402);

    expect((await handler(request(credential))).status).toBe(200);
  });

  it("rejects forged caveats, identifier changes and credentials issued by another secret", async () => {
    const { handler, challenge, preimage, node, credential } = await setup();

    const original = Buffer.from(challenge.macaroon, "base64");

    // Changing a digit in the signed expiry leaves a valid macaroon encoding but invalid signature.
    const tampered = Buffer.from(original);

    const expiryIndex =
      tampered.indexOf(Buffer.from("expires_at=")) + "expires_at=".length;
    tampered[expiryIndex] = tampered[expiryIndex] === 49 ? 50 : 49;

    expect(
      (
        await handler(
          request(`L402 ${tampered.toString("base64")}:${preimage}`),
        )
      ).status,
    ).toBe(402);

    const changedId = Buffer.from(original);

    const id = macaroon.importMacaroon(original).identifier;

    const index = changedId.indexOf(Buffer.from(id));
    changedId[index + 65] = changedId[index + 65]! ^ 1;

    expect(
      (
        await handler(
          request(`L402 ${changedId.toString("base64")}:${preimage}`),
        )
      ).status,
    ).toBe(402);

    const other = L402.create({
      client: node,
      secretKey: "b".repeat(64),
    }).charge({ amount: "100" });

    expect((await other(request(credential))).status).toBe(402);
  });

  it("honours attenuated expiry and rejects unknown restrictions", async () => {
    const { handler, challenge, preimage } = await setup();

    const token = macaroon.importMacaroon(
      Buffer.from(challenge.macaroon, "base64"),
    );

    const expires = Date.now() + 1000;

    token.addFirstPartyCaveat(`expires_at=${expires}`);

    const credential = `L402 ${serializeMacaroon(token).toString("base64url")}:${preimage}`;

    expect(await handler(request(credential))).toMatchObject({
      status: 200,
      payment: { expiresAt: expires },
    });
    vi.spyOn(Date, "now").mockReturnValue(expires);

    expect((await handler(request(credential))).status).toBe(402);
    vi.restoreAllMocks();

    token.addFirstPartyCaveat("unknown=restriction");

    expect(
      (
        await handler(
          request(
            `L402 ${serializeMacaroon(token).toString("base64")}:${preimage}`,
          ),
        )
      ).status,
    ).toBe(402);
  });

  it("accepts a client-appended preimage caveat", async () => {
    const { handler, challenge, preimage } = await setup();

    const token = macaroon.importMacaroon(
      Buffer.from(challenge.macaroon, "base64"),
    );

    token.addFirstPartyCaveat(`preimage=${preimage}`);

    expect(
      (
        await handler(
          request(
            `L402 ${serializeMacaroon(token).toString("base64")}:${preimage}`,
          ),
        )
      ).status,
    ).toBe(200);
  });

  it("expires access even after invoice settlement", async () => {
    const { handler, credential, challenge } = await setup();
    vi.spyOn(Date, "now").mockReturnValue(challenge.expiresAt);

    expect((await handler(request(credential))).status).toBe(402);
  });

  it("fails closed on node failures and invalid invoices", async () => {
    const { handler, node } = await setup();
    node.decodeInvoice.mockImplementationOnce(async () => {
      throw new Error("unavailable");
    });

    await expect(handler(request())).rejects.toMatchObject({
      code: "invalid_invoice",
    });
    node.createInvoice.mockRejectedValueOnce(new Error("unavailable"));

    await expect(handler(request())).rejects.toBeInstanceOf(L402Error);

    const valid = await node.createInvoice({
      amountSat: 100,
      description: "Query",
    });
    node.createInvoice.mockResolvedValueOnce({ ...valid, amountSat: 200 });

    await expect(handler(request())).rejects.toMatchObject({
      code: "invalid_invoice",
    });

    const invoice = await node.decodeInvoice({ invoice: valid.serialized });
    node.createInvoice.mockResolvedValueOnce(valid);
    node.decodeInvoice.mockResolvedValueOnce({ ...invoice, chain: "regtest" });

    await expect(handler(request())).rejects.toMatchObject({
      code: "invalid_invoice",
    });
  });

  it("validates configuration and prices", () => {
    const node = fakeNode();

    expect(() => L402.create({ client: node, secretKey: "short" })).toThrow(
      "secretKey",
    );

    expect(() =>
      L402.create({ client: node, secretKey, challengeExpirySeconds: 0 }),
    ).toThrow("Expiry");

    expect(() =>
      L402.create({ client: node, secretKey, invoiceExpirySeconds: Infinity }),
    ).toThrow("Expiry");

    const payments = L402.create({ client: node, secretKey });

    for (const amount of ["0", "-1", "1.2", "001", "9007199254740991"])
      expect(() => payments.charge({ amount })).toThrow();
  });
});
