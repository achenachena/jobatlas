import { useId, useState } from "react";

import type { Region, TimeWindow, WorkplaceFilter } from "../../lib/api";
import { t } from "../../lib/strings";
import { useRegions } from "./useSearch";
import styles from "./FilterBar.module.css";

const TIME_OPTIONS: TimeWindow[] = ["all", "today", "24h", "2d", "3d", "7d", "30d"];
const WORKPLACE_OPTIONS: WorkplaceFilter[] = ["all", "on_site", "hybrid", "remote"];

interface Props {
  q: string;
  onQ: (q: string) => void;
  timeWindow: TimeWindow;
  onTimeWindow: (v: TimeWindow) => void;
  workplace: WorkplaceFilter;
  onWorkplace: (v: WorkplaceFilter) => void;
  region: Region | null;
  onRegion: (r: Region) => void;
}

export function FilterBar(p: Props) {
  const ids = { q: useId(), time: useId(), region: useId(), more: useId() };
  const [moreOpen, setMoreOpen] = useState(false);
  const active =
    (p.timeWindow !== "all" ? 1 : 0) + (p.workplace !== "all" ? 1 : 0) +
    (p.region && p.region.region_id !== "gta" ? 1 : 0);
  return (
    <div className={styles.bar} role="search">
      <div className={styles.field}>
        <label htmlFor={ids.q} className={styles.label}>
          {t.searchLabel}
        </label>
        <input
          id={ids.q}
          type="search"
          className={styles.input}
          value={p.q}
          maxLength={100}
          placeholder={t.searchPlaceholder}
          onChange={(e) => p.onQ(e.target.value)}
        />
      </div>
      {/* On phones the other filters fold away so the map keeps the screen (§10). */}
      <button
        type="button"
        className={styles.moreToggle}
        aria-expanded={moreOpen}
        aria-controls={ids.more}
        onClick={() => setMoreOpen((o) => !o)}
      >
        Filters{active ? ` (${active})` : ""}
      </button>
      <div id={ids.more} className={`${styles.more} ${moreOpen ? styles.moreOpen : ""}`}>
      <div className={styles.field}>
        <label htmlFor={ids.time} className={styles.label}>
          {t.timeLabel}
        </label>
        <select
          id={ids.time}
          className={styles.select}
          value={p.timeWindow}
          onChange={(e) => p.onTimeWindow(e.target.value as TimeWindow)}
        >
          {TIME_OPTIONS.map((v) => (
            <option key={v} value={v}>
              {t.timeWindows[v]}
            </option>
          ))}
        </select>
      </div>
      <fieldset className={styles.segmented}>
        <legend className={styles.label}>{t.workplaceLabel}</legend>
        <div className={styles.segments}>
          {WORKPLACE_OPTIONS.map((v) => (
            <label key={v} className={`${styles.segment} ${p.workplace === v ? styles.on : ""}`}>
              <input
                type="radio"
                name="workplace"
                value={v}
                checked={p.workplace === v}
                onChange={() => p.onWorkplace(v)}
                className="visually-hidden"
              />
              {v !== "all" && <span className={`${styles.shape} ${styles[v]}`} aria-hidden="true" />}
              {t.workplaces[v]}
            </label>
          ))}
        </div>
      </fieldset>
      <RegionPicker inputId={ids.region} region={p.region} onRegion={p.onRegion} />
      </div>
    </div>
  );
}

function RegionPicker({
  inputId,
  region,
  onRegion,
}: {
  inputId: string;
  region: Region | null;
  onRegion: (r: Region) => void;
}) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const regions = useRegions(text);
  return (
    <div className={styles.field}>
      <span className={styles.label}>{t.regionLabel}</span>
      {!open ? (
        <button type="button" className={styles.regionButton} onClick={() => setOpen(true)}>
          {t.remoteRegion(region?.name ?? "GTA")}
          <span className={styles.change}>{t.changeRegion}</span>
        </button>
      ) : (
        <div className={styles.regionSearch}>
          <label htmlFor={inputId} className="visually-hidden">
            {t.regionLabel}
          </label>
          <input
            id={inputId}
            className={styles.input}
            autoFocus
            value={text}
            placeholder="Toronto, Mississauga, Markham…"
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => e.key === "Escape" && setOpen(false)}
          />
          <ul className={styles.regionList}>
            {(regions.data?.items ?? []).map((r) => (
              <li key={r.region_id}>
                <button
                  type="button"
                  onClick={() => {
                    onRegion(r);
                    setOpen(false);
                    setText("");
                  }}
                >
                  {r.name}
                  <span className={styles.kind}>{r.kind}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
