import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import macaroon from "macaroon";
import type { PhoenixdClient } from "@nodana/phoenixd-ts";
import { L402Error } from "./errors";
import { bodyHash, invoiceDetails, paymentHash, satoshis } from "./shared";
import type { LightningNetwork } from "./shared";

export interface L402Options {
  client: Pick<PhoenixdClient, "createInvoice" | "decodeInvoice">;

  /** A 32-byte hex secret held by your application. Keep stable across instances. */
  secretKey: string;

  /** Time allowed to pay an invoice. Defaults to 300 seconds. */
  invoiceExpirySeconds?: number;

  /** Deadline for redeeming a paid request. Defaults to 300 seconds; capped to invoice expiry. */
  challengeExpirySeconds?: number;

  /** Expected invoice network. Defaults to mainnet. */
  network?: LightningNetwork;
}

export interface ChargeOptions {
  /** Positive integer string in satoshis. */
  amount: string;
  description?: string;
}

export interface Payment {
  paymentHash: string;
  amountSat: number;
  expiresAt: number;
}

export type ChargeResult =
  { status: 402; challenge: Response } | { status: 200; payment: Payment };

function lifetime(value: number): number {
  if (
    !Number.isSafeInteger(value) ||
    value < 1 ||
    !Number.isSafeInteger(value * 1000)
  )
    throw new TypeError("Expiry must be a positive integer number of seconds");
  return value;
}

/** Accept L402 payments directly against a Phoenixd node. */
export class L402 {
  readonly #client: L402Options["client"];
  readonly #secret: Buffer;
  readonly #invoiceExpiry: number;
  readonly #challengeExpiry: number;
  readonly #network: LightningNetwork;

  static create(options: L402Options): L402 {
    return new L402(options);
  }

