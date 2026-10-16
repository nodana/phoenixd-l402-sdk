import {
  L402,
  type L402Options,
  type ChargeResult,
  L402Error,
} from "@nodana/phoenixd-l402-sdk";
import { Phoenixd } from "@nodana/phoenixd-ts";

const options: L402Options = {
  client: new Phoenixd("https://node.example.test", "password"),
  secretKey: "a".repeat(64),
};

const payments = L402.create(options);

const result: Promise<ChargeResult> = payments.charge({ amount: "100" })(
  new Request("https://api.example.test"),
);

void result;

new L402Error("invalid_invoice", "Node unavailable");

// @ts-expect-error A signing secret is required.
L402.create({ client: options.client });

// @ts-expect-error Prices use integer strings.
payments.charge({ amount: 100 });
