import type { JobCard, Workplace } from "../../lib/api";
import { t } from "../../lib/strings";
import styles from "./Badges.module.css";

/** Shape + text, mirroring the map markers: solid round, double ring, hollow diamond. */
export function WorkplaceBadge({ value }: { value: Workplace }) {
  return (
    <span className={`${styles.badge} ${styles[value]}`}>
      <span className={styles.glyph} aria-hidden="true" />
      {t.workplaces[value]}
    </span>
  );
}

export function LocationBadge({ value }: { value: JobCard["location_status"] }) {
  return (
    <span className={`${styles.badge} ${styles.loc} ${styles[`loc_${value}`]}`}>
      {t.locationStatus[value]}
    </span>
  );
}
