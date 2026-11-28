/**
 * Strict, single-pass XML 1.0 well-formedness validator for SVG uploads (#389).
 *
 * Intentionally avoids `jsdom` (which REST-only apps don't load and which is quadratic on large
 * element lists) and never expands custom entities (immune to Billion Laughs / XXE). It does not
 * strip `<script>`, event handlers or `<foreignObject>`: uploaded SVGs are neutralized at render
 * time by `<img>` and on direct navigation by `Content-Security-Policy: ...; sandbox`.
 */

const SVG_NAMESPACE = "http://www.w3.org/2000/svg";
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });
const PREDEFINED_ENTITIES = new Set(["amp", "lt", "gt", "quot", "apos"]);

// XML 1.0 §2.2 Char forbids C0 controls other than TAB/LF/CR, plus U+FFFE and U+FFFF.
const ILLEGAL_XML_CHAR_RE = /[\x00-\x08\x0B\x0C\x0E-\x1F\uFFFE\uFFFF]/;

// XML 1.0 (5th ed.) NameStartChar / NameChar.
const NAME_START_RE = /^[:A-Z_a-z\u00C0-\u00D6\u00D8-\u00F6\u00F8-\u02FF\u0370-\u037D\u037F-\u1FFF\u200C-\u200D\u2070-\u218F\u2C00-\u2FEF\u3001-\uD7FF\uF900-\uFDCF\uFDF0-\uFFFD]/u;
const NAME_CHAR_RE = /^[:A-Z_a-z\-.0-9\u00B7\u00C0-\u00D6\u00D8-\u00F6\u00F8-\u02FF\u0300-\u036F\u0370-\u037D\u037F-\u1FFF\u200C-\u200D\u203F-\u2040\u2070-\u218F\u2C00-\u2FEF\u3001-\uD7FF\uF900-\uFDCF\uFDF0-\uFFFD]/u;

function isXmlSpace(ch: number): boolean {
  return ch === 0x20 || ch === 0x09 || ch === 0x0a || ch === 0x0d;
}

function isValidXmlCodePoint(cp: number): boolean {
  return (
    cp === 0x09 ||
    cp === 0x0a ||
    cp === 0x0d ||
    (cp >= 0x20 && cp <= 0xd7ff) ||
    (cp >= 0xe000 && cp <= 0xfffd) ||
    (cp >= 0x10000 && cp <= 0x10ffff)
  );
}

export type SvgValidationResult = "valid" | "missing_xmlns" | "undeclared_prefix" | "invalid";

/** Filled with the offending prefix when `validateSvgXml` returns `"undeclared_prefix"`. */
export interface SvgValidationDetail {
  prefix?: string;
}

