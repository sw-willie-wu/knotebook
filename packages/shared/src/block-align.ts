export interface AlignItem { type: string; key: string }
export interface AlignSource { id?: string; type: string; props?: object; content?: unknown; children?: readonly AlignSource[] }

export const ALIGN_MAX_CELLS = 1_000_000;

function sortedJson(value: unknown): string {
  return JSON.stringify(value ?? {}, (_k, v: unknown) => {
    if (v && typeof v === "object" && !Array.isArray(v)) {
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(v).sort()) out[k] = (v as Record<string, unknown>)[k];
      return out;
    }
    return v;
  });
}

export function alignInlineText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  let out = "";
  for (const node of content as Array<Record<string, unknown>>) {
    if (!node || typeof node !== "object") continue;
    if (node.type === "text") out += typeof node.text === "string" ? node.text : "";
    else if (node.type === "link") out += alignInlineText(node.content);
    else if (node.type === "wikilink") {
      const props = (node.props ?? node) as Record<string, unknown>;
      const label = typeof props.label === "string" ? props.label : "";
      out += label !== "" ? label : `[[${String(props.targetNoteId ?? "")}#${String(props.anchorBlockId ?? "")}]]`;
    }
  }
  return out;
}

function ownText(block: AlignSource): string {
  const content = block.content;
  if (content === undefined || content === null) return sortedJson(block.props);
  if (typeof content === "string") return content.trim();
  if (Array.isArray(content)) return alignInlineText(content).trim();
  const table = content as { type?: unknown; rows?: unknown };
  if (table.type === "tableContent" && Array.isArray(table.rows)) {
    const rows = (table.rows as Array<{ cells?: unknown[] }>).map((row) =>
      (row.cells ?? [])
        .map((cell) => alignInlineText(Array.isArray(cell) ? cell : (cell as { content?: unknown } | null)?.content))
        .join("\t"),
    );
    return rows.join("\n").trim();
  }
  return sortedJson(block.props);
}

export function alignItemOf(block: AlignSource): AlignItem {
  interface Frame { block: AlignSource; next: number; keys: string[] }
  const stack: Frame[] = [{ block, next: 0, keys: [] }];
  let result = "";
  while (stack.length > 0) {
    const top = stack[stack.length - 1]!;
    const children = top.block.children ?? [];
    if (top.next < children.length) {
      stack.push({ block: children[top.next++]!, next: 0, keys: [] });
      continue;
    }
    // Length-prefixed and self-delimiting, so child keys embed verbatim: JSON-escaping them at every level would double the key length per level of nesting.
    const text = ownText(top.block);
    const key = `${top.block.type.length}:${top.block.type}${text.length}:${text}${top.keys.length}:${top.keys.join("")}`;
    stack.pop();
    if (stack.length === 0) result = key;
    else stack[stack.length - 1]!.keys.push(key);
  }
  return { type: block.type, key: result };
}

export function alignBlocks(
  oldItems: readonly AlignItem[],
  newItems: readonly AlignItem[],
  opts?: { maxCells?: number },
): Array<[number, number]> {
  const maxCells = opts?.maxCells ?? ALIGN_MAX_CELLS;
  const on = oldItems.length;
  const nn = newItems.length;
  const pairs: Array<[number, number]> = [];

  let pre = 0;
  while (pre < on && pre < nn && oldItems[pre]!.key === newItems[pre]!.key) pre++;
  let suf = 0;
  while (suf < on - pre && suf < nn - pre && oldItems[on - 1 - suf]!.key === newItems[nn - 1 - suf]!.key) suf++;
  for (let k = 0; k < pre; k++) pairs.push([k, k]);

  const mo = on - pre - suf;
  const mn = nn - pre - suf;
  if (mo > 0 && mn > 0 && (mo + 1) * (mn + 1) <= maxCells) {
    const w = mn + 1;
    const L = new Uint32Array((mo + 1) * w);
    for (let i = mo - 1; i >= 0; i--) {
      for (let j = mn - 1; j >= 0; j--) {
        L[i * w + j] =
          oldItems[pre + i]!.key === newItems[pre + j]!.key
            ? L[(i + 1) * w + j + 1]! + 1
            : Math.max(L[(i + 1) * w + j]!, L[i * w + j + 1]!);
      }
    }
    let i = 0;
    let j = 0;
    while (i < mo && j < mn) {
      if (oldItems[pre + i]!.key === newItems[pre + j]!.key) {
        pairs.push([pre + i, pre + j]);
        i++;
        j++;
      } else if (L[(i + 1) * w + j]! >= L[i * w + j + 1]!) i++;
      else j++;
    }
  }
  for (let k = 0; k < suf; k++) pairs.push([on - suf + k, nn - suf + k]);

  // Prefix, middle and suffix pairs are already ascending in both coordinates.
  const withLone: Array<[number, number]> = [];
  let po = -1;
  let pn = -1;
  const addGap = (no: number, nnx: number) => {
    if (no - po === 2 && nnx - pn === 2 && oldItems[po + 1]!.type === newItems[pn + 1]!.type) {
      withLone.push([po + 1, pn + 1]);
    }
  };
  for (const pair of pairs) {
    addGap(pair[0], pair[1]);
    withLone.push(pair);
    po = pair[0];
    pn = pair[1];
  }
  addGap(on, nn);
  withLone.sort((a, b) => a[0] - b[0]);
  return withLone;
}

export function keptIdRenames(
  before: readonly (AlignSource & { id: string })[],
  inserted: readonly (AlignSource & { id: string })[],
  opts?: { maxCells?: number },
): Map<string, string> {
  const oldItems = before.map(alignItemOf);
  const newItems = inserted.map(alignItemOf);
  const renames = new Map<string, string>();
  for (const [o, n] of alignBlocks(oldItems, newItems, opts)) {
    const oldBlock = before[o]!;
    const newBlock = inserted[n]!;
    renames.set(newBlock.id, oldBlock.id);
    if (oldItems[o]!.key !== newItems[n]!.key) continue;
    // Equal keys mean equal subtree shape, so children line up by position.
    const stack: Array<[AlignSource, AlignSource]> = [[oldBlock, newBlock]];
    while (stack.length > 0) {
      const [a, b] = stack.pop()!;
      const ac = a.children ?? [];
      const bc = b.children ?? [];
      for (let k = 0; k < ac.length; k++) {
        const ca = ac[k]!;
        const cb = bc[k]!;
        if (ca.id !== undefined && cb.id !== undefined) renames.set(cb.id, ca.id);
        stack.push([ca, cb]);
      }
    }
  }
  return renames;
}
