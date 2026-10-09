import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { useLocation, useNavigate } from "react-router";
import { useQueryClient } from "@tanstack/react-query";
import "reveal.js/reveal.css";
import "./present.css";
import { useHistoryLocationKey, useRealLocation } from "@/lib/real-location";
import { useTheme } from "@/theme";
import { startDeck, type DeckController, type DeckEnv, type PresentationSource } from "./controller";
import { createHashWriter, type HashWriter } from "./hash-writer";
import { usePresentationShell } from "./PresentationShell";
import { PRESENT_SEARCH } from "./present-url";

/**
 * #229 簡報層（lazy chunk 的入口，spec §6）。React 薄殼：最新值寫進 ref、生命週期交給 controller.ts。
 * reveal.js、reveal.css、present.css、DOMPurify、presentationSchema 只經由本模組進來（§6.2、§11.1）。
 * router 的 search 還沒正規化成 `?present`（外殼在做）之前不啟動（§6.4-1）。
 */
export type PresentationOverlayProps = PresentationSource;

export default function PresentationOverlay(props: PresentationOverlayProps) {
  const { t } = useTranslation();
  const shell = usePresentationShell();
  const { resolvedTheme } = useTheme();
  const queryClient = useQueryClient();
  const location = useLocation();
  const realLocation = useRealLocation();
  const navigate = useNavigate();
  const readHistoryKey = useHistoryLocationKey();
  const hostRef = useRef<HTMLDivElement>(null);
  const controllerRef = useRef<DeckController | null>(null);

  const envRef = useRef<DeckEnv | null>(null);
  envRef.current = { source: props, shell, theme: resolvedTheme, t: (key) => t(key), queryClient, hash: location.hash };
  const routerRef = useRef({ location, realLocation, navigate, readHistoryKey });
  routerRef.current = { location, realLocation, navigate, readHistoryKey };

  const hashWriterRef = useRef<HashWriter | null>(null);
  if (hashWriterRef.current === null) {
    hashWriterRef.current = createHashWriter({
      latest: () => routerRef.current.location,
      currentKey: () => (routerRef.current.realLocation ?? routerRef.current.location).key,
      historyKey: () => routerRef.current.readHistoryKey(),
      navigate: (to, options) => void routerRef.current.navigate(to, options),
    });
  }

  useEffect(() => {
    hashWriterRef.current?.flush();
  }, [location]);

  const routerReady = location.search === PRESENT_SEARCH;
  useEffect(() => {
    const host = hostRef.current;
    const hashWriter = hashWriterRef.current;
    if (!routerReady || !host || !hashWriter) return;
    const controller = startDeck(host, () => envRef.current!, hashWriter);
    controllerRef.current = controller;
    return () => {
      controllerRef.current = null;
      controller.dispose();
    };
  }, [routerReady]);

  useEffect(() => {
    controllerRef.current?.sourceChanged();
  }, [props.doc, props.title]);

  useEffect(() => {
    controllerRef.current?.themeChanged();
  }, [resolvedTheme]);

  return <div ref={hostRef} className="kn-present absolute inset-0" />;
}