/** Validates UTF-8 XML 1.0 well-formedness and checks for a root `<svg>` element declaring the SVG namespace. An undeclared prefix fails too: browsers render such a file as a broken image. */
export function validateSvgXml(bytes: Uint8Array, detail?: SvgValidationDetail): SvgValidationResult {
  if (bytes.length === 0) return "invalid";

  let text: string;
  try {
    text = UTF8_DECODER.decode(bytes);
  } catch {
    return "invalid";
  }
  if (text.length === 0 || ILLEGAL_XML_CHAR_RE.test(text)) return "invalid";

  const len = text.length;
  let i = 0;

  // Fast reject for inputs that cannot possibly start with XML markup.
  const firstNonSpace = skipSpaceFrom(text, 0);
  if (firstNonSpace >= len || text.charCodeAt(firstNonSpace) !== 0x3c /* '<' */) return "invalid";

  const declaredEntities = new Set<string>();

  function skipSpace(): void {
    while (i < len && isXmlSpace(text.charCodeAt(i))) i++;
  }

  function readName(): string | null {
    if (i >= len) return null;
    const start = i;
    const first = text.codePointAt(i)!;
    // Fast ASCII path covers virtually all SVG element and attribute names.
    if (
      (first >= 0x41 && first <= 0x5a) ||
      (first >= 0x61 && first <= 0x7a) ||
      first === 0x5f ||
      first === 0x3a
    ) {
      i++;
    } else if (first >= 0x10000 && first <= 0xeffff) {
      i += 2;
    } else if (NAME_START_RE.test(text.slice(i, i + 2))) {
      i++;
    } else {
      return null;
    }

    while (i < len) {
      const ch = text.charCodeAt(i);
      if (
        (ch >= 0x41 && ch <= 0x5a) ||
        (ch >= 0x61 && ch <= 0x7a) ||
        (ch >= 0x30 && ch <= 0x39) ||
        ch === 0x5f ||
        ch === 0x2d ||
        ch === 0x2e ||
        ch === 0x3a
      ) {
        i++;
      } else if (ch < 0x80) {
        break;
      } else {
        const cp = text.codePointAt(i)!;
        if (cp >= 0x10000 && cp <= 0xeffff) {
          i += 2;
        } else if (NAME_CHAR_RE.test(text.slice(i, i + 2))) {
          i++;
        } else {
          break;
        }
      }
    }
    return text.slice(start, i);
  }

  function parseComment(): boolean {
    // Caller verified `<!--` at `i`.
    i += 4;
    const end = text.indexOf("--", i);
    if (end === -1 || end + 2 >= len || text.charCodeAt(end + 2) !== 0x3e /* '>' */) return false;
    i = end + 3;
    return true;
  }

  function parsePI(allowXmlDecl: boolean): boolean {
    // Caller verified `<?` at `i`.
    i += 2;
    const target = readName();
    if (target === null) return false;
    const isXmlTarget = target.toLowerCase() === "xml";
    if (isXmlTarget) {
      if (!allowXmlDecl || target !== "xml") return false;
    }
    if (i + 1 < len && text.charCodeAt(i) === 0x3f /* '?' */ && text.charCodeAt(i + 1) === 0x3e /* '>' */) {
      if (isXmlTarget) return false; // `<?xml?>` without version is not a valid XMLDecl
      i += 2;
      return true;
    }
    if (i >= len || !isXmlSpace(text.charCodeAt(i))) return false;
    const end = text.indexOf("?>", i);
    if (end === -1) return false;
    if (isXmlTarget) {
      const body = text.slice(i, end).trim();
      if (!/^version\s*=\s*(?:"1\.[0-9]+"|'1\.[0-9]+')(?:\s+encoding\s*=\s*(?:"[A-Za-z][A-Za-z0-9._-]*"|'[A-Za-z][A-Za-z0-9._-]*'))?(?:\s+standalone\s*=\s*(?:"(?:yes|no)"|'(?:yes|no)'))?$/.test(body)) {
        return false;
      }
    }
    i = end + 2;
    return true;
  }

  function parseReference(): boolean {
    // Caller verified `&` at `i`.
    i++;
    if (i >= len) return false;
    if (text.charCodeAt(i) === 0x23 /* '#' */) {
      i++;
      const hex = i < len && text.charCodeAt(i) === 0x78 /* 'x' */;
      if (hex) i++;
      const start = i;
      while (i < len && text.charCodeAt(i) !== 0x3b /* ';' */) i++;
      if (i >= len || i === start) return false;
      const digits = text.slice(start, i);
      if (hex ? !/^[0-9A-Fa-f]+$/.test(digits) : !/^[0-9]+$/.test(digits)) return false;
      const cp = Number.parseInt(digits, hex ? 16 : 10);
      if (!isValidXmlCodePoint(cp)) return false;
      i++; // ';'
      return true;
    }
    const name = readName();
    if (name === null || i >= len || text.charCodeAt(i) !== 0x3b /* ';' */) return false;
    if (!PREDEFINED_ENTITIES.has(name) && !declaredEntities.has(name)) return false;
    i++; // ';'
    return true;
  }

  function parseQuotedLiteral(): boolean {
    if (i >= len) return false;
    const quote = text.charCodeAt(i);
    if (quote !== 0x22 /* '"' */ && quote !== 0x27 /* "'" */) return false;
    const end = text.indexOf(String.fromCharCode(quote), i + 1);
    if (end === -1) return false;
    i = end + 1;
    return true;
  }

  function parseDoctype(): boolean {
    // Caller verified `<!DOCTYPE` at `i`.
    i += 9;
    if (i >= len || !isXmlSpace(text.charCodeAt(i))) return false;
    skipSpace();
    if (readName() === null) return false;
    skipSpace();
    if (text.startsWith("SYSTEM", i)) {
      i += 6;
      if (i >= len || !isXmlSpace(text.charCodeAt(i))) return false;
      skipSpace();
      if (!parseQuotedLiteral()) return false;
      skipSpace();
    } else if (text.startsWith("PUBLIC", i)) {
      i += 6;
      if (i >= len || !isXmlSpace(text.charCodeAt(i))) return false;
      skipSpace();
      if (!parseQuotedLiteral()) return false;
      if (i >= len || !isXmlSpace(text.charCodeAt(i))) return false;
      skipSpace();
      if (!parseQuotedLiteral()) return false;
      skipSpace();
    }

    if (i < len && text.charCodeAt(i) === 0x5b /* '[' */) {
      i++;
      while (i < len) {
        skipSpace();
        if (i >= len) return false;
        const ch = text.charCodeAt(i);
        if (ch === 0x5d /* ']' */) {
          i++;
          skipSpace();
          break;
        }
        if (text.startsWith("<!--", i)) {
          if (!parseComment()) return false;
        } else if (text.startsWith("<?", i)) {
          if (!parsePI(false)) return false;
        } else if (text.startsWith("<!", i)) {
          // Record `<!ENTITY name ...>` names so references inside the document validate without expanding them.
          const isEntity = text.startsWith("<!ENTITY", i) && i + 8 < len && isXmlSpace(text.charCodeAt(i + 8));
          i += 2;
          if (isEntity) {
            i += 6;
            skipSpace();
            if (i < len && text.charCodeAt(i) !== 0x25 /* '%' */) {
              const entityName = readName();
              if (entityName !== null) declaredEntities.add(entityName);
            }
          }
          let closed = false;
          while (i < len) {
            const c = text.charCodeAt(i);
            if (c === 0x22 || c === 0x27) {
              if (!parseQuotedLiteral()) return false;
            } else if (c === 0x3e /* '>' */) {
              i++;
              closed = true;
              break;
            } else {
              i++;
            }
          }
          if (!closed) return false;
        } else if (ch === 0x25 /* '%' */) {
          i++;
          if (readName() === null || i >= len || text.charCodeAt(i) !== 0x3b) return false;
          i++;
        } else {
          return false;
        }
      }
    }

    if (i >= len || text.charCodeAt(i) !== 0x3e /* '>' */) return false;
    i++;
    return true;
  }

  function parseAttributeValue(): string | null {
    if (i >= len) return null;
    const quote = text.charCodeAt(i);
    if (quote !== 0x22 /* '"' */ && quote !== 0x27 /* "'" */) return null;
    i++;
    const valueStart = i;
    while (i < len) {
      const ch = text.charCodeAt(i);
      if (ch === quote) {
        const value = text.slice(valueStart, i);
        i++;
        return value;
      }
      if (ch === 0x3c /* '<' */) return null;
      if (ch === 0x26 /* '&' */) {
        if (!parseReference()) return null;
        continue;
      }
      i++;
    }
    return null;
  }

  function parseStartTag(): { tagName: string; attrs: Map<string, string>; selfClosing: boolean } | null {
    // Caller verified `<` at `i`.
    i++;
    const tagName = readName();
    if (tagName === null) return null;

    const attrs = new Map<string, string>();
    let selfClosing = false;
    while (true) {
      const beforeSpace = i;
      skipSpace();
      if (i >= len) return null;
      const ch = text.charCodeAt(i);
      if (ch === 0x3e /* '>' */) {
        i++;
        break;
      }
      if (ch === 0x2f /* '/' */) {
        if (i + 1 >= len || text.charCodeAt(i + 1) !== 0x3e /* '>' */) return null;
        i += 2;
        selfClosing = true;
        break;
      }
      if (i === beforeSpace) return null; // whitespace required between tag and attributes
      const attrName = readName();
      if (attrName === null) return null;
      if (attrs.has(attrName)) return null;
      skipSpace();
      if (i >= len || text.charCodeAt(i) !== 0x3d /* '=' */) return null;
      i++;
      skipSpace();
      const attrValue = parseAttributeValue();
      if (attrValue === null) return null;
      attrs.set(attrName, attrValue);
    }
    return { tagName, attrs, selfClosing };
  }

  // Count of open elements that declare each prefix; a prefix is bound while its count is above zero.
  const boundPrefixes = new Map<string, number>();

  function declarePrefixes(attrs: ReadonlyMap<string, string>): string[] | null {
    const declared: string[] = [];
    for (const [name, value] of attrs) {
      if (!name.startsWith("xmlns:")) continue;
      const prefix = name.slice(6);
      if (prefix === "" || prefix === "xmlns" || prefix.includes(":") || value === "") return null;
      declared.push(prefix);
      boundPrefixes.set(prefix, (boundPrefixes.get(prefix) ?? 0) + 1);
    }
    return declared;
  }

  function releasePrefixes(declared: readonly string[]): void {
    for (const prefix of declared) boundPrefixes.set(prefix, boundPrefixes.get(prefix)! - 1);
  }

  // Returns the first prefix that is not bound, "" for a malformed QName, or null when every prefix is bound.
  function findUnboundPrefix(tagName: string, attrs: ReadonlyMap<string, string>): string | null {
    const names = [tagName];
    for (const name of attrs.keys()) {
      if (name !== "xmlns" && !name.startsWith("xmlns:")) names.push(name);
    }
    for (const name of names) {
      const colon = name.indexOf(":");
      if (colon === -1) continue;
      if (colon === 0 || colon === name.length - 1 || name.indexOf(":", colon + 1) !== -1) return "";
      const prefix = name.slice(0, colon);
      if (prefix === "xmlns") return "";
      if (prefix !== "xml" && !(boundPrefixes.get(prefix)! > 0)) return prefix;
    }
    return null;
  }

  function openElement(tag: { tagName: string; attrs: ReadonlyMap<string, string>; selfClosing: boolean }): "ok" | "invalid" | "undeclared_prefix" {
    const declared = declarePrefixes(tag.attrs);
    if (declared === null) return "invalid";
    const unbound = findUnboundPrefix(tag.tagName, tag.attrs);
    if (unbound === "") return "invalid";
    // The missing root namespace is the more useful thing to report, so it wins over an unbound prefix.
    if (unbound !== null && rootStatus !== "missing_xmlns") {
      if (detail) detail.prefix = unbound;
      return "undeclared_prefix";
    }
    if (tag.selfClosing) releasePrefixes(declared);
    else frames.push(declared);
    return "ok";
  }

  const frames: string[][] = [];

  if (text.startsWith("<?xml", 0)) {
    if (!parsePI(true)) return "invalid";
  }

  let sawDoctype = false;
  while (i < len) {
    skipSpace();
    if (i >= len) return "invalid";
    if (text.charCodeAt(i) !== 0x3c /* '<' */) return "invalid";
    if (text.startsWith("<!--", i)) {
      if (!parseComment()) return "invalid";
    } else if (text.startsWith("<?", i)) {
      if (!parsePI(false)) return "invalid";
    } else if (text.startsWith("<!DOCTYPE", i)) {
      if (sawDoctype || !parseDoctype()) return "invalid";
      sawDoctype = true;
    } else {
      break;
    }
  }

  const stack: string[] = [];
  let rootStatus: SvgValidationResult | null = null;

  while (i < len) {
    if (rootStatus === null) {
      if (text.charCodeAt(i) !== 0x3c /* '<' */) return "invalid";
      const root = parseStartTag();
      if (root === null) return "invalid";
      rootStatus = classifySvgRootElement(root.tagName, root.attrs);
      if (rootStatus === "invalid") return "invalid";
      const rootOpen = openElement(root);
      if (rootOpen !== "ok") return rootOpen;
      if (!root.selfClosing) stack.push(root.tagName);
      if (stack.length === 0) break;
      continue;
    }

    const ch = text.charCodeAt(i);
    if (ch === 0x3c /* '<' */) {
      if (text.startsWith("</", i)) {
        i += 2;
        const endName = readName();
        if (endName === null) return "invalid";
        skipSpace();
        if (i >= len || text.charCodeAt(i) !== 0x3e /* '>' */) return "invalid";
        i++;
        if (stack.length === 0 || stack.pop() !== endName) return "invalid";
        releasePrefixes(frames.pop()!);
        if (stack.length === 0) break;
      } else if (text.startsWith("<!--", i)) {
        if (!parseComment()) return "invalid";
      } else if (text.startsWith("<![CDATA[", i)) {
        i += 9;
        const end = text.indexOf("]]>", i);
        if (end === -1) return "invalid";
        i = end + 3;
      } else if (text.startsWith("<?", i)) {
        if (!parsePI(false)) return "invalid";
      } else {
        const child = parseStartTag();
        if (child === null) return "invalid";
        const childOpen = openElement(child);
        if (childOpen !== "ok") return childOpen;
        if (!child.selfClosing) stack.push(child.tagName);
      }
    } else if (ch === 0x26 /* '&' */) {
      if (!parseReference()) return "invalid";
    } else if (ch === 0x5d /* ']' */ && text.startsWith("]]>", i)) {
      return "invalid";
    } else {
      i++;
    }
  }

  if (rootStatus === null || stack.length !== 0) return "invalid";

  while (i < len) {
    skipSpace();
    if (i >= len) break;
    if (text.startsWith("<!--", i)) {
      if (!parseComment()) return "invalid";
    } else if (text.startsWith("<?", i)) {
      if (!parsePI(false)) return "invalid";
    } else {
      return "invalid";
    }
  }

  return rootStatus;
}

