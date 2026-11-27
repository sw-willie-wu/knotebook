import {
  createContext,
  forwardRef,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentPropsWithoutRef,
  type ElementRef,
  type ReactNode,
} from "react";
import { DropdownMenu as DropdownMenuPrimitive } from "radix-ui";
import { Check, ChevronRight } from "./icons";
import { PANEL_PLACEMENT, PANEL_SURFACE } from "./panel-shell";
import { SheetViewportVars } from "./sheet-viewport";
import { isPhone, useIsPhone } from "@/lib/layout-tiers";
import { cn } from "@/lib/utils";

/** True inside phone sheet menu content (`phoneSheet` and viewport < 640); submenus then replace the whole sheet content (see `DropdownMenuMainLevel`). */
const MenuSheetContext = createContext(false);

export function useMenuSheet(): boolean {
  return useContext(MenuSheetContext);
}

/** `pointer-coarse:py-2` overrides the coarse `py-2.5` of the base row classes; the height comes from `min-h-12`. */
const SHEET_ROW = "min-h-12 py-2 pointer-coarse:py-2 text-base";

interface MenuRootValue {
  phoneSheet: boolean;
  openRef: { readonly current: boolean };
  setOpen: (open: boolean) => void;
}
const MenuRootContext = createContext<MenuRootValue | null>(null);

type MenuRootProps = ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Root> & {
  /** Phone (< 640): a bottom sheet (rises with `kb-sheet`, backdrop, lifted above the keyboard). Still the same Radix menu (roles, arrows, typeahead, Esc, outside close, focus return); only position, style and when the pointer opens it differ (see `DropdownMenuTrigger`). Crossing 640 while open closes the menu. */
  phoneSheet?: boolean;
};

/** Internally always controlled so the trigger can open it on click (sheet form). */
export function DropdownMenu({ open: openProp, defaultOpen, onOpenChange, phoneSheet = false, ...props }: MenuRootProps) {
  const [uncontrolledOpen, setUncontrolledOpen] = useState(defaultOpen ?? false);
  const controlled = openProp !== undefined;
  const open = controlled ? openProp : uncontrolledOpen;
  const openRef = useRef(open);
  openRef.current = open;
  const setOpen = useCallback(
    (next: boolean) => {
      openRef.current = next;
      if (!controlled) setUncontrolledOpen(next);
      onOpenChange?.(next);
    },
    [controlled, onOpenChange],
  );
  const value = useMemo<MenuRootValue>(() => ({ phoneSheet, openRef, setOpen }), [phoneSheet, setOpen]);
  return (
    <MenuRootContext.Provider value={value}>
      <DropdownMenuPrimitive.Root open={open} onOpenChange={setOpen} {...props} />
    </MenuRootContext.Provider>
  );
}

/**
 * Radix opens on pointerdown, but the phone sheet rises under the finger and the same press's pointerup/click would pick the item under it (e.g. move to trash). So in sheet form (`phoneSheet` and viewport narrower than 640, any pointer type) pointerdown's default open is blocked and the menu opens on click.
 * The click opens only if this button received that pointerdown (a click landing here after pressing the backdrop to close doesn't reopen); clicks without pointerdown (`detail` 0: assistive tech, programmatic) open. Keyboard opens via Radix's own keydown; the click Enter/Space then fires finds it open and does nothing.
 * The phone check is read at event time (`isPhone()`), not subscribed: every sidebar row has one.
 */
export const DropdownMenuTrigger = forwardRef<
  ElementRef<typeof DropdownMenuPrimitive.Trigger>,
  ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Trigger>
