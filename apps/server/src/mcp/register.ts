/**
 * Filtering `tools/list` is not a security boundary (a client can `tools/call` an unlisted
 * name); the real checks are the `require*Scope()` calls inside each write tool. The filter
 * only avoids advertising what can't be served.
 * Every tool must go through `runTool()` (it keeps raw exception messages out of the model's context); add new tool names to the `beforeTool` name sets
 * in the tests, or nothing guards the wrapping. Register as `.strict()` objects.
 * Call order matters: `registerTool` resets `listChanged` to `true`, so this runs before
 * `registerCapabilities` (guard: the `listChanged === false` case in `mcp-tools-list.test.ts`).
 *
 * Gate: tools that read the live doc register only with `collab && editing` (`canRead`).
 * Which side of the gate a tool belongs on is decided by "does it read a live doc", not by
 * which tool it resembles; tests catch a tool silently moving but not one placed wrongly.
 * `open_notes_as_files` is inside the gate: its token's export mounts the doc.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { runTool } from "./tool-result.js";
import type { McpToolCtx } from "./context.js";
import { LIST_NOTES_DESCRIPTION, listNotes, listNotesInput, listNotesOutput } from "./tools/list-notes.js";
import {
  READ_NOTE_OUTLINE_DESCRIPTION,
  readNoteOutline,
  readNoteOutlineInput,
  readNoteOutlineOutput,
} from "./tools/read-note-outline.js";
import {
  READ_NOTE_SECTION_DESCRIPTION,
  readNoteSection,
  readNoteSectionInput,
  readNoteSectionOutput,
} from "./tools/read-note-section.js";
import { searchNotes, searchNotesDescription, searchNotesInput, searchNotesOutputFor } from "./tools/search-notes.js";
import {
  OPEN_NOTES_AS_FILES_DESCRIPTION_RO,
  OPEN_NOTES_AS_FILES_DESCRIPTION_RW,
  openNotesAsFiles,
  openNotesAsFilesInput,
  openNotesAsFilesOutputRo,
  openNotesAsFilesOutputRw,
} from "./tools/open-notes-as-files.js";
import { EDIT_NOTE_DESCRIPTION, editNote, editNoteInput, editNoteOutput } from "./tools/edit-note.js";
import { CREATE_NOTE_DESCRIPTION, createNote, createNoteInput, createNoteOutput } from "./tools/create-note.js";
import {
  COPY_NOTE_DESCRIPTION,
  COPY_NOTE_DESCRIPTION_NO_MOVE,
  copyNoteInput,
  copyNoteInputNoMove,
  copyNoteOutput,
  copyNoteTool,
} from "./tools/copy-note.js";
import {
  MOVE_NOTE_TO_GROUP_DESCRIPTION,
  moveNoteToGroupInput,
  moveNoteToGroupOutput,
  moveNoteToGroupTool,
} from "./tools/move-note-to-group.js";
import {
  CREATE_TRANSFER_TOKEN_DESCRIPTION_RO,
  CREATE_TRANSFER_TOKEN_DESCRIPTION_RW,
  createTransferToken,
  createTransferTokenInputRo,
  createTransferTokenInputRw,
  createTransferTokenOutput,
} from "./tools/create-transfer-token.js";
import {
  READ_NOTE_IMAGE_DESCRIPTION_SESSION,
  READ_NOTE_IMAGE_DESCRIPTION_TOKEN,
  readNoteImage,
  readNoteImageInput,
  readNoteImageOutput,
} from "./tools/read-note-image.js";
import { LIST_TRASH_DESCRIPTION, listTrash, listTrashInput, listTrashOutput } from "./tools/list-trash.js";
import { DELETE_NOTE_DESCRIPTION, deleteNoteInput, deleteNoteOutput, deleteNoteTool } from "./tools/delete-note.js";
import { RESTORE_NOTE_DESCRIPTION, restoreNoteInput, restoreNoteOutput, restoreNoteTool } from "./tools/restore-note.js";
import { LIST_FOLDERS_DESCRIPTION, listFolders, listFoldersInput, listFoldersOutput } from "./tools/list-folders.js";
import { CREATE_FOLDER_DESCRIPTION, createFolderInput, createFolderTool, folderReplyOutput } from "./tools/create-folder.js";
import { RENAME_FOLDER_DESCRIPTION, renameFolderInput, renameFolderTool } from "./tools/rename-folder.js";
import { MOVE_FOLDER_DESCRIPTION, moveFolderInput, moveFolderTool } from "./tools/move-folder.js";
import {
  MOVE_NOTE_TO_FOLDER_DESCRIPTION,
  moveNoteToFolderInput,
  moveNoteToFolderOutput,
  moveNoteToFolderTool,
} from "./tools/move-note-to-folder.js";
import { DELETE_FOLDER_DESCRIPTION, deleteFolderInput, deleteFolderOutput, deleteFolderTool } from "./tools/delete-folder.js";
import { READ_COMMENTS_DESCRIPTION, readComments, readCommentsInput, readCommentsOutput } from "./tools/read-comments.js";
import { POST_COMMENT_DESCRIPTION, postCommentInput, postCommentOutput, postCommentTool } from "./tools/post-comment.js";
import { listNotificationsDescription, listNotificationsInput, listNotificationsOutput, listNotificationsTool } from "./tools/list-notifications.js";
import { canDeleteNotes, canMoveNotes, canWriteNotes } from "./write-scope.js";

/** Token path only (the signed token binds to a parent credential). Shared with `routes/mcp.ts` so instructions never mention a tool that isn't listed. */
export function hasOpenNotesAsFiles(ctx: Pick<McpToolCtx, "authKind" | "collab" | "editing">): boolean {
  return ctx.authKind === "token" && Boolean(ctx.collab && ctx.editing);
}

