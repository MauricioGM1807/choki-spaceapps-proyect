"""
Chokí Harmonized Database Exporter.
Exports strictly Chokí's harmonized, co-located, and cross-sensor calibrated
fire intelligence database (thermal_events + harmonized_monthly_series),
never raw unharmonized NASA FIRMS detections, in CSV or GeoJSON format.
"""

from __future__ import annotations

import csv
import datetime as dt
import io
import sqlite3
from typing import Any, Dict, List, Optional, Tuple
import orjson

from pipeline.analytics import compute_burning_calendar


EVENT_CSV_HEADER = [
    "thermal_event_id",
    "region_code",
    "acq_date",
    "acq_year",
    "acq_month",
    "center_lat",
    "center_lon",
    "sensor_composition",
    "modis_pixel_count",
    "viirs_pixel_count",
    "total_pixel_count",
    "consolidated_frp_mw",
    "harmonized_calibrated_weight",
    "harmonized_frp_mw_est",
    "effective_area_km2",
    "max_bright_mir",
    "confidence_tier",
    "monthly_calibration_alpha",
    "monthly_calibration_r2",
    "viirs_effort_factor",
    "harmonized_source",
]

SERIES_CSV_HEADER = [
    "region_code",
    "region_name",
    "year",
    "month",
    "month_name",
    "period_ym",
    "harmonized_calibrated_index",
    "harmonized_grid_1km_count",
    "colocated_event_count",
    "dual_sensor_event_count",
    "harmonized_frp_mw",
    "calibration_alpha",
    "calibration_r2",
    "effort_factor_modis",
    "effort_factor_viirs",
    "monthly_median",
    "pct_anomaly_vs_median",
    "historical_percentile",
    "robust_z_mad",
    "anomaly_classification",
    "active_sensors_label",
    "provenance_status",
]


def _resolve_region_info(conn: sqlite3.Connection, region_code: str) -> Dict[str, Any]:
    if not region_code or region_code == "ALL":
        return {
            "region_code": "ALL",
            "name": "Global (All Regions & Live NASA FIRMS)",
            "center_lat": 15.0,
            "center_lon": -30.0,
        }
    row = conn.execute("SELECT * FROM regions WHERE region_code = ?", (region_code,)).fetchone()
    if row:
        return dict(row)
    return {"region_code": region_code, "name": region_code, "center_lat": 0.0, "center_lon": 0.0}


def _build_temporal_filter(params: Dict[str, Any]) -> Tuple[str, List[Any], str]:
    """Builds SQL WHERE clauses for thermal_events plus a human-readable period tag."""
    scope = (params.get("scope") or "full_year").strip().lower()
    year = params.get("year")
    month = params.get("month")
    single_date = (params.get("date") or "").strip()
    start_date = (params.get("start_date") or "").strip()
    end_date = (params.get("end_date") or "").strip()

    clauses: List[str] = []
    args: List[Any] = []

    if scope == "specific_date" and single_date:
        clauses.append("e.acq_date = ?")
        args.append(single_date)
        return " AND ".join(clauses), args, single_date

    if scope == "date_range" and (start_date or end_date):
        if start_date:
            clauses.append("e.acq_date >= ?")
            args.append(start_date)
        if end_date:
            clauses.append("e.acq_date <= ?")
            args.append(end_date)
        label = f"{start_date or '2001-01-01'}_to_{end_date or '2026-12-31'}"
        return " AND ".join(clauses), args, label

    if scope == "full_month":
        parts = []
        if year is not None:
            clauses.append("e.acq_year = ?")
            args.append(int(year))
            parts.append(str(year))
        else:
            parts.append("2001-2026")
        if month is not None:
            clauses.append("e.acq_month = ?")
            args.append(int(month))
            parts.append(f"{int(month):02d}")
        return " AND ".join(clauses), args, "-".join(parts)

    if scope == "full_year" and year is not None:
        clauses.append("e.acq_year = ?")
        args.append(int(year))
        return " AND ".join(clauses), args, str(year)

    if year is not None:
        clauses.append("e.acq_year = ?")
        args.append(int(year))
    if month is not None:
        clauses.append("e.acq_month = ?")
        args.append(int(month))

    if clauses:
        lbl = f"{year or '2001-2026'}-{f'{int(month):02d}' if month else 'ALL'}"
        return " AND ".join(clauses), args, lbl
    return "1=1", [], "2001-2026"


