import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef } from "react";

import { Icon } from "../../components/Icon";
import { StatusState } from "../../components/StatusState";
import { apiGet, type JobDetail } from "../../lib/api";
import { postedText, relativeTime, safeHttpUrl, salaryText } from "../../lib/format";
import { t } from "../../lib/strings";
import { LocationNote, WorkplaceBadge } from "./Badges";
import styles from "./JobDetailCard.module.css";

const ROLE_LABEL = {
  work_site: t.locationStatus.exact_work_location,
  company_office: t.locationStatus.company_location,
  headquarters: "Company headquarters",
} as const;

interface Props {
  jobId: string;
  onClose: () => void;
  /** Present when the card was opened from the list. */
  onBack?: () => void;
}

/** One job, lightest first: title, company, address, workplace, posted, Apply. Verification
 * and the description wait behind "Details & verification". */
export function JobDetailCard({ jobId, onClose, onBack }: Props) {
  const q = useQuery({
    queryKey: ["job", jobId],
    queryFn: ({ signal }) => apiGet<JobDetail>(`/jobs/${jobId}`, signal),
  });
  const root = useRef<HTMLElement>(null);
  useEffect(() => {
    root.current?.focus({ preventScroll: true });
  }, [jobId]);
  return (
    <article
      ref={root}
      tabIndex={-1}
      className={styles.card}
      data-workplace={q.data?.workplace_type}
      aria-labelledby="job-detail-title"
    >
      <div className={styles.top}>
        <span className={styles.topLeft}>
          {onBack && (
            <button type="button" className={styles.back} onClick={onBack}>
              <Icon name="back" />
              {t.backToList}
            </button>
          )}
          {q.data && (
            <span className={styles.tag}>
              <WorkplaceBadge value={q.data.workplace_type} />
            </span>
          )}
        </span>
        <button type="button" className={styles.close} onClick={onClose} aria-label={t.close}>
          <Icon name="close" />
        </button>
      </div>
      {q.isPending && <StatusState tone="loading" title={t.loading} compact />}
      {q.isError && (
        <StatusState
          tone="error"
          title={t.errorTitle}
          compact
          action={
            <button type="button" className={styles.retry} onClick={() => q.refetch()}>
              {t.retry}
            </button>
          }
        />
      )}
      {q.data && <Detail job={q.data} />}
    </article>
  );
}

function Detail({ job }: { job: JobDetail }) {
  const apply = job.is_open_opportunity ? safeHttpUrl(job.apply_url) : null;
  const salary = salaryText(job.salary);
  const primary = job.locations[0];
  return (
    <div className={styles.body}>
      <header className={styles.head}>
        <h2 id="job-detail-title" className={styles.title}>
          {job.title ?? t.notProvided}
        </h2>
        <p className={styles.company}>{job.company.name ?? t.notProvided}</p>
      </header>

      <ul className={styles.facts}>
        <li>
          <Icon name="pin" className={styles.factIcon} />
          <span>
            {primary?.address ?? job.location_label ?? t.notProvided}
            <br />
            <LocationNote value={job.location_status} />
          </span>
        </li>
        <li>
          <Icon name="clock" className={styles.factIcon} />
          <span>{postedText(job)}</span>
        </li>
      </ul>

      {job.location_status === "company_location" && <p className={styles.note}>{t.companyLocationNote}</p>}
      {job.location_status === "unverified" && <p className={styles.note}>{t.noPinNote}</p>}
      {job.workplace_type === "remote" && (
        <p className={styles.noteQuiet}>
          {job.eligibility.text ? `Open to: ${job.eligibility.text}. ` : ""}
          {t.checkRemoteRules}
        </p>
      )}

      {apply ? (
        <a className={styles.apply} href={apply} target="_blank" rel="noopener noreferrer">
          {t.apply}
          <Icon name="external" />
        </a>
      ) : (
        <p className={styles.closed} role="status">
          {t.notOpen}
        </p>
      )}

      <details className={styles.more}>
        <summary>{t.moreDetails}</summary>
        <dl className={styles.dl}>
          <dt>Salary</dt>
          <dd>{salary ?? t.notProvided}</dd>
          <dt>Employment type</dt>
          <dd>{job.employment_type ?? t.notProvided}</dd>
          <dt>{t.firstSeen}</dt>
          <dd>{relativeTime(job.first_seen_at) ?? t.notProvided}</dd>
          <dt>{t.lastVerified}</dt>
          <dd>{relativeTime(job.last_verified_at) ?? t.notProvided}</dd>
          <dt>Source</dt>
          <dd>
            {job.source ? (
              <a href={safeHttpUrl(job.source.job_url) ?? undefined} target="_blank" rel="noopener noreferrer">
                {job.source.provider}
              </a>
            ) : (
              t.notProvided
            )}
          </dd>
        </dl>
        {job.locations.length > 0 && (
          <ul className={styles.locations}>
            {job.locations.map((l, i) => (
              <li key={i}>
                <strong>{ROLE_LABEL[l.role]}</strong>
                <span>{l.address ?? t.notProvided}</span>
                {l.role !== "work_site" && <span className={styles.noteSmall}>{t.companyLocationNote}</span>}
                {l.evidence.source_url && (
                  <a href={safeHttpUrl(l.evidence.source_url) ?? undefined} target="_blank" rel="noopener noreferrer">
                    Source of this address
                  </a>
                )}
              </li>
            ))}
          </ul>
        )}
        {job.description_text && (
          <>
            <h3 className={styles.descTitle}>Description</h3>
            {/* Plain text only: source HTML is never rendered. */}
            <p className={styles.description}>{job.description_text}</p>
          </>
        )}
      </details>
    </div>
  );
}
