import { useEffect, useRef, useState } from "react";
import { atlasGet, type Capabilities, type TimelineResponse } from "./api";
import { completeFrame, loadOverview, type Overview, type ReplayFrame, replayIndex, replayProgress } from "./replay";
import { cityScaleMax } from "./scale";
import { daysBetween } from "./state";

type Phase = "idle" | "loading" | "ready" | "playing" | "paused" | "ended" | "gap" | "error";

export function useReplay(selectionKey: string, reducedMotion: boolean) {
  const [session, setSession] = useState<{ key: string; overview: Overview; scale: number; occupation: string } | null>(null);
  const [phase, setPhase] = useState<Phase>("idle");
  const [duration, setDuration] = useState(10);
  const [index, setIndex] = useState(0);
  // An exact frame for a date between sampled frames (seeking), fetched on demand.
  const [exact, setExact] = useState<{ date: string; frame: ReplayFrame | null } | null>(null);
  const [compare, setCompare] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [errorCode, setErrorCode] = useState<string | null>(null);
  const controller = useRef<AbortController | null>(null);
  const seeking = useRef<AbortController | null>(null);
  const retryLast = useRef<() => void>(() => {});
  const clock = useRef({ elapsed: 0, started: 0, index: 0 });
  const active = session?.key === selectionKey ? session : null;
  const fail = (e: unknown) => { setError((e as Error).message); setErrorCode((e as { code?: string }).code ?? null); };
  const cancel = () => {
    controller.current?.abort(); controller.current = null; seeking.current?.abort(); seeking.current = null;
    setSession(null); setPhase("idle"); setError(null); setErrorCode(null); setCompare(false); setIndex(0); setExact(null);
    clock.current = { elapsed: 0, started: 0, index: 0 };
  };
  useEffect(() => { cancel(); return () => { controller.current?.abort(); seeking.current?.abort(); }; }, [selectionKey]); // selection owns the session
  const prepare = async (caps: Capabilities, occupation: string, mode: "shared" | "fit") => {
    controller.current?.abort(); seeking.current?.abort();
    const abort = new AbortController(); controller.current = abort;
    retryLast.current = () => void prepare(caps, occupation, mode);
    setPhase("loading"); setError(null); setErrorCode(null); setCompare(false); setSession(null); setExact(null);
    try {
      const overview = await loadOverview(caps, occupation, abort.signal);
      if (abort.signal.aborted) return;
      const scale = cityScaleMax(caps.quality, mode === "shared" ? "all" : occupation, "30d");
      if (scale == null) throw new Error("This release does not publish a fixed city scale for 30-day playback.");
      setSession({ key: selectionKey, overview, scale, occupation });
      setIndex(0); clock.current = { elapsed: 0, started: 0, index: 0 }; setPhase("ready");
    } catch (e) { if (!abort.signal.aborted) { fail(e); setPhase("error"); } }
  };
  const at = (i: number) => {
    if (!active) return;
    clock.current.index = i; clock.current.elapsed = replayProgress(active.overview.frames, i) * duration * 1000;
    setIndex(i);
  };
  const begin = () => {
    if (!active) return;
    seeking.current?.abort(); setExact(null); setError(null);
    if (document.hidden) { setPhase("paused"); return; }
    const frames = active.overview.frames;
    if (reducedMotion) {
      const gap = frames.findIndex((f, i) => i > clock.current.index && !completeFrame(f));
      if (gap >= 0) { at(gap); setPhase("gap"); return; }
      setIndex(frames.length - 1); setPhase("ended"); setCompare(true); return;
    }
    clock.current.started = performance.now(); setPhase("playing");
  };
  const pause = () => {
    if (phase === "playing") clock.current.elapsed += performance.now() - clock.current.started;
    setPhase("paused");
  };
  useEffect(() => {
    if (phase !== "playing" || !active) return;
    let raf = 0;
    const frames = active.overview.frames;
    const tick = (now: number) => {
      const elapsed = clock.current.elapsed + now - clock.current.started;
      const next = Math.max(clock.current.index, replayIndex(elapsed / (duration * 1000), frames));
      // Every incomplete stretch starts with a frame of its own, so crossing one stops here.
      for (let i = clock.current.index + 1; i <= next; i++) {
        if (!completeFrame(frames[i]!)) { at(i); setPhase("gap"); return; }
      }
      if (next !== clock.current.index) { clock.current.index = next; setIndex(next); }
      if (elapsed >= duration * 1000) { setIndex(frames.length - 1); setPhase("ended"); setCompare(true); return; }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    const hidden = () => { if (document.hidden) pause(); };
    document.addEventListener("visibilitychange", hidden);
    return () => { cancelAnimationFrame(raf); document.removeEventListener("visibilitychange", hidden); };
  }, [phase, active, duration]);
  /** Sampled dates show their frame; any other date shows the last sampled date until its own
   * exact frame arrives (never interpolated numbers). */
  const seek = (date: string) => {
    if (!active) return;
    seeking.current?.abort(); seeking.current = null; setError(null);
    const { overview } = active, frames = overview.frames;
    const target = date < overview.start ? overview.start : date > overview.end ? overview.end : date;
    let i = frames.length - 1;
    while (i > 0 && frames[i]!.date > target) i--;
    at(i);
    if (frames[i]!.date === target) { setExact(null); setPhase(completeFrame(frames[i]!) ? "paused" : "gap"); return; }
    // keep playback time at the chosen date, so continuing starts from there
    clock.current.elapsed = daysBetween(overview.start, target) / daysBetween(overview.start, overview.end) * duration * 1000;
    setExact({ date: target, frame: null }); setPhase("paused");
    const abort = new AbortController(); seeking.current = abort;
    retryLast.current = () => seek(target);
    atlasGet<TimelineResponse>("/timeline", { dataset: "real", release: overview.release_id, occupation: overview.occupation, window: "30d", start: target, end: target }, abort.signal)
      .then(day => {
        if (abort.signal.aborted) return;
        const f = day.frames[0];
        if (day.release_id !== overview.release_id || day.occupation !== overview.occupation || day.window !== "30d" || f?.date !== target)
          throw new Error("History response does not match this selection.");
        const byId = new Map(day.city_ids.map((id, k) => [id, f.counts[k] ?? null]));
        const frame = { ...f, counts: overview.city_ids.map(id => byId.get(id) ?? null) };
        setExact({ date: target, frame }); setPhase(completeFrame(frame) ? "paused" : "gap");
      })
      .catch(e => { if (!abort.signal.aborted) fail(e); });
  };
  const replay = () => { setExact(null); clock.current = { elapsed: 0, started: 0, index: 0 }; setIndex(0); setCompare(false); setPhase("ready"); };
  const continueGap = () => {
    if (!active) return;
    const from = exact?.date ?? active.overview.frames[index]!.date;
    const next = active.overview.frames.findIndex(f => f.date > from && completeFrame(f));
    if (next < 0) return;
    setExact(null); at(next); setPhase("paused");
  };
  const changeDuration = (seconds: number) => {
    clock.current.elapsed = clock.current.elapsed / duration * seconds;
    setDuration(seconds);
  };
  const frame = exact ? exact.frame ?? active?.overview.frames[index] : active?.overview.frames[index];
  return {
    active, phase, duration, setDuration: changeDuration, frame, loadingDate: exact && !exact.frame ? exact.date : null,
    baseline: active?.overview.frames[0], compare, setCompare, error, errorCode, prepare, begin, pause, seek, replay,
    continueGap, cancel, retry: () => retryLast.current(),
  };
}
