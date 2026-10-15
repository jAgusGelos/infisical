import { Knex } from "knex";

import { TableName } from "../schemas";
import { createOnUpdateTrigger, dropOnUpdateTrigger } from "../utils";

export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable(TableName.PamWebAppSessionKey))) {
    await knex.schema.createTable(TableName.PamWebAppSessionKey, (t) => {
      t.uuid("sessionId").primary();
      t.foreign("sessionId").references("id").inTable(TableName.PamSession).onDelete("CASCADE");

      // The first recording key seen for a gateway is its pin; no FK so a removed gateway keeps its evidence
      t.uuid("gatewayId").nullable();
      t.index("gatewayId");

      t.binary("recordingPublicKey").notNullable();
      t.string("recordingKeyId", 16).notNullable();
      t.string("fingerprint", 64).notNullable();
      t.binary("keyCert").notNullable();
      t.binary("keyCertSig").notNullable();
      t.binary("sessionPublicKey").notNullable();
      t.string("sessionKeyId", 16).notNullable();

      t.bigInteger("lastESeq").nullable();
      t.integer("lastEObjectIndex").nullable();
      t.binary("eChainHead").nullable();
      t.bigInteger("finalSeq").nullable();
      t.string("endReason", 64).nullable();

      t.timestamps(true, true, true);
    });

    await createOnUpdateTrigger(knex, TableName.PamWebAppSessionKey);
  }

  if (!(await knex.schema.hasTable(TableName.PamWebAppObject))) {
    await knex.schema.createTable(TableName.PamWebAppObject, (t) => {
      t.uuid("id", { primaryKey: true }).defaultTo(knex.fn.uuid());

      t.uuid("sessionId").notNullable();
      t.foreign("sessionId").references("id").inTable(TableName.PamSession).onDelete("CASCADE");

      t.string("series", 1).notNullable(); // E or V
      t.integer("objectIndex").notNullable();
      t.string("kind", 16).notNullable(); // events, init, media
      t.string("objectKey", 1024).notNullable();
      t.string("versionId", 1024).nullable();

      t.binary("checkpoint").notNullable();
      t.binary("signature").notNullable();

      t.bigInteger("firstSeq").notNullable();
      t.bigInteger("lastSeq").notNullable();
      t.binary("chainHead").notNullable();
      t.binary("plaintextSha256").notNullable();
      t.binary("ciphertextSha256").notNullable();
      t.bigInteger("plaintextBytes").notNullable();
      t.bigInteger("ciphertextBytes").notNullable();

      t.string("binding", 16).notNullable(); // bound, pending, mismatch

      // V media metadata, copied from the bound v_segment event
      t.integer("initIndex").nullable();
      t.bigInteger("startPtsUs").nullable();
      t.bigInteger("endPtsUs").nullable();
      t.bigInteger("monoStartUs").nullable();
      t.bigInteger("monoEndUs").nullable();
      t.integer("frameCount").nullable();
      t.integer("framesDropped").nullable();

      t.timestamps(true, true, true);

      // Leftmost sessionId also covers the FK
      t.unique(["sessionId", "series", "objectIndex"]);
    });

    await createOnUpdateTrigger(knex, TableName.PamWebAppObject);
  }
}

export async function down(knex: Knex): Promise<void> {
  if (await knex.schema.hasTable(TableName.PamWebAppObject)) {
    await dropOnUpdateTrigger(knex, TableName.PamWebAppObject);
    await knex.schema.dropTable(TableName.PamWebAppObject);
  }

  if (await knex.schema.hasTable(TableName.PamWebAppSessionKey)) {
    await dropOnUpdateTrigger(knex, TableName.PamWebAppSessionKey);
    await knex.schema.dropTable(TableName.PamWebAppSessionKey);
  }
}
