import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EMPTY_YDOC_UPDATE_B64, type TrashPreviewDto } from "@knotebook/shared";
import { noopCollabHooks } from "../../src/collab/hooks.js";
import type { Db } from "../../src/db/index.js";
import { sendError } from "../../src/http/errors.js";
import { trashRightFromRow, type AccessRow } from "../../src/notes/service.js";
import { UPLOAD_CSP, uploadFilePath } from "../../src/uploads/service.js";

const mockReadTrashRetentionDays = vi.fn();
const mockLoadTrashPreview = vi.fn();
const mockListTrash = vi.fn();
const mockResolveTrashedNoteAccess = vi.fn();

vi.mock("../../src/trash/list.js", () => ({
  readTrashRetentionDays: (...args: unknown[]) => mockReadTrashRetentionDays(...args),
  loadTrashPreview: (...args: unknown[]) => mockLoadTrashPreview(...args),
  listTrash: (...args: unknown[]) => mockListTrash(...args),
}));

vi.mock("../../src/notes/service.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/notes/service.js")>();
  return {
    ...actual,
    resolveTrashedNoteAccess: (...args: unknown[]) => mockResolveTrashedNoteAccess(...args),
  };
});

import { trashRoutes } from "../../src/routes/trash.js";

const USER_ID = "11111111-1111-4111-8111-111111111111";
const NOTE_ID = "22222222-2222-4222-8222-222222222222";
const OTHER_NOTE_ID = "33333333-3333-4333-8333-333333333333";
const UPLOAD_ID = "44444444-4444-4444-8444-444444444444";

const SAMPLE_PREVIEW: TrashPreviewDto = {
  id: NOTE_ID,
  title: "Trashed Note",
  deletedAt: "2026-10-20T00:00:00.000Z",
  purgeAt: "2026-10-27T00:00:00.000Z",
  deletedBy: { handle: "alice", displayName: "Alice" },
  group: null,
  folderPath: ["Work"],
  ydoc: EMPTY_YDOC_UPDATE_B64,
};

function makeUploadDb(row: { id: string; noteId: string; mime: string; fileName: string | null } | undefined): Db {
  return {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => Promise.resolve(row ? [row] : []),
        }),
      }),
    }),
  } as unknown as Db;
}

async function buildUnitApp(opts: { authenticated?: boolean; uploadRow?: { id: string; noteId: string; mime: string; fileName: string | null }; uploadsDir?: string } = {}) {
  const app = Fastify({ logger: false });
  app.decorate("authenticate", async (request, reply) => {
    if (opts.authenticated === false) {
      sendError(reply, 401, "unauthorized", "Not signed in.");
      return;
    }
    request.user = {
      id: USER_ID,
      email: "alice@example.com",
      handle: "alice",
      displayName: "Alice",
      isAdmin: false,
      mustChangePassword: false,
      hasPassword: true,
      autoVersions: true,
      avatar: null,
    };
  });
  await app.register(
    trashRoutes({
      db: makeUploadDb(opts.uploadRow),
      collabHooks: noopCollabHooks,
      uploadsDir: opts.uploadsDir ?? tmpdir(),
      storageLockTimeoutMs: 5000,
    }),
  );
  await app.ready();
  return app;
}

