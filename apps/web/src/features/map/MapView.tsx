import "maplibre-gl/dist/maplibre-gl.css";

import workerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url";
import {
  addProtocol,
  type GeoJSONSource,
  type LngLatBoundsLike,
  Map as MapLibreMap,
  type MapGeoJSONFeature,
  NavigationControl,
  setWorkerUrl,
} from "maplibre-gl";
import { Protocol } from "pmtiles";
import { useEffect, useRef, useState } from "react";

import type { Bbox, SearchResponse } from "../../lib/api";
import { t } from "../../lib/strings";
import { buildStyle } from "./mapStyle";
import { registerMarkerImages } from "./markerImages";
import styles from "./MapView.module.css";

export type FlyTarget =
  | { kind: "point"; lon: number; lat: number; zoom?: number }
  | { kind: "bbox"; bbox: Bbox };

interface Props {
  data: SearchResponse | undefined;
  initialBbox: Bbox;
  selectedJobId: string | null;
  flyTo: FlyTarget | null;
  onViewportChange: (bbox: Bbox, zoom: number) => void;
  onSelectJob: (jobId: string) => void;
  onSameSite: (jobIds: string[]) => void;
}

const CLUSTER_MAX_ZOOM = 15;
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

function sameSpot(features: MapGeoJSONFeature[]): string[] | null {
  const ids = [...new Set(features.map((f) => String(f.properties.job_id)))];
  if (ids.length < 2) return null;
  const coords = new Set(
    features.map((f) =>
      (f.geometry as GeoJSON.Point).coordinates.map((c: number) => c.toFixed(6)).join(","),
    ),
  );
  return coords.size === 1 ? ids : null;
}

