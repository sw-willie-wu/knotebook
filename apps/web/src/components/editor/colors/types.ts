export type ColorSection = "text" | "background";
export type ColorTarget = { kind: "inline" } | { kind: "block"; blockId: string };

export interface PanelRequest {
  section: ColorSection;
  target: ColorTarget;
  current: string;
  byKeyboard: boolean;
  returnTo: string;
}

export const sectionProp = (s: ColorSection): "textColor" | "backgroundColor" => (s === "text" ? "textColor" : "backgroundColor");
