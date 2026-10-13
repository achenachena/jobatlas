import "maplibre-gl/dist/maplibre-gl.css";

import workerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url";
import {
  addProtocol,
  AttributionControl,
  type GeoJSONSource,
  type LngLatBoundsLike,
  Map as MapLibreMap,
  type MapGeoJSONFeature,
  setWorkerUrl,
} from "maplibre-gl";
import { Protocol } from "pmtiles";
import { type ReactNode, useEffect, useRef, useState } from "react";

import { Icon } from "../../components/Icon";
import type { Bbox, SearchResponse } from "../../lib/api";
import { t } from "../../lib/strings";
import { INK } from "../../theme/palette";
import { groupByLocation } from "./locations";
import { buildStyle, FONT_DISPLAY, FONT_HEAVY } from "./mapStyle";
import { BADGE_CENTER_OFFSET, MARKER_ICON_OFFSET, provideImages } from "./markerImages";
import styles from "./MapView.module.css";

export type FlyTarget =
  | { kind: "point"; lon: number; lat: number; zoom?: number }
  | { kind: "bbox"; bbox: Bbox };

/** What the map highlights: one job's badge, or a same-address stack. */
export interface MapSelection {
  lon: number;
  lat: number;
  workplace: string;
  count: number;
  /** Company's single city office rather than a job-stated address. */
  inferred?: boolean;
}

interface Props {
  data: SearchResponse | undefined;
  initialBbox: Bbox;
  selection: MapSelection | null;
  /** Content shown next to the selection (desktop detail card / same-site picker). */
  popover: ReactNode;
  flyTo: FlyTarget | null;
  onViewportChange: (bbox: Bbox, zoom: number) => void;
  onSelectJob: (jobId: string, at: [number, number]) => void;
  onStack: (jobIds: string[], at: [number, number]) => void;
  onBackgroundClick: () => void;
}

const CLUSTER_MAX_ZOOM = 15;
/** 2.5D manga map: one fixed oblique angle (tilted, street grid square to the screen). The
 * reader can pan and zoom, never rotate or tilt. */
const VIEW = { pitch: 52, bearing: -17 };
const START = { center: [-79.386, 43.6475] as [number, number], zoom: 14 };
const INTERACTIVE = ["job-clusters", "job-stacks", "job-points", "job-aggregated"];
/** Space kept clear of the floating search dock and the bottom bar. */
const SAFE = { top: 84, bottom: 76, side: 16 };
let protocolRegistered = false;

function ensureProtocol() {
  if (!protocolRegistered) {
    // MapLibre 6 parses tiles in a module worker; Vite bundles it (with its shared chunk).
    setWorkerUrl(workerUrl);
    addProtocol("pmtiles", new Protocol().tile);
    protocolRegistered = true;
  }
}

function boundsOf(map: MapLibreMap): Bbox {
  const b = map.getBounds();
  return [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()];
}

const pointOf = (f: MapGeoJSONFeature) => (f.geometry as GeoJSON.Point).coordinates as [number, number];
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/** Text sitting on the stack badge, whose centre is BADGE_CENTER_OFFSET × scale px above the point. */
const STACK_TEXT_SIZE = 13;
const stackTextOffset = (scale: number): [number, number] => [0, (-BADGE_CENTER_OFFSET * scale) / STACK_TEXT_SIZE];

const emptyFc = (): GeoJSON.FeatureCollection => ({ type: "FeatureCollection", features: [] });

