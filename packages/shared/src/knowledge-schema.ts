import * as Y from "yjs";

export const KNOWLEDGE_BLOCK_TYPE = "heading";

export const KNOWLEDGE_PROP_SCHEMA = {
  knowledgeId: { default: "" },
  knowledgeWhen: { default: "" },
  knowledgeConclusion: { default: "" },
  knowledgeEvidence: { default: "" },
  knowledgeVerified: { default: "" },
  knowledgeStatus: { default: "" },
  knowledgeSupersededBy: { default: "" },
} as const;

export type KnowledgePropName = keyof typeof KNOWLEDGE_PROP_SCHEMA;
export const KNOWLEDGE_PROP_NAMES = Object.keys(KNOWLEDGE_PROP_SCHEMA) as readonly KnowledgePropName[];
export const EMPTY_KNOWLEDGE_PROPS = Object.fromEntries(KNOWLEDGE_PROP_NAMES.map((n) => [n, ""])) as Readonly<Record<KnowledgePropName, "">>;

// `defaultBlockSpecs.heading` is a module-level shared object: mutating it would change every schema built from `defaultBlockSpecs`.
export function withKnowledgeProps<Spec extends { config: { propSchema: object } }>(
  spec: Spec,
): Spec & { config: Spec["config"] & { propSchema: Spec["config"]["propSchema"] & typeof KNOWLEDGE_PROP_SCHEMA } } {
  return { ...spec, config: { ...spec.config, propSchema: { ...spec.config.propSchema, ...KNOWLEDGE_PROP_SCHEMA } } } as never;
}

// `this` and `...rest` are forwarded unchanged so upstream signature changes still work.
// Resetting the props rather than stripping the output: BlockNote copies the block's non-default props onto the exported element as data-* attributes.
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- BlockNote generic triple; repo convention
export function withoutKnowledgeInExternalHTML<Spec extends { implementation: { toExternalHTML?: (this: any, block: any, ...rest: any[]) => unknown } }>(spec: Spec): Spec {
  const original = spec.implementation.toExternalHTML;
  if (!original) return spec;
  return {
    ...spec,
    implementation: {
      ...spec.implementation,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- same as above
      toExternalHTML(this: unknown, block: any, ...rest: any[]) {
        return original.call(this, { ...block, props: { ...block.props, ...EMPTY_KNOWLEDGE_PROPS } }, ...rest);
      },
    },
  } as Spec;
}

// hasOwn, not `in`: "constructor" and "toString" are on every object's prototype.
export function isIgnorableKnowledgeDefault(nodeName: string, attr: string, value: unknown): boolean {
  if (nodeName !== KNOWLEDGE_BLOCK_TYPE || !Object.hasOwn(KNOWLEDGE_PROP_SCHEMA, attr)) return false;
  return value === KNOWLEDGE_PROP_SCHEMA[attr as KnowledgePropName].default;
}

// Iterative: columns and lists nest, and a pathological note must not overflow the stack.
function visitHeadings(fragment: Y.XmlFragment, visit: (heading: Y.XmlElement) => boolean | void): void {
  const stack: Array<Y.XmlFragment | Y.XmlElement> = [fragment];
  while (stack.length > 0) {
    const node = stack.pop()!;
    for (const child of node.toArray()) {
      if (!(child instanceof Y.XmlElement)) continue;
      if (child.nodeName === KNOWLEDGE_BLOCK_TYPE && visit(child) === true) return;
      stack.push(child);
    }
  }
}

export function stripKnowledgeAttributes(fragment: Y.XmlFragment): number {
  let removed = 0;
  visitHeadings(fragment, (heading) => {
    for (const name of KNOWLEDGE_PROP_NAMES) {
      if (heading.getAttribute(name) !== undefined) {
        heading.removeAttribute(name);
        removed += 1;
      }
    }
  });
  return removed;
}

export function hasKnowledgeAttributes(fragment: Y.XmlFragment): boolean {
  let found = false;
  visitHeadings(fragment, (heading) => {
    if (KNOWLEDGE_PROP_NAMES.some((name) => heading.getAttribute(name) !== undefined)) {
      found = true;
      return true;
    }
  });
  return found;
}
