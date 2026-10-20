import {cleanup,render,screen} from "@testing-library/react";
import {afterEach,expect,it} from "vitest";
import type {SeriesResponse} from "../api";
import {HistoryChart} from "./HistoryChart";
afterEach(cleanup);
function points(counts:(number|null)[], quality: "complete"|"partial" = "complete"):SeriesResponse["points"] {
  return counts.map((count,i)=>({date:`2026-01-0${i+1}`,count,quality:count==null?"missing":quality,backfilled_days:0}));
}
it("breaks the line at unknown observations and never includes future data",()=>{
  const {container}=render(<HistoryChart points={points([10,20,null,30,40,999])} day="2026-01-05"/>);
  const chart=screen.getByRole("img");
  expect(chart.getAttribute("aria-label")).toContain("Peak 40");
  expect(chart.getAttribute("aria-label")).toContain("Gaps are not connected");
  expect(container.querySelector("g path")!.getAttribute("d")!.match(/L/g)).toHaveLength(2);
});
it("keeps zero history distinct from an unavailable city, and partial windows are unknown",()=>{
  const {rerender}=render(<HistoryChart points={points([0,0])} day="2026-01-02"/>);
  expect(screen.getByRole("img").getAttribute("aria-label")).toContain("Peak 0 postings");
  rerender(<HistoryChart points={points([5,7],"partial")} day="2026-01-02"/>);
  expect(screen.queryByRole("img")).toBeNull();
  expect(screen.getByText("No complete history available for this city.")).toBeTruthy();
});
