"""Oracle Recruiting Cloud career sites ({pod}.fa.{dc}.oraclecloud.com, "Candidate Experience").

Verified 2026-10-09 (docs/SOURCES.md §4.10): the pod hosts serve no robots.txt (404 = allow);
every fetch is still checked. The public site itself calls these REST resources without login:
    listing  GET /hcmRestApi/resources/latest/recruitingCEJobRequisitions
             ?onlyData=true&expand=requisitionList.secondaryLocations
             &finder=findReqs;siteNumber={site},limit=N,offset=M,sortBy=POSTING_DATES_DESC
             -> items[0]: TotalJobsCount, requisitionList[]: Id, Title, PostedDate (date),
                PrimaryLocation ("Toronto, ON, Canada"), WorkplaceTypeCode, secondaryLocations
    detail   GET .../recruitingCEJobRequisitionDetails?expand=all&onlyData=true
             &finder=ById;Id="{id}",siteNumber={site}
             -> ExternalPostedStartDate (datetime), ExternalDescriptionStr (HTML),
                workLocation[]: AddressLine1-4, TownOrCity, Region2, PostalCode, Country
Field mapping:
    Id -> external_id; Title -> title; ExternalPostedStartDate -> posted_at (original; the
    listing's PostedDate is the same date without a time); PrimaryLocation + secondary
    locations -> location label; WorkplaceTypeCode ORA_ON_SITE/ORA_HYBRID/ORA_REMOTE.
    workLocation is a structured work address only when its town is one of the job's own
    location labels (a requisition can carry an unrelated "work location", e.g. a business
    office in another city); the street is the first address line starting with a number.
Closure evidence: the detail finder returns no item while the site's listing answers.
"""

from __future__ import annotations

import html
import re
from datetime import date
from typing import Any
from urllib.parse import quote, urlsplit

from app.core.config import get_settings
from app.core.timeutil import parse_iso_datetime
from app.net.robots import RobotsCache
from app.net.safe_http import FetchError, SafeHttpClient, UnsafeURLError
from app.providers.base import (
    BoardInfo,
    FetchPage,
    NormalizedJob,
    ProviderError,
    SourceCandidate,
    SourceRef,
    StructuredAddress,
    VerifyResult,
)
from app.providers.text import html_to_text
from app.services.region_match import slug_may_be_relevant

HOST_RE = re.compile(
    r"^[a-z0-9]{3,12}(?:-[a-z0-9]{1,12})?\.fa(?:\.[a-z0-9]{2,12})?\.oraclecloud\.com$"
)
PATH_RE = re.compile(
    r"/hcmUI/CandidateExperience/[a-zA-Z_-]{2,8}/sites/(?P<site>[A-Za-z0-9_]{1,40})"
)
TITLE_RE = re.compile(r"<title>([^<]{1,200})</title>", re.I)
STREET_RE = re.compile(r"^\d{1,6}[A-Za-z]?\s+\S")
WORKPLACE = {"ORA_ON_SITE": "on_site", "ORA_HYBRID": "hybrid", "ORA_REMOTE": "remote"}
PAGE = 100
MAX_JOBS = 6000


REST = "/hcmRestApi/resources/latest"


def listing_path(site: str, offset: int) -> str:
    finder = f"findReqs;siteNumber={site},limit={PAGE},offset={offset},sortBy=POSTING_DATES_DESC"
    return (
        f"{REST}/recruitingCEJobRequisitions?onlyData=true"
        f"&expand=requisitionList.secondaryLocations&finder={quote(finder, safe=';,=')}"
    )


def detail_path(site: str, external_id: str) -> str:
    finder = quote(f'ById;Id="{external_id}",siteNumber={site}', safe=";,=")
    return f"{REST}/recruitingCEJobRequisitionDetails?expand=all&onlyData=true&finder={finder}"


def split_key(tenant_key: str) -> tuple[str, str]:
    """tenant_key is the site root URL: https://{host}/hcmUI/CandidateExperience/en/sites/{site}/"""
    parts = urlsplit(tenant_key)
    m = PATH_RE.search(parts.path)
    if not parts.hostname or not m:
        raise ValueError(tenant_key)
    return parts.hostname, m["site"]


