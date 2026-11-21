import type { SVGProps } from "react";
import type { NoteWidth } from "@knotebook/shared";

// Icons used only by lazily loaded UI; kept apart from icons.tsx so first-bundle icons don't pull these in.

/** Adapted from lucide `rotate-ccw` (ISC). */
export function RotateCcw(props: SVGProps<SVGSVGElement>) {
  return (
    <svg data-icon="restore" aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
      <path d="M3 3v5h5" />
    </svg>
  );
}

/** Adapted from lucide `star-off` (ISC). */
export function StarOff(props: SVGProps<SVGSVGElement>) {
  return (
    <svg data-icon="star-off" aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d="M8.34 8.34 2 9.27l5 4.87L5.82 21 12 17.77 18.18 21l-.59-3.43" />
      <path d="M18.42 12.76 22 9.27l-6.91-1L12 2l-1.44 2.91" />
      <path d="m2 2 20 20" />
    </svg>
  );
}

export function Lock(props: SVGProps<SVGSVGElement>) {
  return (
    <svg data-icon="lock" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" {...props}>
      <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
      <path d="M7 11V7a5 5 0 0 1 10 0v4" />
    </svg>
  );
}

export function Globe(props: SVGProps<SVGSVGElement>) {
  return (
    <svg data-icon="globe" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" {...props}>
      <circle cx="12" cy="12" r="10" />
      <line x1="2" y1="12" x2="22" y2="12" />
      <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
    </svg>
  );
}

export function Diagram(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" {...props}>
      <rect x="9" y="2" width="6" height="5" rx="1" />
      <rect x="2" y="17" width="6" height="5" rx="1" />
      <rect x="16" y="17" width="6" height="5" rx="1" />
      <path d="M12 7v4" />
      <path d="M12 11H5v6" />
      <path d="M12 11h7v6" />
    </svg>
  );
}

/** Adapted from lucide `maximize` (ISC). */
export function Maximize(props: SVGProps<SVGSVGElement>) {
  return (
    <svg data-icon="maximize" aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d="M8 3H5a2 2 0 0 0-2 2v3" />
      <path d="M21 8V5a2 2 0 0 0-2-2h-3" />
      <path d="M3 16v3a2 2 0 0 0 2 2h3" />
      <path d="M16 21h3a2 2 0 0 0 2-2v-3" />
    </svg>
  );
}

/** Adapted from lucide `zoom-in` (ISC). */
export function ZoomIn(props: SVGProps<SVGSVGElement>) {
  return (
    <svg data-icon="zoom-in" aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" {...props}>
      <circle cx="11" cy="11" r="8" />
      <line x1="21" x2="16.65" y1="21" y2="16.65" />
      <line x1="11" x2="11" y1="8" y2="14" />
      <line x1="8" x2="14" y1="11" y2="11" />
    </svg>
  );
}

/** Adapted from lucide `minimize` (ISC). */
export function Minimize(props: SVGProps<SVGSVGElement>) {
  return (
    <svg data-icon="minimize" aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d="M8 3v3a2 2 0 0 1-2 2H3" />
      <path d="M21 8h-3a2 2 0 0 1-2-2V3" />
      <path d="M3 16h3a2 2 0 0 1 2 2v3" />
      <path d="M16 21v-3a2 2 0 0 1 2-2h3" />
    </svg>
  );
}

export function Columns2(props: SVGProps<SVGSVGElement>) {
  return (
    <svg data-icon="columns-2" aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" {...props}>
      <rect width="18" height="18" x="3" y="3" rx="2" />
      <path d="M12 3v18" />
    </svg>
  );
}

export function Rows3(props: SVGProps<SVGSVGElement>) {
  return (
    <svg data-icon="rows-3" aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" {...props}>
      <rect width="18" height="18" x="3" y="3" rx="2" />
      <path d="M21 9H3" />
      <path d="M21 15H3" />
    </svg>
  );
}

export function ListFilter(props: SVGProps<SVGSVGElement>) {
  return (
    <svg data-icon="list-filter" aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d="M3 6h18" />
      <path d="M7 12h10" />
      <path d="M10 18h4" />
    </svg>
  );
}

