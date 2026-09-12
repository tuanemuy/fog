"use client";

import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";

/** How long a toast stays: long enough to read one sentence, then gone. */
export const TOAST_DURATION_MS = 4_000;

// More than this at once is a burst nobody reads; the oldest go first.
const MAX_VISIBLE = 3;

type ToastEntry = Readonly<{ id: number; message: string }>;

type ShowToast = (message: string) => void;

const ShowToastContext = createContext<ShowToast | null>(null);
const ToastListContext = createContext<readonly ToastEntry[] | null>(null);

const TOAST_CLASS =
  "max-w-full rounded-full bg-neutral-900 px-lg py-md text-center font-base text-sm font-medium leading-tight text-text-inverse shadow-md wrap-anywhere";

export type ToastProps = Readonly<{ message: string }>;

/**
 * One toast (`spec/design/pages/settings.html`, `.toast`): a dark pill with
 * one sentence and nothing else. It holds no control — it leaves on its own
 * after a few seconds, and anything that has to be acted on stays on the
 * screen instead. Drawn by `ToastRegion`; a screen
 * raises one through `useToast`, never by drawing this.
 */
export function Toast({ message }: ToastProps) {
  return <p className={TOAST_CLASS}>{message}</p>;
}

/**
 * Holds the frame's toasts. The frame (`AppShell` / `AuthSheet`) wraps its
 * content in this and places one `ToastRegion` where toasts belong on it, so
 * a toast outlives the screen that raised it — the list lives here, not in
 * the component that called `useToast`, and its timer keeps running after
 * that component unmounts.
 */
export function ToastProvider({ children }: Readonly<{ children: ReactNode }>) {
  const [toasts, setToasts] = useState<readonly ToastEntry[]>([]);
  const nextId = useRef(0);
  const timers = useRef(new Set<ReturnType<typeof setTimeout>>());

  useEffect(() => {
    const pending = timers.current;
    return () => {
      for (const timer of pending) clearTimeout(timer);
      pending.clear();
    };
  }, []);

  // The same sentence again replaces the one on screen rather than stacking
  // a copy: the new entry is a new node, so the region announces it again,
  // and its timer starts over.
  const show = useCallback<ShowToast>((message) => {
    nextId.current += 1;
    const id = nextId.current;
    setToasts((current) =>
      [
        ...current.filter((toast) => toast.message !== message),
        { id, message },
      ].slice(-MAX_VISIBLE),
    );
    const timer = setTimeout(() => {
      timers.current.delete(timer);
      setToasts((current) => current.filter((toast) => toast.id !== id));
    }, TOAST_DURATION_MS);
    timers.current.add(timer);
  }, []);

  return (
    <ShowToastContext.Provider value={show}>
      <ToastListContext.Provider value={toasts}>
        {children}
      </ToastListContext.Provider>
    </ShowToastContext.Provider>
  );
}

/**
 * Where the frame draws its toasts. The region is always mounted — a live
 * region that appears together with its first message is often not read —
 * and announces each added toast politely. It takes no pointer events: a
 * toast has nothing to press, and whatever lies under it stays reachable.
 * Where it sits on the screen is the frame's to decide.
 */
export function ToastRegion() {
  const toasts = useContext(ToastListContext);
  if (toasts === null) {
    throw new Error("ToastRegion must be drawn inside a ToastProvider");
  }
  return (
    <div
      role="status"
      aria-live="polite"
      aria-atomic="false"
      className="pointer-events-none flex flex-col items-center gap-sm"
    >
      {toasts.map((toast) => (
        <Toast key={toast.id} message={toast.message} />
      ))}
    </div>
  );
}

/**
 * Raises a toast on the frame the calling screen sits in: a success, or a
 * one-off notice with nothing on the screen to attach to (the memo a link
 * pointed at is gone). A failure is never a toast — it stays with the form,
 * field or row it belongs to. Throws outside a `ToastProvider`, which only a
 * screen drawn without its frame can be.
 */
export function useToast(): ShowToast {
  const show = useContext(ShowToastContext);
  if (show === null) {
    throw new Error(
      "useToast must be called inside a ToastProvider (the AppShell / AuthSheet frame hosts one)",
    );
  }
  return show;
}