def _build_event_spatial_filter(
    conn: sqlite3.Connection,
    region_code: str,
    bbox: Optional[Tuple[float, float, float, float]],
) -> Tuple[str, List[Any]]:
    if bbox is not None:
        min_lat, max_lat, min_lon, max_lon = bbox
        return (
            "e.center_lat BETWEEN ? AND ? AND e.center_lon BETWEEN ? AND ?",
            [min_lat, max_lat, min_lon, max_lon],
        )
    if region_code and region_code != "ALL":
        reg = conn.execute(
            "SELECT min_lat, max_lat, min_lon, max_lon FROM regions WHERE region_code = ?",
            (region_code,),
        ).fetchone()
        if reg:
            return (
                "(e.region_code = ? OR (e.center_lat BETWEEN ? AND ? AND e.center_lon BETWEEN ? AND ?))",
                [region_code, reg["min_lat"], reg["max_lat"], reg["min_lon"], reg["max_lon"]],
            )
        return "e.region_code = ?", [region_code]
    return "1=1", []


def _parse_bbox(params: Dict[str, Any]) -> Optional[Tuple[float, float, float, float]]:
    keys = ("min_lat", "max_lat", "min_lon", "max_lon")
    vals = [params.get(k) for k in keys]
    if all(v is not None for v in vals):
        return (float(vals[0]), float(vals[1]), float(vals[2]), float(vals[3]))
    return None


