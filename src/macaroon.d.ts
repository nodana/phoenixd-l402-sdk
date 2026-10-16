declare module "macaroon" {
  interface Macaroon {
    readonly identifier: Uint8Array;
    readonly signature: Uint8Array;
    readonly caveats: { identifier: Uint8Array; vid?: Uint8Array }[];
    addFirstPartyCaveat(condition: string): void;
    verify(
      rootKey: Uint8Array,
      check: (condition: string) => string | null,
    ): void;
    exportBinary(): Uint8Array;
  }

  const macaroon: {
    newMacaroon(options: {
      identifier: Uint8Array;
      rootKey: Uint8Array;
      version: number;
    }): Macaroon;
    importMacaroon(value: Uint8Array): Macaroon;
  };
  export default macaroon;
}
