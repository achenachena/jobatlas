import { Icon } from "../../components/Icon";
import type { JobCard } from "../../lib/api";
import { postedText, salaryText } from "../../lib/format";
import { t } from "../../lib/strings";
import { LocationNote, WorkplaceBadge } from "./Badges";
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
        data-job-id={job.id}
      >
        <span className={styles.title}>{job.title ?? t.notProvided}</span>
        <span className={styles.company}>{job.company ?? t.notProvided}</span>
        <span className={styles.line}>
          <WorkplaceBadge value={job.workplace_type} />
          <span className={styles.dot} aria-hidden="true">·</span>
          <span className={styles.posted}>{postedText(job)}</span>
          {salary && (
            <>
              <span className={styles.dot} aria-hidden="true">·</span>
              <span>{salary}</span>
            </>
          )}
        </span>
        <span className={styles.address}>
          <Icon name="pin" className={styles.pin} />
          <span>
            {marker?.address ?? job.location_label ?? t.notProvided}
            {"  "}
            <LocationNote value={job.location_status} />
          </span>
        </span>
        {job.location_status === "company_location" && (
          <span className={styles.note}>{t.companyLocationNote}</span>
        )}
      </button>
      {onShowCompany && marker && (
        <button type="button" className={styles.secondary} onClick={() => onShowCompany(job)}>
          <Icon name="locate" />
          {t.moveToCompany}
        </button>
      )}
    </li>
  );
}
