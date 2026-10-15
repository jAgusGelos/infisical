import { createFileRoute, linkOptions } from "@tanstack/react-router";
import { zodValidator } from "@tanstack/zod-adapter";
import { z } from "zod";

import { PamSessionDetailPage } from "./PamSessionDetailPage";

const searchSchema = z.object({
  // DEV only: name of a generated fixture variant (scripts/webapp-replay-fixture.ts); ignored in production builds.
  replayFixture: z
    .string()
    .regex(/^[a-z0-9-]+$/)
    .optional(),
  // Session time in seconds, written by "Copy link at <time>".
  t: z.coerce.number().min(0).optional()
});

export const Route = createFileRoute(
  "/_authenticate/_inject-org-details/_org-layout/organizations/$orgId/pam/_pam-layout/sessions/$sessionId"
)({
  component: PamSessionDetailPage,
  validateSearch: zodValidator(searchSchema),
  beforeLoad: ({ context, params }) => ({
    breadcrumbs: [
      ...context.breadcrumbs,
      {
        label: "Sessions",
        link: linkOptions({
          to: "/organizations/$orgId/pam/sessions",
          params: { orgId: params.orgId }
        })
      },
      { label: "Session Review" }
    ]
  })
});
