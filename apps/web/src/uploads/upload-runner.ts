import { sanitizeUploadFileName, uploadServedName, type UploadResponseDto } from "@knotebook/shared";
import { ApiFail } from "@/api/client";
import { fetchSessionUser } from "@/auth/useSession";
import type { CollabState } from "@/collab/connection";
import { acquireNoteConnection, type NoteConnectionHandle } from "@/collab/note-connection";
import { precheckUpload, type PrecheckCtx, type PrecheckResult } from "./precheck";
import {
  currentUploadUserId,
  getUploadItems,
  notifyUploadSessionExpired,
  patchUpload,
  putUpload,
  removeUpload,
  subscribeUploads,
  type UploadItem,
} from "./upload-queue-store";
import { reportUploadFinished } from "./report-upload-finished";
import { isUploadRetryable, uploadRetryWaitMs } from "./upload-rules";
import { xhrUpload } from "./xhr-upload";
import { writeUploadedBlock } from "./yjs-block-write";

/**
 * The connection keeps retrying for an editor's sake and never gives up on its own; this covers one
 * token backoff round plus the longest jittered restart.
 */
export const UPLOAD_WRITE_WAIT_MS = 90_000;

const CONFIRM_USER_TIMEOUT_MS = 10_000;

type Refusal = PrecheckResult & { ok: false };

export interface StartUploadArgs {
  noteId: string;
  blockId: string;
  file: File;
  /** A getter is read once the pre-check has passed, so a replace sees a file written into the block during the check. */
  expectedUrl: string | (() => string);
  precheckCtx: () => Promise<PrecheckCtx>;
  /** Default true. False when the caller shows the refusal itself and the block is left alone. */
  recordRefusal?: boolean;
}

export type StartUploadResult = { ok: true; id: string } | { ok: false; result: Refusal };

interface Run {
  file: File;
  precheckCtx: () => Promise<PrecheckCtx>;
  /** Set once the file is stored: a retry then repeats only the write. */
  stored?: UploadResponseDto;
  handle?: NoteConnectionHandle;
  abort?: AbortController;
  /** Bumped whenever the run is stopped or restarted, so continuations of an older attempt do nothing. */
  attempt: number;
  retrying?: boolean;
}

const runs = new Map<string, Run>();
let nextId = 0;

const SIGNED_OUT = () => new ApiFail(401, "unauthorized", "Signed out");
const INTERRUPTED = () => new ApiFail(0, "upload_interrupted", "Upload interrupted");
const UNCONFIRMED = () => new ApiFail(0, "upload_session_unconfirmed", "Couldn't confirm who is signed in");

function writeRefusal(state: CollabState): ApiFail {
  if (state.phase === "outdated") return new ApiFail(0, "upload_write_outdated", "This page is out of date");
  if (state.phase === "deleted") return new ApiFail(404, "upload_write_deleted", "The note was deleted");
  return new ApiFail(403, "upload_write_rejected", "The note can no longer be edited");
}

// Dismissed items have no use for the file or the connection any more.
subscribeUploads(() => {
  const ids = new Set(getUploadItems().map((item) => item.id));
  for (const [id, run] of runs) if (!ids.has(id)) stopRun(id, run, { forget: true });
});

function stopRun(id: string, run: Run, opts: { forget?: boolean } = {}) {
  run.attempt += 1;
  run.abort?.abort();
  run.abort = undefined;
  releaseHandle(run);
  if (opts.forget) runs.delete(id);
}

function releaseHandle(run: Run) {
  const handle = run.handle;
  run.handle = undefined;
  handle?.release();
}

function itemOf(id: string): UploadItem | undefined {
  return getUploadItems().find((item) => item.id === id);
}

/** A failure no retry can get past no longer needs the file or the connection. */
function fail(id: string, run: Run, patch: Pick<UploadItem, "error"> | Pick<UploadItem, "precheck">) {
  const waitMs = "error" in patch ? patch.error?.retryAfterMs : undefined;
  const retryAt = typeof waitMs === "number" && waitMs > 0 ? Date.now() + waitMs : undefined;
  patchUpload(id, { status: "failed", error: undefined, retryAt, ...patch });
  const item = itemOf(id);
  if (!item || !isUploadRetryable(item)) stopRun(id, run, { forget: true });
}

