import type { ReactNode } from "react";

import styles from "./StatusState.module.css";

type Tone = "empty" | "error" | "loading";

/** Shared look for loading / empty / error states (all designed, never a bare string). */
export function StatusState({
  tone,
  title,
  body,
  action,
}: {
  tone: Tone;
  title: string;
  body?: string;
  action?: ReactNode;
}) {
  return (
    <div className={`${styles.box} ${styles[tone]}`} role={tone === "error" ? "alert" : "status"}>
      <span className={styles.art} aria-hidden="true">
        {tone === "loading" ? <span className={styles.spinner} /> : tone === "error" ? "!" : "✦"}
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
