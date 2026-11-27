// Session only: a Bearer token never reaches the bell. Rows addressed to the person's agents are the person's too, so list, delete one and clear all cover them.
import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import type { NotificationListDto } from "@knotebook/shared";
import { decodeCursor } from "../comments/queries.js";
import type { Db } from "../db/index.js";
import { sendError } from "../http/errors.js";
import {
  NOTIFICATION_PAGE_DEFAULT,
  NOTIFICATION_PAGE_MAX,
  clearNotifications,
  countUnreadNotifications,
  deleteNotification,
  listNotifications,
  markNotificationsSeen,
} from "../notifications/queries.js";

export const NOTIFICATION_NOT_FOUND_MESSAGE = "No notification with that id.";

const LIMIT_RE = /^[1-9]\d{0,2}$/;
const listQuerySchema = z.object({ before: z.string().optional(), limit: z.string().optional() }).strict();
const emptyBodySchema = z.object({}).strict();

export function notificationsRoutes(deps: { db: Db }) {
  return async function register(app: FastifyInstance): Promise<void> {
    const invalidQuery = (reply: FastifyReply): FastifyReply => sendError(reply, 400, "invalid_body", "Invalid query parameters.");

    app.get("/api/notifications", { preHandler: app.authenticate }, async (request, reply) => {
      const q = listQuerySchema.safeParse(request.query ?? {});
      if (!q.success) return invalidQuery(reply);
      const { before, limit: rawLimit } = q.data;
      if (rawLimit !== undefined && (!LIMIT_RE.test(rawLimit) || Number(rawLimit) > NOTIFICATION_PAGE_MAX)) return invalidQuery(reply);
      const cursor = before === undefined ? null : decodeCursor(before);
      if (before !== undefined && cursor === null) return invalidQuery(reply);
      const list = await listNotifications(deps.db, {
        userId: request.user!.id,
        before: cursor,
        limit: rawLimit === undefined ? NOTIFICATION_PAGE_DEFAULT : Number(rawLimit),
      });
      return reply.send(list satisfies NotificationListDto);
    });

    app.get("/api/notifications/unread-count", { preHandler: app.authenticate }, async (request, reply) => {
      return reply.send({ count: await countUnreadNotifications(deps.db, request.user!.id) });
    });

    app.post("/api/notifications/seen", { preHandler: app.authenticate }, async (request, reply) => {
      if (!emptyBodySchema.safeParse(request.body === undefined ? {} : request.body).success) return sendError(reply, 400, "invalid_body", "Invalid request body.");
      await markNotificationsSeen(deps.db, request.user!.id);
      return reply.code(204).send();
    });

    app.delete("/api/notifications/:id", { preHandler: app.authenticate }, async (request, reply) => {
      const { id } = request.params as { id: string };
      if (!(await deleteNotification(deps.db, request.user!.id, id))) return sendError(reply, 404, "notification_not_found", NOTIFICATION_NOT_FOUND_MESSAGE);
      return reply.code(204).send();
    });

    app.delete("/api/notifications", { preHandler: app.authenticate }, async (request, reply) => {
      await clearNotifications(deps.db, request.user!.id);
      return reply.code(204).send();
    });
  };
}
