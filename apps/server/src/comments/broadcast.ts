import type { CollabServer } from "../collab/server.js";

export type CommentChangeOp = "created" | "edited" | "deleted";

/**
 * Tells everyone with the note open that a comment changed; they fetch it themselves, so the message carries no text and a connection
 * that lost access in the meantime learns nothing. Call only after the transaction committed. Does nothing when the document isn't
 * loaded: nobody is connected, and a client that connects later refetches on sync.
 */
export function broadcastCommentChange(collab: CollabServer | undefined, noteId: string, op: CommentChangeOp, commentId: string): void {
  collab?.hocuspocus.documents.get(noteId)?.broadcastStateless(JSON.stringify({ type: "comment", op, commentId }));
}

/** The whole thread is gone (a move that clears history), so there is no single comment to name; clients refetch what they show. */
export function broadcastCommentsCleared(collab: CollabServer | undefined, noteId: string): void {
  collab?.hocuspocus.documents.get(noteId)?.broadcastStateless(JSON.stringify({ type: "comment", op: "cleared", commentId: "" }));
}
