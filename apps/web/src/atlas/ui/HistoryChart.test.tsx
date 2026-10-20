import {cleanup,render,screen} from "@testing-library/react";
import {afterEach,expect,it} from "vitest";
import type {TimelineResponse} from "../api";
import {HistoryChart} from "./HistoryChart";
afterEach(cleanup);
function timeline(counts:(number|null)[]):TimelineResponse {
  return {dataset_id:"jobbank",data_mode:"real",release_id:"test",metric:"new_postings",occupation:"all",window:"30d",reporting_timezone:"America/Toronto",start:"2026-01-01",end:"2026-01-06",max_count:999,city_ids:["city"],frames:counts.map((count,i)=>({date:`2026-01-0${i+1}`,counts:[count],quality:count==null?"missing":"complete",days_available:30,backfilled_days:0,notes:[],national:count}))};
}
it("breaks the line at unknown observations and never includes future data",()=>{
  const {container}=render(<HistoryChart timeline={timeline([10,20,null,30,40,999])} cityId="city" day="2026-01-05"/>);
  const chart=screen.getByRole("img");
  expect(chart.getAttribute("aria-label")).toContain("Peak 40");
  expect(chart.getAttribute("aria-label")).toContain("Gaps are not connected");
  expect(container.querySelector("g path")!.getAttribute("d")!.match(/L/g)).toHaveLength(2);
});
it("keeps zero history distinct from an unavailable city",()=>{
  const {rerender}=render(<HistoryChart timeline={timeline([0,0])} cityId="city" day="2026-01-02"/>);
  expect(screen.getByRole("img").getAttribute("aria-label")).toContain("Peak 0 postings");
  rerender(<HistoryChart timeline={timeline([0,0])} cityId="absent" day="2026-01-02"/>);
  expect(screen.queryByRole("img")).toBeNull();
  expect(screen.getByText("No complete history available for this city.")).toBeTruthy();
});
