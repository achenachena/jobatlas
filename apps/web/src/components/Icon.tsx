import { GLYPHS, type GlyphName } from "../theme/glyphs";

/** SVG rendering of the shared glyph set (same paths as the map markers). Decorative by
 * default; pass `label` when the icon is the only content of its control. */
export function Icon({ name, className, label }: { name: GlyphName; className?: string; label?: string }) {
  const g = GLYPHS[name] as { fill?: string; stroke?: string };
  return (
    <svg
      viewBox="0 0 24 24"
      width="1em"
      height="1em"
      className={className}
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      focusable="false"
    >
      {g.fill && <path d={g.fill} fill="currentColor" fillRule="evenodd" />}
      {g.stroke && (
        <path d={g.stroke} fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
      )}
    </svg>
  );
}
