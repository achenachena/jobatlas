/** Hosts the Three.js scene: pointer orbit/pan/zoom/pick, keyboard (arrows pan, Q/E rotate,
 * +/- zoom, 0 reset), map controls, and stable geographic reference labels (four desktop, two mobile),
 * one hover name with its count, and the selected city's note. */
import { useEffect, useRef, useState } from "react";

import type { City } from "../api";
import { type Anchor, AtlasScene, type GeoData } from "../scene/AtlasScene";
import s from "./atlas.module.css";
import { fmtNum, Icon } from "./parts";

interface Props {
  geo: GeoData;
  cities: City[];
  counts: Map<string, number | null>;
  scaleMax: number;
  countsKey: string;
  priority: { id: string; max: number }[];
  playing: boolean;
  reducedMotion: boolean;
  selected: string | null;
  focus: { id: string } | null;
  onSelect: (id: string | null) => void;
  onOpenDetails: () => void;
}

type Side = "right" | "left";
interface Placed {
  id: string;
  side: Side;
  dy: number;
}

export function SceneView(p: Props) {
  const host = useRef<HTMLDivElement>(null);
  const scene = useRef<AtlasScene | null>(null);
  const [anchors, setAnchors] = useState<Map<string, Anchor>>(new Map());
  const [auto, setAuto] = useState<Placed[]>([]);
  const [hover, setHover] = useState<string | null>(null);
  const hoverRef = useRef(hover);
  hoverRef.current = hover;
  const refreshLabels = useRef<() => void>(() => {});
  const names = useRef(new Map<string, string>());
  const references = useRef<{ desktop: string[]; mobile: string[] }>({ desktop: [], mobile: [] });
  const selectedRef = useRef(p.selected);
  selectedRef.current = p.selected;
  const onSelectRef = useRef(p.onSelect);
  onSelectRef.current = p.onSelect;

  useEffect(() => {
    const el = host.current!;
    const sc = new AtlasScene(el, { reducedMotion: p.reducedMotion });
    sc.setGeo(p.geo);
    scene.current = sc;
    (window as unknown as { __atlas?: AtlasScene }).__atlas = sc;
    // Commit candidate identities and their projected anchors in the same callback.
    // No extra RAF: an idle scene may never produce another frame after React commits.
    const refresh = () => {
      const placed = placeLabels(sc, el, names.current, references.current);
      const ids = new Set([...placed.map(l => l.id), ...[hoverRef.current, selectedRef.current].filter((id): id is string => !!id)]);
      setAuto(placed);
      setAnchors(new Map(sc.anchors(ids).map(a => [a.id, a])));
    };
    refreshLabels.current = refresh;
    const offFrame = sc.onFrame(refresh);
    const offSettle = sc.onSettle(refresh);
    return () => {
      offFrame();
      offSettle();
      refreshLabels.current = () => {};
      sc.dispose();
      scene.current = null;
    };
  }, [p.geo, p.reducedMotion]);

  useEffect(() => {
    names.current = new Map(p.cities.map((c) => [c.city_id, c.name]));
    // Match canonical city IDs, not names: Canada also contains Toronto, PE.
    const available = new Set(p.cities.map(c => c.city_id));
    const ids = (list: string[]) => list.filter(id => available.has(id));
    references.current = {
      desktop: ids(["ca-on-toronto", "ca-qc-montreal", "ca-bc-vancouver", "ca-ab-calgary"]),
      mobile: ids(["ca-on-toronto", "ca-bc-vancouver"]),
    };
    scene.current?.setCities(p.cities.map((c) => ({ id: c.city_id, name: c.name, lon: c.lon, lat: c.lat })));
  }, [p.cities]);

  useEffect(() => {
    scene.current?.setCounts(p.counts, p.scaleMax, p.priority);
    // countsKey changes exactly when the shown data does
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.countsKey, p.scaleMax, p.cities, p.priority]);

  useEffect(() => scene.current?.setFrozen(p.playing), [p.playing]);
  useEffect(() => {
    scene.current?.setSelected(p.selected);
    refreshLabels.current();
  }, [p.selected]);
  useEffect(() => { scene.current?.setHovered(hover); refreshLabels.current(); }, [hover]);
  useEffect(() => {
    if (p.focus) scene.current?.focusCity(p.focus.id);
  }, [p.focus]);

  // Drag orbits; Shift/right-drag pans; two fingers pan/pinch; click picks.
  useEffect(() => {
    const el = host.current!;
    let down: { x: number; y: number; moved: boolean; pan: boolean } | null = null;
    const pointers = new Map<number, { x: number; y: number }>();
    let pinch = 0;
    const onDown = (e: PointerEvent) => {
      el.setPointerCapture(e.pointerId);
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      down = { x: e.clientX, y: e.clientY, moved: pointers.size > 1, pan: e.shiftKey || e.button === 2 };
      if (pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        pinch = Math.hypot(a!.x - b!.x, a!.y - b!.y);
      }
    };
    const onMove = (e: PointerEvent) => {
      const sc = scene.current;
      if (!sc) return;
      const prev = pointers.get(e.pointerId);
      if (prev) {
        pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
        if (pointers.size === 2) {
          const [a, b] = [...pointers.values()];
          const d = Math.hypot(a!.x - b!.x, a!.y - b!.y);
          sc.pan((e.clientX - prev.x) / 2, (e.clientY - prev.y) / 2);
          if (pinch) sc.zoomAt(d / pinch, (a!.x + b!.x) / 2, (a!.y + b!.y) / 2);
          pinch = d;
        } else if (down?.pan) sc.pan(e.clientX - prev.x, e.clientY - prev.y);
        else sc.rotate(e.clientX - prev.x, e.clientY - prev.y);
        if (down && Math.hypot(e.clientX - down.x, e.clientY - down.y) > 4) down.moved = true;
      } else if (e.pointerType === "mouse") {
        setHover(sc.pick(e.clientX, e.clientY));
      }
    };
    const onUp = (e: PointerEvent) => {
      pointers.delete(e.pointerId);
      if (pointers.size < 2) pinch = 0;
      if (e.type !== "pointercancel" && e.button === 0 && down && !down.moved && scene.current) onSelectRef.current(scene.current.pick(e.clientX, e.clientY));
      down = null;
    };
    const onLeave = () => setHover(null);
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      scene.current?.zoomAt(Math.exp(-e.deltaY * 0.0016), e.clientX, e.clientY);
    };
    const onContext = (e: MouseEvent) => e.preventDefault();
    el.addEventListener("contextmenu", onContext);
    el.addEventListener("pointerdown", onDown);
    el.addEventListener("pointermove", onMove);
    el.addEventListener("pointerup", onUp);
    el.addEventListener("pointercancel", onUp);
    el.addEventListener("pointerleave", onLeave);
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      el.removeEventListener("contextmenu", onContext);
      el.removeEventListener("pointerdown", onDown);
      el.removeEventListener("pointermove", onMove);
      el.removeEventListener("pointerup", onUp);
      el.removeEventListener("pointercancel", onUp);
      el.removeEventListener("pointerleave", onLeave);
      el.removeEventListener("wheel", onWheel);
    };
  }, []);

  const onKey = (e: React.KeyboardEvent) => {
    const sc = scene.current;
    if (!sc) return;
    const step = 60;
    const keys: Record<string, () => void> = {
      ArrowLeft: () => sc.pan(step, 0),
      ArrowRight: () => sc.pan(-step, 0),
      ArrowUp: () => sc.pan(0, step),
      ArrowDown: () => sc.pan(0, -step),
      "+": () => sc.zoomAt(1.25),
      "=": () => sc.zoomAt(1.25),
      "-": () => sc.zoomAt(0.8),
      "0": () => sc.resetView(),
      q: () => sc.rotate(-100),
      e: () => sc.rotate(100),
    };
    const fn = keys[e.key];
    if (fn) {
      e.preventDefault();
      fn();
    }
  };

  const name = (id: string) => names.current.get(id) ?? id;
  const sel = p.selected ? anchors.get(p.selected) : undefined;
  const hov = hover && hover !== p.selected ? anchors.get(hover) : undefined;
  const autoShown = auto.filter((l) => l.id !== p.selected && l.id !== hover && anchors.has(l.id));
  return (
    <>
      <div
        ref={host}
        className={s.stage}
        tabIndex={0}
        role="img"
        aria-label="3D map of Canada. Body height shows new job postings per city on a square-root scale. The national overview shows hundreds of cities as bodies, with a stable set at every viewing angle. Search to inspect any city. Select a city on the map or in the city list for exact values. Drag to rotate, Shift-drag to pan, scroll to zoom; Q/E rotate, arrow keys pan, plus and minus zoom, 0 resets."
        onKeyDown={onKey}
        style={{ cursor: hover ? "pointer" : "grab", touchAction: "none" }}
      />
      <div className={s.mapTools} aria-label="Map view controls" role="group">
        <button
          className={s.iconBtn}
          type="button"
          aria-label="Reset view"
          title="Reset view · drag to rotate, Shift-drag to pan, scroll to zoom"
          onClick={() => scene.current?.resetView()}
        >
          <Icon name="reset" />
        </button>
        <button className={s.iconBtn} type="button" aria-label="Zoom in" title="Zoom in" onClick={() => scene.current?.zoomAt(1.25)}>
          <Icon name="plus" />
        </button>
        <button className={s.iconBtn} type="button" aria-label="Zoom out" title="Zoom out" onClick={() => scene.current?.zoomAt(0.8)}>
          <Icon name="minus" />
        </button>
      </div>
      <div className={s.labels} aria-hidden="true">
        {autoShown.map((l) => {
          const a = anchors.get(l.id)!;
          return <Note key={l.id} a={a} side={l.side} dy={l.dy} lines={[name(l.id)]} />;
        })}
        {hov && <Note a={hov} side={sideFor(hov, host.current?.clientWidth ?? 0)} lines={[name(hov.id), countText(hov.count)]} detail />}
      </div>
      {sel && (
        <Note
          a={sel}
          side={sideFor(sel, host.current?.clientWidth ?? 0)}
          lines={[name(sel.id), countText(sel.count)]}
          detail
          hint={sel.displaced ? "The ground line connects this body to the city’s geographic location." : undefined}
          strong
          onClick={p.onOpenDetails}
        />
      )}
    </>
  );
}

