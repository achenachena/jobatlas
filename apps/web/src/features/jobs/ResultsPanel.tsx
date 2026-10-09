import { SkeletonList, StatusState } from "../../components/StatusState";
import type { GroupName, JobCard, SearchResponse } from "../../lib/api";
import { relativeTime } from "../../lib/format";
import { t } from "../../lib/strings";
import { JobCardItem } from "./JobCardItem";
import styles from "./ResultsPanel.module.css";

const GROUP_ORDER: GroupName[] = ["in_view", "remote_elsewhere", "location_unverified"];

interface Props {
  data: SearchResponse | undefined;
  isLoading: boolean;
  isError: boolean;
  stale: boolean;
  isFetching: boolean;
  items: (g: GroupName) => JobCard[];
  hasMore: (g: GroupName) => boolean;
  loadingGroup: GroupName | null;
  onLoadMore: (g: GroupName) => void;
  onRetry: () => void;
  selectedJobId: string | null;
  onSelect: (job: JobCard) => void;
  onShowCompany: (job: JobCard) => void;
}

export function ResultsPanel(p: Props) {
  if (p.isLoading && !p.data) {
    return (
      <div className={styles.panel} aria-busy="true">
        <StatusState tone="loading" title={t.loading} />
        <SkeletonList />
      </div>
    );
  }
  if (p.isError && !p.data) {
    return (
      <div className={styles.panel}>
        <StatusState
          tone="error"
          title={t.errorTitle}
          body={t.errorBody}
          action={
            <button type="button" className={styles.retry} onClick={p.onRetry}>
              {t.retry}
            </button>
          }
        />
      </div>
    );
  }
  if (!p.data) return null;
  const { counts, warnings } = p.data;
  const excluded = warnings.find((w) => w.code === "UNTRUSTED_POSTING_TIME_EXCLUDED");
  return (
    <div className={styles.panel} aria-busy={p.isFetching}>
      {p.stale && (
        <p className={styles.stale} role="status">
          {t.staleNotice(relativeTime(p.data.as_of) ?? "")}{" "}
          <button type="button" className={styles.linkButton} onClick={p.onRetry}>
            {t.retry}
          </button>
        </p>
      )}
      <div className={styles.summary}>
        <h2 className={styles.heading}>
          {t.results} <span className={styles.total}>{counts.total}</span>
        </h2>
        <ul className={styles.countChips}>
          {GROUP_ORDER.map((g) => (
            <li key={g} className={`${styles.chip} ${styles[`chip_${g}`]}`}>
              {t.groups[g]} <strong>{counts[g]}</strong>
            </li>
          ))}
        </ul>
        {excluded?.count ? <p className={styles.notice}>{t.excludedTime(excluded.count)}</p> : null}
      </div>
      {counts.total === 0 ? (
        <StatusState tone="empty" title={t.emptyTitle} body={t.emptyBody} />
      ) : (
        GROUP_ORDER.filter((g) => counts[g] > 0).map((g) => (
          <section key={g} className={styles.group} aria-labelledby={`group-${g}`}>
            <header className={styles.groupHeader}>
              <h3 id={`group-${g}`} className={styles.groupTitle}>
                {t.groups[g]} <span className={styles.groupCount}>{counts[g]}</span>
              </h3>
              <p className={styles.groupHint}>{t.groupHints[g]}</p>
            </header>
            <ul className={styles.list}>
              {p.items(g).map((job) => (
                <JobCardItem
                  key={job.id}
                  job={job}
                  selected={job.id === p.selectedJobId}
                  onSelect={p.onSelect}
                  onShowCompany={g === "remote_elsewhere" ? p.onShowCompany : undefined}
                />
              ))}
            </ul>
            {p.hasMore(g) && (
              <button
                type="button"
                className={styles.more}
                onClick={() => p.onLoadMore(g)}
                disabled={p.loadingGroup === g}
              >
                {p.loadingGroup === g ? t.loading : t.loadMore}
              </button>
            )}
          </section>
        ))
      )}
    </div>
  );
}