// A 401 means the whole session is gone: every running upload would get the same answer.
function signOut() {
  let stopped = 0;
  for (const item of getUploadItems()) {
    if (item.status !== "uploading" && item.status !== "writing") continue;
    stopped += 1;
    const run = runs.get(item.id);
    if (run) stopRun(item.id, run, { forget: true });
    patchUpload(item.id, { status: "failed", error: SIGNED_OUT() });
  }
  // A second 401 in the same burst finds nothing running and stays quiet.
  if (stopped > 0) notifyUploadSessionExpired();
}

function holdConnection(noteId: string, run: Run) {
  run.handle ??= acquireNoteConnection(noteId, {
    kind: "queue",
    // Called from inside the connection's token handling; releasing there would tear it down mid-call.
    onUnauthorized: () => void Promise.resolve().then(signOut),
  });
  return run.handle;
}

/** `null` when signed out, `undefined` when the server couldn't be asked. */
async function signedInUserId(): Promise<string | null | undefined> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), CONFIRM_USER_TIMEOUT_MS);
  try {
    return (await fetchSessionUser(ctl.signal))?.id ?? null;
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

async function safeCtx(provider: () => Promise<PrecheckCtx>): Promise<PrecheckCtx> {
  try {
    return await provider();
  } catch {
    return { roomBytes: undefined, fetchFailed: true };
  }
}

export async function startUpload(args: StartUploadArgs): Promise<StartUploadResult> {
  const { noteId, blockId, file, precheckCtx, recordRefusal = true } = args;
  const checked = precheckUpload(file, await safeCtx(precheckCtx));
  const id = `upload-${++nextId}`;
  const expectedUrl = typeof args.expectedUrl === "function" ? args.expectedUrl() : args.expectedUrl;
  const base = { id, noteId, blockId, fileName: file.name, size: file.size, loaded: 0, expectedUrl, ownerId: currentUploadUserId() };
  if (!checked.ok) {
    if (recordRefusal) putUpload({ ...base, status: "failed", precheck: checked });
    return { ok: false, result: checked };
  }
  // A newer file for the same block replaces an older upload, which would otherwise expect the block's old URL and end
  // up "no longer placed". Only once the newer one passed its check: a refused pick leaves the running upload alone.
  for (const older of getUploadItems()) if (older.noteId === noteId && older.blockId === blockId) removeUpload(older.id);
  const run: Run = { file, precheckCtx, attempt: 0 };
  runs.set(id, run);
  putUpload({ ...base, status: "uploading" });
  holdConnection(noteId, run);
  void upload(id, run);
  return { ok: true, id };
}

export async function retryUpload(id: string): Promise<void> {
  const run = runs.get(id);
  const item = itemOf(id);
  if (!run || !item || run.retrying || !isUploadRetryable(item) || uploadRetryWaitMs(item) > 0) return;
  run.retrying = true;
  patchUpload(id, { retrying: true });
  try {
    // Another tab may have signed in someone else since: the file and the note belong to the person who started it,
    // and this tab's own session cache only notices on its next refetch.
    if (item.ownerId !== undefined) {
      const now = await signedInUserId();
      if (!runs.has(id)) return;
      // Not knowing counts as not confirmed: sending would go out with whatever session this browser now holds.
      if (now === undefined) {
        fail(id, run, { error: UNCONFIRMED() });
        return;
      }
      if (now !== item.ownerId) {
        // The app refetches the session, and the queue is cleared once the cache shows the change.
        notifyUploadSessionExpired();
        return;
      }
    }
    if (run.stored) {
      patchUpload(id, { status: "writing", error: undefined, retryAt: undefined });
      holdConnection(item.noteId, run);
      void write(id, run, run.attempt);
      return;
    }
    const checked = precheckUpload(run.file, await safeCtx(run.precheckCtx));
    if (!runs.has(id)) return;
    if (!checked.ok) {
      fail(id, run, { precheck: checked });
      return;
    }
  } finally {
    run.retrying = false;
    patchUpload(id, { retrying: undefined });
  }
  patchUpload(id, { status: "uploading", loaded: 0, error: undefined, retryAt: undefined });
  holdConnection(item.noteId, run);
  void upload(id, run);
}

async function upload(id: string, run: Run) {
  const attempt = ++run.attempt;
  const item = itemOf(id);
  if (!item) return;
  const abort = new AbortController();
  run.abort = abort;
  const form = new FormData();
  form.append("file", run.file);
  try {
    run.stored = await xhrUpload(`/api/notes/${encodeURIComponent(item.noteId)}/uploads`, form, {
      signal: abort.signal,
      onProgress: (loaded, total) => {
        if (run.attempt !== attempt || total <= 0) return;
        patchUpload(id, { loaded: Math.round((Math.min(loaded, total) / total) * item.size) });
      },
    });
  } catch (err) {
    if (run.attempt !== attempt) return;
    run.abort = undefined;
    if (err instanceof ApiFail && err.status === 401) {
      signOut();
      return;
    }
    releaseHandle(run);
    if (err instanceof ApiFail && err.code === "upload_interrupted") {
      // A refusal sent while the body is still uploading often reaches the browser as a network
      // error, so the size and room are checked again before offering a retry that would fail the same way.
      const checked = precheckUpload(run.file, await safeCtx(run.precheckCtx));
      if (run.attempt !== attempt) return;
      fail(id, run, checked.ok ? { error: err } : { precheck: checked });
      return;
    }
    fail(id, run, { error: err instanceof ApiFail ? err : INTERRUPTED() });
    return;
  }
  if (run.attempt !== attempt) return;
  run.abort = undefined;
  patchUpload(id, { status: "writing", loaded: item.size, stored: true });
  await write(id, run, attempt);
}

type WriteWait = "ok" | "rejected" | "timeout";

async function write(id: string, run: Run, attempt: number) {
  const item = itemOf(id);
  const handle = run.handle;
  const stored = run.stored;
  if (!item || !handle || !stored) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  // The timer settles this before `release()` runs: release resolves the pending `whenWritable`
  // with "rejected", which would read as lost access.
  const outcome = await new Promise<WriteWait>((resolve) => {
    timer = setTimeout(() => resolve("timeout"), UPLOAD_WRITE_WAIT_MS);
    void handle.whenWritable().then(resolve);
  });
  clearTimeout(timer);
  if (run.attempt !== attempt) return;
  if (outcome !== "ok") {
    const error = outcome === "timeout" ? INTERRUPTED() : writeRefusal(handle.getState());
    releaseHandle(run);
    fail(id, run, { error });
    return;
  }
  const name = uploadServedName(sanitizeUploadFileName(run.file.name), stored.mime, stored.id);
  let written: ReturnType<typeof writeUploadedBlock>;
  try {
    written = writeUploadedBlock(handle.doc, item.blockId, item.expectedUrl, stored, name);
  } catch {
    // A throw would leave the item `writing`, and the leave-page prompt with it, for good.
    releaseHandle(run);
    fail(id, run, { error: INTERRUPTED() });
    return;
  }
  // With the note on screen the file appears in front of the person; the bell is for uploads that finish elsewhere.
  const editorAttached = handle.hasEditor();
  releaseHandle(run);
  runs.delete(id);
  if (written === "written") {
    removeUpload(id);
    if (!editorAttached) reportUploadFinished(stored.id, item.blockId);
  } else patchUpload(id, { status: "unplaced" });
}

/** Tests only. */
export function hasUploadRunForTest(id: string): boolean {
  return runs.has(id);
}

/** Tests only. */
export function resetUploadRunnerForTest(): void {
  for (const [id, run] of runs) stopRun(id, run, { forget: true });
}
