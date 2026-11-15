"""
Fetches REAL global live hotspot detections from NASA FIRMS Area API
across all 6 continental bounding boxes for MODIS_NRT, VIIRS_NOAA20_NRT, and VIIRS_NOAA21_NRT,
then ingests and co-locates them into SQLite (`raw_hotspots`, `hotspots_rtree`, `thermal_events`)
without altering the 26-year (2001-2026) baseline `harmonized_monthly_series` tables.
"""

from __future__ import annotations
import csv
import io
import os
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
import requests

ROOT_DIR = Path(__file__).resolve().parent.parent
if str(ROOT_DIR) not in sys.path:
    sys.path.insert(0, str(ROOT_DIR))

from pipeline.database import init_database, get_connection, REFERENCE_REGIONS
from pipeline.schemas import RawHotspotRecord
from pipeline.harmonizer import compute_1km_grid_key, colocate_thermal_events

# Load MAP_KEY privately from .env
env_path = ROOT_DIR / ".env"
if env_path.is_file():
    for line in env_path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            k, v = line.split("=", 1)
            os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))

CONTINENT_BOXES = [
    ("NA_MX", "-140,12,-55,62"),
    ("SA_AMZ", "-82,-55,-34,12"),
    ("AF", "-18,-35,52,37"),
    ("EU_MED", "-12,35,45,70"),
    ("AS", "45,5,150,72"),
    ("AU_OC", "110,-46,160,-8"),
]

# Active operational sources (excluding Suomi-NPP after Nov 2, 2026 cessation)
LIVE_SOURCES = ["MODIS_NRT", "VIIRS_NOAA20_NRT", "VIIRS_NOAA21_NRT"]


def match_study_region(lat: float, lon: float) -> str:
    for r in REFERENCE_REGIONS:
        if r["min_lat"] <= lat <= r["max_lat"] and r["min_lon"] <= lon <= r["max_lon"]:
            return r["region_code"]
    return "LIVE-WORLD"


def _row_to_record(raw: dict, src: str) -> RawHotspotRecord:
    norm = {str(k).strip().lower(): str(v).strip() for k, v in raw.items() if k is not None}
    lat = float(norm["latitude"])
    lon = float(norm["longitude"])
    rcode = match_study_region(lat, lon)
    acq_date = norm.get("acq_date", "")
    acq_time = norm.get("acq_time", "1200")

    inst_raw = norm.get("instrument", "").upper()
    if "bright_ti4" in norm or inst_raw == "VIIRS" or norm.get("satellite", "").upper() in ("N", "N20", "N21", "SNPP"):
        instrument = "VIIRS"
        bright_mir = float(norm.get("bright_ti4") or norm.get("brightness") or 330.0)
        bright_tir = float(norm.get("bright_ti5") or norm.get("bright_t31") or 295.0)
        scan = float(norm.get("scan") or 0.39)
        track = float(norm.get("track") or 0.36)
        sat = norm.get("satellite") or ("N21" if "NOAA21" in src else "N20")
        version = norm.get("version") or "2.0NRT"
        prod = "VJ214IMGML" if "21" in str(sat) else ("VJ114IMGML" if "20" in str(sat) else "VNP14IMGML")
    else:
        instrument = "MODIS"
        bright_mir = float(norm.get("brightness") or norm.get("bright_ti4") or 325.0)
        bright_tir = float(norm.get("bright_t31") or norm.get("bright_ti5") or 295.0)
        scan = float(norm.get("scan") or 1.05)
        track = float(norm.get("track") or 1.02)
        sat = norm.get("satellite") or "Aqua"
        version = norm.get("version") or "6.1NRT"
        prod = "MCD14DL"

    conf_raw = str(norm.get("confidence", "n" if instrument == "VIIRS" else "75"))
    frp = max(0.1, float(norm.get("frp") or 15.0))
    daynight = norm.get("daynight") or "D"
    anom_type = int(float(norm.get("type") or 0))

    return RawHotspotRecord(
        latitude=lat,
        longitude=lon,
        acq_date=acq_date,
        acq_time=acq_time,
        satellite=sat,
        instrument=instrument,  # type: ignore
        product_code=prod,
        version=version,
        confidence_raw=conf_raw,
        bright_mir=bright_mir,
        bright_tir=bright_tir,
        frp=frp,
        scan=scan,
        track=track,
        daynight=daynight,  # type: ignore
        anomaly_type=anom_type,
        region_code=rcode,
        source_provenance="NASA_FIRMS_API",
    )


