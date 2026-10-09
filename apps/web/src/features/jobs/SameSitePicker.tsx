import { useEffect, useRef } from "react";

import { Icon } from "../../components/Icon";
import type { JobCard } from "../../lib/api";
import { t } from "../../lib/strings";
import { WorkplaceBadge } from "./Badges";
import styles from "./SameSitePicker.module.css";

export type PickerJob = Pick<JobCard, "id" | "title" | "company" | "workplace_type">;

/** Several jobs at one address: choose one instead of faking separate pins (§4.2). */
export function SameSitePicker({
  jobs,
  total,
  onPick,
  onClose,
}: {
  jobs: PickerJob[];
  total: number;
  onPick: (job: PickerJob) => void;
  onClose: () => void;
}) {
  const root = useRef<HTMLElement>(null);
  useEffect(() => root.current?.focus({ preventScroll: true }), []);
  return (
    <section ref={root} tabIndex={-1} className={styles.picker} aria-labelledby="same-site-title">
      <header className={styles.head}>
        <span className={styles.stack} aria-hidden="true">
          <Icon name="stack" />
        </span>
        <div>
          <h2 id="same-site-title" className={styles.title}>
            {t.sameSiteTitle(total)}
          </h2>
          <p className={styles.hint}>{t.sameSitePick}</p>
        </div>
        <button type="button" className={styles.close} onClick={onClose} aria-label={t.close}>
          <Icon name="close" />
        </button>
      </header>
      <ul className={styles.list}>
        {jobs.map((job) => (
          <li key={job.id}>
            <button type="button" className={styles.item} onClick={() => onPick(job)}>
              <span className={styles.itemTitle}>{job.title ?? t.notProvided}</span>
              <span className={styles.itemMeta}>
                {job.company ?? t.notProvided}
                <WorkplaceBadge value={job.workplace_type} />
              </span>
            </button>
          </li>
        ))}
        {jobs.length < total && <li className={styles.loading}>{t.loading}</li>}
      </ul>
    </section>
  );
}
