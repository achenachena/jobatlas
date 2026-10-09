import type { ReactNode } from "react";

import { Icon } from "./Icon";
import styles from "./StatusState.module.css";

type Tone = "empty" | "error" | "loading";

/** Shared look for loading / empty / error states (all designed, never a bare string). The
 * empty state reuses the navigation star and route from the brand mark. */
export function StatusState({
  tone,
  title,
  body,
  action,
  compact = false,
}: {
  tone: Tone;
  title: string;
  body?: string;
  action?: ReactNode;
  compact?: boolean;
}) {
  return (
    <div
      className={`${styles.box} ${styles[tone]} ${compact ? styles.compact : ""}`}
      role={tone === "error" ? "alert" : "status"}
    >
      <span className={styles.art} aria-hidden="true">
        {tone === "loading" ? (
          <Icon name="star" className={styles.spin} />
        ) : tone === "error" ? (
          <span className={styles.bang}>!</span>
        ) : (
          <>
            <Icon name="route" className={styles.route} />
            <Icon name="star" className={styles.star} />
          </>
        )}
      </span>
      <strong className={styles.title}>{title}</strong>
      {body && <span className={styles.body}>{body}</span>}
      {action}
    </div>
  );
}

export function SkeletonList({ count = 4 }: { count?: number }) {
  return (
    <ul className={styles.skeletons} aria-hidden="true">
      {Array.from({ length: count }, (_, i) => (
        <li key={i} className={styles.skeleton}>
          <span />
          <span />
          <span />
        </li>
      ))}
    </ul>
  );
}