describe("trash preview authorization predicate (trashRightFromRow)", () => {
  const baseRow: AccessRow = {
    ownerId: null,
    groupId: "gggggggg-gggg-4ggg-8ggg-gggggggggggg",
    shareRole: null,
    roleId: "rrrrrrrr-rrrr-4rrr-8rrr-rrrrrrrrrrrr",
    canRead: true,
    canEdit: false,
    canDelete: false,
    canManagePublicLink: false,
  };

  it("personal note: owner allowed, shared editor/viewer and stranger denied", () => {
    expect(trashRightFromRow({ ...baseRow, groupId: null, roleId: null, ownerId: USER_ID }, USER_ID)).toBe(true);
    expect(trashRightFromRow({ ...baseRow, groupId: null, roleId: null, ownerId: "other", shareRole: "editor" }, USER_ID)).toBe(false);
    expect(trashRightFromRow({ ...baseRow, groupId: null, roleId: null, ownerId: "other", shareRole: "viewer" }, USER_ID)).toBe(false);
    expect(trashRightFromRow({ ...baseRow, groupId: null, roleId: null, ownerId: "other", shareRole: null }, USER_ID)).toBe(false);
    expect(trashRightFromRow(undefined, USER_ID)).toBe(false);
  });

  it("group note: only roles with BOTH canEdit and canDelete are allowed", () => {
    expect(trashRightFromRow({ ...baseRow, canEdit: true, canDelete: true }, USER_ID)).toBe(true);
    expect(trashRightFromRow({ ...baseRow, canEdit: true, canDelete: false }, USER_ID)).toBe(false);
    expect(trashRightFromRow({ ...baseRow, canEdit: false, canDelete: true }, USER_ID)).toBe(false);
    expect(trashRightFromRow({ ...baseRow, canEdit: false, canDelete: false }, USER_ID)).toBe(false);
    expect(trashRightFromRow({ ...baseRow, roleId: null, canEdit: true, canDelete: true }, USER_ID)).toBe(false);
  });
});

describe("GET /api/trash/:id", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("unauthenticated request returns 401", async () => {
    const app = await buildUnitApp({ authenticated: false });
    const res = await app.inject({ method: "GET", url: `/api/trash/${NOTE_ID}` });
    expect(res.statusCode).toBe(401);
    expect(mockLoadTrashPreview).not.toHaveBeenCalled();
    await app.close();
  });

  it("malformed UUID returns 404 not_found identical to missing note without touching DB", async () => {
    const app = await buildUnitApp();
    mockReadTrashRetentionDays.mockResolvedValue({ retentionDays: 7 });
    mockLoadTrashPreview.mockResolvedValue(null);

    const bad = await app.inject({ method: "GET", url: "/api/trash/not-a-uuid" });
    const missing = await app.inject({ method: "GET", url: `/api/trash/${randomUUID()}` });

    expect(bad.statusCode).toBe(404);
    expect(bad.body).toBe(missing.body);
    expect(mockLoadTrashPreview).toHaveBeenCalledTimes(1);
    await app.close();
  });

  it("missing site_settings row returns 500 internal", async () => {
    const app = await buildUnitApp();
    mockReadTrashRetentionDays.mockResolvedValue(undefined);

    const res = await app.inject({ method: "GET", url: `/api/trash/${NOTE_ID}` });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({ error: { code: "internal", message: "Internal server error." } });
    await app.close();
  });

  it("authorized caller gets 200 TrashPreviewDto with private, no-store and lowercase id lookup", async () => {
    const app = await buildUnitApp();
    mockReadTrashRetentionDays.mockResolvedValue({ retentionDays: 7 });
    mockLoadTrashPreview.mockResolvedValue(SAMPLE_PREVIEW);

    const res = await app.inject({ method: "GET", url: `/api/trash/${NOTE_ID.toUpperCase()}` });
    expect(res.statusCode).toBe(200);
    expect(res.headers["cache-control"]).toBe("private, no-store");
    expect(res.json()).toEqual(SAMPLE_PREVIEW);
    expect(mockLoadTrashPreview).toHaveBeenCalledWith(expect.anything(), USER_ID, NOTE_ID, 7);
    await app.close();
  });
});

