/** JobAtlas mark: an explore badge (rounded body, one bevelled corner) carrying the
 * navigation star and a dotted route that ends at it. Shapes shared with the markers. */
export function BrandMark({ size = 36, className }: { size?: number; className?: string }) {
  return (
    <svg viewBox="0 0 40 40" width={size} height={size} className={className} aria-hidden="true" focusable="false">
      <path d="M8 2h20l10 10v18a8 8 0 0 1-8 8H8a8 8 0 0 1-8-8V10a8 8 0 0 1 8-8Z" fill="var(--brand-ink, #1f2a44)" />
      <path
        d="M8.6 4.4h18.6l8.4 8.4v16.8a6 6 0 0 1-6 6H8.6a6 6 0 0 1-6-6V10.4a6 6 0 0 1 6-6Z"
        fill="none"
        stroke="var(--brand-line, rgba(255,255,255,.28))"
        strokeWidth="1"
      />
      <path d="M7 31c3-1 4-5 7.5-5.5S19 27 22 23.5" fill="none" stroke="#9cc0ff" strokeWidth="1.8" strokeLinecap="round" strokeDasharray="0.1 3.4" />
      <path d="M25 6.5 27.3 15.2 36 17.5 27.3 19.8 25 28.5 22.7 19.8 14 17.5 22.7 15.2Z" fill="var(--brand-star, #ffd166)" />
      <path d="M25 13.2 25.9 16.6 29.3 17.5 25.9 18.4 25 21.8 24.1 18.4 20.7 17.5 24.1 16.6Z" fill="#ffffff" />
    </svg>
  );
}