function countText(n: number | null): string {
  return n == null ? "Unknown" : `${fmtNum(n)} ${n === 1 ? "job" : "jobs"}`;
}

const sideFor = (a: Anchor, width: number): Side => (a.bx + a.r + 140 > width - 16 ? "left" : "right");

/** A note beside the city's base with a short leader line; two lines when selected/hovered. */
function Note(p: { a: Anchor; side: Side; dy?: number; lines: string[]; strong?: boolean; detail?: boolean; hint?: string; onClick?: () => void }) {
  const style = { left: p.a.bx, top: p.a.by + (p.dy ?? 0), "--gap": `${p.a.body ? p.a.r + 8 : 8}px`, "--anchor-display": p.dy ? "none" : "block" } as React.CSSProperties;
  const cls = `${s.note} ${p.side === "left" ? s.noteLeft : ""} ${p.strong ? s.noteStrong : ""} ${p.detail ? s.noteDetail : ""}`;
  const body = (
    <span className={s.noteText}>
      {p.lines.map((l, i) => (
        <span key={i} className={i > 1 ? s.noteHint : i ? s.noteCount : undefined}>
          {l}
        </span>
      ))}
    </span>
  );
  if (!p.onClick) return <>
    {!!p.dy && <svg className={s.labelLeader} width="100%" height="100%"><path d={`M ${p.a.bx} ${p.a.by} L ${p.a.bx} ${p.a.by + p.dy}`} /><circle cx={p.a.bx} cy={p.a.by} r="2.5" /></svg>}
    <div className={cls} style={style} data-city-id={p.a.id}>{body}</div>
  </>;
  return (
    <button type="button" className={cls} style={style} data-city-id={p.a.id} title={p.hint} onClick={p.onClick} aria-label={`${p.lines.join(", ")}. Open details`}>
      {body}
    </button>
  );
}