export function registerMcpTools(server: McpServer, ctx: McpToolCtx): void {
  // This filter is not the security boundary. The registry is the tool list, so the write
  // check's `insufficient_scope` is dead over HTTP (don't pin it in integration tests; same for
  // move_note_to_group's move check), except `copy_note` with `group_id`.
  const canWrite = canWriteNotes(ctx);
  const canMove = canMoveNotes(ctx);
  const canDelete = canDeleteNotes(ctx);
  const canRead = Boolean(ctx.collab && ctx.editing);

  server.registerTool(
    "list_notes",
    { description: LIST_NOTES_DESCRIPTION, inputSchema: z.object(listNotesInput).strict(), outputSchema: listNotesOutput },
    async args => runTool("list_notes", ctx, () => listNotes(args, ctx))
  );

  server.registerTool(
    "search_notes",
    { description: searchNotesDescription(canRead), inputSchema: z.object(searchNotesInput).strict(), outputSchema: searchNotesOutputFor(canRead) },
    async args => runTool("search_notes", ctx, () => searchNotes(args, ctx))
  );

  // A block, not an early return: an early return would silently gate any later tool that doesn't need collab.
  if (canRead) {
    server.registerTool(
      "read_note_outline",
      {
        description: READ_NOTE_OUTLINE_DESCRIPTION,
        inputSchema: z.object(readNoteOutlineInput).strict(),
        outputSchema: readNoteOutlineOutput,
      },
      async args => runTool("read_note_outline", ctx, () => readNoteOutline(args, ctx))
    );

    server.registerTool(
      "read_note_section",
      {
        description: READ_NOTE_SECTION_DESCRIPTION,
        inputSchema: z.object(readNoteSectionInput).strict(),
        outputSchema: readNoteSectionOutput,
      },
      async args => runTool("read_note_section", ctx, () => readNoteSection(args, ctx))
    );

    if (canWrite) {
      server.registerTool(
        "edit_note",
        { description: EDIT_NOTE_DESCRIPTION, inputSchema: z.object(editNoteInput).strict(), outputSchema: editNoteOutput },
        async args => runTool("edit_note", ctx, () => editNote(args, ctx))
      );
    }
  }

  // `create_note` is outside the gate: without `content` it never touches the live doc, and
  // REST `POST /api/notes` is unconditional too; with `content` but no collab it returns
  // `invalid_body`, like REST's 400 (`createNote` checks `ctx.writes.available`).
  // `.strict()` everywhere: a raw shape silently drops unknown keys, so an old `groupId` would
  // create a personal note and a misspelled `ifMatch` would skip the fingerprint check. A bare `.strict()` ZodObject keeps `inputSchema.properties` intact.
  if (canWrite) {
    server.registerTool(
      "create_note",
      { description: CREATE_NOTE_DESCRIPTION, inputSchema: z.object(createNoteInput).strict(), outputSchema: createNoteOutput },
      async args => runTool("create_note", ctx, () => createNote(args, ctx))
    );
  }

  // Both annotations equal the SDK defaults; written out so clients needn't depend on them.
  if (canMove) {
    server.registerTool(
      "move_note_to_group",
      {
        description: MOVE_NOTE_TO_GROUP_DESCRIPTION,
        inputSchema: z.object(moveNoteToGroupInput).strict(),
        outputSchema: moveNoteToGroupOutput,
        annotations: { destructiveHint: true, idempotentHint: false },
      },
      async args => runTool("move_note_to_group", ctx, () => moveNoteToGroupTool(args, ctx))
    );
  }

  // Outside the collab gate (REST copy is unconditional; `loadNoteDoc` reads `note_states` without collab). Under canWrite; with `group_id` the handler also checks notes:move at run time. `idempotentHint` omitted: every call creates a new note.
  if (canWrite) {
    server.registerTool(
      "copy_note",
      {
        description: canMove ? COPY_NOTE_DESCRIPTION : COPY_NOTE_DESCRIPTION_NO_MOVE,
        inputSchema: z.object(canMove ? copyNoteInput : copyNoteInputNoMove).strict(),
        outputSchema: copyNoteOutput,
        annotations: { destructiveHint: false },
      },
      async args => runTool("copy_note", ctx, () => copyNoteTool(args, ctx))
    );
  }

  // Token path only: a session has no parent credential to bind.
  if (ctx.authKind === "token") {
    if (canWrite) {
      server.registerTool(
        "create_transfer_token",
        { description: CREATE_TRANSFER_TOKEN_DESCRIPTION_RW, inputSchema: z.object(createTransferTokenInputRw).strict(), outputSchema: createTransferTokenOutput },
        async args => runTool("create_transfer_token", ctx, () => createTransferToken(args, ctx))
      );
    } else {
      server.registerTool(
        "create_transfer_token",
        { description: CREATE_TRANSFER_TOKEN_DESCRIPTION_RO, inputSchema: z.object(createTransferTokenInputRo).strict(), outputSchema: createTransferTokenOutput },
        async args => runTool("create_transfer_token", ctx, () => createTransferToken(args, ctx))
      );
    }
  }

  if (hasOpenNotesAsFiles(ctx)) {
    server.registerTool(
      "open_notes_as_files",
      {
        description: canWrite ? OPEN_NOTES_AS_FILES_DESCRIPTION_RW : OPEN_NOTES_AS_FILES_DESCRIPTION_RO,
        inputSchema: z.object(openNotesAsFilesInput).strict(),
        outputSchema: canWrite ? openNotesAsFilesOutputRw : openNotesAsFilesOutputRo,
      },
      async args => runTool("open_notes_as_files", ctx, () => openNotesAsFiles(args, ctx))
    );
  }

  server.registerTool(
    "list_trash",
    { description: LIST_TRASH_DESCRIPTION, inputSchema: z.object(listTrashInput).strict(), outputSchema: listTrashOutput },
    async args => runTool("list_trash", ctx, () => listTrash(args, ctx))
  );

  // `idempotentHint` omitted: a second call returns not_found. MCP has no permanent delete or empty-trash.
  if (canDelete) {
    server.registerTool(
      "delete_note",
      {
        description: DELETE_NOTE_DESCRIPTION,
        inputSchema: z.object(deleteNoteInput).strict(),
        outputSchema: deleteNoteOutput,
        annotations: { destructiveHint: true },
      },
      async args => runTool("delete_note", ctx, () => deleteNoteTool(args, ctx))
    );

    server.registerTool(
      "restore_note",
      {
        description: RESTORE_NOTE_DESCRIPTION,
        inputSchema: z.object(restoreNoteInput).strict(),
        outputSchema: restoreNoteOutput,
        annotations: { destructiveHint: false },
      },
      async args => runTool("restore_note", ctx, () => restoreNoteTool(args, ctx))
    );
  }

  // The only read tool with annotations.
  server.registerTool(
    "list_folders",
    {
      description: LIST_FOLDERS_DESCRIPTION,
      inputSchema: z.object(listFoldersInput).strict(),
      outputSchema: listFoldersOutput,
      annotations: { readOnlyHint: true },
    },
    async args => runTool("list_folders", ctx, () => listFolders(args, ctx))
  );

  if (canWrite) {
    server.registerTool(
      "create_folder",
      {
        description: CREATE_FOLDER_DESCRIPTION,
        inputSchema: z.object(createFolderInput).strict(),
        outputSchema: folderReplyOutput,
        annotations: { destructiveHint: false },
      },
      async args => runTool("create_folder", ctx, () => createFolderTool(args, ctx))
    );
    server.registerTool(
      "rename_folder",
      {
        description: RENAME_FOLDER_DESCRIPTION,
        inputSchema: z.object(renameFolderInput).strict(),
        outputSchema: folderReplyOutput,
        annotations: { destructiveHint: false, idempotentHint: true },
      },
      async args => runTool("rename_folder", ctx, () => renameFolderTool(args, ctx))
    );
    server.registerTool(
      "move_folder",
      {
        description: MOVE_FOLDER_DESCRIPTION,
        inputSchema: z.object(moveFolderInput).strict(),
        outputSchema: folderReplyOutput,
        annotations: { destructiveHint: false, idempotentHint: true },
      },
      async args => runTool("move_folder", ctx, () => moveFolderTool(args, ctx))
    );
    // Under canWrite, not canMove: placement needs only notes:write.
    server.registerTool(
      "move_note_to_folder",
      {
        description: MOVE_NOTE_TO_FOLDER_DESCRIPTION,
        inputSchema: z.object(moveNoteToFolderInput).strict(),
        outputSchema: moveNoteToFolderOutput,
        annotations: { destructiveHint: false, idempotentHint: true },
      },
      async args => runTool("move_note_to_folder", ctx, () => moveNoteToFolderTool(args, ctx))
    );
  }

  // `idempotentHint` omitted: a second call returns not_found. delete_folder trashes its subtree's notes, hence notes:delete.
  if (canDelete) {
    server.registerTool(
      "delete_folder",
      {
        description: DELETE_FOLDER_DESCRIPTION,
        inputSchema: z.object(deleteFolderInput).strict(),
        outputSchema: deleteFolderOutput,
        annotations: { destructiveHint: true },
      },
      async args => runTool("delete_folder", ctx, () => deleteFolderTool(args, ctx))
    );
  }

  server.registerTool(
    "read_note_image",
    {
      description: ctx.authKind === "token" ? READ_NOTE_IMAGE_DESCRIPTION_TOKEN : READ_NOTE_IMAGE_DESCRIPTION_SESSION,
      inputSchema: z.object(readNoteImageInput).strict(),
      outputSchema: readNoteImageOutput,
    },
    async args => runTool("read_note_image", ctx, () => readNoteImage(args, ctx))
  );

  // Inside the gate: both read the live doc, for an anchor's current section.
  if (canRead) {
    server.registerTool(
      "read_comments",
      { description: READ_COMMENTS_DESCRIPTION, inputSchema: z.object(readCommentsInput).strict(), outputSchema: readCommentsOutput },
      async args => runTool("read_comments", ctx, () => readComments(args, ctx))
    );
    if (canWrite) {
      server.registerTool(
        "post_comment",
        {
          description: POST_COMMENT_DESCRIPTION,
          inputSchema: z.object(postCommentInput).strict(),
          outputSchema: postCommentOutput,
          annotations: { destructiveHint: false },
        },
        async args => runTool("post_comment", ctx, () => postCommentTool(args, ctx))
      );
    }
  }

  server.registerTool(
    "list_notifications",
    { description: listNotificationsDescription(canRead), inputSchema: z.object(listNotificationsInput).strict(), outputSchema: listNotificationsOutput },
    async args => runTool("list_notifications", ctx, () => listNotificationsTool(args, ctx))
  );
}
