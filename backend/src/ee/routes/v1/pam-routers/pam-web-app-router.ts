import { FastifyReply, FastifyRequest } from "fastify";
import RE2 from "re2";
import { z } from "zod";

import { EventType } from "@app/ee/services/audit-log/audit-log-types";
import { Series } from "@app/ee/services/pam-web-app/contract";
import {
  PAM_WEB_APP_MAX_EVENTS_SEQ_SPAN,
  PamWebAppBinding,
  PamWebAppEventStream,
  PamWebAppObjectKind,
  PamWebAppSeries
} from "@app/ee/services/pam-web-app/pam-web-app-checkpoint-service";
import { PamWebAppError, PamWebAppErrorCode } from "@app/ee/services/pam-web-app/pam-web-app-errors";
import { ApiDocsTags } from "@app/lib/api-docs/constants";
import { readLimit, writeLimit } from "@app/server/config/rateLimiter";
import { verifyAuth } from "@app/server/plugins/auth/verify-auth";
import { AuthMode } from "@app/services/auth/auth-type";

const GATEWAY_TOKEN_HEADER = "x-gateway-upload-token";
const BASE64_PATTERN = new RE2(/^[A-Za-z0-9+/]*={0,2}$/);

const base64 = (maxBytes: number) =>
  z
    .string()
    .trim()
    .max(Math.ceil(maxBytes / 3) * 4)
    .refine((v) => BASE64_PATTERN.test(v), "Must be standard base64");

const SessionParams = z.object({ sessionId: z.string().uuid().describe("The ID of the Web App session") });

const ErrorBody = z.object({ code: z.nativeEnum(PamWebAppErrorCode), message: z.string() });

const ObjectEntry = z.object({
  objectIndex: z.number(),
  checkpoint: z.string(),
  signature: z.string(),
  objectKey: z.string(),
  versionId: z.string().nullable(),
  binding: z.nativeEnum(PamWebAppBinding)
});

const ReplaySchema = z.object({
  sessionId: z.string(),
  projectId: z.string(),
  status: z.enum(["active", "ended"]),
  startedAt: z.string(),
  endedAt: z.string().nullable(),
  endReason: z.string().nullable(),
  recordingKey: z.object({ publicKey: z.string(), keyId: z.string(), fingerprint: z.string() }),
  keyCert: z.string(),
  keyCertSig: z.string(),
  video: z.object({
    mime: z.string(),
    objects: z.array(
      ObjectEntry.extend({
        kind: z.enum([PamWebAppObjectKind.Init, PamWebAppObjectKind.Media]),
        initIndex: z.number().nullable().optional(),
        startMs: z.number().nullable().optional(),
        endMs: z.number().nullable().optional(),
        monoStartUs: z.number().nullable().optional(),
        monoEndUs: z.number().nullable().optional(),
        frameCount: z.number().nullable().optional(),
        framesDropped: z.number().nullable().optional()
      })
    )
  }),
  events: z.object({ chunks: z.array(ObjectEntry.extend({ firstSeq: z.number(), lastSeq: z.number() })) }),
  manifest: z.unknown().nullable()
});

// The gateway branches on `code` (CONTRACTS 6.9), so these answer the contract body, not the house envelope.
const withContractErrors = async <T>(reply: FastifyReply, fn: () => Promise<T>) => {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof PamWebAppError) {
      return reply.status(err.statusCode).send({ code: err.code, message: err.message });
    }
    throw err;
  }
};

