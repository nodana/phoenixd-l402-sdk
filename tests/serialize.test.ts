import { expect, it } from "vitest";
import macaroon from "macaroon";
import { serializeMacaroon } from "../src/serialize";

it("matches independently specified V2 wire bytes", () => {
  const bytes = serializeMacaroon({
    identifier: Buffer.from("id"),
    caveats: [{ identifier: Buffer.from("ok") }],
    signature: Buffer.alloc(32, 0xab),
  });

  // Version, identifier, header end, caveat, caveat end, list end, signature.
  expect(bytes.toString("hex")).toBe(
    "02020269640002026f6b00000620" + "ab".repeat(32),
  );

  const imported = macaroon.importMacaroon(bytes);

  expect(Buffer.from(imported.identifier).toString()).toBe("id");
  expect(Buffer.from(imported.caveats[0]!.identifier).toString()).toBe("ok");
  expect(Buffer.from(imported.signature)).toEqual(Buffer.alloc(32, 0xab));
});

it("round-trips and verifies many caveats and multi-byte lengths without excessive allocation", () => {
  const rootKey = Buffer.alloc(32, 7);
  const token = macaroon.newMacaroon({
    identifier: Buffer.alloc(200, 3),
    rootKey,
    version: 2,
  });

  for (let i = 0; i < 64; i++)
    token.addFirstPartyCaveat(`restriction_${i}=${"a".repeat(150)}`);

  const bytes = serializeMacaroon(token);

  expect(bytes.length).toBeLessThan(12_000);

  const imported = macaroon.importMacaroon(bytes);

  expect(imported.caveats).toHaveLength(64);
  expect(() => imported.verify(rootKey, () => null)).not.toThrow();
});

it("rejects third-party caveats instead of dropping their verification data", () => {
  expect(() =>
    serializeMacaroon({
      identifier: Buffer.from("id"),
      signature: Buffer.alloc(32),
      caveats: [
        { identifier: Buffer.from("caveat"), vid: Buffer.from("verification") },
      ],
    }),
  ).toThrow("first-party");
});