describe("GET /api/trash/:id/uploads/:uploadId", () => {
  const tempDirs: string[] = [];
  afterEach(() => {
    vi.clearAllMocks();
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function makeUploadsDir(fileId?: string, bytes?: Buffer): string {
    const dir = mkdtempSync(path.join(tmpdir(), "trash-preview-uploads-"));
    tempDirs.push(dir);
    if (fileId && bytes) writeFileSync(uploadFilePath(dir, fileId), bytes);
    return dir;
  }

  it("unauthenticated request returns 401", async () => {
    const app = await buildUnitApp({ authenticated: false });
    const res = await app.inject({ method: "GET", url: `/api/trash/${NOTE_ID}/uploads/${UPLOAD_ID}` });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it("malformed UUIDs, unauthorized caller, missing upload, cross-note upload, and missing disk file all return byte-identical 404", async () => {
    const dir = makeUploadsDir();
    const appNoRow = await buildUnitApp({ uploadsDir: dir });
    const badId = await appNoRow.inject({ method: "GET", url: `/api/trash/bad/uploads/${UPLOAD_ID}` });
    const badUpload = await appNoRow.inject({ method: "GET", url: `/api/trash/${NOTE_ID}/uploads/bad` });

    mockResolveTrashedNoteAccess.mockResolvedValue(false);
    const denied = await appNoRow.inject({ method: "GET", url: `/api/trash/${NOTE_ID}/uploads/${UPLOAD_ID}` });

    mockResolveTrashedNoteAccess.mockResolvedValue(true);
    const missingRow = await appNoRow.inject({ method: "GET", url: `/api/trash/${NOTE_ID}/uploads/${UPLOAD_ID}` });
    await appNoRow.close();

    const appCrossNote = await buildUnitApp({
      uploadsDir: dir,
      uploadRow: { id: UPLOAD_ID, noteId: OTHER_NOTE_ID, mime: "image/png", fileName: null },
    });
    const crossNote = await appCrossNote.inject({ method: "GET", url: `/api/trash/${NOTE_ID}/uploads/${UPLOAD_ID}` });
    await appCrossNote.close();

    const appMissingFile = await buildUnitApp({
      uploadsDir: dir,
      uploadRow: { id: UPLOAD_ID, noteId: NOTE_ID, mime: "image/png", fileName: null },
    });
    const missingFile = await appMissingFile.inject({ method: "GET", url: `/api/trash/${NOTE_ID}/uploads/${UPLOAD_ID}` });
    await appMissingFile.close();

    for (const res of [badId, badUpload, denied, missingRow, crossNote, missingFile]) {
      expect(res.statusCode).toBe(404);
      expect(res.body).toBe(badId.body);
    }
  });

  it("authorized caller gets 200 with bytes and the same headers as GET /api/uploads/:id", async () => {
    const payload = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const dir = makeUploadsDir(UPLOAD_ID, payload);
    mockResolveTrashedNoteAccess.mockResolvedValue(true);
    const app = await buildUnitApp({
      uploadsDir: dir,
      uploadRow: { id: UPLOAD_ID, noteId: NOTE_ID, mime: "image/png", fileName: null },
    });

    const res = await app.inject({
      method: "GET",
      url: `/api/trash/${NOTE_ID.toUpperCase()}/uploads/${UPLOAD_ID.toUpperCase()}`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.rawPayload).toEqual(payload);
    expect(res.headers["content-type"]).toBe("image/png");
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["content-security-policy"]).toBe(UPLOAD_CSP);
    expect(res.headers["cache-control"]).toBe("private, max-age=31536000, immutable");
    await app.close();
  });

  it("answers a Range request with 206 and the requested bytes", async () => {
    const payload = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const dir = makeUploadsDir(UPLOAD_ID, payload);
    mockResolveTrashedNoteAccess.mockResolvedValue(true);
    const app = await buildUnitApp({
      uploadsDir: dir,
      uploadRow: { id: UPLOAD_ID, noteId: NOTE_ID, mime: "image/png", fileName: null },
    });

    const res = await app.inject({
      method: "GET",
      url: `/api/trash/${NOTE_ID}/uploads/${UPLOAD_ID}`,
      headers: { range: "bytes=0-3" },
    });
    expect(res.statusCode).toBe(206);
    expect(res.headers["content-range"]).toBe("bytes 0-3/8");
    expect(res.rawPayload).toEqual(payload.subarray(0, 4));
    await app.close();
  });
});