>(({ onPointerDown, onPointerUp, onPointerCancel, onLostPointerCapture, onClick, ...props }, ref) => {
  const root = useContext(MenuRootContext);
  const sheetNow = () => root !== null && root.phoneSheet && isPhone();
  // Progress of the press on this button: "down" = pressed, "up" = released on it; cleared on pointercancel (scroll took over) or lost capture before release.
  // Touch also fires lostpointercapture after pointerup, so only clear on it before release.
  const pressRef = useRef<"down" | "up" | null>(null);
  return (
    <DropdownMenuPrimitive.Trigger
      ref={ref}
      {...props}
      onPointerDown={(event) => {
        onPointerDown?.(event);
        if (event.defaultPrevented || props.disabled) return;
        // Once blocked, Radix's own pointerdown handling doesn't run (composeEventHandlers checks defaultPrevented).
        pressRef.current = null;
        if (event.button !== 0 || event.ctrlKey) return;
        if (!root?.openRef.current && sheetNow()) {
          event.preventDefault();
          pressRef.current = "down";
        }
      }}
      onPointerUp={(event) => {
        onPointerUp?.(event);
        if (pressRef.current === "down") pressRef.current = "up";
      }}
      onPointerCancel={(event) => {
        onPointerCancel?.(event);
        pressRef.current = null;
      }}
      onLostPointerCapture={(event) => {
        onLostPointerCapture?.(event);
        if (pressRef.current === "down") pressRef.current = null;
      }}
      onClick={(event) => {
        onClick?.(event);
        const pressed = pressRef.current !== null;
        pressRef.current = null;
        if (event.defaultPrevented || props.disabled) return;
        if (!pressed && event.detail !== 0) return;
        if (!root?.openRef.current && sheetNow()) root?.setOpen(true);
      }}
    />
  );
});
DropdownMenuTrigger.displayName = DropdownMenuPrimitive.Trigger.displayName;
export const DropdownMenuGroup = DropdownMenuPrimitive.Group;
export const DropdownMenuPortal = DropdownMenuPrimitive.Portal;
export const DropdownMenuSub = DropdownMenuPrimitive.Sub;
export const DropdownMenuRadioGroup = DropdownMenuPrimitive.RadioGroup;
export const DropdownMenuItemIndicator = DropdownMenuPrimitive.ItemIndicator;

export const DropdownMenuSubTrigger = forwardRef<
  ElementRef<typeof DropdownMenuPrimitive.SubTrigger>,
  ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.SubTrigger>
>(({ className, children, ...props }, ref) => {
  const sheet = useMenuSheet();
  return (
    <DropdownMenuPrimitive.SubTrigger
      ref={ref}
      className={cn(
        "flex cursor-default select-none items-center rounded-sm px-2 py-1.5 pointer-coarse:py-2.5 text-sm outline-none " +
          "focus:bg-accent data-[state=open]:bg-accent",
        className,
        sheet && SHEET_ROW,
      )}
      {...props}
    >
      {children}
      <ChevronRight aria-hidden="true" className="ml-auto h-4 w-4 shrink-0" />
    </DropdownMenuPrimitive.SubTrigger>
  );
});
DropdownMenuSubTrigger.displayName = DropdownMenuPrimitive.SubTrigger.displayName;

export const DropdownMenuSubContent = forwardRef<
  ElementRef<typeof DropdownMenuPrimitive.SubContent>,
  ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.SubContent>
>(({ className, collisionPadding = 8, ...props }, ref) => (
  // Must be a Portal: the parent `DropdownMenuContent` is `overflow-hidden`, so rendering inline would clip a submenu opening to the right;
  // after the Portal Radix flips it to the left on collision (collisionPadding keeps it off the edge in narrow windows / phone drawers).
  <DropdownMenuPrimitive.Portal>
    <DropdownMenuPrimitive.SubContent
      ref={ref}
      collisionPadding={collisionPadding}
      className={cn(PANEL_SURFACE, className)}
      {...props}
    />
  </DropdownMenuPrimitive.Portal>
));
DropdownMenuSubContent.displayName = DropdownMenuPrimitive.SubContent.displayName;

type MenuContentProps = ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Content> & {
  sheetTitle?: ReactNode;
};

export const MENU_CONTENT_BASE = PANEL_SURFACE;

const MENU_ITEM_BASE =
  "relative flex cursor-default select-none items-center rounded-sm px-2 py-1.5 pointer-coarse:py-2.5 text-sm outline-none " +
  "transition-colors focus:bg-accent focus:text-accent-foreground";