class OracleProvider:
    name = "oracle"
    supports_fetch = True
    incremental = True
    detail_recheck_hours = 168  # the complete listing is the daily open evidence
    detail_cap_per_run = 80  # listing rows make jobs visible; details fill in over runs

    def recognize(self, url: str) -> SourceCandidate | None:
        try:
            parts = urlsplit(url)
        except ValueError:
            return None
        host = (parts.hostname or "").lower()
        m = PATH_RE.search(parts.path)
        if not HOST_RE.match(host) or not m:
            return None
        root = f"https://{host}/hcmUI/CandidateExperience/en/sites/{m['site']}/"
        return SourceCandidate(self.name, root, root)

    def _get(self, client: SafeHttpClient, url: str, accept: str = "application/json"):
        if not RobotsCache(client).allowed(url):
            raise ProviderError(f"robots.txt disallows {url}", error_class="robots")
        try:
            return client.get(url, headers={"Accept": accept})
        except UnsafeURLError as exc:
            raise ProviderError(str(exc), error_class="unsafe_url") from exc

    def _json(self, client: SafeHttpClient, url: str) -> dict:
        resp = self._get(client, url)
        if resp.status_code != 200:
            raise ProviderError(
                f"status {resp.status_code}", error_class="http", http_status=resp.status_code
            )
        try:
            data = resp.json()
            data["items"]  # noqa: B018 - shape check
        except (ValueError, KeyError, TypeError) as exc:
            raise ProviderError("not json", error_class="parse", http_status=200) from exc
        return data

    def _listing(self, client: SafeHttpClient, tenant_key: str) -> tuple[list[dict], bool]:
        host, site = split_key(tenant_key)
        rows: dict[str, dict] = {}
        total = None
        offset = 0
        while offset < MAX_JOBS:
            data = self._json(client, f"https://{host}{listing_path(site, offset)}")
            items = data["items"]
            if not items:
                break
            search = items[0]
            if total is None:
                total = search.get("TotalJobsCount")
            page = [r for r in search.get("requisitionList") or [] if r.get("Id")]
            for r in page:
                rows.setdefault(str(r["Id"]), r)
            if not page or (isinstance(total, int) and offset + PAGE >= total):
                break
            offset += PAGE
        return list(rows.values()), isinstance(total, int) and len(rows) == total

    def job_url(self, tenant_key: str, external_id: str) -> str:
        return f"{tenant_key.rstrip('/')}/job/{external_id}"

    def board_info(self, client: SafeHttpClient, source: SourceRef) -> BoardInfo:
        try:
            rows, _ = self._listing(client, source.tenant_key)
        except ProviderError as exc:
            if exc.error_class == "robots":
                return BoardInfo(exists=False, reason="robots_disallowed")
            if exc.error_class in ("http", "parse"):
                return BoardInfo(exists=False, http_status=exc.http_status, reason="site_not_found")
            raise
        name = None
        try:  # the public site's page title is the employer's display name
            resp = self._get(client, source.tenant_key, accept="text/html")
            m = TITLE_RE.search(resp.text) if resp.status_code == 200 else None
            name = html.unescape(m.group(1)).strip() or None if m else None
        except (ProviderError, FetchError):
            pass
        return BoardInfo(
            exists=bool(rows), company_name=name, http_status=200,
            evidence_url=source.tenant_key, reason=None if rows else "empty",
        )  # fmt: skip

    def _detail(self, client: SafeHttpClient, tenant_key: str, external_id: str) -> dict | None:
        host, site = split_key(tenant_key)
        data = self._json(client, f"https://{host}{detail_path(site, external_id)}")
        return data["items"][0] if data["items"] else None

    def fetch_jobs(
        self, client: SafeHttpClient, source: SourceRef, cursor: str | None
    ) -> FetchPage:
        rows, complete = self._listing(client, source.tenant_key)
        cap = min(get_settings().careersite_max_detail_pages, self.detail_cap_per_run)
        records: list[dict[str, Any]] = []
        listed: list[str] = []
        fetched = 0
        for row in rows:
            ext = str(row["Id"])
            listed.append(ext)
            labels = _labels(row)
            if not any(slug_may_be_relevant(lbl) for lbl in labels):
                continue  # e.g. "Elko, NV, United States": never a GTA job
            if ext in source.recently_verified:
                records.append({"_listing_only": True, "external_id": ext, "_complete": complete})
                continue
            base = {"_row": row, "_tenant": source.tenant_key}
            if fetched >= cap:
                records.append(base)  # visible now from the listing row
                continue
            fetched += 1
            try:
                detail = self._detail(client, source.tenant_key, ext)
            except (ProviderError, FetchError):
                detail = None
            records.append({**base, "_detail": detail} if detail else base)
        return FetchPage(records, None, is_complete=complete, http_status=200, listed_only=listed)

    def normalize(self, raw: dict[str, Any]) -> NormalizedJob:
        row, detail = raw["_row"], raw.get("_detail")
        ext = str(row["Id"])
        url = self.job_url(raw["_tenant"], ext)
        labels = _labels(row)
        code = (detail or row).get("WorkplaceTypeCode") or row.get("WorkplaceTypeCode")
        workplace = WORKPLACE.get(str(code), "unknown")
        posted_at = parse_iso_datetime(detail.get("ExternalPostedStartDate")) if detail else None
        posted_date = _date(row.get("PostedDate")) if posted_at is None else None
        if posted_at:
            precision, tz_basis = "datetime", None
        elif posted_date:
            precision, tz_basis = "date", "date only; Oracle listing PostedDate, zone unknown"
        else:
            precision, tz_basis = "none", None
        return NormalizedJob(
            external_id=ext,
            title=(row.get("Title") or "").strip() or None,
            company_name=None,
            apply_url=url,
            canonical_url=url,
            description_text=html_to_text(
                "\n".join(
                    detail.get(k) or ""
                    for k in (
                        "ExternalDescriptionStr",
                        "ExternalResponsibilitiesStr",
                        "ExternalQualificationsStr",
                    )
                )  # fmt: skip
            )
            if detail
            else None,
            location_text=labels[0] if labels else None,
            extra_location_labels=labels[1:],
            workplace_type=workplace,  # type: ignore[arg-type]
            workplace_evidence=f"oracle WorkplaceTypeCode={code}"
            if workplace != "unknown"
            else None,
            posted_at=posted_at,
            posted_date=posted_date,
            posted_precision=precision,  # type: ignore[arg-type]
            posted_basis="original" if precision != "none" else "unknown",
            posted_tz_basis=tz_basis,
            requisition_id=str(detail.get("RequisitionId"))
            if detail and detail.get("RequisitionId")
            else None,
            employment_type=detail.get("JobSchedule") if detail else None,
            structured_addresses=_work_addresses(detail, labels) if detail else [],
            from_listing=detail is None,
        )

    def verify_job(
        self, client: SafeHttpClient, source: SourceRef, external_id: str
    ) -> VerifyResult:
        try:
            detail = self._detail(client, source.tenant_key, external_id)
        except (ProviderError, FetchError) as exc:
            return VerifyResult("unknown", f"fetch failed: {exc}")
        if detail is not None:
            return VerifyResult("active", "requisition published on the career site", 200)
        try:
            self._listing(client, source.tenant_key)
        except (ProviderError, FetchError):
            return VerifyResult("unknown", "career site listing unavailable", 200)
        return VerifyResult("closed", "requisition no longer published while the site answers", 200)


