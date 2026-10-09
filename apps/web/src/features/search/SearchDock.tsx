import { useEffect, useId, useRef, useState } from "react";

import { BrandMark } from "../../components/BrandMark";
import { Icon } from "../../components/Icon";
import type { Region, TimeWindow, WorkplaceFilter } from "../../lib/api";
import { t } from "../../lib/strings";
import type { GlyphName } from "../../theme/glyphs";
import { useRegions } from "./useSearch";
import styles from "./SearchDock.module.css";

const TIME_OPTIONS: TimeWindow[] = ["all", "today", "24h", "2d", "3d", "7d", "30d"];
/** Default search window: postings from the past 7 days. */
export const DEFAULT_TIME_WINDOW: TimeWindow = "7d";
const WORKPLACE_OPTIONS: WorkplaceFilter[] = ["all", "on_site", "hybrid", "remote"];
export const WORKPLACE_GLYPH: Record<string, GlyphName> = {
  all: "starSmall",
  on_site: "onSite",
  hybrid: "hybrid",
  remote: "remote",
  unknown: "unknown",
};

export type DockPopover = "filters" | "area";

interface Props {
  q: string;
  onQ: (q: string) => void;
  timeWindow: TimeWindow;
  onTimeWindow: (v: TimeWindow) => void;
  workplace: WorkplaceFilter;
  onWorkplace: (v: WorkplaceFilter) => void;
  region: Region;
  onRegion: (r: Region) => void;
  open: DockPopover | null;
  onOpen: (p: DockPopover) => void;
  onClose: () => void;
}

/** Floating top-left dock: brand, keyword, area, filters and up to two active-filter chips.
 * Everything else lives in on-demand popovers so the map keeps the screen. */
export function SearchDock(p: Props) {
  const ids = { q: useId(), filters: useId(), area: useId() };
  const active = (p.timeWindow !== DEFAULT_TIME_WINDOW ? 1 : 0) + (p.workplace !== "all" ? 1 : 0);
  return (
    <div className={styles.dockArea}>
      <div className={styles.dock} role="search">
        <span className={styles.brand}>
          <BrandMark size={34} />
          <span className={styles.wordmark}>{t.appName}</span>
        </span>
        <div className={styles.searchField}>
          <Icon name="search" className={styles.searchIcon} />
          <label htmlFor={ids.q} className="visually-hidden">
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
          {p.q && (
            <button type="button" className={styles.clear} onClick={() => p.onQ("")} aria-label={t.clearSearch}>
              <Icon name="close" />
            </button>
          )}
        </div>
      </div>

      <div className={styles.row}>
        <button
          type="button"
          className={`${styles.pill} ${p.open === "area" ? styles.pillOn : ""}`}
          aria-expanded={p.open === "area"}
          aria-controls={ids.area}
          aria-label={t.areaButton(p.region.name)}
          onClick={() => (p.open === "area" ? p.onClose() : p.onOpen("area"))}
        >
          <Icon name="pin" />
          <span className={styles.pillText}>{p.region.name}</span>
        </button>
        <button
          type="button"
          className={`${styles.pill} ${p.open === "filters" ? styles.pillOn : ""}`}
          aria-expanded={p.open === "filters"}
          aria-controls={ids.filters}
          onClick={() => (p.open === "filters" ? p.onClose() : p.onOpen("filters"))}
        >
          <Icon name="filter" />
          {t.filters}
          {active > 0 && <span className={styles.count}>{active}</span>}
        </button>
        {p.timeWindow !== DEFAULT_TIME_WINDOW && (
          <ActiveChip label={t.timeWindows[p.timeWindow]} onRemove={() => p.onTimeWindow(DEFAULT_TIME_WINDOW)} />
        )}
        {p.workplace !== "all" && (
          <ActiveChip
            label={t.workplaces[p.workplace]}
            glyph={WORKPLACE_GLYPH[p.workplace]}
            onRemove={() => p.onWorkplace("all")}
          />
        )}
      </div>

      {p.open === "filters" && (
        <FilterPopover id={ids.filters} {...p} />
      )}
      {p.open === "area" && <AreaPopover id={ids.area} region={p.region} onRegion={p.onRegion} onClose={p.onClose} />}
    </div>
  );
}

