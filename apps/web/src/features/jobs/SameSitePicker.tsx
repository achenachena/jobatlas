import { useEffect, useRef } from "react";

import type { JobCard } from "../../lib/api";

export type PickerJob = Pick<JobCard, "id" | "title" | "company" | "workplace_type">;
import { t } from "../../lib/strings";
import { WorkplaceBadge } from "./Badges";
import styles from "./SameSitePicker.module.css";

/** Several jobs at one building: choose instead of faking separate pins (§4.2). */
export function SameSitePicker({
  jobs,
  onPick,
  onClose,
}: {
  jobs: PickerJob[];
  onPick: (job: PickerJob) => void;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = dialog.current;
    if (d && !d.open) d.showModal?.();
    return () => d?.close?.();
  }, []);
  return (
    <dialog ref={dialog} className={styles.dialog} onClose={onClose} aria-labelledby="same-site-title">
      <h2 id="same-site-title" className={styles.title}>
        {t.sameSiteTitle(jobs.length)}
      </h2>
      <ul className={styles.list}>
        {jobs.map((job) => (
          <li key={job.id}>
            <button type="button" className={styles.item} onClick={() => onPick(job)}>
              <strong>{job.title ?? t.notProvided}</strong>
              <span>{job.company ?? t.notProvided}</span>
              <WorkplaceBadge value={job.workplace_type} />
            </button>
          </li>
        ))}
      </ul>
      <button type="button" className={styles.close} onClick={onClose}>
        {t.close}
      </button>
    </dialog>
  );
}
