interface FirstPartyMacaroon {
  readonly identifier: Uint8Array;
  readonly signature: Uint8Array;
  readonly caveats: { identifier: Uint8Array; vid?: Uint8Array }[];
}

/** Encode our first-party V2 macaroons without macaroon 3.0.4's faulty buffer growth. */
export function serializeMacaroon(token: FirstPartyMacaroon): Buffer {
  const parts: Uint8Array[] = [Buffer.from([2])];

  const field = (tag: number, bytes: Uint8Array) => {
    let length = bytes.length;
    const prefix = [tag];

    do {
      const next = length % 128;
      length = Math.floor(length / 128);
      prefix.push(next | (length > 0 ? 128 : 0));
    } while (length > 0);

    parts.push(Buffer.from(prefix), bytes);
  };

  field(2, token.identifier);
  parts.push(Buffer.from([0]));

  for (const caveat of token.caveats) {
    if (caveat.vid !== undefined)
      throw new TypeError("Only first-party caveats can be serialized");

    field(2, caveat.identifier);
    parts.push(Buffer.from([0]));
  }

  parts.push(Buffer.from([0]));
  field(6, token.signature);

  return Buffer.concat(parts);
}
