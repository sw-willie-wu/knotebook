import { createContext } from "react";
import { matchPath } from "react-router";
import { isKnowledgeIndexPath } from "./knowledge-index-path";

export const NOTE_ROUTE_PATTERNS = ["/notes/:ref", "/n/:handle/:slug", "/g/:groupId/:slug"] as const;
export const TRASH_PREVIEW_ROUTE = "/trash/:id" as const;

export function trashPreviewPath(noteId: string): string {
  return `/trash/${encodeURIComponent(noteId)}`;
}

export function isTrashPreviewPath(pathname: string): boolean {
  return matchPath({ path: TRASH_PREVIEW_ROUTE, end: true }, pathname) !== null;
}

/** The backgrounds of `/groups/*` and `/admin/*` are also the list, so `pathname === "/"` alone is not enough. */
export function isNoteRoutePath(pathname: string): boolean {
  return NOTE_ROUTE_PATTERNS.some((pattern) => matchPath({ path: pattern, end: true }, pathname) !== null);
}

/** Pages that replace the phone list: a note, a trash preview, or a knowledge index. */
export function isPageRoutePath(pathname: string): boolean {
  return isNoteRoutePath(pathname) || isTrashPreviewPath(pathname) || isKnowledgeIndexPath(pathname);
}

export interface PhoneListState {
  backToList: () => void;
}

export const PhoneListContext = createContext<PhoneListState | null>(null);

export interface PhoneBrowseState {
  openSearch: () => void;
  searchOpen?: boolean;
  /** Mount point outside the main content area, which shifts when sliding in. */
  fabSlot?: HTMLElement | null;
  createNote: (groupId?: string, folderId?: string) => Promise<void>;
}

export const PhoneBrowseContext = createContext<PhoneBrowseState | null>(null);