export function MapView({
  data,
  initialBbox,
  selectedJobId,
  flyTo,
  onViewportChange,
  onSelectJob,
  onSameSite,
}: Props) {
  const container = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);
  // Keep the latest callbacks without re-creating the map.
  const handlers = useRef({ onViewportChange, onSelectJob, onSameSite });
  handlers.current = { onViewportChange, onSelectJob, onSameSite };

  useEffect(() => {
    if (!container.current) return;
    ensureProtocol();
    let map: MapLibreMap;
    try {
      map = new MapLibreMap({
        container: container.current,
        style: buildStyle(),
        bounds: initialBbox as LngLatBoundsLike,
        maxZoom: 18,
        attributionControl: { compact: true },
      });
    } catch {
      setFailed(true); // e.g. WebGL unavailable
      return;
    }
    mapRef.current = map;
    map.addControl(new NavigationControl({ showCompass: false }), "bottom-right");
    const styleTimeout = window.setTimeout(() => {
      if (!map.isStyleLoaded()) setFailed(true);
    }, 15000);

    map.on("load", () => {
      window.clearTimeout(styleTimeout);
      registerMarkerImages(map);
      map.addSource("jobs", {
        type: "geojson",
        data: { type: "FeatureCollection", features: [] },
        cluster: true,
        clusterMaxZoom: CLUSTER_MAX_ZOOM,
        clusterRadius: 46,
      });
      map.addSource("jobs-aggregated", {
        type: "geojson",
        data: { type: "FeatureCollection", features: [] },
      });
      map.addLayer({
        id: "job-cluster-halo",
        type: "circle",
        source: "jobs",
        filter: ["has", "point_count"],
        paint: {
          "circle-color": "#ff79b4",
          "circle-opacity": 0.22,
          "circle-radius": ["step", ["get", "point_count"], 26, 10, 32, 50, 40],
        },
      });
      map.addLayer({
        id: "job-clusters",
        type: "circle",
        source: "jobs",
        filter: ["has", "point_count"],
        paint: {
          "circle-color": "#6a5cf0",
          "circle-radius": ["step", ["get", "point_count"], 17, 10, 22, 50, 28],
          "circle-stroke-width": 3,
          "circle-stroke-color": "#ffffff",
        },
      });
      map.addLayer({
        id: "job-cluster-count",
        type: "symbol",
        source: "jobs",
        filter: ["has", "point_count"],
        layout: {
          "text-field": ["get", "point_count_abbreviated"],
          "text-font": ["Noto Sans Medium"],
          "text-size": 14,
        },
        paint: { "text-color": "#ffffff" },
      });
      map.addLayer({
        id: "job-points",
        type: "symbol",
        source: "jobs",
        filter: ["!", ["has", "point_count"]],
        layout: {
          "icon-image": ["concat", "marker-", ["get", "workplace_type"]],
          "icon-allow-overlap": true,
          "icon-ignore-placement": true,
          // Remote always carries its label; the others gain theirs when zoomed in.
          "text-field": [
            "step",
            ["zoom"],
            ["match", ["get", "workplace_type"], "remote", "Remote", ""],
            14,
            ["match", ["get", "workplace_type"],
              "remote", "Remote", "hybrid", "Hybrid", "on_site", "On-site", ""],
          ],
          "text-font": ["Noto Sans Medium"],
          "text-size": 12,
          "text-offset": [0, 1.7],
          "text-optional": true,
        },
        paint: {
          "text-color": "#36336a",
          "text-halo-color": "#ffffff",
          "text-halo-width": 1.5,
        },
      });
      // The selected job lives in its own unclustered source, so it stays visible even when
      // its neighbours are still grouped into a cluster.
      map.addSource("job-selected", {
        type: "geojson",
        data: { type: "FeatureCollection", features: [] },
      });
      map.addLayer({
        id: "job-selected",
        type: "symbol",
        source: "job-selected",
        layout: {
          "icon-image": ["concat", "marker-", ["get", "workplace_type"], "-selected"],
          "icon-allow-overlap": true,
          "icon-ignore-placement": true,
        },
      });
      map.addLayer({
        id: "job-aggregated",
        type: "circle",
        source: "jobs-aggregated",
        paint: {
          "circle-color": "#6a5cf0",
          "circle-opacity": 0.85,
          "circle-radius": ["interpolate", ["linear"], ["get", "point_count"], 1, 14, 500, 34],
          "circle-stroke-width": 3,
          "circle-stroke-color": "#ffffff",
        },
      });
      map.addLayer({
        id: "job-aggregated-count",
        type: "symbol",
        source: "jobs-aggregated",
        layout: {
          "text-field": ["to-string", ["get", "job_count"]],
          "text-font": ["Noto Sans Medium"],
          "text-size": 13,
        },
        paint: { "text-color": "#ffffff" },
      });
      setReady(true);
      handlers.current.onViewportChange(boundsOf(map), map.getZoom());
    });

    map.on("moveend", () => handlers.current.onViewportChange(boundsOf(map), map.getZoom()));

    map.on("click", "job-clusters", async (e) => {
      const feature = e.features?.[0];
      if (!feature) return;
      const source = map.getSource("jobs") as GeoJSONSource;
      const clusterId = feature.properties.cluster_id as number;
      const zoom = await source.getClusterExpansionZoom(clusterId);
      if (map.getZoom() >= CLUSTER_MAX_ZOOM || zoom > CLUSTER_MAX_ZOOM) {
        // Still clustered at the deepest zoom: these share a location.
        const leaves = await source.getClusterLeaves(clusterId, 200, 0);
        handlers.current.onSameSite([...new Set(leaves.map((l) => String(l.properties?.job_id)))]);
        return;
      }
      map.easeTo({ center: (feature.geometry as GeoJSON.Point).coordinates as [number, number], zoom });
    });

    map.on("click", "job-aggregated", (e) => {
      const f = e.features?.[0];
      if (f) map.easeTo({ center: (f.geometry as GeoJSON.Point).coordinates as [number, number], zoom: map.getZoom() + 2 });
    });

    map.on("click", "job-points", (e) => {
      const features = map.queryRenderedFeatures(e.point, { layers: ["job-points"] });
      const shared = sameSpot(features);
      if (shared) handlers.current.onSameSite(shared);
      else if (features[0]) handlers.current.onSelectJob(String(features[0].properties.job_id));
    });

    for (const layer of ["job-clusters", "job-points", "job-aggregated"]) {
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
    const empty = { type: "FeatureCollection" as const, features: [] };
    // The API returns GeoJSON features (typed loosely in the OpenAPI schema).
    const fc = (data?.map ?? empty) as unknown as GeoJSON.FeatureCollection;
    const aggregated = data?.map_meta.mode === "clusters";
    (map.getSource("jobs") as GeoJSONSource).setData(aggregated ? empty : fc);
    (map.getSource("jobs-aggregated") as GeoJSONSource).setData(aggregated ? fc : empty);
  }, [data, ready]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    const features = ((data?.map.features ?? []) as unknown as GeoJSON.Feature[]).filter(
      (f) => selectedJobId !== null && f.properties?.job_id === selectedJobId,
    );
    (map.getSource("job-selected") as GeoJSONSource).setData({
      type: "FeatureCollection",
      features: data?.map_meta.mode === "clusters" ? [] : features,
    });
  }, [selectedJobId, data, ready]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready || !flyTo) return;
    if (flyTo.kind === "bbox") map.fitBounds(flyTo.bbox as LngLatBoundsLike, { padding: 24 });
    else map.easeTo({ center: [flyTo.lon, flyTo.lat], zoom: flyTo.zoom ?? Math.max(map.getZoom(), 14) });
  }, [flyTo, ready]);

  return (
    <div className={styles.wrap}>
      <div ref={container} className={styles.map} aria-label={t.mapAreaTitle} role="region" />
      {failed && (
        <div className={styles.failed} role="alert">
          <strong>{t.mapErrorTitle}</strong>
          <span>{t.mapErrorBody}</span>
        </div>
      )}
    </div>
  );
}
