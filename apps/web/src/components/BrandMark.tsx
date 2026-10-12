/** JobAtlas mark: a square ink panel with one cut corner, the navigation star bursting out of
 * it, and a dotted route ending at the star — the same shapes as the map's badges. */
export function BrandMark({ size = 36, className }: { size?: number; className?: string }) {
  return (
    <svg viewBox="0 0 40 40" width={size} height={size} className={className} aria-hidden="true" focusable="false">
      <path d="M2 2h27l9 9v27H2Z" fill="var(--brand-ink, #17151f)" />
      <path d="M4.8 4.8h23l7.4 7.4v23H4.8Z" fill="none" stroke="#fff" strokeWidth="1.2" />
      <path
        d="M7 31c3-1 4-5 7.5-5.5S19 27 22 23.5"
        fill="none"
        stroke="var(--sakura, #ff5c93)"
        strokeWidth="2"
        strokeLinecap="round"
        strokeDasharray="0.1 3.6"
      />
      <path
        d="M25 5.5 27.6 15 37 17.5 27.6 20 25 29.5 22.4 20 13 17.5 22.4 15Z"
        fill="var(--brand-star, #ffd43b)"
        stroke="#fff"
        strokeWidth="1.4"
        strokeLinejoin="round"
      />
    </svg>
  );
}
