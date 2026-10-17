"""/api/v2/atlas (spec §9). Sync handlers run in FastAPI's thread pool with sync sessions.

Real data that is not configured is a distinct 503 DATA_SOURCE_NOT_CONFIGURED, never an empty
or all-zero success, and never a silent switch to demo data. Parameters are whitelisted and
ranges are bounded.
"""

from __future__ import annotations

from collections import Counter, defaultdict
from collections.abc import Iterator
from datetime import date, timedelta
from functools import lru_cache
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response
from sqlalchemy.orm import Session

from app.atlas import ats, groups, jobbank
from app.atlas import datasets as ds
from app.atlas.cities import GEONAMES_ATTRIBUTION
from app.atlas.metrics import GROUP_SCALE_SQL, current_release, grouping_version, scale_maxima
from app.atlas.models import AtlasSource
from app.atlas.occupations import PUBLIC_IDS
from app.atlas.permissions import OGL_ATTRIBUTION, admitted, source
from app.atlas.schemas import (
    Capabilities,
    CitiesResponse,
    CityCount,
    FrameResponse,
    NationalSummary,
    SeriesPoint,
    SeriesResponse,
    SourceInfo,
    SourcesResponse,
    TimelineFrame,
    TimelineResponse,
    VersionResponse,
)
from app.atlas.windows import DEFAULT_WINDOW, WINDOWS, window
from app.db.session import sync_session

router = APIRouter(prefix="/atlas", tags=["atlas"])

# "real" is Job Bank (kept for compatibility); "ats" is Employer boards. Never added together.
DatasetParam = Literal["real", "ats", "demo"]
DATASET_IDS = {"real": ds.REAL_DATASET, "ats": ds.ATS_DATASET}
WindowParam = Literal["1d", "7d", "30d"]
Occ = Literal[PUBLIC_IDS]  # type: ignore[valid-type]
MAX_TIMELINE_DAYS = 400
NATURAL_EARTH = "Map outlines: Natural Earth (public domain)."
NOT_CONFIGURED = (
    "Real data source is not connected yet (no published release of an admitted source)."
)
REFRESH = {ds.REAL_DATASET: "monthly", ds.ATS_DATASET: "hourly"}
PUBLICATION = {
    ds.REAL_DATASET: "monthly: Job Bank publishes each month's postings a few days after it ends",
    ds.ATS_DATASET: "hourly: employer job boards are re-read about every hour; figures run "
    "through the last complete day (America/Toronto)",
}
# An Employer boards occupation is offered only with at least this many postings nationally in
# the last 30 days: about five a week, below which every city shows 0 or 1 and the choice
# says nothing (in October 2026: Software development 381, Human resources 32, the rest 0).
MIN_OCCUPATION_POSTINGS = 20


def get_session() -> Iterator[Session]:
    with sync_session() as session:
        yield session


def _open(session: Session, dataset: str, release: str | None = None):
    if dataset == "demo":
        demo = ds.DemoDataset(session)
        if not demo.available:
            raise HTTPException(503, {"code": "DEMO_UNAVAILABLE",
                                      "message": "city catalogue not loaded"})  # fmt: skip
        return demo
    real = ds.RealDataset.open(session, DATASET_IDS[dataset], release)
    if real is None:
        if release:
            raise HTTPException(404, {"code": "RELEASE_NOT_FOUND", "message": "release not served"})
        raise HTTPException(503, {"code": "DATA_SOURCE_NOT_CONFIGURED", "message": NOT_CONFIGURED})
    return real


def _check_day(info: ds.Info, d: date) -> None:
    if d < info.history_start or d > info.data_through:
        span = f"{info.history_start}..{info.data_through}"
        raise HTTPException(
            400, {"code": "DATE_OUT_OF_RANGE", "message": f"date must be within {span}"}
        )


def _cutoff(info: ds.Info, d: date):
    return info.cutoff if (info.cutoff is not None and d == info.data_through) else None


