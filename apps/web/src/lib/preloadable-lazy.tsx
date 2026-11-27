import { lazy, useState, type ComponentType, type LazyExoticComponent } from "react";

/**
 * A plain `lazy()` suspends on its first render even when its module has already loaded, so its fallback is committed at least once.
 * A failed `preload()` is not reported: the first render rethrows it to the error boundary, as `lazy()` would.
 */
export function preloadableLazy<P extends object>(load: () => Promise<ComponentType<P>>) {
  let loaded: ComponentType<P> | null = null;
  let pending: Promise<ComponentType<P>> | null = null;
  const get = () =>
    (pending ??= load().then((component) => {
      loaded = component;
      return component;
    }));
  const Lazy = lazy(() => get().then((component) => ({ default: component })));
  function Preloadable(props: P) {
    // Chosen once per mount: changing from the lazy wrapper to the loaded component later would remount it and lose its state.
    const [Component] = useState<ComponentType<P> | LazyExoticComponent<ComponentType<P>>>(() => loaded ?? Lazy);
    return <Component {...props} />;
  }
  return Object.assign(Preloadable, {
    preload: () => {
      get().catch(() => {});
    },
  });
}
