import { createContext, useCallback, useContext, useMemo, useRef, useState, type AnimationEvent, type CSSProperties, type ReactNode } from 'react';

/**
 * The Arcaid look (2026-11-25): Castcade's toast, on the model of Arcaid's toast (G23, ADR 0042: Arcaid's own look,
 * never a library's; Castcade carries no toast library, the behaviour is the few lines below). The look is `.cc-toast`
 * in aw-castcade.css: a dark glass slab with the panel's top light bar, a double-line neon edge, the Arcaid triangle
 * as the status mark and a chrome pinball on a lit rail as the clock.
 *
 * The rules are Arcaid's: an ERROR stays until Dismiss (a long refusal must not vanish before it is read); success and
 * info clear after 4 s, when the rail's animation ends, so the clock stops while the pointer is over the toasts or the
 * focus is in them; at most three are on screen (the newest). Errors are `role="alert"`; the others are read from the
 * polite live region they appear in.
 *
 * For a message that reports the result of a press made somewhere the result line would not be seen (Settings: a
 * Save at the top of a long tab). A result that is itself something to read or act on stays in its panel.
 */
type ToastType = 'success' | 'error' | 'info';

interface ToastOptions {
  /** The heading, in place of the type's own (Done / Heads up / Didn't work). */
  label?: string;
  /** How long a success or info toast stays (4 s when left out); nothing on an error. */
  durationMs?: number;
}

interface ToastItem {
  id: number;
  message: string;
  type: ToastType;
  options?: ToastOptions;
}

interface ToastApi {
  /** A line break in `message` starts a new line in the toast. */
  toast(message: string, type?: ToastType, options?: ToastOptions): void;
}

const ToastContext = createContext<ToastApi>({ toast: () => undefined });

export function useToast(): ToastApi {
  return useContext(ToastContext);
}

const MAX_ON_SCREEN = 3;
const CLEARS_AFTER_MS = 4000;

const LOOK: Record<ToastType, { tone: 'cyan' | 'ice' | 'pink'; label: string }> = {
  success: { tone: 'cyan', label: 'Done' },
  info: { tone: 'ice', label: 'Heads up' },
  error: { tone: 'pink', label: "Didn't work" },
};

/** The Arcaid triangle, double-lined like the logo's and tilted like the ones on the Witness background. */
function Emblem() {
  return (
    <svg className="cc-toast__emblem" viewBox="0 0 32 32" aria-hidden="true">
      <polygon className="cc-toast__emblem-outer" points="13.1,3.3 29.3,21.3 5.6,26.4" />
      <polygon className="cc-toast__emblem-inner" points="14.1,8 24.8,19.9 9.1,23.2" />
    </svg>
  );
}

function Toast({ item, onDismiss }: { item: ToastItem; onDismiss: (id: number) => void }) {
  const { tone } = LOOK[item.type];
  const label = item.options?.label ?? LOOK[item.type].label;
  const stays = item.type === 'error';
  const dismiss = () => onDismiss(item.id);
  // Only the rail's own animation is the clock (a child's animationend bubbles here too).
  const railEnded = (e: AnimationEvent<HTMLDivElement>) => {
    if (e.target === e.currentTarget) dismiss();
  };
  return (
    <div className={`cc-toast cc-toast--${tone}`} role={stays ? 'alert' : 'status'}>
      <Emblem />
      <div className="cc-toast__body">
        <p className="cc-toast__label">{label}</p>
        <p className="cc-toast__msg">{item.message}</p>
        {stays && (
          <button type="button" className="cc-toast__chip" onClick={dismiss}>
            Dismiss
          </button>
        )}
      </div>
      {!stays && (
        <>
          <button type="button" className="cc-toast__x" aria-label="Dismiss" onClick={dismiss}>
            ×
          </button>
          <div className="cc-toast__rail" aria-hidden="true">
            <div className="cc-toast__run" style={{ '--cc-toast-ms': `${item.options?.durationMs ?? CLEARS_AFTER_MS}ms` } as CSSProperties} onAnimationEnd={railEnded}>
              <span className="cc-toast__ball" />
            </div>
          </div>
        </>
      )}
    </div>
  );
}

/** Holds the toasts; `overlay` is where they are drawn (give it to the page shell's `overlays`). */
export function useToaster(): { api: ToastApi; overlay: ReactNode } {
  const [items, setItems] = useState<ToastItem[]>([]);
  const next = useRef(1);
  const dismiss = useCallback((id: number) => setItems((all) => all.filter((t) => t.id !== id)), []);
  const api = useMemo<ToastApi>(
    () => ({
      toast(message, type = 'success', options) {
        const id = next.current++;
        setItems((all) => [...all, { id, message, type, options }].slice(-MAX_ON_SCREEN));
      },
    }),
    [],
  );
  const overlay = (
    <section className="cc-toasts" aria-label="Notifications" aria-live="polite">
      {items.map((t) => (
        <Toast key={t.id} item={t} onDismiss={dismiss} />
      ))}
    </section>
  );
  return { api, overlay };
}

export function ToastProvider({ api, children }: { api: ToastApi; children: ReactNode }) {
  return <ToastContext.Provider value={api}>{children}</ToastContext.Provider>;
}