/** Positioning comes from `.kb-menu-sheet` in `index.css`: Radix wraps content in a positioning wrapper (inline transform next to the trigger); that rule makes it bottom/full-width and draws the backdrop in its `::before`. `mb-(--kb-inset)` lifts the content above the keyboard. Placed after the caller's className so the caller's small-menu size limits are overridden in the sheet. */
const SHEET_CONTENT =
  "kb-menu-sheet kb-sheet w-full min-w-0 max-w-none rounded-t-xl rounded-b-none border-x-0 border-b-0 shadow-lg " +
  "px-2 pt-2 pb-[max(0.5rem,env(safe-area-inset-bottom))] mb-(--kb-inset,0px) " +
  "max-h-[calc(var(--kb-visible-h,100dvh)*0.85)] overflow-y-auto";

/** Radix mounts this only while the menu is open (and exiting), so the phone matchMedia subscription exists only then: each sidebar row's ⋮ doesn't hold one. */
const MenuContent = forwardRef<ElementRef<typeof DropdownMenuPrimitive.Content>, MenuContentProps>(
  ({ className, sideOffset = PANEL_PLACEMENT.sideOffset, sheetTitle, children, ...props }, ref) => {
    const root = useContext(MenuRootContext);
    const phoneSheet = root?.phoneSheet ?? false;
    const phone = useIsPhone();
    const sheet = phoneSheet && phone;
    // Crossing 640 while open (rotation, resizing): sheet and small-menu layout and focus can't be swapped, so the whole menu closes (it reopens at the new width).
    const prevPhone = useRef(phone);
    useEffect(() => {
      if (prevPhone.current === phone) return;
      prevPhone.current = phone;
      if (phoneSheet) root?.setOpen(false);
    }, [phone, phoneSheet, root]);
    const contentRef = useRef<HTMLDivElement | null>(null);
    const setRefs = useCallback(
      (node: HTMLDivElement | null) => {
        contentRef.current = node;
        if (typeof ref === "function") ref(node);
        else if (ref) ref.current = node;
      },
      [ref],
    );
    const showTitle = sheet && sheetTitle !== undefined && sheetTitle !== null && sheetTitle !== "";
    return (
      <DropdownMenuPrimitive.Content
        ref={setRefs}
        sideOffset={sideOffset}
        data-menu-sheet={sheet ? "" : undefined}
        className={cn(MENU_CONTENT_BASE, className, sheet && SHEET_CONTENT)}
        {...props}
      >
        <MenuSheetContext.Provider value={sheet}>
          {sheet && <SheetViewportVars target={contentRef} />}
          {showTitle && (
            <>
              <DropdownMenuPrimitive.Label className="truncate px-2 pb-2 pt-1 text-sm font-medium text-muted-foreground">
                {sheetTitle}
              </DropdownMenuPrimitive.Label>
              <DropdownMenuSeparator />
            </>
          )}
          {children}
        </MenuSheetContext.Provider>
      </DropdownMenuPrimitive.Content>
    );
  },
);
MenuContent.displayName = "MenuContent";

export const DropdownMenuContent = forwardRef<ElementRef<typeof DropdownMenuPrimitive.Content>, MenuContentProps>((props, ref) => (
  <DropdownMenuPrimitive.Portal>
    <MenuContent ref={ref} {...props} />
  </DropdownMenuPrimitive.Portal>
));
DropdownMenuContent.displayName = DropdownMenuPrimitive.Content.displayName;

/** In a phone sheet submenus replace the whole content: while a submenu group is expanded (`drilled`) this isn't rendered. Conditional render, not hidden: display:none Radix items stay in the menu collection and typeahead would stop on invisible items. */
export function DropdownMenuMainLevel({ drilled, children }: { drilled: boolean; children: ReactNode }) {
  const sheet = useMenuSheet();
  return sheet && drilled ? null : <>{children}</>;
}

export const DropdownMenuItem = forwardRef<
  ElementRef<typeof DropdownMenuPrimitive.Item>,
  ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Item> & { inset?: boolean }