def _query_harmonized_events(
    conn: sqlite3.Connection,
    params: Dict[str, Any],
    limit: int = 25000,
) -> Dict[str, Any]:
    region_code = (params.get("region_code") or "ALL").strip()
    bbox = _parse_bbox(params)
    spatial_sql, spatial_args = _build_event_spatial_filter(conn, region_code, bbox)
    time_sql, time_args, period_label = _build_temporal_filter(params)
    now_utc = dt.datetime.now(dt.timezone.utc)
    today_utc = now_utc.strftime("%Y-%m-%d")
    now_hhmm = now_utc.strftime("%H%M")
    live_guard_sql = (
        "e.acq_date <= ? "
        "AND NOT (e.acq_date >= ? AND EXISTS ("
        "SELECT 1 FROM event_members em JOIN raw_hotspots rh ON rh.id = em.hotspot_id "
        "WHERE em.event_id = e.event_id AND ("
        "rh.source_provenance = 'CALIBRATED_REFERENCE_SERIES' "
        "OR rh.acq_date > ? OR (rh.acq_date = ? AND rh.acq_time > ?)"
        ")))"
    )
    where_sql = f"({spatial_sql}) AND ({time_sql}) AND ({live_guard_sql})"
    all_args = spatial_args + time_args + [today_utc, today_utc, today_utc, today_utc, now_hhmm]

    total_row = conn.execute(
        f"SELECT COUNT(*) AS cnt FROM thermal_events e WHERE {where_sql}",
        all_args,
    ).fetchone()
    total_count = int(total_row["cnt"]) if total_row else 0

    sql = f"""
        SELECT
            e.event_id AS thermal_event_id,
            e.region_code,
            e.acq_date,
            e.acq_year,
            e.acq_month,
            e.center_lat,
            e.center_lon,
            e.sensor_composition,
            e.modis_pixel_count,
            e.viirs_pixel_count,
            e.total_pixel_count,
            e.consolidated_frp_mw,
            e.effective_area_km2,
            e.max_bright_mir,
            e.confidence_tier,
            COALESCE(hms.calibration_alpha, 1.0) AS monthly_calibration_alpha,
            COALESCE(hms.calibration_r2, 0.0) AS monthly_calibration_r2,
            COALESCE(hms.effort_factor_viirs, 1.0) AS viirs_effort_factor,
            COALESCE(hms.harmonized_frp_mw, 0.0) AS month_harmonized_frp,
            COALESCE(hms.raw_modis_frp_mw, 0.0) + COALESCE(hms.raw_viirs_frp_mw, 0.0) AS month_raw_frp
        FROM thermal_events e
        LEFT JOIN harmonized_monthly_series hms
            ON hms.region_code = CASE
                WHEN e.region_code = 'LIVE-WORLD' THEN 'ALL'
                ELSE e.region_code
            END
            AND hms.year = e.acq_year
            AND hms.month = e.acq_month
        WHERE {where_sql}
        ORDER BY e.acq_date DESC, e.consolidated_frp_mw DESC
        LIMIT ?
    """
    rows = []
    for r in conn.execute(sql, all_args + [int(limit)]).fetchall():
        d = dict(r)
        comp = d["sensor_composition"] or "VIIRS_ONLY"
        alpha = float(d["monthly_calibration_alpha"] or 1.0)
        raw_frp = float(d["consolidated_frp_mw"] or 0.0)
        m_harm_frp = float(d["month_harmonized_frp"] or 0.0)
        m_raw_frp = float(d["month_raw_frp"] or 0.0)
        frp_ratio = (m_harm_frp / m_raw_frp) if m_raw_frp > 0 and m_harm_frp > 0 else 1.0
        harm_weight = 1.0 if "MODIS" in comp else round(min(1.5, max(0.05, alpha)), 4)
        rows.append(
            {
                "thermal_event_id": d["thermal_event_id"],
                "region_code": d["region_code"],
                "acq_date": d["acq_date"],
                "acq_year": d["acq_year"],
                "acq_month": d["acq_month"],
                "center_lat": round(float(d["center_lat"]), 5),
                "center_lon": round(float(d["center_lon"]), 5),
                "sensor_composition": comp,
                "modis_pixel_count": d["modis_pixel_count"],
                "viirs_pixel_count": d["viirs_pixel_count"],
                "total_pixel_count": d["total_pixel_count"],
                "consolidated_frp_mw": round(raw_frp, 2),
                "harmonized_calibrated_weight": harm_weight,
                "harmonized_frp_mw_est": round(raw_frp * frp_ratio, 2),
                "effective_area_km2": round(float(d["effective_area_km2"] or 0.0), 4),
                "max_bright_mir": round(float(d["max_bright_mir"] or 0.0), 2),
                "confidence_tier": d["confidence_tier"],
                "monthly_calibration_alpha": round(alpha, 5),
                "monthly_calibration_r2": round(float(d["monthly_calibration_r2"] or 0.0), 4),
                "viirs_effort_factor": round(float(d["viirs_effort_factor"] or 1.0), 4),
                "harmonized_source": "CHOKI_HARMONIZED_COLOCATED_DB",
            }
        )

    return {
        "rows": rows,
        "total_count": total_count,
        "returned_count": len(rows),
        "truncated": total_count > len(rows),
        "period_label": period_label,
        "region": _resolve_region_info(conn, region_code),
    }


