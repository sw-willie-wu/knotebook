import { COMMENT_BODY_MAX, COMMENT_QUOTE_MAX } from "@knotebook/shared";

export const COMMENT_NOT_FOUND_MESSAGE = "No comment with that id.";
export const INVALID_COMMENT_BODY_MESSAGE = `A comment needs some text, at most ${COMMENT_BODY_MAX} characters, without NUL or unpaired surrogate characters.`;
export const INVALID_COMMENT_ANCHOR_MESSAGE = `A passage needs a valid block id and a quote of 1 to ${COMMENT_QUOTE_MAX} characters.`;
export const INVALID_COMMENT_REPLY_MESSAGE = "The comment it answers isn't on this note.";
export const COMMENT_EDIT_FORBIDDEN_MESSAGE = "Only the comment's author can edit it.";
export const COMMENT_DELETE_FORBIDDEN_MESSAGE = "You can't delete this comment.";
export const COMMENT_CONFLICT_MESSAGE = "The note's owner or group changed. Reload and try again.";