export const registerPamWebAppRouter = async (server: FastifyZodProvider) => {
  const getUploadToken = async (
    req: Pick<FastifyRequest, "headers" | "auditLogInfo" | "permission" | "internalPamProjectId"> & {
      params: { sessionId: string };
    }
  ) => {
    const uploadToken = req.headers[GATEWAY_TOKEN_HEADER];
    if (typeof uploadToken === "string" && uploadToken) return uploadToken;

    await server.services.auditLog.createAuditLog({
      ...req.auditLogInfo,
      orgId: req.permission.orgId,
      projectId: req.internalPamProjectId,
      event: { type: EventType.PAM_SESSION_UPLOAD_TOKEN_INVALID, metadata: { sessionId: req.params.sessionId } }
    });
    return undefined;
  };

  server.route({
    method: "POST",
    url: "/:sessionId/web-app/open",
    config: { rateLimit: writeLimit },
    schema: {
      operationId: "pamWebAppOpenRecording",
      description: "Register the gateway recording key and the session key certificate for a Web App session",
      tags: [ApiDocsTags.PamSessions],
      params: SessionParams,
      body: z.object({
        recordingPublicKey: base64(32).describe("Raw Ed25519 recording public key (32 bytes, base64)"),
        fingerprint: z.string().trim().max(64).describe("Recording key fingerprint, SHA256:..."),
        keyCert: base64(80).describe("KeyCert v1 (80 bytes, base64)"),
        keyCertSig: base64(64).describe("Recording key signature over the KeyCert (64 bytes, base64)")
      }),
      response: { 200: z.object({ ok: z.literal(true) }), 409: ErrorBody, 422: ErrorBody }
    },
    onRequest: verifyAuth([AuthMode.GATEWAY_ACCESS_TOKEN]),
    handler: async (req, reply) => {
      const uploadToken = await getUploadToken(req);
      return withContractErrors(reply, () =>
        server.services.pamWebAppCheckpoint.open(
          { sessionId: req.params.sessionId, uploadToken, ...req.body },
          req.permission
        )
      );
    }
  });

  server.route({
    method: "POST",
    url: "/:sessionId/web-app/end",
    config: { rateLimit: writeLimit },
    schema: {
      operationId: "pamWebAppEndRecording",
      description: "Set the final sequence and close reason for a Web App recording",
      tags: [ApiDocsTags.PamSessions],
      params: SessionParams,
      body: z.object({
        finalSeq: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
        reason: z.string().trim().min(1).max(128)
      }),
      response: { 200: z.object({ ok: z.literal(true) }), 409: ErrorBody, 422: ErrorBody }
    },
    onRequest: verifyAuth([AuthMode.GATEWAY_ACCESS_TOKEN]),
    handler: async (req, reply) => {
      const uploadToken = await getUploadToken(req);
      return withContractErrors(reply, () =>
        server.services.pamWebAppCheckpoint.end(
          { sessionId: req.params.sessionId, uploadToken, ...req.body },
          req.permission
        )
      );
    }
  });

  server.route({
    method: "POST",
    url: "/:sessionId/web-app/objects/presign",
    config: { rateLimit: writeLimit },
    schema: {
      operationId: "pamWebAppPresignObject",
      description: "Get a create-only presigned PUT for one Web App recording object",
      tags: [ApiDocsTags.PamSessions],
      params: SessionParams,
      body: z.object({
        series: z.nativeEnum(PamWebAppSeries).describe("E for event chunks, V for video objects"),
        objectIndex: z.number().int().min(0).max(4_294_967_295).describe("Object index within the series"),
        kind: z.nativeEnum(PamWebAppObjectKind).describe("events, init or media"),
        ciphertextBytes: z.number().int().positive().describe("Size of the stored object in bytes"),
        ciphertextSha256: base64(32).describe("SHA-256 of the stored object, base64")
      }),
      response: {
        200: z.object({
          url: z.string(),
          objectKey: z.string(),
          method: z.literal("PUT"),
          headers: z.object({ "x-amz-checksum-sha256": z.string(), "If-None-Match": z.literal("*") }),
          expiresInSeconds: z.number()
        }),
        409: ErrorBody
      }
    },
    onRequest: verifyAuth([AuthMode.GATEWAY_ACCESS_TOKEN]),
    handler: async (req, reply) => {
      const uploadToken = await getUploadToken(req);
      return withContractErrors(reply, () =>
        server.services.pamWebAppCheckpoint.presign(
          { sessionId: req.params.sessionId, uploadToken, ...req.body },
          req.permission
        )
      );
    }
  });

  server.route({
    method: "POST",
    url: "/:sessionId/web-app/checkpoints",
    config: { rateLimit: writeLimit },
    schema: {
      operationId: "pamWebAppSubmitCheckpoint",
      description: "Submit a signed checkpoint for an uploaded Web App recording object",
      tags: [ApiDocsTags.PamSessions],
      params: SessionParams,
      body: z.object({
        checkpoint: base64(208).describe("Checkpoint v1 (208 bytes, base64)"),
        signature: base64(64).describe("Session key signature over the checkpoint (64 bytes, base64)"),
        objectKey: z.string().trim().min(1).max(1024).describe("The object key the presign returned"),
        versionId: z.string().trim().max(1024).optional().describe("x-amz-version-id from the PUT response")
      }),
      response: {
        200: z.object({ accepted: z.literal(true), duplicate: z.literal(true) }),
        201: z.object({ accepted: z.literal(true) }),
        409: ErrorBody,
        422: ErrorBody
      }
    },
    onRequest: verifyAuth([AuthMode.GATEWAY_ACCESS_TOKEN]),
    handler: async (req, reply) => {
      const uploadToken = await getUploadToken(req);
      return withContractErrors(reply, async () => {
        const result = await server.services.pamWebAppCheckpoint.submitCheckpoint(
          { sessionId: req.params.sessionId, uploadToken, ...req.body },
          req.permission
        );
        if (result.duplicate) return reply.status(200).send({ accepted: true, duplicate: true });
        await server.services.auditLog.createAuditLog({
          ...req.auditLogInfo,
          orgId: req.permission.orgId,
          projectId: req.internalPamProjectId,
          event: {
            type: EventType.PAM_WEB_APP_CHECKPOINT,
            metadata: {
              sessionId: req.params.sessionId,
              accountId: result.accountId ?? undefined,
              folderId: result.folderId ?? undefined,
              series: result.checkpoint.series === Series.E ? "E" : "V",
              objectIndex: result.checkpoint.objectIndex,
              firstSeq: Number(result.checkpoint.firstSeq),
              lastSeq: Number(result.checkpoint.lastSeq),
              chainHead: Buffer.from(result.checkpoint.chainHead).toString("hex"),
              signerKeyId: Buffer.from(result.checkpoint.signerKeyId).toString("hex"),
              fingerprint: result.fingerprint ?? ""
            }
          }
        });
        return reply.status(201).send({ accepted: true });
      });
    }
  });

  server.route({
    method: "GET",
    url: "/:sessionId/web-app/replay",
    config: { rateLimit: readLimit },
    schema: {
      operationId: "pamWebAppReplay",
      description: "Get the signed object index of a Web App session recording",
      tags: [ApiDocsTags.PamSessions],
      params: SessionParams,
      response: { 200: ReplaySchema }
    },
    onRequest: verifyAuth([AuthMode.JWT, AuthMode.IDENTITY_ACCESS_TOKEN, AuthMode.OAUTH]),
    handler: async (req) => server.services.pamWebAppCheckpoint.getReplay(req.params.sessionId, req.permission)
  });

  server.route({
    method: "GET",
    url: "/:sessionId/web-app/objects/:series/:objectIndex",
    config: { rateLimit: readLimit },
    schema: {
      operationId: "pamWebAppGetObject",
      description:
        "Get one Web App recording object: decrypted plaintext by default, or the stored bytes with form=stored",
      tags: [ApiDocsTags.PamSessions],
      params: SessionParams.extend({
        series: z.nativeEnum(PamWebAppSeries).describe("E or V"),
        objectIndex: z.coerce.number().int().min(0).max(4_294_967_295).describe("Object index within the series")
      }),
      querystring: z.object({
        form: z.enum(["plaintext", "stored"]).default("plaintext").describe("plaintext or stored")
      })
    },
    onRequest: verifyAuth([AuthMode.JWT, AuthMode.IDENTITY_ACCESS_TOKEN, AuthMode.OAUTH]),
    handler: async (req, reply) =>
      withContractErrors(reply, async () => {
        const { contentType, body } = await server.services.pamWebAppCheckpoint.getObject(
          { ...req.params, form: req.query.form },
          req.permission
        );
        void reply.header("Content-Type", contentType);
        void reply.header("Cache-Control", "no-store");
        return reply.send(body);
      })
  });

  server.route({
    method: "GET",
    url: "/:sessionId/web-app/events",
    config: { rateLimit: readLimit },
    schema: {
      operationId: "pamWebAppListEvents",
      description:
        "List decoded Web App recording events in a seq range, filtered by stream. Display only: integrity comes from the signed chunks",
      tags: [ApiDocsTags.PamSessions],
      params: SessionParams,
      querystring: z.object({
        fromSeq: z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER).default(0).describe("First seq"),
        toSeq: z.coerce
          .number()
          .int()
          .min(0)
          .max(Number.MAX_SAFE_INTEGER)
          .optional()
          .describe(`Last seq, inclusive; at most fromSeq + ${PAM_WEB_APP_MAX_EVENTS_SEQ_SPAN}`),
        streams: z
          .string()
          .trim()
          .max(64)
          .optional()
          .transform((v, ctx) => {
            if (!v) return Object.values(PamWebAppEventStream);
            const parts = v.split(",").map((p) => p.trim());
            const parsed = z.array(z.nativeEnum(PamWebAppEventStream)).min(1).max(5).safeParse(parts);
            if (!parsed.success) {
              ctx.addIssue({
                code: z.ZodIssueCode.custom,
                message: `streams must be a comma separated list of ${Object.values(PamWebAppEventStream).join(", ")}`
              });
              return z.NEVER;
            }
            return [...new Set(parsed.data)];
          })
          .describe("Comma separated streams: L1, L3, lifecycle, V, index (default all)")
      }),
      response: {
        200: z.object({
          events: z.array(
            z.object({
              seq: z.number(),
              type: z.string(),
              wallTimeUnixMs: z.number(),
              monoElapsedUs: z.number(),
              body: z.unknown()
            })
          )
        }),
        409: ErrorBody,
        422: ErrorBody
      }
    },
    onRequest: verifyAuth([AuthMode.JWT, AuthMode.IDENTITY_ACCESS_TOKEN, AuthMode.OAUTH]),
    handler: async (req, reply) =>
      withContractErrors(reply, () =>
        server.services.pamWebAppCheckpoint.getEvents(
          {
            sessionId: req.params.sessionId,
            fromSeq: req.query.fromSeq,
            toSeq: req.query.toSeq ?? req.query.fromSeq + PAM_WEB_APP_MAX_EVENTS_SEQ_SPAN,
            streams: req.query.streams
          },
          req.permission
        )
      )
  });
};
