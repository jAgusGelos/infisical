// Mirrors CONTRACTS.md 6.10 (Web App playback API). Unknown fields are ignored; optional fields are the ones the
// contract marks as additive (v1.1) or that a v1 backend may omit.

export type TWebAppReplayBinding = "bound" | "pending" | "mismatch";

export type TWebAppReplaySeries = "V" | "E";

type TSignedObjectEntry = {
  objectIndex: number;
  checkpoint: string;
  signature: string;
  objectKey?: string;
  versionId?: string;
  binding?: TWebAppReplayBinding;
};

export type TWebAppVideoInitEntry = TSignedObjectEntry & {
  kind: "init";
};

export type TWebAppVideoMediaEntry = TSignedObjectEntry & {
  kind: "media";
  initIndex: number;
  startMs: number;
  endMs: number;
  monoStartUs?: number;
  monoEndUs?: number;
  frameCount?: number;
  framesDropped?: number;
};

export type TWebAppVideoEntry = TWebAppVideoInitEntry | TWebAppVideoMediaEntry;

export type TWebAppEventChunkEntry = TSignedObjectEntry & {
  firstSeq: number;
  lastSeq: number;
};

export type TWebAppReplay = {
  sessionId: string;
  projectId: string;
  status: "active" | "ended";
  startedAt: string;
  endedAt?: string | null;
  endReason?: string | null;
  recordingKey: {
    publicKey: string;
    keyId: string;
    fingerprint: string;
  };
  keyCert: string;
  keyCertSig: string;
  storage?: {
    objectLock: boolean;
    mode?: string;
    retainUntil?: string;
  } | null;
  video: {
    mime: string;
    objects: TWebAppVideoEntry[];
  };
  events: {
    chunks: TWebAppEventChunkEntry[];
  };
  manifest: unknown | null;
};