export function Plug(props: SVGProps<SVGSVGElement>) {
  return (
    <svg data-icon="plug" aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d="M12 22v-5" />
      <path d="M9 8V2" />
      <path d="M15 8V2" />
      <path d="M18 8v5a4 4 0 0 1-4 4h-4a4 4 0 0 1-4-4V8Z" />
    </svg>
  );
}

/** Adapted from lucide `key-round` (ISC). */
export function KeyRound(props: SVGProps<SVGSVGElement>) {
  return (
    <svg data-icon="key-round" aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d="M2.586 17.414A2 2 0 0 0 2 18.828V21a1 1 0 0 0 1 1h3a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h1a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h.172a2 2 0 0 0 1.414-.586l.814-.814a6.5 6.5 0 1 0-4-4z" />
      <circle cx="16.5" cy="7.5" r=".5" fill="currentColor" />
    </svg>
  );
}

/** Named to avoid the DOM global `Image`. */
export function ImageIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg data-icon="image" aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" {...props}>
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <circle cx="9" cy="9" r="2" />
      <path d="m21 15-3.1-3.1a2 2 0 0 0-2.8 0L6 21" />
    </svg>
  );
}

/** Adapted from lucide `send` (ISC). */
export function Send(props: SVGProps<SVGSVGElement>) {
  return (
    <svg data-icon="send" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d="M14.536 21.686a.5.5 0 0 0 .937-.024l6.5-19a.496.496 0 0 0-.635-.635l-19 6.5a.5.5 0 0 0-.024.937l7.93 3.18a2 2 0 0 1 1.112 1.11z" />
      <path d="m21.854 2.147-10.94 10.939" />
    </svg>
  );
}

/** Adapted from lucide `pen-line` (ISC). */
export function PenLine(props: SVGProps<SVGSVGElement>) {
  return (
    <svg data-icon="pen-line" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d="M12 20h9" />
      <path d="M16.376 3.622a1 1 0 0 1 3.002 3.002L7.368 18.635a2 2 0 0 1-.855.506l-2.872.838a.5.5 0 0 1-.62-.62l.838-2.872a2 2 0 0 1 .506-.854z" />
    </svg>
  );
}

/** Adapted from lucide `languages` (ISC). */
export function Languages(props: SVGProps<SVGSVGElement>) {
  return (
    <svg data-icon="languages" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d="m5 8 6 6" />
      <path d="m4 14 6-6 2-3" />
      <path d="M2 5h12" />
      <path d="M7 2h1" />
      <path d="m22 22-5-10-5 10" />
      <path d="M14 18h6" />
    </svg>
  );
}

/** Adapted from lucide `list-collapse` (ISC). */
export function ListCollapse(props: SVGProps<SVGSVGElement>) {
  return (
    <svg data-icon="list-collapse" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d="m3 10 2.5-2.5L3 5" />
      <path d="m3 19 2.5-2.5L3 14" />
      <path d="M10 6h11" />
      <path d="M10 12h11" />
      <path d="M10 18h11" />
    </svg>
  );
}

/** Adapted from lucide `chevrons-right` (ISC). */
export function ChevronsRight(props: SVGProps<SVGSVGElement>) {
  return (
    <svg data-icon="chevrons-right" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d="m6 17 5-5-5-5" />
      <path d="m13 17 5-5-5-5" />
    </svg>
  );
}

/** Adapted from lucide `arrow-up` (ISC). */
export function ArrowUp(props: SVGProps<SVGSVGElement>) {
  return (
    <svg data-icon="arrow-up" aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d="m5 12 7-7 7 7" />
      <path d="M12 19V5" />
    </svg>
  );
}

/** Adapted from lucide `arrow-down` (ISC). */
export function ArrowDown(props: SVGProps<SVGSVGElement>) {
  return (
    <svg data-icon="arrow-down" aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d="M12 5v14" />
      <path d="m19 12-7 7-7-7" />
    </svg>
  );
}

const NOTE_WIDTH_PATH: Record<NoteWidth, string> = {
  standard: "M6 8v8M18 8v8M6 12h12",
  wide: "M3 8v8M21 8v8M10 8l-4 4 4 4M6 12h12M14 8l4 4-4 4",
  full: "M7 8l-4 4 4 4M3 12h18M17 8l4 4-4 4",
};

export function NoteWidthIcon({ width, ...props }: { width: NoteWidth } & SVGProps<SVGSVGElement>) {
  return (
    <svg data-icon={`note-width-${width}`} aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d={NOTE_WIDTH_PATH[width]} />
    </svg>
  );
}

