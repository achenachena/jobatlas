import { useQuery } from "@tanstack/react-query";

import { StatusState } from "../../components/StatusState";
import { apiGet, type JobDetail } from "../../lib/api";
import { postedText, relativeTime, safeHttpUrl, salaryText } from "../../lib/format";
import { t } from "../../lib/strings";
import { LocationBadge, WorkplaceBadge } from "./Badges";
import styles from "./JobDetailPanel.module.css";

const ROLE_LABEL = {
  work_site: t.locationStatus.exact_work_location,
  company_office: t.locationStatus.company_location,
  headquarters: "Company headquarters",
} as const;

export function JobDetailPanel({ jobId, onClose }: { jobId: string; onClose: () => void }) {
  const q = useQuery({
    queryKey: ["job", jobId],
    queryFn: ({ signal }) => apiGet<JobDetail>(`/jobs/${jobId}`, signal),
  });
  return (
    <aside className={styles.panel} aria-labelledby="job-detail-title">
      <button type="button" className={styles.close} onClick={onClose} aria-label={t.close}>
        ×
      </button>
      {q.isPending && <StatusState tone="loading" title={t.loading} />}
      {q.isError && (
        <StatusState
          tone="error"
          title={t.errorTitle}
          action={
            <button type="button" className={styles.apply} onClick={() => q.refetch()}>
              {t.retry}
            </button>
          }
        />
      )}
      {q.data && <Detail job={q.data} />}
    </aside>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <>
      <dt>{label}</dt>
      <dd>{children}</dd>
    </>
  );
}

function Detail({ job }: { job: JobDetail }) {
  const apply = job.is_open_opportunity ? safeHttpUrl(job.apply_url) : null;
  const salary = salaryText(job.salary);
  return (
    <div className={styles.body}>
      <h2 id="job-detail-title" className={styles.title}>
        {job.title ?? t.notProvided}
      </h2>
      <p className={styles.company}>{job.company.name ?? t.notProvided}</p>
      <div className={styles.badges}>
        <WorkplaceBadge value={job.workplace_type} />
        <LocationBadge value={job.location_status} />
      </div>

      {apply ? (
        <a className={styles.apply} href={apply} target="_blank" rel="noopener noreferrer">
          {t.apply} ↗
        </a>
      ) : (
        <p className={styles.closed} role="status">
          {t.notOpen}
        </p>
      )}

      <section className={styles.section}>
        <h3>Location</h3>
        {job.locations.length === 0 ? (
          <p className={styles.muted}>
            {job.location_label ?? t.notProvided} · {t.locationStatus.unverified}
          </p>
        ) : (
          <ul className={styles.locations}>
            {job.locations.map((l, i) => (
              <li key={i}>
                <strong>{ROLE_LABEL[l.role]}</strong>
                <span>{l.address ?? t.notProvided}</span>
                {l.role !== "work_site" && <span className={styles.note}>{t.companyLocationNote}</span>}
                {l.evidence.source_url && (
                  <a href={safeHttpUrl(l.evidence.source_url) ?? undefined} target="_blank" rel="noopener noreferrer">
                    Source of this address
                  </a>
                )}
              </li>
            ))}
          </ul>
        )}
        {job.workplace_type === "remote" && (
          <p className={styles.note}>
            {job.eligibility.text ? `Open to: ${job.eligibility.text}. ` : ""}
            {t.checkRemoteRules}
          </p>
        )}
      </section>

      <dl className={styles.facts}>
        <Row label="Posted">{postedText(job)}</Row>
        <Row label={t.firstSeen}>{relativeTime(job.first_seen_at) ?? t.notProvided}</Row>
        <Row label={t.lastVerified}>{relativeTime(job.last_verified_at) ?? t.notProvided}</Row>
        <Row label="Salary">{salary ?? t.notProvided}</Row>
        <Row label="Employment type">{job.employment_type ?? t.notProvided}</Row>
        <Row label="Source">
          {job.source ? (
            <a href={safeHttpUrl(job.source.job_url) ?? undefined} target="_blank" rel="noopener noreferrer">
              {job.source.provider}
            </a>
          ) : (
            t.notProvided
          )}
        </Row>
      </dl>

      {job.description_text && (
        <section className={styles.section}>
          <h3>Description</h3>
          {/* Plain text only: source HTML is never rendered. */}
          <p className={styles.description}>{job.description_text}</p>
        </section>
      )}
    </div>
  );
}