  constructor(options: L402Options) {
    if (!/^[0-9a-fA-F]{64}$/.test(options.secretKey))
      throw new TypeError(
        "secretKey must be 32 bytes encoded as 64 hex characters",
      );
    this.#secret = Buffer.from(options.secretKey, "hex");
    this.#client = options.client;
    this.#invoiceExpiry = lifetime(options.invoiceExpirySeconds ?? 300);
    this.#challengeExpiry = lifetime(options.challengeExpirySeconds ?? 300);
    this.#network = options.network ?? "mainnet";

    if (!["mainnet", "regtest", "signet"].includes(this.#network))
      throw new TypeError("Unsupported Lightning network");
  }

  // Domain separation prevents reuse of this secret's derived keys elsewhere.
  #rootKey(identifier: Uint8Array): Buffer {
    return createHmac("sha256", this.#secret)
      .update("phoenixd-l402-sdk:root:v1\0")
      .update(identifier)
      .digest();
  }

  charge(options: ChargeOptions): (request: Request) => Promise<ChargeResult> {
    const amountSat = satoshis(options.amount);

    const amount = String(amountSat);

    const description = options.description ?? "Paid API access";

    return async (request) => {
      const url = new URL(request.url);

      if (url.username || url.password || url.hash)
        throw new L402Error(
          "invalid_request",
          "Use a request URL without credentials or a fragment",
        );

      const requestBodyHash = await bodyHash(request);

      const binding = createHash("sha256")
        .update(JSON.stringify([request.url, request.method, requestBodyHash]))
        .digest("hex");
      const payment = this.#verify(
        request.headers.get("Authorization"),
        binding,
        amountSat,
      );

      if (payment) return { status: 200, payment };

      const now = Date.now();

      let expiresAt = now + this.#challengeExpiry * 1000;

      if (!Number.isSafeInteger(expiresAt))
        throw new TypeError("Challenge expiry is too large");
      let invoice: string;

      let hash: string;

      try {
        const created = await this.#client.createInvoice({
          amountSat,
          description,
          expirySeconds: this.#invoiceExpiry,
        });
        invoice = created.serialized;

        const details = invoiceDetails(
          await this.#client.decodeInvoice({ invoice }),
          { amount, currency: "sat" },
          this.#network,
        );
        hash = details.paymentHash;
        expiresAt = Math.min(expiresAt, details.expiresAt);

        if (Date.now() >= expiresAt)
          throw new Error("Challenge expired during invoice creation");
        if (
          created.paymentHash !== hash ||
          created.amountSat !== amountSat ||
          !/^[a-z0-9]+$/i.test(invoice)
        )
          throw new Error("Invoice does not match Phoenixd response");
      } catch {
        throw new L402Error(
          "invalid_invoice",
          "Phoenixd could not provide a matching, unexpired invoice",
        );
      }

      // L402 v0 identifier: uint16 version || payment hash || random token ID.
      const identifier = Buffer.concat([
        Buffer.alloc(2),
        Buffer.from(hash, "hex"),
        randomBytes(32),
      ]);

      const token = macaroon.newMacaroon({
        identifier,
        rootKey: this.#rootKey(identifier),
        version: 2,
      });

      token.addFirstPartyCaveat(`request=${binding}`);

      token.addFirstPartyCaveat(`amount_sat=${amount}`);

      token.addFirstPartyCaveat(`expires_at=${expiresAt}`);

      const encoded = Buffer.from(token.exportBinary()).toString("base64");

      return {
        status: 402,
        challenge: Response.json(
          {
            macaroon: encoded,
            invoice,
            paymentHash: hash,
            amountSat,
            expiresAt,
          },
          {
            status: 402,
            headers: {
              "WWW-Authenticate": `L402 macaroon="${encoded}", invoice="${invoice}"`,
              "Cache-Control": "no-store",
            },
          },
        ),
      };
    };
  }

  #verify(
    authorization: string | null,
    binding: string,
    amountSat: number,
  ): Payment | undefined {
    if (!authorization || authorization.length > 16_384) return undefined;

    const match =
      /^(?:L402|LSAT) ([A-Za-z0-9+/_-]+={0,2}):([0-9a-fA-F]{64})$/i.exec(
        authorization,
      );

    if (!match) return undefined;

    try {
      const token = macaroon.importMacaroon(Buffer.from(match[1]!, "base64"));

      const identifier = Buffer.from(token.identifier);

      if (
        identifier.length !== 66 ||
        identifier.readUInt16BE(0) !== 0 ||
        token.caveats.length > 64
      )
        return undefined;
      const hash = identifier.subarray(2, 34);

      const proof = Buffer.from(paymentHash(match[2]!.toLowerCase()), "hex");

      if (!timingSafeEqual(hash, proof)) return undefined;

      const seen = new Set<string>();

      let expiresAt = Number.MAX_SAFE_INTEGER;

      token.verify(this.#rootKey(identifier), (condition) => {
        const separator = condition.indexOf("=");

        const key = condition.slice(0, separator);

        const value = condition.slice(separator + 1);

        if (separator < 1) return "Invalid caveat";

        if (key === "request" && value === binding) seen.add(key);
        else if (key === "amount_sat" && value === String(amountSat))
          seen.add(key);
        else if (
          key === "expires_at" &&
          /^[1-9][0-9]*$/.test(value) &&
          Number.isSafeInteger(Number(value)) &&
          Number(value) > Date.now()
        ) {
          seen.add(key);
          expiresAt = Math.min(expiresAt, Number(value));
        } else if (
          key === "preimage" &&
          /^[0-9a-f]{64}$/.test(value) &&
          paymentHash(value) === hash.toString("hex")
        ) {
          // Some clients append the payment proof as an additional caveat.
        } else return "Unsupported or unsatisfied caveat";

        return null;
      });

      if (
        !["request", "amount_sat", "expires_at"].every((key) => seen.has(key))
      )
        return undefined;
      return {
        paymentHash: hash.toString("hex"),
        amountSat,
        expiresAt,
      };
    } catch {
      return undefined;
    }
  }
}
