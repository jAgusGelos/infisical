import { Knex } from "knex";

import { TDbClient } from "@app/db";
import { TableName, TPamWebAppManifestsInsert } from "@app/db/schemas";
import { ormify } from "@app/lib/knex";

export type TPamWebAppManifestDALFactory = ReturnType<typeof pamWebAppManifestDALFactory>;

export const pamWebAppManifestDALFactory = (db: TDbClient) => {
  const orm = ormify(db, TableName.PamWebAppManifest);

  const findBySessionId = async (sessionId: string, tx?: Knex) =>
    (tx || db.replicaNode())(TableName.PamWebAppManifest).where({ sessionId }).first();

  // A later checkpoint can complete a manifest built earlier, so the newest signature wins.
  const upsert = async (data: TPamWebAppManifestsInsert, tx?: Knex) => {
    const [row] = await (tx || db)(TableName.PamWebAppManifest)
      .insert(data)
      .onConflict("sessionId")
      .merge(["manifest", "signature", "kmsKeyId", "signingAlgorithm"])
      .returning("*");
    return row;
  };

  return { ...orm, findBySessionId, upsert };
};
