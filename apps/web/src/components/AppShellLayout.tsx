import { useMemo, useState } from "react";
import { Outlet } from "react-router";
import { AppShell } from "@/components/AppShell";
import { BlockAnchorContext, NO_BLOCK_ANCHOR, type BlockAnchorApi } from "@/hooks/block-anchor-context";
import { AppShellInertContext } from "@/lib/app-shell-inert";
import { NotePageControlsContext, type NotePageControls } from "@/lib/note-page-controls";
import { NotePageBridgeContext, type NotePageBridge } from "@/lib/note-page-bridge";

/**
 * 首頁、筆記頁（含它的載入中與錯誤畫面）共用的外層：側欄殼只掛一份，換路由時不重掛，
 * 清單的捲動位置與選取模式因此保留。頁面只渲染主內容區（`<Outlet />`）。
 * 簡報模式的 inert、側欄需要的「目前那篇」控制與錨點 API 由頁面經 context 登記進來。
 */
export function AppShellLayout() {
  const [inert, setInert] = useState(false);
  const [controls, setControls] = useState<NotePageControls | null>(null);
  const [anchors, setAnchors] = useState<BlockAnchorApi | null>(null);
  const bridge = useMemo<NotePageBridge>(() => ({ setControls, setAnchors }), []);
  return (
    <AppShellInertContext.Provider value={setInert}>
      <NotePageBridgeContext.Provider value={bridge}>
        <NotePageControlsContext.Provider value={controls}>
          <BlockAnchorContext.Provider value={anchors ?? NO_BLOCK_ANCHOR}>
            <AppShell inert={inert}>
              <Outlet />
            </AppShell>
          </BlockAnchorContext.Provider>
        </NotePageControlsContext.Provider>
      </NotePageBridgeContext.Provider>
    </AppShellInertContext.Provider>
  );
}