def _filter_series_rows(
    conn: sqlite3.Connection,
    params: Dict[str, Any],
) -> Dict[str, Any]:
    region_code = (params.get("region_code") or "ALL").strip()
    region_info = _resolve_region_info(conn, region_code)
    cal = compute_burning_calendar(conn, region_code, "harmonized_calibrated")

    scope = (params.get("scope") or "all_years").strip().lower()
    year = params.get("year")
    month = params.get("month")
    single_date = (params.get("date") or "").strip()
    start_date = (params.get("start_date") or "").strip()
    end_date = (params.get("end_date") or "").strip()

    # Load calibration_alpha / r2 / effort factors directly from DB for complete metadata
    db_meta: Dict[Tuple[int, int], Dict[str, Any]] = {}
    for db_r in conn.execute(
        """
        SELECT year, month, colocated_event_count, dual_sensor_event_count,
               effort_factor_modis, effort_factor_viirs, calibration_alpha, calibration_r2
        FROM harmonized_monthly_series
        WHERE region_code = ?
        """,
        (region_code,),
    ).fetchall():
        db_meta[(int(db_r["year"]), int(db_r["month"]))] = dict(db_r)

    start_ym = int(start_date[:4]) * 100 + int(start_date[5:7]) if len(start_date) >= 7 else None
    end_ym = int(end_date[:4]) * 100 + int(end_date[5:7]) if len(end_date) >= 7 else None
    exact_ym = (int(single_date[:4]), int(single_date[5:7])) if len(single_date) >= 7 else None

    filtered: List[Dict[str, Any]] = []
    for y_obj in cal["calendar_years"]:
        yr = int(y_obj["year"])
        for m in range(1, 13):
            cell = y_obj["months"].get(m)
            if not cell or not cell.get("available"):
                continue

            if scope == "specific_date" and exact_ym is not None:
                if (yr, m) != exact_ym:
                    continue
            elif scope == "date_range" and (start_ym or end_ym):
                cur_ym = yr * 100 + m
                if start_ym and cur_ym < start_ym:
                    continue
                if end_ym and cur_ym > end_ym:
                    continue
            elif scope == "full_year" and year is not None:
                if yr != int(year):
                    continue
            elif scope == "full_month":
                if year is not None and yr != int(year):
                    continue
                if month is not None and m != int(month):
                    continue
            else:
                if year is not None and yr != int(year):
                    continue
                if month is not None and m != int(month):
                    continue

            extra = db_meta.get((yr, m), {})
            filtered.append(
                {
                    "region_code": region_code,
                    "region_name": region_info.get("name", region_code),
                    "year": yr,
                    "month": m,
                    "month_name": cell["month_name"],
                    "period_ym": f"{yr}-{m:02d}",
                    "harmonized_calibrated_index": cell["harmonized_calibrated"],
                    "harmonized_grid_1km_count": cell["harmonized_grid"],
                    "colocated_event_count": extra.get("colocated_event_count", cell["colocated_events"]),
                    "dual_sensor_event_count": extra.get("dual_sensor_event_count", 0),
                    "harmonized_frp_mw": cell["harmonized_frp_mw"],
                    "calibration_alpha": round(float(extra.get("calibration_alpha", 1.0)), 5),
                    "calibration_r2": round(float(extra.get("calibration_r2", 0.0)), 4),
                    "effort_factor_modis": round(float(extra.get("effort_factor_modis", 1.0)), 4),
                    "effort_factor_viirs": round(float(extra.get("effort_factor_viirs", 1.0)), 4),
                    "monthly_median": cell["month_median"],
                    "pct_anomaly_vs_median": cell["pct_anomaly"],
                    "historical_percentile": cell["percentile"],
                    "robust_z_mad": cell["z_mad"],
                    "anomaly_classification": cell["anomaly_label"],
                    "active_sensors_label": cell["active_sensors"],
                    "provenance_status": cell["provenance_status"],
                }
            )

    period_label = single_date if (scope == "specific_date" and single_date) else (
        f"{start_date or '2001-01-01'}_to_{end_date or '2026-12-31'}" if scope == "date_range" else
        f"{year or '2001-2026'}-{f'{int(month):02d}' if month else 'ALL'}"
    )
    return {
        "rows": filtered,
        "total_count": len(filtered),
        "returned_count": len(filtered),
        "truncated": False,
        "period_label": period_label,
        "region": region_info,
    }