function skipSpaceFrom(text: string, start: number): number {
  let pos = start;
  while (pos < text.length && isXmlSpace(text.charCodeAt(pos))) pos++;
  return pos;
}

function classifySvgRootElement(tagName: string, attrs: ReadonlyMap<string, string>): SvgValidationResult {
  const colon = tagName.indexOf(":");
  if (colon === -1) {
    if (tagName !== "svg") return "invalid";
    // Standalone `image/svg+xml` renders as a broken image without the SVG namespace;
    // DTD entity references (e.g. legacy Illustrator `xmlns="&ns_svg;"`) are not expanded and fail here too.
    if (attrs.get("xmlns") === SVG_NAMESPACE) return "valid";
    return attrs.has("xmlns") ? "invalid" : "missing_xmlns";
  }
  // Reject multiple colons or empty prefix/local name.
  if (colon === 0 || tagName.indexOf(":", colon + 1) !== -1) return "invalid";
  const prefix = tagName.slice(0, colon);
  const local = tagName.slice(colon + 1);
  if (local !== "svg") return "invalid";
  const nsAttr = `xmlns:${prefix}`;
  if (attrs.get(nsAttr) === SVG_NAMESPACE) return "valid";
  return attrs.has(nsAttr) ? "invalid" : "missing_xmlns";
}
