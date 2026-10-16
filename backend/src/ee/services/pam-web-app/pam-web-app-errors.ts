// Codes the gateway and the viewer branch on (CONTRACTS 6.9); the HTTP status is part of the contract.
export enum PamWebAppErrorCode {
  BadSignature = "bad_signature",
  SeqGap = "seq_gap",
  ChecksumMismatch = "checksum_mismatch",
  VersionMismatch = "version_mismatch",
  UnknownKey = "unknown_key",
  Conflict = "conflict",
  RecordingKeyMismatch = "recording_key_mismatch",
  ObjectLockRequired = "object_lock_required"
}

const STATUS_BY_CODE: Record<PamWebAppErrorCode, 409 | 422> = {
  [PamWebAppErrorCode.BadSignature]: 422,
  [PamWebAppErrorCode.SeqGap]: 422,
  [PamWebAppErrorCode.ChecksumMismatch]: 422,
  [PamWebAppErrorCode.VersionMismatch]: 422,
  [PamWebAppErrorCode.UnknownKey]: 422,
  [PamWebAppErrorCode.Conflict]: 409,
  [PamWebAppErrorCode.RecordingKeyMismatch]: 409,
  [PamWebAppErrorCode.ObjectLockRequired]: 409
};

export class PamWebAppError extends Error {
  code: PamWebAppErrorCode;

  statusCode: 409 | 422;

  constructor(code: PamWebAppErrorCode, message: string) {
    super(message);
    this.name = "PamWebAppError";
    this.code = code;
    this.statusCode = STATUS_BY_CODE[code];
  }
}