/** Adapted from lucide `rotate-cw` (ISC). */
export function RotateCw(props: SVGProps<SVGSVGElement>) {
  return (
    <svg data-icon="redo" aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8" />
      <path d="M21 3v5h-5" />
    </svg>
  );
}

/** Adapted from lucide `pilcrow` (ISC). */
export function Pilcrow(props: SVGProps<SVGSVGElement>) {
  return (
    <svg data-icon="pilcrow" aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d="M13 4v16" />
      <path d="M17 4v16" />
      <path d="M19 4H9.5a4.5 4.5 0 0 0 0 9H13" />
    </svg>
  );
}

export function KeyboardDown(props: SVGProps<SVGSVGElement>) {
  return (
    <svg data-icon="keyboard-down" aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" {...props}>
      <rect x="2" y="3" width="20" height="12" rx="2" />
      <path d="M7 8h.01M12 8h.01M17 8h.01M8 11.5h8" />
      <path d="m9 18 3 3 3-3" />
    </svg>
  );
}

const STROKE = { fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round", strokeLinejoin: "round" } as const;

/** Adapted from lucide `code` (ISC). */
export function CodeIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg data-icon="code" aria-hidden="true" viewBox="0 0 24 24" {...STROKE} {...props}>
      <path d="m16 18 6-6-6-6" />
      <path d="m8 6-6 6 6 6" />
    </svg>
  );
}

/** Adapted from lucide `align-left`/`align-center`/`align-right` (ISC). */
export function AlignIcon({ align, ...props }: { align: "left" | "center" | "right" } & SVGProps<SVGSVGElement>) {
  const lines = {
    left: ["M21 6H3", "M15 12H3", "M17 18H3"],
    center: ["M21 6H3", "M17 12H7", "M19 18H5"],
    right: ["M21 6H3", "M21 12H9", "M21 18H7"],
  }[align];
  return (
    <svg data-icon={`align-${align}`} aria-hidden="true" viewBox="0 0 24 24" {...STROKE} {...props}>
      {lines.map((d) => (
        <path key={d} d={d} />
      ))}
    </svg>
  );
}

/** Adapted from lucide `indent-increase`/`indent-decrease` (ISC). */
export function IndentIcon({ direction, ...props }: { direction: "in" | "out" } & SVGProps<SVGSVGElement>) {
  return (
    <svg data-icon={direction === "in" ? "indent" : "outdent"} aria-hidden="true" viewBox="0 0 24 24" {...STROKE} {...props}>
      <path d="M21 12H11" />
      <path d="M21 6H11" />
      <path d="M21 18H11" />
      <path d={direction === "in" ? "m3 8 4 4-4 4" : "m7 8-4 4 4 4"} />
    </svg>
  );
}

/** Adapted from lucide `circle-check`, `info`, `circle-alert` and `ban` (ISC); the knowledge status glyphs. */
export function CircleCheck(props: SVGProps<SVGSVGElement>) {
  return (
    <svg data-icon="circle-check" aria-hidden="true" viewBox="0 0 24 24" {...STROKE} {...props}>
      <circle cx="12" cy="12" r="10" />
      <path d="m9 12 2 2 4-4" />
    </svg>
  );
}

export function CircleInfo(props: SVGProps<SVGSVGElement>) {
  return (
    <svg data-icon="circle-info" aria-hidden="true" viewBox="0 0 24 24" {...STROKE} {...props}>
      <circle cx="12" cy="12" r="10" />
      <path d="M12 16v-4" />
      <path d="M12 8h.01" />
    </svg>
  );
}

export function CircleAlert(props: SVGProps<SVGSVGElement>) {
  return (
    <svg data-icon="circle-alert" aria-hidden="true" viewBox="0 0 24 24" {...STROKE} {...props}>
      <circle cx="12" cy="12" r="10" />
      <path d="M12 8v4" />
      <path d="M12 16h.01" />
    </svg>
  );
}

export function CircleSlash(props: SVGProps<SVGSVGElement>) {
  return (
    <svg data-icon="circle-slash" aria-hidden="true" viewBox="0 0 24 24" {...STROKE} {...props}>
      <circle cx="12" cy="12" r="10" />
      <path d="m4.9 4.9 14.2 14.2" />
    </svg>
  );
}