>(({ className, inset, ...props }, ref) => {
  const sheet = useMenuSheet();
  return (
    <DropdownMenuPrimitive.Item
      ref={ref}
      className={cn(
        MENU_ITEM_BASE + " data-[disabled]:pointer-events-none data-[disabled]:opacity-50",
        inset && "pl-8",
        className,
        sheet && SHEET_ROW,
      )}
      {...props}
    />
  );
});
DropdownMenuItem.displayName = DropdownMenuPrimitive.Item.displayName;

export const DropdownMenuCheckboxItem = forwardRef<
  ElementRef<typeof DropdownMenuPrimitive.CheckboxItem>,
  ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.CheckboxItem>
>(({ className, children, checked, ...props }, ref) => {
  const sheet = useMenuSheet();
  return (
    <DropdownMenuPrimitive.CheckboxItem
      ref={ref}
      className={cn(
        "relative flex cursor-default select-none items-center rounded-sm py-1.5 pl-8 pr-2 pointer-coarse:py-2.5 text-sm outline-none " +
          "transition-colors focus:bg-accent focus:text-accent-foreground " +
          "data-[disabled]:pointer-events-none data-[disabled]:opacity-50",
        className,
        sheet && SHEET_ROW,
      )}
      checked={checked}
      {...props}
    >
      <span className="absolute left-2 flex h-3.5 w-3.5 items-center justify-center">
        <DropdownMenuPrimitive.ItemIndicator>
          <Check className="h-4 w-4" />
        </DropdownMenuPrimitive.ItemIndicator>
      </span>
      {children}
    </DropdownMenuPrimitive.CheckboxItem>
  );
});
DropdownMenuCheckboxItem.displayName = DropdownMenuPrimitive.CheckboxItem.displayName;

/** Minimal wrapper over Radix RadioItem: keeps only the behaviour classes for `role="menuitemradio"`/`aria-checked`, deliberately not DropdownMenuItem's padding/flex/indicator defaults: the theme colour picker renders it as a 16px dot, styled entirely by the caller (`UserMenu.tsx`). `aria-checked` comes from the RadioGroup `value`. */
export const DropdownMenuRadioItem = forwardRef<
  ElementRef<typeof DropdownMenuPrimitive.RadioItem>,
  ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.RadioItem> & {
    /** Pass for ordinary rows (e.g. folder sort): in the phone sheet they become 48px/16px rows. Not for non-row things like colour dots. */
    sheetRow?: boolean;
  }
>(({ className, sheetRow = false, ...props }, ref) => {
  const sheet = useMenuSheet();
  return (
    <DropdownMenuPrimitive.RadioItem
      ref={ref}
      className={cn("cursor-default select-none outline-none", className, sheet && sheetRow && SHEET_ROW)}
      {...props}
    />
  );
});
DropdownMenuRadioItem.displayName = DropdownMenuPrimitive.RadioItem.displayName;

export const DropdownMenuLabel = forwardRef<
  ElementRef<typeof DropdownMenuPrimitive.Label>,
  ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Label> & { inset?: boolean }
>(({ className, inset, ...props }, ref) => (
  <DropdownMenuPrimitive.Label
    ref={ref}
    className={cn("px-2 py-1.5 text-sm font-semibold", inset && "pl-8", className)}
    {...props}
  />
));
DropdownMenuLabel.displayName = DropdownMenuPrimitive.Label.displayName;

export const DropdownMenuSeparator = forwardRef<
  ElementRef<typeof DropdownMenuPrimitive.Separator>,
  ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Separator>
>(({ className, ...props }, ref) => {
  // The sheet's side padding is 8px (small menu 4px): the separator still reaches both edges.
  const sheet = useMenuSheet();
  return <DropdownMenuPrimitive.Separator ref={ref} className={cn("-mx-1 my-1 h-px bg-border", sheet && "-mx-2", className)} {...props} />;
});
DropdownMenuSeparator.displayName = DropdownMenuPrimitive.Separator.displayName;