/** Choose by importance first, then place: busy centres must not lose their identity merely
 * because their coast cannot fit a body or the first label slot intersects another column. */
function placeLabels(sc: AtlasScene, el: HTMLElement, names: Map<string, string>, references: { desktop: string[]; mobile: string[] }): Placed[] {
  const w = el.clientWidth, h = el.clientHeight;
  // Geographic references, never a changing ranking of the current occupation/date.
  // Missing cities remain absent; zero/unknown cities keep their geographic name.
  const candidates = w < 760 ? references.mobile : references.desktop;
  const anchors = new Map(sc.anchors(new Set(candidates)).map(a => [a.id, a]));
  const boxes: { x0: number; x1: number; y0: number; y1: number }[] = [];
  const out: Placed[] = [];
  for (const id of candidates) {
    const a = anchors.get(id);
    if (!a || a.bx < 0 || a.bx > w || a.by < 0 || a.by > h) continue;
    const textW = 12 + (names.get(id) ?? id).length * 7.5;
    // Calgary sits inland behind the southern body cluster; its reference note
    // needs a longer leader to reach the quiet margin, without changing identity.
    const preferredDy = id === "ca-ab-calgary" ? 64 : 24;
    let best: { side: Side; dy: number; box: { x0: number; x1: number; y0: number; y1: number }; score: number } | null = null;
    // Prefer the quiet area just below the land, with short elbow leaders. Labels do not
    // disappear simply because a chart occupies their first horizontal slot.
    for (const dy of [24, 44, 64, 84, 104, 124, 0, -28, -52]) {
      for (const side of [sideFor(a, w), sideFor(a, w) === "right" ? "left" : "right"] as Side[]) {
        const x0 = side === "right" ? a.bx + a.r + 8 : a.bx - a.r - 8 - textW;
        const box = { x0, x1: x0 + textW, y0: a.by + dy - 11, y1: a.by + dy + 11 };
        if (box.x0 < 12 || box.x1 > w - 12 || box.y1 > h - 92 || box.y0 < 96) continue;
        if (boxes.some(b => box.x0 < b.x1 && box.x1 > b.x0 && box.y0 < b.y1 && box.y1 > b.y0)) continue;
        const collisions = [...anchors.values()].filter(other => other.body && other.id !== id && box.x0 < other.x + other.r && box.x1 > other.x - other.r && box.y0 < other.by + 3 && box.y1 > other.y - other.r).length;
        const score = collisions * 1000 + Math.abs(dy - preferredDy);
        if (!best || score < best.score) best = { side, dy, box, score };
      }
    }
    if (best) { boxes.push(best.box); out.push({ id, side: best.side, dy: best.dy }); }
    else out.push({ id, side: sideFor(a, w), dy: Math.max(100 - a.by, Math.min(24, h - 104 - a.by)) });
  }
  return out;
}