export function MapView({
  data,
  initialBbox,
  selection,
  popover,
  flyTo,
  onViewportChange,
  onSelectJob,
  onStack,
  onBackgroundClick,
}: Props) {
  const container = useRef<HTMLDivElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const pingRef = useRef<HTMLSpanElement>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);
  // Keep the latest callbacks without re-creating the map.
  const handlers = useRef({ onViewportChange, onSelectJob, onStack, onBackgroundClick });
  handlers.current = { onViewportChange, onSelectJob, onStack, onBackgroundClick };

  useEffect(() => {
    if (!container.current) return;
    ensureProtocol();
    let map: MapLibreMap;
    try {
      map = new MapLibreMap({
        container: container.current,
        style: buildStyle(),
        center: START.center,
        zoom: START.zoom,
        pitch: VIEW.pitch,
        bearing: VIEW.bearing,
        minPitch: VIEW.pitch,
        maxPitch: VIEW.pitch,
        dragRotate: false,
        pitchWithRotate: false,
        touchPitch: false,
        maxZoom: 18,
        attributionControl: false,
      });
    } catch {
      setFailed(true); // e.g. WebGL unavailable
      return;
    }
    mapRef.current = map;
    // Dev builds expose the map so scripts/screenshots.mjs can drive real interactions.
    if (import.meta.env.DEV) (window as unknown as { __map: MapLibreMap }).__map = map;
    map.addControl(new AttributionControl({ compact: true }), "bottom-right");
    provideImages(map);
    // The camera (and so the viewport) is known before any tile loads: search right away.
    handlers.current.onViewportChange(boundsOf(map), map.getZoom());
    // "Couldn't load" only when the map really fails: a style/tile-source error before the
    // first load, or no load at all within 45 s (slow machines can take a while for 3D).
    let loaded = false;
    const fail = () => !loaded && setFailed(true);
    map.on("error", (e) => {
      const sourceId = (e as unknown as { sourceId?: string }).sourceId;
      if (!sourceId || sourceId === "protomaps") fail();
    });
    const styleTimeout = window.setTimeout(fail, 45000);

    map.on("load", () => {
      loaded = true;
      window.clearTimeout(styleTimeout);
      const countText = {
        "text-font": [FONT_DISPLAY],
        "text-size": STACK_TEXT_SIZE,
        "text-allow-overlap": true,
        "text-ignore-placement": true,
      };

      map.addSource("jobs", {
        type: "geojson",
        data: emptyFc(),
        cluster: true,
        clusterMaxZoom: CLUSTER_MAX_ZOOM,
        clusterRadius: 52,
        clusterProperties: { jobs: ["+", ["get", "count"]] },
      });
      map.addSource("jobs-aggregated", { type: "geojson", data: emptyFc() });
      map.addSource("job-hover", { type: "geojson", data: emptyFc() });
      map.addSource("job-selected", { type: "geojson", data: emptyFc() });

      const clusterIcon = (count: unknown) =>
        ["step", count, "cluster-s", 10, "cluster-m", 50, "cluster-l"] as unknown as string;

      // Region clusters: count plate on the navigation star.
      map.addLayer({
        id: "job-clusters",
        type: "symbol",
        source: "jobs",
        filter: ["has", "point_count"],
        layout: {
          "icon-image": clusterIcon(["get", "jobs"]),
          "icon-allow-overlap": true,
          // Clusters never hide city plates (Toronto sits under the downtown cluster).
          "icon-ignore-placement": true,
          "text-field": ["to-string", ["get", "jobs"]],
          "text-font": [FONT_DISPLAY],
          "text-size": ["step", ["get", "jobs"], 13, 10, 15, 50, 17],
          "text-allow-overlap": true,
          "text-ignore-placement": true,
        },
        paint: { "text-color": "#ffffff" },
      });
      // Server-side aggregation (very large result sets) uses the same emblem.
      map.addLayer({
        id: "job-aggregated",
        type: "symbol",
        source: "jobs-aggregated",
        layout: {
          "icon-image": clusterIcon(["get", "job_count"]),
          "icon-allow-overlap": true,
          "icon-ignore-placement": true,
          "text-field": ["to-string", ["get", "job_count"]],
          "text-font": [FONT_DISPLAY],
          "text-size": 14,
          "text-allow-overlap": true,
        },
        paint: { "text-color": "#ffffff" },
      });
      // Same address: stacked badges with the count, tip on the real point.
      map.addLayer({
        id: "job-stacks",
        type: "symbol",
        source: "jobs",
        filter: ["all", ["!", ["has", "point_count"]], [">", ["get", "count"], 1]],
        layout: {
          "icon-image": "stack",
          "icon-anchor": "bottom",
          "icon-offset": MARKER_ICON_OFFSET.default,
          "icon-allow-overlap": true,
          "text-field": ["to-string", ["get", "count"]],
          "text-offset": stackTextOffset(1),
          ...countText,
        },
        paint: { "text-color": "#ffffff" },
      });
      map.addLayer({
        id: "job-points",
        type: "symbol",
        source: "jobs",
        filter: ["all", ["!", ["has", "point_count"]], ["==", ["get", "count"], 1]],
        layout: {
          "icon-image": ["concat", "marker-", ["get", "workplace_type"],
            ["case", ["==", ["get", "inferred"], true], "-inferred", ""]],
          "icon-anchor": "bottom",
          "icon-offset": MARKER_ICON_OFFSET.default,
          "icon-allow-overlap": true,
          // Street level: the workplace word sits beside the badge as well.
          "text-field": [
            "step", ["zoom"], "",
            15.5,
            ["match", ["get", "workplace_type"],
              "remote", t.workplaces.remote, "hybrid", t.workplaces.hybrid,
              "on_site", t.workplaces.on_site, t.workplaces.unknown],
          ],
          "text-font": [FONT_HEAVY],
          "text-size": 12,
          "text-anchor": "left",
          "text-offset": [1.45, -1.9],
          "text-optional": true,
        },
        paint: {
          "text-color": INK,
          "text-halo-color": "#ffffff",
          "text-halo-width": 2,
        },
      });
      for (const [id, source, state, scale] of [
        ["job-hover", "job-hover", "hover", 1.1],
        ["job-selected", "job-selected", "selected", 1.2],
      ] as const) {
        map.addLayer({
          id,
          type: "symbol",
          source,
          layout: {
            "icon-image": [
              "case",
              [">", ["get", "count"], 1],
              `stack-${state}`,
              ["concat", "marker-", ["get", "workplace_type"],
                ["case", ["==", ["get", "inferred"], true], "-inferred", ""], `-${state}`],
            ],
            "icon-anchor": "bottom",
            "icon-offset": MARKER_ICON_OFFSET[state],
            "icon-allow-overlap": true,
            "icon-ignore-placement": true,
            "text-field": ["case", [">", ["get", "count"], 1], ["to-string", ["get", "count"]], ""],
            "text-offset": stackTextOffset(scale),
            ...countText,
          },
          paint: { "text-color": "#ffffff" },
        });
      }
      setReady(true);
      handlers.current.onViewportChange(boundsOf(map), map.getZoom());
    });

    map.touchZoomRotate.disableRotation();
    map.keyboard.disableRotation();

    map.on("moveend", () => handlers.current.onViewportChange(boundsOf(map), map.getZoom()));

    map.on("click", "job-clusters", async (e) => {
      const feature = e.features?.[0];
      if (!feature) return;
      const source = map.getSource("jobs") as GeoJSONSource;
      const zoom = await source.getClusterExpansionZoom(feature.properties.cluster_id as number);
      map.easeTo({ center: pointOf(feature), zoom: Math.min(zoom + 0.3, 18) });
    });
    map.on("click", "job-aggregated", (e) => {
      const f = e.features?.[0];
      if (f) map.easeTo({ center: pointOf(f), zoom: map.getZoom() + 2 });
    });
    map.on("click", "job-stacks", (e) => {
      const f = e.features?.[0];
      if (f) handlers.current.onStack(JSON.parse(String(f.properties.job_ids)) as string[], pointOf(f));
    });
    map.on("click", "job-points", (e) => {
      const f = e.features?.[0];
      if (f) handlers.current.onSelectJob(String(f.properties.job_id), pointOf(f));
    });
    map.on("click", (e) => {
      const hits = map.queryRenderedFeatures(e.point, { layers: INTERACTIVE.filter((l) => map.getLayer(l)) });
      if (hits.length === 0) handlers.current.onBackgroundClick();
    });

    const hover = (f: MapGeoJSONFeature | null) => {
      const src = map.getSource("job-hover") as GeoJSONSource | undefined;
      src?.setData(f ? { type: "FeatureCollection", features: [{ type: "Feature", geometry: f.geometry, properties: f.properties }] } : emptyFc());
    };
    for (const layer of ["job-points", "job-stacks"]) {
      map.on("mousemove", layer, (e) => {
        map.getCanvas().style.cursor = "pointer";
        hover(e.features?.[0] ?? null);
      });
      map.on("mouseleave", layer, () => {
        map.getCanvas().style.cursor = "";
        hover(null);
      });
    }
    for (const layer of ["job-clusters", "job-aggregated"]) {
      map.on("mouseenter", layer, () => (map.getCanvas().style.cursor = "pointer"));
      map.on("mouseleave", layer, () => (map.getCanvas().style.cursor = ""));
    }

    return () => {
      window.clearTimeout(styleTimeout);
      map.remove();
      mapRef.current = null;
    };
    // The map instance is created once and reused (DEVELOPMENT.md §10).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Push results into the map.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    // The API returns GeoJSON features (typed loosely in the OpenAPI schema).
    const features = (data?.map.features ?? []) as unknown as GeoJSON.Feature[];
    const aggregated = data?.map_meta.mode === "clusters";
    (map.getSource("jobs") as GeoJSONSource).setData(aggregated ? emptyFc() : groupByLocation(features));
    (map.getSource("jobs-aggregated") as GeoJSONSource).setData(
      aggregated ? { type: "FeatureCollection", features } : emptyFc(),
    );
  }, [data, ready]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    (map.getSource("job-selected") as GeoJSONSource).setData(
      selection
        ? {
            type: "FeatureCollection",
            features: [{
              type: "Feature",
              geometry: { type: "Point", coordinates: [selection.lon, selection.lat] },
              properties: {
                workplace_type: selection.workplace,
                count: selection.count,
                inferred: selection.inferred === true,
              },
            }],
          }
        : emptyFc(),
    );
  }, [selection, ready]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready || !flyTo) return;
    if (flyTo.kind === "bbox") map.fitBounds(flyTo.bbox as LngLatBoundsLike, { padding: 40 });
    else map.easeTo({ center: [flyTo.lon, flyTo.lat], zoom: flyTo.zoom ?? Math.max(map.getZoom(), 14) });
  }, [flyTo, ready]);

  // Keep the popover beside the selected point: prefer the right side, flip left near the
  // edge, clamp inside the area left free by the search dock and bottom bar.
  const showPopover = Boolean(popover && selection);
  const selLon = selection?.lon;
  const selLat = selection?.lat;
  useEffect(() => {
    const map = mapRef.current;
    const el = popRef.current;
    const wrap = container.current;
    if (!map || !ready || !showPopover || !el || !wrap || selLon == null || selLat == null) return;

    // If the point hides under the dock or the bottom bar, nudge the map once.
    const p0 = map.project([selLon, selLat]);
    const H0 = wrap.clientHeight;
    const W0 = wrap.clientWidth;
    const dy = p0.y - BADGE_CENTER_OFFSET * 2 < SAFE.top ? p0.y - BADGE_CENTER_OFFSET * 2 - SAFE.top - 24 : p0.y > H0 - SAFE.bottom ? p0.y - (H0 - SAFE.bottom) + 24 : 0;
    const dx = p0.x < SAFE.side + 24 ? p0.x - SAFE.side - 48 : p0.x > W0 - SAFE.side - 24 ? p0.x - (W0 - SAFE.side) + 48 : 0;
    if (dx || dy) map.panBy([dx, dy], { duration: 200 });

    const place = () => {
      const p = map.project([selLon, selLat]);
      const W = wrap.clientWidth;
      const H = wrap.clientHeight;
      const w = el.offsetWidth;
      const h = el.offsetHeight;
      const gap = 30;
      const badgeY = p.y - BADGE_CENTER_OFFSET;
      const fitsRight = p.x + gap + w + SAFE.side <= W;
      const fitsLeft = p.x - gap - w >= SAFE.side;
      const side = fitsRight || !fitsLeft ? "right" : "left";
      const x = clamp(side === "right" ? p.x + gap : p.x - gap - w, SAFE.side, Math.max(SAFE.side, W - w - SAFE.side));
      const y = clamp(badgeY - 56, SAFE.top, Math.max(SAFE.top, H - h - SAFE.bottom));
      el.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
      el.dataset.side = side;
      el.style.setProperty("--pointer-y", `${Math.round(clamp(badgeY - y, 22, h - 22))}px`);
      if (pingRef.current) pingRef.current.style.transform = `translate(${Math.round(p.x)}px, ${Math.round(badgeY)}px)`;
    };
    place();
    map.on("move", place);
    const ro = new ResizeObserver(place);
    ro.observe(el);
    ro.observe(wrap);
    return () => {
      map.off("move", place);
      ro.disconnect();
    };
  }, [ready, showPopover, selLon, selLat]);

  // Phones (and jobs opened without a popover): the card covers the lower part of the screen,
  // so make sure the selected badge sits in the strip between the dock and the card.
  useEffect(() => {
    const map = mapRef.current;
    const wrap = container.current;
    if (!map || !ready || showPopover || selLon == null || selLat == null || !wrap) return;
    const H = wrap.clientHeight;
    const p = map.project([selLon, selLat]);
    const top = 150;
    const bottom = H * 0.38;
    if (p.y - BADGE_CENTER_OFFSET * 2 < top || p.y > bottom || p.x < 24 || p.x > wrap.clientWidth - 24) {
      map.easeTo({ center: [selLon, selLat], offset: [0, Math.round((top + bottom) / 2 + BADGE_CENTER_OFFSET - H / 2)], duration: 240 });
    }
  }, [ready, showPopover, selLon, selLat]);

  const zoomBy = (d: number) => mapRef.current?.easeTo({ zoom: mapRef.current.getZoom() + d, duration: 200 });
  const locate = () => {
    const map = mapRef.current;
    if (!map) return;
    const home = () => map.easeTo({ ...START, ...VIEW, duration: 600 });
    if (!navigator.geolocation) return home();
    navigator.geolocation.getCurrentPosition(
      (pos) => map.easeTo({ center: [pos.coords.longitude, pos.coords.latitude], zoom: 13 }),
      home,
      { timeout: 8000, maximumAge: 300_000 },
    );
  };

  return (
    <div className={styles.wrap}>
      <div ref={container} className={styles.map} aria-label={t.mapAreaTitle} role="region" />
      <div className={styles.frame} aria-hidden="true" />
      {showPopover && (
        <>
          <span ref={pingRef} key={`${selLon},${selLat}`} className={styles.ping} aria-hidden="true" />
          <div ref={popRef} className={styles.popover}>
            {popover}
          </div>
        </>
      )}
      <div className={styles.controls}>
        <button type="button" className={styles.control} onClick={locate} aria-label={t.locate} title={t.locate}>
          <Icon name="locate" />
        </button>
        <div className={styles.zoom}>
          <button type="button" className={styles.control} onClick={() => zoomBy(1)} aria-label={t.zoomIn} title={t.zoomIn}>
            <Icon name="plus" />
          </button>
          <button type="button" className={styles.control} onClick={() => zoomBy(-1)} aria-label={t.zoomOut} title={t.zoomOut}>
            <Icon name="minus" />
          </button>
        </div>
      </div>
      {failed && (
        <div className={styles.failed} role="alert">
          <Icon name="star" className={styles.failedStar} />
          <div>
            <strong>{t.mapErrorTitle}</strong>
            <span>{t.mapErrorBody}</span>
          </div>
        </div>
      )}
    </div>
  );
}
