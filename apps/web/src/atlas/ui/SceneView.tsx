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

const HINT_KEY = "atlas.gestureHintSeen";
const TOUCH = typeof window !== "undefined" && !!window.matchMedia?.("(pointer: coarse)").matches;

type Side = "right" | "left";
interface References {
  core: Set<string>;
  desktop: string[];
  mobile: string[];
}
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
  // One-line gesture hint on the first visit; gone after the first interaction or a few seconds.
  const [hint, setHint] = useState(() => {
    try {
      return !localStorage.getItem(HINT_KEY);
    } catch {
      return true;
    }
  });
  const dismissHint = useRef(() => {
    setHint(false);
    try {
      localStorage.setItem(HINT_KEY, "1");
    } catch {
      /* private mode: the hint simply shows again next time */
    }
  }).current;
  useEffect(() => {
    if (!hint) return;
    const t = setTimeout(dismissHint, 7000);
    return () => clearTimeout(t);
  }, [hint, dismissHint]);
  const refreshLabels = useRef<() => void>(() => {});
  const [away, setAway] = useState(false);
  const names = useRef(new Map<string, string>());
  const references = useRef<References>({ core: new Set(), desktop: [], mobile: [] });
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
      setAway(!sc.isHome());
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
    // Geographic references only (never a ranking of the current data): core cities spread
    // across the country that are always named, then other regional centres and the territorial
    // capitals where there is room, then (zoomed in) the largest cities by population.
    const core = ids([
      "ca-bc-vancouver", "ca-ab-calgary", "ca-ab-edmonton", "ca-sk-saskatoon",
      "ca-on-toronto", "ca-qc-montreal", "ca-qc-quebec", "ca-ns-halifax",
    ]);
    const regional = ids(["ca-mb-winnipeg", "ca-on-ottawa", "ca-sk-regina", "ca-nl-st-john-s"]);
    // one name, one place: a smaller namesake (Toronto, PE) is never named next to the big one
    const named = new Set(core.map(id => names.current.get(id)));
    const byPopulation = [...p.cities].sort((a, b) => (b.population ?? 0) - (a.population ?? 0) || (a.city_id < b.city_id ? -1 : 1))
      .filter(c => core.includes(c.city_id) || (!named.has(c.name) && named.add(c.name))).map(c => c.city_id);
    const capitals = ids(["ca-yt-whitehorse", "ca-nt-yellowknife", "ca-nu-iqaluit"]);
    const unique = (list: string[]) => [...new Set(list)];
    references.current = {
      core: new Set(core),
      desktop: unique([...core, ...regional, ...capitals, ...byPopulation.slice(0, 80)]),
      // phones name only a few: the largest first
      mobile: unique([...ids(["ca-on-toronto", "ca-bc-vancouver", "ca-qc-montreal", "ca-ab-calgary"]), ...core, ...byPopulation.slice(0, 40)]),
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

  // Drag pans (the grabbed point follows the pointer); right/Shift-drag orbits; two fingers
  // pan, pinch-zoom and twist; a click that did not move picks.
  useEffect(() => {
    const el = host.current!;
    let down: { x: number; y: number; moved: boolean; orbit: boolean } | null = null;
    const pointers = new Map<number, { x: number; y: number }>();
    let pinch = 0;
    let twist = 0;
    const onDown = (e: PointerEvent) => {
      el.setPointerCapture(e.pointerId);
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      // Ctrl-drag (Mac trackpads), Shift-drag and right-drag turn the map; a plain drag moves it
      down = { x: e.clientX, y: e.clientY, moved: pointers.size > 1, orbit: e.shiftKey || e.ctrlKey || e.button === 2 };
      dismissHint();
      scene.current?.beginGesture(); // limits are elastic until every pointer is released
      el.style.cursor = "grabbing";
      if (pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        pinch = Math.hypot(a!.x - b!.x, a!.y - b!.y);
        twist = Math.atan2(b!.y - a!.y, b!.x - a!.x);
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
          const angle = Math.atan2(b!.y - a!.y, b!.x - a!.x);
          const mx = (a!.x + b!.x) / 2, my = (a!.y + b!.y) / 2;
          sc.drag(mx - (e.clientX - prev.x) / 2, my - (e.clientY - prev.y) / 2, mx, my, true);
          if (pinch) sc.zoomAt(d / pinch, mx, my, true);
          // twisting clockwise turns the map clockwise (rotate() is 0.28° per pixel)
          let turn = angle - twist;
          if (turn > Math.PI) turn -= 2 * Math.PI;
          if (turn < -Math.PI) turn += 2 * Math.PI;
          sc.rotate(-((turn * 180) / Math.PI) / 0.28, 0, true);
          pinch = d;
          twist = angle;
        } else if (down?.orbit) sc.rotate(e.clientX - prev.x, e.clientY - prev.y, true);
        else sc.drag(prev.x, prev.y, e.clientX, e.clientY, true);
        if (down && Math.hypot(e.clientX - down.x, e.clientY - down.y) > 4) down.moved = true;
      } else if (e.pointerType === "mouse") {
        setHover(sc.pick(e.clientX, e.clientY));
      }
    };
    const onUp = (e: PointerEvent) => {
      pointers.delete(e.pointerId);
      if (pointers.size < 2) pinch = 0;
      if (e.type !== "pointercancel" && e.button === 0 && down && !down.moved && !down.orbit && scene.current) onSelectRef.current(scene.current.pick(e.clientX, e.clientY));
      if (pointers.size === 0) {
        scene.current?.endGesture(); // spring back inside the limits
        down = null;
        el.style.cursor = "";
      }
    };
    const onLeave = () => setHover(null);
    // Trackpad pinch arrives as a wheel event with ctrlKey and small deltas: zoom faster for it.
    let gesture: { scale: number; rotation: number } | null = null;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      dismissHint();
      if (gesture) return; // Safari reports the pinch as a gesture below
      // Normalize wheel notches and trackpad pixels to the same zoom response.
      const pixels = e.deltaY * (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? el.clientHeight : 1);
      scene.current?.zoomAt(Math.exp(-Math.max(-1000, Math.min(1000, pixels)) * (e.ctrlKey ? 0.01 : 0.0016)), e.clientX, e.clientY, true);
    };
    // Safari's trackpad gestures: pinch zooms at the pointer, a two-finger twist turns the map.
    type Gesture = Event & { scale: number; rotation: number; clientX: number; clientY: number };
    const onGestureStart = (e: Event) => {
      if (pointers.size > 1) return; // touch screens use the pointer handling above
      e.preventDefault();
      dismissHint();
      gesture = { scale: 1, rotation: 0 };
      scene.current?.beginGesture();
    };
    const onGestureChange = (e: Event) => {
      const g = e as Gesture;
      const sc = scene.current;
      if (!gesture || !sc) return;
      e.preventDefault();
      sc.zoomAt(g.scale / gesture.scale, g.clientX, g.clientY, true);
      sc.rotate(-(g.rotation - gesture.rotation) / 0.28, 0, true); // clockwise twist turns the map clockwise
      gesture = { scale: g.scale, rotation: g.rotation };
    };
    const onGestureEnd = () => {
      if (gesture) scene.current?.endGesture();
      gesture = null;
    };
    const onContext = (e: MouseEvent) => e.preventDefault();
    el.addEventListener("contextmenu", onContext);
    el.addEventListener("pointerdown", onDown);
    el.addEventListener("pointermove", onMove);
    el.addEventListener("pointerup", onUp);
    el.addEventListener("pointercancel", onUp);
    el.addEventListener("pointerleave", onLeave);
    el.addEventListener("wheel", onWheel, { passive: false });
    el.addEventListener("gesturestart", onGestureStart);
    el.addEventListener("gesturechange", onGestureChange);
    el.addEventListener("gestureend", onGestureEnd);
    return () => {
      el.removeEventListener("gesturestart", onGestureStart);
      el.removeEventListener("gesturechange", onGestureChange);
      el.removeEventListener("gestureend", onGestureEnd);
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
      dismissHint();
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
        aria-label="3D map of Canada. Body height shows new job postings per city on a square-root scale. The national overview shows hundreds of cities as bodies, with a stable set at every viewing angle. Search to inspect any city. Select a city on the map or in the city list for exact values. Drag to pan; Ctrl-drag, Shift-drag or right-drag to rotate; scroll or pinch to zoom at the pointer; on touch, drag to pan and use two fingers to zoom and turn. Q/E or the rotate buttons rotate, arrow keys pan, plus and minus zoom, 0 resets."
        onKeyDown={onKey}
        style={{ cursor: hover ? "pointer" : "grab", touchAction: "none" }}
      />
      {hint && !away && (
        <p className={s.gestureHint} role="note">
          {TOUCH ? "Drag to move · Pinch to zoom · Twist two fingers to rotate" : "Drag to move · Scroll or pinch to zoom · Ctrl-drag to rotate"}
        </p>
      )}
      {away && (
        <button type="button" className={s.backHome} onClick={() => scene.current?.resetView()}>
          Back to all of Canada
        </button>
      )}
      <div className={s.mapTools} aria-label="Map view controls" role="group">
        <button
          className={`${s.iconBtn} ${s.rotateBtn}`}
          type="button"
          aria-label="Rotate left"
          title="Rotate left (Q) · or Ctrl-drag / Shift-drag the map"
          onClick={() => scene.current?.rotate(-100)}
        >
          <Icon name="rotateLeft" />
        </button>
        <button
          className={`${s.iconBtn} ${s.rotateBtn}`}
          type="button"
          aria-label="Rotate right"
          title="Rotate right (E) · or Ctrl-drag / Shift-drag the map"
          onClick={() => scene.current?.rotate(100)}
        >
          <Icon name="rotateRight" />
        </button>
        <button
          className={s.iconBtn}
          type="button"
          aria-label="Reset view"
          title="Reset view (0) · back to the starting zoom, position and angle"
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
function placeLabels(sc: AtlasScene, el: HTMLElement, names: Map<string, string>, references: References): Placed[] {
  const w = el.clientWidth, h = el.clientHeight;
  // Geographic references, never a changing ranking of the current occupation/date.
  // Missing cities remain absent; zero/unknown cities keep their geographic name.
  const mobile = w < 760, regional = sc.detail().regional;
  const limit = mobile ? (regional ? 6 : 4) : regional ? 18 : 15;
  const candidates = mobile ? references.mobile : references.desktop;
  const anchors = new Map(sc.anchors(new Set(candidates)).map(a => [a.id, a]));
  const boxes: { x0: number; x1: number; y0: number; y1: number }[] = [];
  const out: Placed[] = [];
  for (const id of candidates) {
    if (out.length >= limit) break;
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
    // the core cities are always named; the others only where a clear spot exists
    if (best && (best.score < 1000 || references.core.has(id))) { boxes.push(best.box); out.push({ id, side: best.side, dy: best.dy }); }
    else if (references.core.has(id)) out.push({ id, side: sideFor(a, w), dy: Math.max(100 - a.by, Math.min(24, h - 104 - a.by)) });
  }
  return out;
}
