import { useEffect, useRef, useState } from "react";
import type { Capabilities, TimelineResponse } from "./api";
import { completeFrame, loadReplay, replayIndex } from "./replay";
import { cityScaleMax } from "./scale";

export function useReplay(selectionKey: string, reducedMotion: boolean) {
  const [session, setSession] = useState<{ key: string; timeline: TimelineResponse; scale: number; priority: { id: string; max: number }[] } | null>(null);
  const [phase, setPhase] = useState<"idle" | "loading" | "ready" | "playing" | "paused" | "ended" | "gap" | "error">("idle");
  const [duration, setDuration] = useState(10);
  const [index, setIndex] = useState(0);
  const [compare, setCompare] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [errorCode, setErrorCode] = useState<string | null>(null);
  const controller = useRef<AbortController | null>(null);
  const clock = useRef({ elapsed: 0, started: 0, index: 0 });
  const active = session?.key === selectionKey ? session : null;
  const cancel = () => { controller.current?.abort(); controller.current = null; setSession(null); setPhase("idle"); setError(null); setErrorCode(null); setCompare(false); setIndex(0); clock.current = { elapsed: 0, started: 0, index: 0 }; };
  useEffect(() => { cancel(); return () => controller.current?.abort(); }, [selectionKey]); // selection owns the session
  const prepare = async (caps: Capabilities, occupation: string, mode: "shared" | "fit") => {
    controller.current?.abort();
    const abort = new AbortController(); controller.current = abort;
    setPhase("loading"); setError(null); setErrorCode(null); setCompare(false); setSession(null);
    try {
      const timeline = await loadReplay(caps, occupation, abort.signal);
      if (abort.signal.aborted) return;
      const scale = cityScaleMax(caps.quality, mode === "shared" ? "all" : occupation, "30d");
      if (scale == null) throw new Error("This release does not publish a fixed city scale for 30-day playback.");
      const priority = timeline.city_ids.map((id, i) => ({ id, max: Math.max(...timeline.frames.map(f => f.counts[i] ?? 0)) })).filter(p => p.max > 0).sort((a,b) => b.max - a.max || a.id.localeCompare(b.id));
      setSession({ key: selectionKey, timeline, scale, priority });
      setIndex(0); clock.current = { elapsed: 0, started: 0, index: 0 }; setPhase("ready");
    } catch (e) { if (!abort.signal.aborted) { setError((e as Error).message); setErrorCode((e as {code?:string}).code ?? null); setPhase("error"); } }
  };
  const begin = () => {
    if (!active) return;
    if (document.hidden) { setPhase("paused"); return; }
    if (reducedMotion) {
      const gap = active.timeline.frames.findIndex((f,i) => i > clock.current.index && !completeFrame(f));
      if (gap >= 0) { clock.current.index = gap; setIndex(gap); setPhase("gap"); return; }
      setIndex(active.timeline.frames.length - 1); setPhase("ended"); setCompare(true); return;
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
    const frames = active.timeline.frames;
    const tick = (now: number) => {
      const elapsed = clock.current.elapsed + now - clock.current.started;
      const next = Math.max(clock.current.index, replayIndex(elapsed / (duration * 1000), frames.length));
      // Inspect every crossed date, including dates omitted by visual sampling.
      for (let i = clock.current.index + 1; i <= next; i++) {
        if (!completeFrame(frames[i]!)) {
          clock.current.index = i; clock.current.elapsed = i / (frames.length - 1) * duration * 1000;
          setIndex(i); setPhase("gap"); return;
        }
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
  const seek = (date: string) => {
    if (!active) return;
    const i = active.timeline.frames.findIndex(f => f.date >= date);
    const next = i < 0 ? active.timeline.frames.length - 1 : i;
    clock.current.index = next; clock.current.elapsed = next / (active.timeline.frames.length - 1) * duration * 1000;
    setIndex(next); setPhase(completeFrame(active.timeline.frames[next]!) ? "paused" : "gap");
  };
  const replay = () => { clock.current = { elapsed: 0, started: 0, index: 0 }; setIndex(0); setCompare(false); setPhase("ready"); };
  const continueGap = () => {
    if (!active) return;
    const next = active.timeline.frames.findIndex((f,i) => i > index && completeFrame(f));
    if (next < 0) return;
    seek(active.timeline.frames[next]!.date);
  };
  const changeDuration = (seconds: number) => {
    clock.current.elapsed = clock.current.elapsed / duration * seconds;
    setDuration(seconds);
  };
  return { active, phase, duration, setDuration: changeDuration, frame: active?.timeline.frames[index], baseline: active?.timeline.frames[0], compare, setCompare, error, errorCode, prepare, begin, pause, seek, replay, continueGap, cancel };
}