function ActiveChip({ label, glyph, onRemove }: { label: string; glyph?: GlyphName; onRemove: () => void }) {
  return (
    <span className={styles.chip}>
      {glyph && <Icon name={glyph} />}
      {label}
      <button type="button" onClick={onRemove} aria-label={t.removeFilter(label)} className={styles.chipX}>
        <Icon name="close" />
      </button>
    </span>
  );
}

/** Focus the first control on open; Escape closes (App returns focus to the trigger). */
function usePopoverFocus(onClose: () => void) {
  const ref = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    ref.current?.querySelector<HTMLElement>("input:checked, input, button")?.focus();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close.current();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  return ref;
}

function FilterPopover(p: Props & { id: string }) {
  const ref = usePopoverFocus(p.onClose);
  return (
    <div ref={ref} id={p.id} className={styles.popover} role="dialog" aria-label={t.filtersTitle}>
      <h2 className={styles.popTitle}>{t.filtersTitle}</h2>
      <fieldset className={styles.group}>
        <legend className={styles.legend}>{t.timeLabel}</legend>
        <div className={styles.options}>
          {TIME_OPTIONS.map((v) => (
            <label key={v} className={`${styles.option} ${p.timeWindow === v ? styles.optionOn : ""}`}>
              <input
                type="radio"
                name="time_window"
                value={v}
                checked={p.timeWindow === v}
                onChange={() => p.onTimeWindow(v)}
                className="visually-hidden"
              />
              {t.timeWindows[v]}
            </label>
          ))}
        </div>
      </fieldset>
      <fieldset className={styles.group}>
        <legend className={styles.legend}>{t.workplaceLabel}</legend>
        <div className={styles.options}>
          {WORKPLACE_OPTIONS.map((v) => (
            <label
              key={v}
              className={`${styles.option} ${styles.workplace} ${styles[`wp_${v}`]} ${p.workplace === v ? styles.optionOn : ""}`}
            >
              <input
                type="radio"
                name="workplace"
                value={v}
                checked={p.workplace === v}
                onChange={() => p.onWorkplace(v)}
                className="visually-hidden"
              />
              <Icon name={WORKPLACE_GLYPH[v]!} />
              {t.workplaces[v]}
            </label>
          ))}
        </div>
        <p className={styles.note}>{t.workplaceFilterNote}</p>
      </fieldset>
      <div className={styles.popFooter}>
        <button
          type="button"
          className={styles.ghost}
          onClick={() => {
            p.onTimeWindow(DEFAULT_TIME_WINDOW);
            p.onWorkplace("all");
          }}
        >
          {t.resetFilters}
        </button>
        <button type="button" className={styles.primary} onClick={p.onClose}>
          {t.done}
        </button>
      </div>
    </div>
  );
}

function AreaPopover({
  id,
  region,
  onRegion,
  onClose,
}: {
  id: string;
  region: Region;
  onRegion: (r: Region) => void;
  onClose: () => void;
}) {
  const ref = usePopoverFocus(onClose);
  const [text, setText] = useState("");
  const regions = useRegions(text);
  const inputId = useId();
  return (
    <div ref={ref} id={id} className={`${styles.popover} ${styles.areaPopover}`} role="dialog" aria-label={t.regionLabel}>
      <h2 className={styles.popTitle}>{t.remoteRegion(region.name)}</h2>
      <p className={styles.note}>{t.areaHint}</p>
      <label htmlFor={inputId} className="visually-hidden">
        {t.regionLabel}
      </label>
      <input
        id={inputId}
        className={styles.areaInput}
        value={text}
        placeholder={t.areaSearchPlaceholder}
        onChange={(e) => setText(e.target.value)}
      />
      <ul className={styles.regionList}>
        {(regions.data?.items ?? []).map((r) => (
          <li key={r.region_id}>
            <button
              type="button"
              onClick={() => {
                onRegion(r);
                onClose();
              }}
            >
              <Icon name="pin" />
              <span>{r.name}</span>
              <span className={styles.kind}>{r.kind}</span>
            </button>
          </li>
        ))}
      </ul>
      {region.approximate && <p className={styles.note}>{t.approxRegion}</p>}
    </div>
  );
}
