"""Search latency benchmark on SYNTHETIC data (DEVELOPMENT.md §13).

Seeds N synthetic jobs into a dedicated benchmark database (refuses any database not named
*_bench) and measures run_search for a set of combined queries. Synthetic rows exist only for
this measurement; they never go near the dev or production database.

    uv run python scripts/bench_search.py --db postgresql+psycopg://jobatlas:jobatlas@localhost:54329/jobatlas_bench --jobs 10000
"""

from __future__ import annotations

import argparse
import asyncio
import os
import platform
import random
import statistics
import subprocess
import sys
import time
from datetime import timedelta
from pathlib import Path

from sqlalchemy import create_engine, text
from sqlalchemy.engine import make_url

BACKEND = Path(__file__).resolve().parents[1]
TITLES = ["Backend Engineer", "Senior Software Engineer", "Data Analyst", "Registered Nurse",
          "Customer Service Representative", "Accountant", "Product Manager", "Barista",
          "Warehouse Associate", "Frontend Developer", "Back-End Developer", "Store Manager"]  # fmt: skip
REGIONS = ["toronto", "mississauga", "brampton", "markham", "vaughan", "oakville"]


def seed(url: str, n: int) -> None:
    u = make_url(url)
    if not (u.database or "").endswith("_bench"):
        sys.exit("refusing: benchmark database name must end with _bench")
    admin = create_engine(u.set(database="postgres"), isolation_level="AUTOCOMMIT")
    with admin.connect() as c:
        c.execute(text(f'DROP DATABASE IF EXISTS "{u.database}"'))
        c.execute(text(f'CREATE DATABASE "{u.database}"'))
    admin.dispose()
    subprocess.run([sys.executable, "-m", "alembic", "upgrade", "head"], cwd=BACKEND,
                   env={**os.environ, "DATABASE_URL": url}, check=True, capture_output=True)  # fmt: skip
    eng = create_engine(url)
    rnd = random.Random(42)
    with eng.begin() as c:
        cid = c.execute(text("INSERT INTO companies (name, identity_status) VALUES "
                             "('Synthetic Co', 'unverified') RETURNING id")).scalar()  # fmt: skip
        rows = []
        for i in range(n):
            wp = rnd.choice(["on_site", "hybrid", "remote", "unknown"])
            located = rnd.random() < 0.6
            rows.append({
                "cid": cid, "title": f"{rnd.choice(TITLES)} {i % 7}", "wp": wp,
                "posted": timedelta(hours=rnd.uniform(0, 24 * 40)),
                "region": rnd.choice(REGIONS), "elig": "known" if wp == "remote" else "not_applicable",
                "lon": rnd.uniform(-79.75, -79.15), "lat": rnd.uniform(43.55, 43.90),
                "located": located,
            })  # fmt: skip
        for r in rows:
            jid = c.execute(text(
                """INSERT INTO jobs (company_id, title, workplace_type, status, is_publishable,
                     posted_at, posted_precision, posted_basis, first_seen_at, last_seen_at,
                     last_verified_at, apply_url, location_region_id, location_status,
                     eligibility_status)
                   VALUES (:cid, :title, :wp, 'active', true, now() - :posted, 'datetime',
                     'original', now() - interval '41 days', now(), now(),
                     'https://example.test/apply', :region, 'unverified', :elig)
                   RETURNING id"""), r).scalar()  # fmt: skip
            if r["wp"] == "remote":
                c.execute(text("INSERT INTO job_eligibility_regions (job_id, region_id, "
                               "include_or_exclude) VALUES (:j, 'ca', 'include')"), {"j": jid})  # fmt: skip
            if r["located"]:
                lid = c.execute(text(
                    """INSERT INTO locations (normalized_address, display_address, point, precision)
                       VALUES (:a, :a, ST_SetSRID(ST_MakePoint(:lon, :lat), 4326), 'rooftop')
                       RETURNING id"""), {"a": f"synthetic {jid}", **r}).scalar()  # fmt: skip
                role = "headquarters" if r["wp"] == "remote" else "work_site"
                c.execute(text("INSERT INTO job_locations (job_id, location_id, role, "
                               "verification_status) VALUES (:j, :l, :role, 'verified')"),
                          {"j": jid, "l": lid, "role": role})  # fmt: skip
    with eng.connect() as c:
        c.execute(text("ANALYZE"))
    eng.dispose()


async def measure(url: str, redis_url: str, runs: int) -> dict:
    os.environ["DATABASE_URL"] = url
    os.environ["REDIS_URL"] = redis_url
    from redis.asyncio import Redis

    from app.db.session import _async_factory
    from app.services.search import BBox, SearchParams, run_search

    queries = {
        "all_gta": SearchParams(None, "gta", None),
        "kw_backend_3d": SearchParams("backend engineer", "gta", None, "3d"),
        "kw_nurse_downtown": SearchParams("nurse", "gta", BBox(-79.45, 43.62, -79.30, 43.70)),
        "hybrid_7d_downtown": SearchParams(None, "gta", BBox(-79.45, 43.62, -79.30, 43.70), "7d",
                                           "hybrid"),  # fmt: skip
        "today_remote": SearchParams(None, "gta", None, "today", "remote"),
    }
    redis = Redis.from_url(redis_url, decode_responses=True)
    out = {}
    for name, p in queries.items():
        times = []
        for i in range(runs + 2):
            async with _async_factory()() as s:
                t = time.perf_counter()
                body = await run_search(s, redis, p)
                dt = (time.perf_counter() - t) * 1000
            if i >= 2:  # warm runs only
                times.append(dt)
        times.sort()
        out[name] = {
            "p50_ms": round(statistics.median(times), 1),
            "p95_ms": round(times[int(len(times) * 0.95) - 1], 1),
            "total": body["counts"]["total"],
            "map_markers": body["map_meta"]["marker_count"],
            "map_mode": body["map_meta"]["mode"],
        }
    await redis.aclose()
    return out


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--db", required=True)
    ap.add_argument("--redis", default="redis://localhost:63799/14")
    ap.add_argument("--jobs", type=int, default=10000)
    ap.add_argument("--runs", type=int, default=40)
    ap.add_argument("--skip-seed", action="store_true")
    a = ap.parse_args()
    if not a.skip_seed:
        t = time.perf_counter()
        seed(a.db, a.jobs)
        print(f"seeded {a.jobs} synthetic jobs in {time.perf_counter() - t:.0f}s")
    print(f"machine: {platform.platform()} {platform.machine()} cpus={os.cpu_count()}")
    for name, r in asyncio.run(measure(a.db, a.redis, a.runs)).items():
        print(f"{name:22s} {r}")


if __name__ == "__main__":
    main()
