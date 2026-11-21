import { lazy } from "react";
import { SidebarLazyBoundary } from "@/components/sidebar/SidebarLazyBoundary";
import type { KnowledgeLayerProps } from "./KnowledgeLayer";

const Layer = lazy(() => import("./KnowledgeLayer").then((m) => ({ default: m.KnowledgeLayer })));

/** Sole entry to the icon layer, hover card, sheet and `knowledge.*` strings: a note without knowledge never fetches that chunk. */
export function KnowledgeLayerLazy(props: KnowledgeLayerProps) {
  if (props.entries.length === 0 && props.controller.state === null) return null;
  return (
    <SidebarLazyBoundary chunk="knowledge" fallback={null} errorClassName="p-2">
      <Layer {...props} />
    </SidebarLazyBoundary>
  );
}
