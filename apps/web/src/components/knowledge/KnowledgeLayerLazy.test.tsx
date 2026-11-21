import { describe, expect, it, vi } from "vitest";
import { render, waitFor } from "@testing-library/react";
import type { KnowledgeController } from "./controller";
import { KnowledgeLayerLazy } from "./KnowledgeLayerLazy";
import { knowledgeEntries } from "./test-support";

const loaded = vi.hoisted(() => ({ count: 0 }));
vi.mock("./KnowledgeLayer", () => {
  loaded.count += 1;
  return { KnowledgeLayer: () => <div data-testid="layer" /> };
});

const closed: KnowledgeController = { state: null, open: () => {}, close: () => {} };
const open: KnowledgeController = { state: { blockId: "a", mode: "view", returnFocus: null }, open: () => {}, close: () => {} };
const base = { container: null, editable: false, noteId: "n1" };

describe("KnowledgeLayerLazy", () => {
  it("renders nothing and never loads the layer chunk while there are no entries and no panel is open", async () => {
    const view = render(<KnowledgeLayerLazy {...base} entries={[]} controller={closed} />);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(view.container).toBeEmptyDOMElement();
    expect(loaded.count).toBe(0);
  });

  it("loads the layer once there are entries", async () => {
    const entries = knowledgeEntries([{ id: "k_00000001", blockId: "a" }]);
    const view = render(<KnowledgeLayerLazy {...base} entries={entries} controller={closed} />);
    await waitFor(() => expect(view.queryByTestId("layer")).not.toBeNull());
    expect(loaded.count).toBe(1);
  });

  it("keeps the layer mounted while a panel is open even if the entries are gone", async () => {
    const view = render(<KnowledgeLayerLazy {...base} entries={[]} controller={open} />);
    await waitFor(() => expect(view.queryByTestId("layer")).not.toBeNull());
  });
});
