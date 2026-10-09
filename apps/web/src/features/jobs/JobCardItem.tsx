import type { JobCard } from "../../lib/api";
import { postedText, salaryText } from "../../lib/format";
import { t } from "../../lib/strings";
import { LocationBadge, WorkplaceBadge } from "./Badges";
import styles from "./JobCardItem.module.css";

interface Props {
  job: JobCard;
  selected: boolean;
  onSelect: (job: JobCard) => void;
  onShowCompany?: (job: JobCard) => void;
}

export function JobCardItem({ job, selected, onSelect, onShowCompany }: Props) {
  const salary = salaryText(job.salary);
  const marker = job.markers[0];
  return (
    <li className={`${styles.card} ${selected ? styles.selected : ""}`}>
      <button
        type="button"
        className={styles.main}
        onClick={() => onSelect(job)}
        aria-pressed={selected}
      >
        <span className={styles.title}>{job.title ?? t.notProvided}</span>
        <span className={styles.company}>{job.company ?? t.notProvided}</span>
        <span className={styles.badges}>
          <WorkplaceBadge value={job.workplace_type} />
          <LocationBadge value={job.location_status} />
        </span>
        <span className={styles.meta}>
          {marker?.address ?? job.location_label ?? t.notProvided}
        </span>
        <span className={styles.meta}>
          {postedText(job)}
          {salary ? ` · ${salary}` : ""}
        </span>
        {job.location_status === "company_location" && (
          <span className={styles.note}>{t.companyLocationNote}</span>
        )}
      </button>
      {onShowCompany && marker && (
        <button type="button" className={styles.secondary} onClick={() => onShowCompany(job)}>
          {t.moveToCompany}
        </button>
      )}
    </li>
  );
}