def fetch_and_ingest_global_live(day_range: int = 2, date_str: str = "2026-11-13") -> None:
    map_key = os.environ.get("FIRMS_MAP_KEY", "").strip()
    if not map_key:
        raise RuntimeError("FIRMS_MAP_KEY missing from environment/.env")

    init_database()
    conn = get_connection()
    cache_dir = ROOT_DIR / "data" / "firms_live_cache"
    cache_dir.mkdir(parents=True, exist_ok=True)

    total_received = 0
    total_inserted = 0
    new_dates_by_region = {}

    for src in LIVE_SOURCES:
        for cname, bbox in CONTINENT_BOXES:
            url = f"https://firms.modaps.eosdis.nasa.gov/api/area/csv/{map_key}/{src}/{bbox}/{day_range}/{date_str}"
            print(f"[FIRMS-LIVE] Fetching {src} | {cname} ({date_str}, +{day_range}d)...", flush=True)
            resp = requests.get(url, timeout=90)
            resp.raise_for_status()
            text = resp.text.strip()
            if "Invalid MAP_KEY" in text:
                raise RuntimeError("NASA FIRMS rejected MAP_KEY")
            if not text or not text.lower().startswith("latitude"):
                print("  -> 0 rows returned.")
                continue

            (cache_dir / f"{src}_{cname}_{date_str}.csv").write_text(text, encoding="utf-8")

            reader = csv.DictReader(io.StringIO(text))
            valid_tuples = []
            for raw in reader:
                total_received += 1
                try:
                    rec = _row_to_record(raw, src)
                    grid_key = compute_1km_grid_key(rec.latitude, rec.longitude)
                    valid_tuples.append((
                        rec.record_hash, rec.region_code, rec.latitude, rec.longitude,
                        rec.acq_date, rec.acq_time, rec.acq_year, rec.acq_month, rec.acq_timestamp_utc,
                        rec.satellite, rec.instrument, rec.product_code, rec.version,
                        rec.confidence_raw, rec.confidence_tier, rec.confidence_score,
                        rec.bright_mir, rec.bright_tir, rec.frp, rec.scan, rec.track,
                        rec.pixel_area_km2, rec.footprint_radius_km, rec.daynight,
                        rec.anomaly_type, rec.source_provenance, grid_key,
                    ))
                except Exception:
                    continue

            inserted_chunk = 0
            with conn:
                for t in valid_tuples:
                    cur = conn.execute(
                        """
                        INSERT OR IGNORE INTO raw_hotspots (
                            record_hash, region_code, latitude, longitude,
                            acq_date, acq_time, acq_year, acq_month, acq_timestamp_utc,
                            satellite, instrument, product_code, version,
                            confidence_raw, confidence_tier, confidence_score,
                            bright_mir, bright_tir, frp, scan, track,
                            pixel_area_km2, footprint_radius_km, daynight,
                            anomaly_type, source_provenance, grid_1km_key
                        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                        """,
                        t,
                    )
                    if cur.rowcount == 1:
                        inserted_chunk += 1
                        rowid = cur.lastrowid
                        conn.execute(
                            "INSERT OR REPLACE INTO hotspots_rtree (id, min_lon, max_lon, min_lat, max_lat) VALUES (?, ?, ?, ?, ?)",
                            (rowid, t[3], t[3], t[2], t[2]),
                        )
                        new_dates_by_region.setdefault((t[1], t[4]), True)

            total_inserted += inserted_chunk
            print(f"  -> Validated: {len(valid_tuples)}, Inserted: {inserted_chunk}", flush=True)
            time.sleep(0.3)

    # Co-locate newly ingested NASA FIRMS live detections into thermal_events
    print(f"[FIRMS-LIVE] Co-locating {len(new_dates_by_region)} region-date buckets...", flush=True)
    for (rcode, dt_str) in new_dates_by_region.keys():
        rows = [
            dict(r)
            for r in conn.execute(
                """
                SELECT id, region_code, latitude, longitude, acq_date, acq_time,
                       acq_year, acq_month, acq_timestamp_utc, satellite, instrument,
                       confidence_tier, confidence_score, bright_mir, frp,
                       scan, track, pixel_area_km2, footprint_radius_km, grid_1km_key
                FROM raw_hotspots
                WHERE region_code = ? AND acq_date = ? AND anomaly_type = 0 AND thermal_event_id IS NULL
                ORDER BY acq_timestamp_utc ASC
                """,
                (rcode, dt_str),
            ).fetchall()
        ]
        if not rows:
            continue
        events = colocate_thermal_events(rows)
        with conn:
            for ev in events:
                c_ev = conn.execute(
                    """
                    INSERT INTO thermal_events (
                        region_code, acq_date, acq_year, acq_month,
                        center_lat, center_lon, start_timestamp_utc, end_timestamp_utc,
                        sensor_composition, modis_pixel_count, viirs_pixel_count,
                        total_pixel_count, consolidated_frp_mw, effective_area_km2,
                        max_bright_mir, confidence_tier
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        ev["region_code"], ev["acq_date"], ev["acq_year"], ev["acq_month"],
                        ev["center_lat"], ev["center_lon"], ev["start_timestamp_utc"], ev["end_timestamp_utc"],
                        ev["sensor_composition"], ev["modis_pixel_count"], ev["viirs_pixel_count"],
                        ev["total_pixel_count"], ev["consolidated_frp_mw"], ev["effective_area_km2"],
                        ev["max_bright_mir"], ev["confidence_tier"],
                    ),
                )
                ev_id = c_ev.lastrowid
                conn.executemany(
                    """
                    INSERT INTO event_members (
                        event_id, hotspot_id, instrument, satellite,
                        distance_to_centroid_km, time_offset_min
                    ) VALUES (?, ?, ?, ?, ?, ?)
                    """,
                    [
                        (ev_id, m["hotspot_id"], m["instrument"], m["satellite"], m["distance_to_centroid_km"], m["time_offset_min"])
                        for m in ev["members"]
                    ],
                )
                conn.executemany(
                    "UPDATE raw_hotspots SET thermal_event_id = ? WHERE id = ?",
                    [(ev_id, m["hotspot_id"]) for m in ev["members"]],
                )

    now_utc = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    with conn:
        conn.execute(
            """
            INSERT INTO ingestion_log (
                ingested_at_utc, source_type, source_identifier, region_code,
                records_received, records_inserted, duplicates_skipped, invalid_rejected, notes
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                now_utc,
                "NASA_FIRMS_API",
                f"GLOBAL_6_CONTINENTS:{date_str}:+{day_range}d",
                "LIVE-WORLD",
                total_received,
                total_inserted,
                max(0, total_received - total_inserted),
                0,
                "Synced real global MODIS_NRT + VIIRS_NOAA20_NRT + VIIRS_NOAA21_NRT from NASA FIRMS Area API.",
            ),
        )
    print(f"[FIRMS-LIVE] DONE! Total received={total_received}, Total inserted={total_inserted}", flush=True)


if __name__ == "__main__":
    fetch_and_ingest_global_live(day_range=2, date_str="2026-11-13")
