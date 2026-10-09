import { Icon } from "../../components/Icon";
import type { JobCard, Workplace } from "../../lib/api";
import { t } from "../../lib/strings";
import { WORKPLACE_GLYPH } from "../search/SearchDock";
import styles from "./Badges.module.css";

/** A small copy of the map badge (solid / split / hollow / dashed + glyph) and the word. */
export function WorkplaceBadge({ value }: { value: Workplace }) {
  return (
    <span className={`${styles.badge} ${styles[value]}`}>
      <span className={styles.mark} aria-hidden="true">
        <Icon name={WORKPLACE_GLYPH[value]!} />
        {/* hybrid: the glyph switches colour across the split, as on the map */}
        {value === "hybrid" && <Icon name="hybrid" className={styles.splitGlyph} />}
      </span>
      {t.workplaces[value]}
    </span>
  );
}

/** Location certainty, kept quiet: a secondary line, not a coloured pill. */
export function LocationNote({ value }: { value: JobCard["location_status"] }) {
  return <span className={`${styles.loc} ${styles[`loc_${value}`]}`}>{t.locationStatus[value]}</span>;
}
