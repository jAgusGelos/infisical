import { BadRequestError } from "@app/lib/errors";

import { TPamRecordingStorageProvider } from "../pam-recording-storage-types";

const WEB_APP_OBJECTS_UNSUPPORTED_MESSAGE =
  "Web App recordings require S3-compatible object storage. Configure the template recording storage backend as AWS S3.";

export const PostgresRecordingStorageProvider: TPamRecordingStorageProvider = () => ({
  validateConfig: async () => {},
  mintPresignedPut: async () => {
    throw new Error(
      "Postgres recording backend does not support presigned PUT URLs; gateway must POST ciphertext directly to backend"
    );
  },
  mintPresignedGet: async () => {
    throw new Error("Postgres recording backend does not support presigned GET URLs; backend serves ciphertext inline");
  },
  deleteSession: async () => {},
  // The Postgres backend stores no Web App objects; the route layer maps this to the contract error code
  mintPresignedCreateOnlyPut: async () => {
    throw new BadRequestError({ message: WEB_APP_OBJECTS_UNSUPPORTED_MESSAGE });
  },
  headObject: async () => {
    throw new BadRequestError({ message: WEB_APP_OBJECTS_UNSUPPORTED_MESSAGE });
  },
  getObject: async () => {
    throw new BadRequestError({ message: WEB_APP_OBJECTS_UNSUPPORTED_MESSAGE });
  }
});