@router.get("/capabilities", response_model=Capabilities)
def capabilities(
    dataset: DatasetParam = "real", session: Session = Depends(get_session)
) -> Capabilities:
    base = {"metrics": ["new_postings"], "windows": list(WINDOWS),
            "default_window": DEFAULT_WINDOW, "geo_levels": ["city"]}  # fmt: skip
    dataset_id = DATASET_IDS.get(dataset, "demo-v1")
    try:
        d = _open(session, dataset)
    except HTTPException as exc:
        return Capabilities(
            dataset_id=dataset_id, data_mode="not_configured",
            release_id=None, reason=exc.detail["message"], history_start=None, data_through=None,
            partial_latest_day=False, gaps=[], playback=False,
            playback_reason="no data", stale=False, publication="—", quality={},
            occupations=ds.occupations_payload(), refresh=REFRESH.get(dataset_id, "on_request"),
            backfilled=[], employers=None, platforms=[], attribution=None, **base,
        )  # fmt: skip
    info = d.info()
    span = (info.data_through - info.history_start).days + 1
    playback = span >= 2
    return Capabilities(
        dataset_id=info.dataset_id, data_mode=info.data_mode, release_id=info.release_id,
        history_start=info.history_start.isoformat(), data_through=info.data_through.isoformat(),
        partial_latest_day=info.cutoff is not None, gaps=info.gaps, playback=playback,
        playback_reason=None if playback else "history shorter than two days",
        stale=info.stale, quality=info.quality,
        publication=PUBLICATION.get(info.dataset_id, "generated on request (demo)"),
        refresh=REFRESH.get(info.dataset_id, "on_request"),
        backfilled=[{"start": info.backfilled[0].isoformat(),
                     "end": info.backfilled[1].isoformat(),
                     "reason": "backfilled: counted from postings still open when collection "
                               "started (closed ones are missing)"}] if info.backfilled else [],
        **_dataset_facts(session, info), **base,
    )  # fmt: skip


def _dataset_facts(session: Session, info: ds.Info) -> dict:
    """Occupations offered, coverage and credit line for one dataset."""
    if info.dataset_id == ds.ATS_DATASET:
        names = ats.platforms(info.quality.get("counted_sources") or info.source_set_id.split("+"))
        return {"occupations": _ats_occupations(info.release_id),
                "employers": info.quality.get("employers"), "platforms": names,
                "attribution": ats.attribution(names) if names else None}  # fmt: skip
    attribution = None
    if info.dataset_id == ds.REAL_DATASET:
        attribution = source(session, jobbank.SOURCE_KEY).attribution
    return {"occupations": ds.occupations_payload(), "employers": None, "platforms": [],
            "attribution": attribution}  # fmt: skip


@lru_cache(maxsize=32)
def _ats_occupations(release_id: str) -> list[dict]:
    with sync_session() as session:
        totals = _open(session, "ats", release_id).occupation_totals(30)
    return ds.occupations_payload({o for o, n in totals.items() if n >= MIN_OCCUPATION_POSTINGS})


@router.get("/cities", response_model=CitiesResponse)
def cities(
    dataset: DatasetParam = "real",
    release: str | None = Query(None, max_length=64),
    session: Session = Depends(get_session),
):
    d = _open(session, dataset, release)
    info = d.info()
    grouping = grouping_version(session)
    cities_out, groups_out = _grouped(info.release_id, dataset, grouping)
    return CitiesResponse(dataset_id=info.dataset_id, data_mode=info.data_mode,
                          release_id=info.release_id, cities=cities_out, groups=groups_out,
                          grouping_version=grouping, attribution=GEONAMES_ATTRIBUTION)  # fmt: skip


@lru_cache(maxsize=32)
def _cities(release_id: str, dataset: str) -> list[dict]:
    with sync_session() as session:
        d = _open(session, dataset, None if dataset == "demo" else release_id)
        return d.cities()


@lru_cache(maxsize=256)
def _city_ids(release_id: str, dataset: str) -> tuple[str, ...]:
    return tuple(c["city_id"] for c in _cities(release_id, dataset))


@lru_cache(maxsize=32)
def _grouped(release_id: str, dataset: str, grouping: str | None) -> tuple[list, list]:
    """The release's cities with their group, and the groups they fall in (members: how many
    of these cities each holds)."""
    with sync_session() as session:
        group_of = groups.membership(session)
        stored = groups.stored_groups(session)
    cities_out = [{**c, "group_id": group_of.get(c["city_id"])}
                  for c in _cities(release_id, dataset)]  # fmt: skip
    counts = Counter(c["group_id"] for c in cities_out if c["group_id"])
    groups_out = [{"id": g.id, "name": g.name, "kind": g.kind, "lat": g.lat, "lon": g.lon,
                   "members": counts[g.id]}
                  for gid, g in sorted(stored.items()) if gid in counts]  # fmt: skip
    return cities_out, groups_out