def query_harmonized_export_preview(conn: sqlite3.Connection, params: Dict[str, Any]) -> Dict[str, Any]:
    """Returns record count and scope metadata for the Export modal preview."""
    dataset = (params.get("dataset") or "events").strip().lower()
    if dataset == "series":
        res = _filter_series_rows(conn, params)
    else:
        res = _query_harmonized_events(conn, params, limit=1)
    return {
        "dataset": dataset,
        "region_code": res["region"]["region_code"],
        "region_name": res["region"]["name"],
        "period_label": res["period_label"],
        "count": res["total_count"],
        "limit": 25000 if dataset == "events" else len(res["rows"]),
        "truncated": res["total_count"] > 25000 if dataset == "events" else False,
    }


def _rows_to_csv(header: List[str], rows: List[Dict[str, Any]], meta_lines: List[str]) -> str:
    buf = io.StringIO()
    for line in meta_lines:
        buf.write(f"# {line}\n")
    writer = csv.writer(buf)
    writer.writerow(header)
    for row in rows:
        writer.writerow([row.get(col, "") for col in header])
    return buf.getvalue()


def export_harmonized_dataset(
    conn: sqlite3.Connection,
    params: Dict[str, Any],
    fmt: str = "csv",
) -> Tuple[bytes | str, str, str]:
    """
    Exports Chokí's harmonized database ('events' or 'series') filtered by region and window.
    Returns (content, filename, mime_type).
    """
    dataset = (params.get("dataset") or "events").strip().lower()
    fmt_clean = (fmt or "csv").strip().lower()
    if fmt_clean not in ("csv", "geojson"):
        fmt_clean = "csv"

    now_utc = dt.datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%SZ")
    if dataset == "series":
        data = _filter_series_rows(conn, params)
        rows = data["rows"]
        header = SERIES_CSV_HEADER
        dataset_tag = "Harmonized_Series"
    else:
        data = _query_harmonized_events(conn, params, limit=25000)
        rows = data["rows"]
        header = EVENT_CSV_HEADER
        dataset_tag = "Harmonized_Events"

    rcode = data["region"]["region_code"]
    period_lbl = data["period_label"]
    fname = f"Choki_{dataset_tag}_{rcode}_{period_lbl}.{fmt_clean}"

    if fmt_clean == "geojson":
        reg_lat = float(data["region"].get("center_lat") or 0.0)
        reg_lon = float(data["region"].get("center_lon") or 0.0)
        features = []
        for row in rows:
            if dataset == "events":
                lon = float(row["center_lon"])
                lat = float(row["center_lat"])
            else:
                lon = reg_lon
                lat = reg_lat
            features.append(
                {
                    "type": "Feature",
                    "geometry": {"type": "Point", "coordinates": [lon, lat]},
                    "properties": row,
                }
            )
        payload = {
            "type": "FeatureCollection",
            "metadata": {
                "source": "Chokí Harmonized Fire Intelligence Database (NOT raw NASA FIRMS feed)",
                "dataset": dataset,
                "region_code": rcode,
                "region_name": data["region"].get("name", rcode),
                "period_label": period_lbl,
                "total_matching_records": data["total_count"],
                "exported_records": len(rows),
                "truncated": data["truncated"],
                "exported_utc": now_utc,
            },
            "features": features,
        }
        return orjson.dumps(payload, option=orjson.OPT_INDENT_2), fname, "application/geo+json; charset=utf-8"

    meta_lines = [
        "CHOKI HARMONIZED FIRE INTELLIGENCE DATABASE (Calibrated MODIS + Co-located VIIRS, NOT raw NASA FIRMS feed)",
        f"Dataset: {dataset} | Region: {rcode} ({data['region'].get('name', rcode)}) | Period: {period_lbl}",
        f"Exported: {now_utc} | Records: {len(rows)} of {data['total_count']}",
    ]
    return _rows_to_csv(header, rows, meta_lines), fname, "text/csv; charset=utf-8"