def _labels(row: dict) -> list[str]:
    out = [str(row.get("PrimaryLocation") or "").strip()]
    for s in row.get("secondaryLocations") or []:
        if isinstance(s, dict) and s.get("Name"):
            out.append(str(s["Name"]).strip())
    return [x for x in dict.fromkeys(out) if x]


def _date(value: Any) -> date | None:
    if isinstance(value, str) and re.match(r"^\d{4}-\d{2}-\d{2}$", value):
        y, m, d = map(int, value.split("-"))
        return date(y, m, d)
    return None


def _work_addresses(detail: dict, labels: list[str]) -> list[StructuredAddress]:
    cities = {lbl.split(",")[0].strip().lower() for lbl in labels}
    out = []
    for w in (detail.get("workLocation") or []) + (detail.get("otherWorkLocations") or []):
        if not isinstance(w, dict):
            continue
        town = (w.get("TownOrCity") or "").strip()
        if not town or town.lower() not in cities:
            continue  # a work location in another city than the posting says: not evidence
        # "Suite 3700, 161 Bay Street": the street is the comma part that starts with a number.
        parts = [
            seg.strip()
            for i in range(1, 5)
            for seg in str(w.get(f"AddressLine{i}") or "").split(",")
        ]
        street = next((seg for seg in parts if STREET_RE.match(seg)), None)
        regions = [str(w.get(k) or "").strip() for k in ("Region2", "Region3", "Region1")]
        region = next((r for r in regions if 0 < len(r) <= 3), None)  # "ON", "NV"
        out.append(
            StructuredAddress(
                street,
                town,
                region,
                w.get("PostalCode"),
                w.get("Country"),
                w.get("LocationName"),
                "oracle_work_location",
            )  # fmt: skip
        )
    return out
