#!/usr/bin/env python3
"""
CLI Batch Downloader for NASA FIRMS Area API (/api/area/csv/[MAP_KEY]/[SOURCE]/[AREA]/[DAY_RANGE]/[DATE]).
Loops in 5-day windows across MODIS and VIIRS sources and ingests directly into GFI's SQLite R-Tree DB.

Usage:
  export FIRMS_MAP_KEY="your_32_char_key"
  python3 scripts/sync_firms_area.py --region MX-CHH --start 2026-06-23 --end 2026-11-14
"""

import argparse
import os
import sys
from pathlib import Path

ROOT_DIR = Path(__file__).resolve().parent.parent
if str(ROOT_DIR) not in sys.path:
    sys.path.insert(0, str(ROOT_DIR))

from pipeline.database import init_database, REFERENCE_REGIONS, DEFAULT_DB_PATH
from pipeline.ingestor import sync_firms_date_range


def main() -> None:
    parser = argparse.ArgumentParser(description="Sync real NASA FIRMS active fire data via Area API.")
    parser.add_argument("--map-key", default=os.environ.get("FIRMS_MAP_KEY", ""), help="NASA FIRMS MAP_KEY")
    parser.add_argument("--region", default="MX-CHH", help="Region code (e.g. MX-CHH, BR-AMZ, US-CAL)")
    parser.add_argument("--start", default="2026-06-23", help="Start date YYYY-MM-DD")
    parser.add_argument("--end", default="2026-11-14", help="End date YYYY-MM-DD")
    parser.add_argument(
        "--sources",
        nargs="+",
        default=["MODIS_SP", "MODIS_NRT", "VIIRS_NOAA20_SP", "VIIRS_NOAA20_NRT", "VIIRS_NOAA21_NRT"],
        help="FIRMS sources to query",
    )
    args = parser.parse_args()

    if not args.map_key:
        print("Error: Provide --map-key or set FIRMS_MAP_KEY environment variable.", file=sys.stderr)
        sys.exit(1)

    reg = next((r for r in REFERENCE_REGIONS if r["region_code"] == args.region), REFERENCE_REGIONS[0])
    bbox = (reg["min_lon"], reg["min_lat"], reg["max_lon"], reg["max_lat"])

    conn = init_database(DEFAULT_DB_PATH)
    print(f"[FIRMS Sync] Region={args.region} BBox={bbox} Window={args.start}..{args.end}")
    res = sync_firms_date_range(
        conn=conn,
        map_key=args.map_key,
        sources=args.sources,
        bbox_west_south_east_north=bbox,
        start_date=args.start,
        end_date=args.end,
        region_code=args.region,
    )
    conn.close()
    print(f"[FIRMS Sync] Completed: {res}")


if __name__ == "__main__":
    main()
