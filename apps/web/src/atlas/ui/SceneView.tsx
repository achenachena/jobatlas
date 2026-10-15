/** Hosts the Three.js scene: pointer orbit/pan/zoom/pick, keyboard (arrows pan, +/- zoom, 0 reset),
 * and HTML labels for the tallest crystals with simple collision culling. */
import { useEffect, useRef, useState } from "react";

import type { City } from "../api";
import { AtlasScene, type GeoData } from "../scene/AtlasScene";
import type { ScenePalette } from "../scene/palette";
import s from "./atlas.module.css";
import { fmtNum } from "./parts";

const MAX_LABELS = 16;

interface Props {
  geo: GeoData;
  cities: City[];
  counts: Map<string, number | null>;
  scaleMax: number;
  countsKey: string;
  palette: ScenePalette;
  reducedMotion: boolean;
  selected: string | null;
  focus: string | null;
  onSelect: (id: string | null) => void;
}

interface Label {
  id: string;
  x: number;
  y: number;
  text: string;
  count: number | null;
}

export function SceneView(p: Props) {
  const host = useRef<HTMLDivElement>(null);
  const scene = useRef<AtlasScene | null>(null);
  const firstCounts = useRef(true);
  const [labels, setLabels] = useState<Label[]>([]);
  const [hover, setHover] = useState<string | null>(null);
  const names = useRef(new Map<string, string>());
  const selectedRef = useRef(p.selected);
  selectedRef.current = p.selected;
  const onSelectRef = useRef(p.onSelect);
  onSelectRef.current = p.onSelect;

  useEffect(() => {
    const el = host.current!;
    const sc = new AtlasScene(el, p.palette, { reducedMotion: p.reducedMotion });
    sc.setGeo(p.geo);
    scene.current = sc;
    (window as unknown as { __atlas?: AtlasScene }).__atlas = sc;
    let pending = 0;
    const off = sc.onFrame(() => {
      if (pending) return;
      pending = requestAnimationFrame(() => {
        pending = 0;
        setLabels(pickLabels(sc, names.current, selectedRef.current, el.clientWidth));
      });
    });
    return () => {
      off();
      cancelAnimationFrame(pending);
      sc.dispose();
      scene.current = null;
    };
  }, [p.geo, p.palette, p.reducedMotion]);

  useEffect(() => {
    names.current = new Map(p.cities.map((c) => [c.city_id, c.name]));
    scene.current?.setCities(p.cities.map((c) => ({ id: c.city_id, name: c.name, lon: c.lon, lat: c.lat })));
    firstCounts.current = true;
  }, [p.cities]);

  useEffect(() => {
    scene.current?.setCounts(p.counts, p.scaleMax, { stagger: firstCounts.current });
    firstCounts.current = false;
    // countsKey changes exactly when the shown data does
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.countsKey, p.scaleMax, p.cities]);

  useEffect(() => scene.current?.setSelected(p.selected), [p.selected]);
  useEffect(() => scene.current?.setHovered(hover), [hover]);
  useEffect(() => {
    if (p.focus) scene.current?.focusCity(p.focus);
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
        } else {
          if (down?.pan) sc.pan(e.clientX - prev.x, e.clientY - prev.y);
          else sc.rotate(e.clientX - prev.x, e.clientY - prev.y);
        }
        if (down && Math.hypot(e.clientX - down.x, e.clientY - down.y) > 4) down.moved = true;
      } else {
        setHover(sc.pick(e.clientX, e.clientY));
      }
    };
    const onUp = (e: PointerEvent) => {
      pointers.delete(e.pointerId);
      if (pointers.size < 2) pinch = 0;
      if (e.type !== "pointercancel" && e.button === 0 && down && !down.moved && scene.current) onSelectRef.current(scene.current.pick(e.clientX, e.clientY));
      down = null;
    };
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
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      el.removeEventListener("contextmenu", onContext);
      el.removeEventListener("pointerdown", onDown);
      el.removeEventListener("pointermove", onMove);
      el.removeEventListener("pointerup", onUp);
      el.removeEventListener("pointercancel", onUp);
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

  return (
    <>
      <div
        ref={host}
        className={s.stage}
        tabIndex={0}
        role="img"
        aria-label="3D map of Canada; crystal height shows job postings per city. Use the city list for exact values. Drag to rotate, Shift-drag to pan, scroll to zoom. Q/E rotate, arrow keys pan, plus and minus zoom, 0 resets."
        onKeyDown={onKey}
        style={{ cursor: hover ? "pointer" : "grab", touchAction: "none" }}
      />
      <div className={s.mapTools} aria-label="Map view controls">
        <span>Drag to rotate · Shift-drag to pan</span>
        <small className={s.mobileKey}>Taller + warmer = more jobs</small>
        <div className={s.row}>
          <button className={s.btn} type="button" aria-label="Rotate left" onClick={() => scene.current?.rotate(-100)}>↶</button>
          <button className={s.btn} type="button" aria-label="Rotate right" onClick={() => scene.current?.rotate(100)}>↷</button>
          <button className={s.btn} type="button" aria-label="Zoom in" onClick={() => scene.current?.zoomAt(1.25)}>+</button>
          <button className={s.btn} type="button" aria-label="Zoom out" onClick={() => scene.current?.zoomAt(0.8)}>−</button>
          <button className={s.btn} type="button" onClick={() => scene.current?.resetView()}>Reset view</button>
        </div>
      </div>
      <div className={s.labels} aria-hidden="true">
        {labels.map((l) => (
          <div key={l.id} className={`${s.label} ${l.id === p.selected ? s.labelSelected : ""}`} style={{ left: l.x, top: l.y }}>
            {l.text}
            {l.count != null && <b>{fmtNum(l.count)}</b>}
          </div>
        ))}
      </div>
    </>
  );
}

function pickLabels(sc: AtlasScene, names: Map<string, string>, selected: string | null, width: number): Label[] {
  const anchors = sc.anchors().filter((a) => a.id === selected || (a.count != null && a.count > 0));
  anchors.sort((a, b) => (b.id === selected ? 1 : 0) - (a.id === selected ? 1 : 0) || b.height - a.height);
  const max = width < 700 ? 7 : MAX_LABELS;
  const placed: { x0: number; x1: number; y0: number; y1: number }[] = [];
  const out: Label[] = [];
  for (const a of anchors) {
    if (out.length >= max) break;
    const text = names.get(a.id) ?? a.id;
    const w = 14 + text.length * 7.2 + (a.count != null ? 34 : 0);
    const box = { x0: a.x - w / 2, x1: a.x + w / 2, y0: a.y - 24, y1: a.y };
    if (box.x0 < 4 || box.x1 > width - 4 || box.y0 < 4) continue; // never a clipped label
    if (placed.some((b) => box.x0 < b.x1 && box.x1 > b.x0 && box.y0 < b.y1 && box.y1 > b.y0)) continue;
    placed.push(box);
    out.push({ id: a.id, x: a.x, y: a.y, text, count: a.count });
  }
  return out;
}
