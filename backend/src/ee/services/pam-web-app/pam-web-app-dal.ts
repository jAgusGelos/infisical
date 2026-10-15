import { Knex } from "knex";

import { TDbClient } from "@app/db";
import { TableName, TPamWebAppObjectsInsert } from "@app/db/schemas";
import { ormify } from "@app/lib/knex";

export type TPamWebAppSessionKeyDALFactory = ReturnType<typeof pamWebAppSessionKeyDALFactory>;
export type TPamWebAppObjectDALFactory = ReturnType<typeof pamWebAppObjectDALFactory>;

export const pamWebAppSessionKeyDALFactory = (db: TDbClient) => {
  const orm = ormify(db, TableName.PamWebAppSessionKey);

  const findBySessionId = async (sessionId: string, tx?: Knex) =>
    (tx || db.replicaNode())(TableName.PamWebAppSessionKey).where({ sessionId }).first();

  // Serializes checkpoint acceptance per session; must run inside the caller's transaction.
  const findBySessionIdForUpdate = async (sessionId: string, tx: Knex) =>
    tx(TableName.PamWebAppSessionKey).where({ sessionId }).forUpdate().first();

  // The first recording key stored for a gateway is its pin.
  const findGatewayPin = async (gatewayId: string, tx?: Knex) =>
    (tx || db.replicaNode())(TableName.PamWebAppSessionKey)
      .where({ gatewayId })
      .orderBy("createdAt", "asc")
      .select("recordingPublicKey", "fingerprint")
      .first();

  return { ...orm, findBySessionId, findBySessionIdForUpdate, findGatewayPin };
};

export const pamWebAppObjectDALFactory = (db: TDbClient) => {
  const orm = ormify(db, TableName.PamWebAppObject);

  const findBySessionId = async (sessionId: string, tx?: Knex) =>
    (tx || db.replicaNode())(TableName.PamWebAppObject)
      .where({ sessionId })
      .orderBy([
        { column: "series", order: "asc" },
        { column: "objectIndex", order: "asc" }
      ])
      .select("*");

  const findObject = async (sessionId: string, series: string, objectIndex: number, tx?: Knex) =>
    (tx || db.replicaNode())(TableName.PamWebAppObject).where({ sessionId, series, objectIndex }).first();

  // Returns null when another row already holds the slot; the caller compares bytes.
  const insertIfAbsent = async (data: TPamWebAppObjectsInsert, tx?: Knex) => {
    const [row] = await (tx || db)(TableName.PamWebAppObject)
      .insert(data)
      .onConflict(["sessionId", "series", "objectIndex"])
      .ignore()
      .returning("*");
    return row ?? null;
  };

  return { ...orm, findBySessionId, findObject, insertIfAbsent };
};