@router.get("/frame", response_model=FrameResponse)
def frame(
    dataset: DatasetParam = "real",
    occupation: Occ = "all",  # type: ignore[valid-type]
    window_key: WindowParam = Query(DEFAULT_WINDOW, alias="window"),
    day: date | None = Query(None, alias="date"),
    release: str | None = Query(None, max_length=64),
    session: Session = Depends(get_session),
) -> FrameResponse:
    d = _open(session, dataset, release)
    info = d.info()
    day = day or info.data_through
    _check_day(info, day)
    ids = list(_city_ids(info.release_id, dataset))
    f = d.frames(occupation, window_key, day, day, ids)[0]
    w = window(window_key, day, history_start=info.history_start, cutoff=_cutoff(info, day))
    q = f.quality
    cities_out = [
        CityCount(city_id=c, count=f.cities.get(c),
                  quality=("not_covered" if f.cities.get(c) is None and q != "missing" else q))
        for c in ids
    ]  # fmt: skip
    return FrameResponse(
        dataset_id=info.dataset_id, data_mode=info.data_mode, release_id=info.release_id,
        window=window_key, window_start=w.start.isoformat(), window_end=w.end.isoformat(),
        data_through=info.data_through.isoformat(), generated_at=ds.generated_at().isoformat(),
        source_set_id=info.source_set_id, classification_version=info.classification_version,
        completeness=q, stale=info.stale, partial_day=w.partial_day,
        date=day.isoformat(), occupation=occupation, cities=cities_out,
        national=NationalSummary(
            total_unique=f.national,
            total_reason=None if f.national is not None else "window not fully covered",
            city_unconfirmed=f.unconfirmed, remote_canada=f.remote,
        ),
        notes=f.notes, backfilled_days=f.backfilled_days,
    )  # fmt: skip


@router.get("/timeline", response_model=TimelineResponse)
def timeline(
    dataset: DatasetParam = "real",
    occupation: Occ = "all",  # type: ignore[valid-type]
    window_key: WindowParam = Query(DEFAULT_WINDOW, alias="window"),
    start: date | None = None,
    end: date | None = None,
    release: str | None = Query(None, max_length=64),
    session: Session = Depends(get_session),
) -> TimelineResponse:
    d = _open(session, dataset, release)
    info = d.info()
    end = end or info.data_through
    start = start or max(info.history_start, end - timedelta(days=89))
    _check_day(info, start)
    _check_day(info, end)
    if end < start or (end - start).days + 1 > MAX_TIMELINE_DAYS:
        msg = f"at most {MAX_TIMELINE_DAYS} days per request"
        raise HTTPException(400, {"code": "RANGE_TOO_LARGE", "message": msg})
    ids = list(_city_ids(info.release_id, dataset))
    fr = d.frames(occupation, window_key, start, end, ids)
    return TimelineResponse(
        dataset_id=info.dataset_id, data_mode=info.data_mode, release_id=info.release_id,
        occupation=occupation, window=window_key, start=start.isoformat(), end=end.isoformat(),
        city_ids=ids,
        frames=[TimelineFrame(date=f.day.isoformat(), quality=f.quality,
                              days_available=f.days_available,
                              counts=[f.cities.get(c) for c in ids], national=f.national,
                              notes=f.notes, backfilled_days=f.backfilled_days) for f in fr],
        max_count=scale_max(dataset, info.release_id, occupation, window_key,
                            grouping_version(session)),
    )  # fmt: skip


@lru_cache(maxsize=128)
def scale_max(
    dataset: str, release_id: str, occupation: str, window_key: str, grouping: str | None
) -> int:
    """Largest region total over the whole history of a release: one fixed scale for a whole
    playback (never re-normalised per frame), shared by regions and their cities. A region
    total sums its members' known counts; it is null only when all are null. Releases built
    under the current grouping store it; others are computed once here."""
    with sync_session() as session:
        d = _open(session, dataset, None if dataset == "demo" else release_id)
        info = d.info()
        stored = (info.quality or {}).get("group_scale_max")
        if stored and stored.get("grouping_version") == grouping:
            return int(stored["values"].get(occupation, {}).get(window_key, 0))
        if dataset != "demo":
            found = scale_maxima(session, info.release_id, GROUP_SCALE_SQL, occupation)
            return found.get(occupation, {}).get(window_key, 0)
        group_of = groups.membership(session)
        ids = list(_city_ids(info.release_id, dataset))
        best = 0
        for f in d.frames(occupation, window_key, info.history_start, info.data_through, ids):
            totals: dict[str, int] = defaultdict(int)
            for c, v in f.cities.items():
                if v is not None:
                    totals[group_of.get(c, c)] += v
            best = max(best, *totals.values(), 0)
        return best


