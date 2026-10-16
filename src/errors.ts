export type L402ErrorCode = "invalid_invoice" | "invalid_request";

export class L402Error extends Error {
  override readonly name = "L402Error";

  constructor(
    public readonly code: L402ErrorCode,
    message: string,
  ) {
    super(message);
  }
}
