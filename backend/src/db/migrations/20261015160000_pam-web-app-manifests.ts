import { Knex } from "knex";

import { TableName } from "../schemas";
import { createOnUpdateTrigger, dropOnUpdateTrigger } from "../utils";

export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable(TableName.PamWebAppManifest))) {
    await knex.schema.createTable(TableName.PamWebAppManifest, (t) => {
      t.uuid("sessionId").primary();
      t.foreign("sessionId").references("id").inTable(TableName.PamSession).onDelete("CASCADE");

      // The exact signed bytes; jsonb would reorder keys and break the signature
      t.text("manifest").notNullable();
      t.binary("signature").notNullable();
      t.uuid("kmsKeyId").notNullable();
      t.foreign("kmsKeyId").references("id").inTable(TableName.KmsKey).onDelete("RESTRICT");
      t.index("kmsKeyId");
      t.string("signingAlgorithm", 64).notNullable();

      t.timestamps(true, true, true);
    });

    await createOnUpdateTrigger(knex, TableName.PamWebAppManifest);
  }
}

export async function down(knex: Knex): Promise<void> {
  if (await knex.schema.hasTable(TableName.PamWebAppManifest)) {
    await dropOnUpdateTrigger(knex, TableName.PamWebAppManifest);
    await knex.schema.dropTable(TableName.PamWebAppManifest);
  }
}