@router.get("/cities/{city_id}/series", response_model=SeriesResponse)
def series(
    city_id: str,
    dataset: DatasetParam = "real",
    occupation: Occ = "all",  # type: ignore[valid-type]
    window_key: WindowParam = Query(DEFAULT_WINDOW, alias="window"),
    end: date | None = None,
    days: int = Query(90, ge=7, le=MAX_TIMELINE_DAYS),
    release: str | None = Query(None, max_length=64),
    session: Session = Depends(get_session),
) -> SeriesResponse:
    d = _open(session, dataset, release)
    info = d.info()
    if city_id not in _city_ids(info.release_id, dataset):
        raise HTTPException(404, {"code": "CITY_NOT_FOUND", "message": "unknown city"})
    end = end or info.data_through
    _check_day(info, end)
    start = max(info.history_start, end - timedelta(days=days - 1))
    fr = d.frames(occupation, window_key, start, end, [city_id])
    return SeriesResponse(
        dataset_id=info.dataset_id, data_mode=info.data_mode, release_id=info.release_id,
        city_id=city_id, occupation=occupation, window=window_key,
        points=[SeriesPoint(date=f.day.isoformat(), count=f.cities.get(city_id),
                            quality=f.quality if f.cities.get(city_id) is not None
                            or f.quality == "missing" else "not_covered",
                            backfilled_days=f.backfilled_days) for f in fr],
    )  # fmt: skip


@router.get("/version", response_model=VersionResponse)
def version(
    request: Request,
    response: Response,
    dataset: DatasetParam = "real",
    session: Session = Depends(get_session),
):
    if dataset == "demo":
        demo = ds.DemoDataset(session)
        info = demo.info() if demo.available else None
        rid, through, published, kind = (
            (info.release_id, info.data_through.isoformat(), None, "update") if info
            else (None, None, None, None)
        )  # fmt: skip
        mode = "demo"
    else:
        real = ds.RealDataset.open(session, DATASET_IDS[dataset])
        r = real.release if real else None
        rid = r.id if r else None
        through = real.data_through.isoformat() if r else None
        published = r.published_at.isoformat() if r and r.published_at else None
        kind = r.change_kind if r else None
        mode = "real" if r else "not_configured"
    etag = f'"{rid or "none"}"'
    if request.headers.get("if-none-match") == etag:
        return Response(status_code=304, headers={"ETag": etag})
    response.headers["ETag"] = etag
    response.headers["Cache-Control"] = "no-cache"
    return VersionResponse(dataset_id=DATASET_IDS.get(dataset, "demo-v1"),
                           data_mode=mode, release_id=rid, data_through=through,
                           published_at=published, change_kind=kind)  # fmt: skip


@router.get("/sources", response_model=SourcesResponse)
def sources(session: Session = Depends(get_session)) -> SourcesResponse:
    # Only the sources of the release this API serves: an admitted source whose data is not
    # shown (e.g. the Employer boards dataset before it has a view) is not "used".
    served = current_release(session, ds.REAL_DATASET)
    keys = served.source_set_id.split("+") if served else []
    rows = session.query(AtlasSource).filter(AtlasSource.key.in_(keys)).order_by(AtlasSource.key)
    out = []
    for r in rows:
        ok, why = admitted(r)
        verified = r.verified_on.isoformat() if r.verified_on else None
        out.append(SourceInfo(key=r.key, provider=r.provider, status=r.status, admitted=ok,
                              reason=why, licence=r.licence, terms_url=r.terms_url,
                              attribution=r.attribution, capabilities=r.capabilities or {},
                              verified_on=verified))  # fmt: skip
    return SourcesResponse(
        sources=out,
        definitions={
            "new_postings": "Distinct job postings first published within the window. One "
            "posting is one advertisement for one work location; not hires, not vacancies.",
            "window": "Calendar days in America/Toronto: 7d = the selected day and the six "
            "days before it. Date-only records count on the day they state.",
            "data_through": "Last day covered by the data. Job Bank publishes monthly, so the "
            "latest week can be weeks before today.",
            "city": "Municipality named in the posting, matched to a GeoNames populated place "
            "in the same province. Postings without a matched city are counted nationally as "
            "'city unconfirmed'; they are never placed at a city.",
            "zero_vs_unknown": "0 means the covered data has no posting; null means the data "
            "does not cover it (gap, not covered).",
            "coverage": "Job Bank postings only — not the whole Canadian job market.",
        },
        attributions=[OGL_ATTRIBUTION, GEONAMES_ATTRIBUTION, NATURAL_EARTH]
        + ([groups.STATCAN_ATTRIBUTION] if grouping_version(session) else []),
    )
