import { expect, it } from "vitest";
import { Phoenixd } from "@nodana/phoenixd-ts";
import { L402 } from "../src";
import { fakeNode } from "./helpers";

it("uses a real Phoenixd HTTP client for receiving only, and preserves the request body", async () => {
  const fixture = fakeNode();

  const calls: string[] = [];

  const node = new Phoenixd(
    "https://node.example.test",
    "restricted-password",
    {
      fetch: async (input, init) => {
        const req = new Request(input, init);

        expect(req.headers.get("Authorization")).toBe(
          `Basic ${Buffer.from(":restricted-password").toString("base64")}`,
        );

        expect(req.headers.get("Content-Type")).toBe(
          "application/x-www-form-urlencoded",
        );

        const path = new URL(req.url).pathname;

        calls.push(path);

        const params = new URLSearchParams(await req.text());

        if (path === "/createinvoice")
          return Response.json(
            await fixture.createInvoice({
              amountSat: Number(params.get("amountSat")),
              description: params.get("description")!,
              expirySeconds: Number(params.get("expirySeconds")),
            }),
          );

        if (path === "/decodeinvoice")
          return Response.json(
            await fixture.decodeInvoice({ invoice: params.get("invoice")! }),
          );
        throw new Error(`Unexpected node call ${path}`);
      },
    },
  );

  const handler = () =>
    L402.create({ client: node, secretKey: "a".repeat(64) }).charge({
      amount: "100",
    });

  const input = () =>
    new Request("https://api.example.test/query", {
      method: "POST",
      body: "question",
    });

  const challenge = await handler()(input());

  if (challenge.status !== 402) throw new Error("Expected challenge");

  const offer = (await challenge.challenge.json()) as {
    macaroon: string;
    invoice: string;
  };

  const payment = await fixture.payInvoice({ invoice: offer.invoice });

  if (payment.type !== "payment_sent") throw new Error("Expected payment");

  const retry = input();
  retry.headers.set(
    "Authorization",
    `L402 ${offer.macaroon}:${payment.paymentPreimage}`,
  );

  expect((await handler()(retry)).status).toBe(200);

  expect(await retry.text()).toBe("question");

  expect(calls).toEqual(["/createinvoice", "/decodeinvoice"]);
});
