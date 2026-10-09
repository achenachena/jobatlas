import { type ReactNode, useEffect, useLayoutEffect, useRef, useState } from "react";

import { Icon } from "../../components/Icon";
import { t } from "../../lib/strings";
import styles from "./ListSheet.module.css";

/** Bottom sheet for the on-demand list (and, on phones / for jobs without a pin, the detail).
 * It floats over the map — it never becomes a column — and remembers its scroll position. */
export function ListSheet({
  title,
  subtitle,
  onClose,
  scrollKey,
  children,
  expandable = true,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  onClose: () => void;
  /** Where to save/restore scrollTop between openings. */
  scrollKey?: { current: number };
  children: ReactNode;
  expandable?: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const body = useRef<HTMLDivElement>(null);
  const root = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    if (body.current && scrollKey) body.current.scrollTop = scrollKey.current;
  }, [scrollKey]);
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    // Focus the sheet once on open (not on re-renders, so typing elsewhere is never interrupted).
    if (!root.current?.contains(document.activeElement)) root.current?.focus({ preventScroll: true });
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close.current();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  return (
    <section
      ref={root}
      tabIndex={-1}
      className={`${styles.sheet} ${expanded ? styles.expanded : ""}`}
      aria-labelledby="sheet-title"
    >
      <header className={styles.head}>
        <span className={styles.grip} aria-hidden="true" />
        <div className={styles.titles}>
          <h2 id="sheet-title" className={styles.title}>
            {title}
          </h2>
          {subtitle && <p className={styles.subtitle}>{subtitle}</p>}
        </div>
        {expandable && (
          <button
            type="button"
            className={styles.iconButton}
            onClick={() => setExpanded((e) => !e)}
            aria-label={expanded ? t.collapseList : t.expandList}
            aria-expanded={expanded}
          >
            <Icon name={expanded ? "collapse" : "expand"} />
          </button>
        )}
        <button type="button" className={styles.iconButton} onClick={onClose} aria-label={t.close}>
          <Icon name="close" />
        </button>
      </header>
      <div
        ref={body}
        className={styles.body}
        onScroll={(e) => {
          if (scrollKey) scrollKey.current = e.currentTarget.scrollTop;
        }}
      >
        {children}
      </div>
    </section>
  );
}
