import { createRef, forwardRef, useImperativeHandle, useState, type ReactNode } from "react";
import { createPortal, flushSync } from "react-dom";
import { render } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import type { BlockNoteEditor } from "@blocknote/core";

/**
 * **elementRenderer**（同 `components/wikilink/menu.test.tsx`、`collab/link-sync.test.tsx` 各自內嵌的那一份）：`editor.mount()`、
 * 非 headless、又沒有 `<BlockNoteView>` 的編輯器，wikilink（React inline content）的 `toDOM` 要靠 `editor.elementRenderer` 渲染，
 * 否則丟 `elementRenderer not available, expected headless editor`。照抄 BlockNote 未匯出的 `ElementRenderer.tsx` 形，包在
 * `QueryClientProvider`／`MemoryRouter` 底下（`WikilinkInline` 用 `useNotes`／`useNavigate`；`["notes"]` 塞空陣列＝「已解析未命中」態）。
 */
type ElementRendererHandle = (node: ReactNode, container: HTMLElement) => void;

const TestElementRenderer = forwardRef<ElementRendererHandle>((_props, ref) => {
  const [singleRenderData, setSingleRenderData] = useState<{ node: ReactNode; container: HTMLElement } | undefined>();
  useImperativeHandle(
    ref,
    () => (node: ReactNode, container: HTMLElement) => {
      flushSync(() => setSingleRenderData({ node, container }));
      setSingleRenderData(undefined);
    },
    [],
  );
  return singleRenderData ? createPortal(singleRenderData.node, singleRenderData.container) : null;
});
TestElementRenderer.displayName = "TestElementRenderer";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- BlockNote 編輯器泛型三元組，走 repo 慣例用 any
export function attachTestElementRenderer(editor: BlockNoteEditor<any, any, any>): void {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  queryClient.setQueryData(["notes"], []);
  const rendererRef = createRef<ElementRendererHandle>();
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <TestElementRenderer ref={rendererRef} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  editor.elementRenderer = rendererRef.current!;
}
