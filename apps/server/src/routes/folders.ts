/**
 * 資料夾 REST（spec docs/superpowers/specs/2026-10-22-folders-design.md §5.11）。讀取收 `authenticateAny("notes:read")`
 * （同 `GET /api/notes`）；寫入一律 cookie-only（`app.authenticate`；外部程式走 MCP），扣 `edit` 桶（在服務層）。
 * body 裡的 id（`parentId`、`space.groupId`、`folderId`）在這裡轉小寫後交服務層；UUID 形由服務層驗（非 UUID 與不存在同形）。
 * 本檔沒有交易（S14 不登記）；交易都在 `folders/service.ts`。
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { FolderDeleteResultDto, FolderListDto, FolderSpaceDto, NoteDto } from "@knotebook/shared";
import { sendError } from "../http/errors.js";
import { createFolder, deleteFolder, listFolders, placeNote, updateFolder, type FolderServiceDeps } from "../folders/service.js";

const spaceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("personal") }).strict(),
  z.object({ kind: z.literal("shared") }).strict(),
  z.object({ kind: z.literal("group"), groupId: z.string() }).strict(),
]);
/** 位置恰一種：`parentId` 或 `space`。 */
const createBodySchema = z.union([
  z.object({ name: z.string(), parentId: z.string() }).strict(),
  z.object({ name: z.string(), space: spaceSchema }).strict(),
]);
/** 至少一個；`parentId: null`＝根層。 */
const updateBodySchema = z
  .object({ name: z.string().optional(), parentId: z.string().nullable().optional() })
  .strict()
  .refine(b => b.name !== undefined || b.parentId !== undefined, "請求格式錯誤：至少需要一個欄位");
/** `folderId: null`＝根層（必填；非 UUID 與不存在同形，由服務層判）。 */
const placeBodySchema = z.object({ folderId: z.string().nullable() }).strict();
/** 可省（沒有 body＝現行行為）；`onlyIfEmpty: true`＝只刪空資料夾（§5.7.4）。 */
const deleteBodySchema = z.object({ onlyIfEmpty: z.boolean().optional() }).strict();

export function foldersRoutes(deps: FolderServiceDeps) {
  return async function register(app: FastifyInstance): Promise<void> {
    app.get("/api/folders", { preHandler: app.authenticateAny("notes:read") }, async request => {
      return { folders: await listFolders(deps.db, request.user!.id) } satisfies FolderListDto;
    });

    app.post("/api/folders", { preHandler: app.authenticate }, async (request, reply) => {
      const parsed = createBodySchema.safeParse(request.body ?? {});
      if (!parsed.success) return sendError(reply, 400, "invalid_body", parsed.error.issues[0]?.message ?? "請求格式錯誤");
      const body = parsed.data;
      let parent: { folderId: string } | { space: FolderSpaceDto };
      if ("parentId" in body) parent = { folderId: body.parentId.toLowerCase() };
      else if (body.space.kind === "group") parent = { space: { kind: "group", groupId: body.space.groupId.toLowerCase() } };
      else parent = { space: { kind: body.space.kind } };
      const out = await createFolder(deps, { by: request.user!.id, name: body.name, parent });
      if (out.kind === "error") return sendError(reply, out.status, out.code, out.message);
      return reply.code(201).send(out.folder);
    });

    app.patch("/api/folders/:id", { preHandler: app.authenticate }, async (request, reply) => {
      const { id } = request.params as { id: string };
      const parsed = updateBodySchema.safeParse(request.body ?? {});
      if (!parsed.success) return sendError(reply, 400, "invalid_body", parsed.error.issues[0]?.message ?? "請求格式錯誤");
      const { name, parentId } = parsed.data;
      const out = await updateFolder(deps, {
        by: request.user!.id,
        folderId: id,
        ...(name !== undefined ? { name } : {}),
        ...(parentId !== undefined ? { parentId: parentId === null ? null : parentId.toLowerCase() } : {}),
      });
      if (out.kind === "error") return sendError(reply, out.status, out.code, out.message);
      return out.folder;
    });

    app.delete("/api/folders/:id", { preHandler: app.authenticate }, async (request, reply) => {
      const { id } = request.params as { id: string };
      const parsed = deleteBodySchema.safeParse(request.body ?? {});
      if (!parsed.success) return sendError(reply, 400, "invalid_body", parsed.error.issues[0]?.message ?? "請求格式錯誤");
      const out = await deleteFolder(deps, { by: request.user!.id, folderId: id, onlyIfEmpty: parsed.data.onlyIfEmpty === true });
      if (out.kind === "error") return sendError(reply, out.status, out.code, out.message);
      return out.result satisfies FolderDeleteResultDto;
    });

    // 放在這裡不放 `routes/notes.ts`：資料夾的入口檢查與錯誤形都在 `folders/service.ts`（§5.7.5）。
    app.put("/api/notes/:id/folder", { preHandler: app.authenticate }, async (request, reply) => {
      const { id } = request.params as { id: string };
      const parsed = placeBodySchema.safeParse(request.body ?? {});
      if (!parsed.success) return sendError(reply, 400, "invalid_body", parsed.error.issues[0]?.message ?? "請求格式錯誤");
      const { folderId } = parsed.data;
      const out = await placeNote(deps, { by: request.user!.id, noteId: id, folderId: folderId === null ? null : folderId.toLowerCase() });
      if (out.kind === "error") return sendError(reply, out.status, out.code, out.message);
      return out.note satisfies NoteDto;
    });
  };
}
