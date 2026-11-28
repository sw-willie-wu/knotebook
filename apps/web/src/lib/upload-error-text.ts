import { ApiFail } from "@/api/client";

/** Browsers often leave `file.type` empty for `.svg`, so the extension counts too (the server judges by content). */
export function isSvgFile(file: Pick<File, "name" | "type">): boolean {
  return file.type === "image/svg+xml" || /\.svg$/i.test(file.name);
}

/** An SVG refused as unsupported has a specific cause the generic message hides: a missing namespace or prefix declaration. */
export function uploadErrorKey(err: unknown, file: Pick<File, "name" | "type">): string | undefined {
  if (!(err instanceof ApiFail)) return undefined;
  if (err.code === "unsupported_media_type" && isSvgFile(file)) return "errors.svg_unusable";
  return `errors.${err.code}`;
}
