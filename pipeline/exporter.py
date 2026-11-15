"""
Scientific Data Export Module (CSV & RFC 7946 GeoJSON).
Includes mandatory provenance metadata headers, sensor attribution, and harmonization indicators.
"""

from __future__ import annotations
import csv
import io
from datetime import datetime, timezone
from typing import Dict, Any, List
import orjson


def export_hotspots_csv(query_result: Dict[str, Any], filter_meta: Dict[str, Any]) -> str:
    """
    Exports queried hotspots to CSV with a comprehensive scientific metadata header
    preserving original sensor attributes and co-location/harmonization provenance.
    """
    now_utc = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    hotspots: List[Dict[str, Any]] = query_result.get("hotspots", [])
    summary = query_result.get("summary", {})

    buf = io.StringIO()
    buf.write("# ==========================================================================\n")
    buf.write("# GLOBAL FIRE INTELLIGENCE (GFI) — SCIENTIFIC HOTSPOT EXPORT\n")
    buf.write("# NASA Space Apps Challenge: Harmonization of MODIS and VIIRS Hot Spots\n")
    buf.write(f"# Generated At (UTC): {now_utc}\n")
    buf.write(f"# Region / Area Filter: {filter_meta.get('region_code', 'CUSTOM_AREA')}\n")
    buf.write(f"# Temporal Window: {filter_meta.get('period_label', '2001-2026')}\n")
    buf.write(f"# Instrument Filter: {filter_meta.get('instrument', 'ALL')}\n")
    buf.write(f"# Total Records Exported: {len(hotspots)}\n")
    buf.write(f"# MODIS Detections (1km): {summary.get('modis_detections', 0)}\n")
    buf.write(f"# VIIRS Detections (375m): {summary.get('viirs_detections', 0)}\n")
    buf.write(f"# Co-located Thermal Events: {summary.get('colocated_thermal_events', 0)}\n")
    buf.write("# Primary Data Attribution: NASA FIRMS / LANCE / EOSDIS (MCD14ML, VNP14IMGML, VJ114IMGML)\n")
    buf.write("# Scientific Caveat: Hotspot counts do NOT directly equal fire count or burned area (ha).\n")
    buf.write("# ==========================================================================\n")

    fieldnames = [
        "id",
        "record_hash",
        "region_code",
        "latitude",
        "longitude",
        "acq_date",
        "acq_time",
        "satellite",
        "instrument",
        "product_code",
        "version",
        "confidence_raw",
        "confidence_tier",
        "confidence_score",
        "bright_mir_kelvin",
        "bright_tir_kelvin",
        "frp_mw",
        "scan_km",
        "track_km",
        "pixel_area_km2",
        "daynight",
        "grid_1km_key",
        "thermal_event_id",
        "event_sensor_composition",
        "event_consolidated_frp_mw",
        "source_provenance",
    ]
    writer = csv.writer(buf)
    writer.writerow(fieldnames)

    for h in hotspots:
        writer.writerow(
            [
                h.get("id"),
                h.get("record_hash"),
                h.get("region_code"),
                h.get("latitude"),
                h.get("longitude"),
                h.get("acq_date"),
                h.get("acq_time"),
                h.get("satellite"),
                h.get("instrument"),
                h.get("product_code"),
                h.get("version"),
                h.get("confidence_raw"),
                h.get("confidence_tier"),
                h.get("confidence_score"),
                h.get("bright_mir"),
                h.get("bright_tir"),
                h.get("frp"),
                h.get("scan"),
                h.get("track"),
                h.get("pixel_area_km2"),
                h.get("daynight"),
                h.get("grid_1km_key"),
                h.get("thermal_event_id"),
                h.get("event_sensor_composition") or "SINGLE_SENSOR",
                h.get("event_consolidated_frp") or h.get("frp"),
                h.get("source_provenance"),
            ]
        )

    return buf.getvalue()


def export_hotspots_geojson(query_result: Dict[str, Any], filter_meta: Dict[str, Any]) -> bytes:
    """
    Exports queried hotspots as an RFC 7946 compliant GeoJSON FeatureCollection
    with embedded scientific provenance and harmonization metadata.
    """
    now_utc = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    hotspots: List[Dict[str, Any]] = query_result.get("hotspots", [])
    summary = query_result.get("summary", {})

    features = []
    for h in hotspots:
        features.append(
            {
                "type": "Feature",
                "geometry": {
                    "type": "Point",
                    "coordinates": [h["longitude"], h["latitude"]],
                },
                "properties": {
                    "id": h.get("id"),
                    "record_hash": h.get("record_hash") or f"GFI-{h.get('id')}",
                    "region_code": h.get("region_code"),
                    "acq_date": h.get("acq_date"),
                    "acq_time": h.get("acq_time"),
                    "satellite": h.get("satellite"),
                    "instrument": h.get("instrument"),
                    "product_code": h.get("product_code"),
                    "version": h.get("version"),
                    "confidence_raw": h.get("confidence_raw"),
                    "confidence_tier": h.get("confidence_tier"),
                    "bright_mir_k": h.get("bright_mir"),
                    "bright_tir_k": h.get("bright_tir"),
                    "frp_mw": h.get("frp"),
                    "scan_km": h.get("scan"),
                    "track_km": h.get("track"),
                    "pixel_area_km2": h.get("pixel_area_km2"),
                    "daynight": h.get("daynight"),
                    "grid_1km_key": h.get("grid_1km_key"),
                    "thermal_event_id": h.get("thermal_event_id"),
                    "event_sensor_composition": h.get("event_sensor_composition"),
                    "event_consolidated_frp_mw": h.get("event_consolidated_frp") or h.get("frp"),
                    "source_provenance": h.get("source_provenance"),
                },
            }
        )

    collection = {
        "type": "FeatureCollection",
        "metadata": {
            "platform": "Global Fire Intelligence (GFI) — NASA Space Apps Challenge",
            "generated_at_utc": now_utc,
            "filter_parameters": filter_meta,
            "summary": summary,
            "attribution": "NASA FIRMS / EOSDIS (MODIS MCD14ML/DL & VIIRS VNP14IMG/VJ114IMG)",
        },
        "features": features,
    }
    return orjson.dumps(collection, option=orjson.OPT_INDENT_2)


def export_calendar_series_csv(calendar_data: Dict[str, Any]) -> str:
    """
    Exports the complete Historical Burning Calendar & Harmonized Monthly Series (2001-2026)
    into an analytical CSV file differentiating Raw Observations vs Harmonized Estimates.
    """
    now_utc = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    region = calendar_data.get("region", {})
    buf = io.StringIO()
    buf.write("# ==========================================================================\n")
    buf.write("# GLOBAL FIRE INTELLIGENCE (GFI) — HARMONIZED HISTORICAL CALENDAR SERIES\n")
    buf.write(f"# Region: {region.get('name', '')} ({region.get('region_code', '')})\n")
    buf.write(f"# Selected Metric Mode: {calendar_data.get('metric_label', '')} [{calendar_data.get('data_nature', '')}]\n")
    buf.write(f"# Generated At (UTC): {now_utc}\n")
    buf.write("# Methodology: Multi-tier MODIS (1km) & VIIRS (375m) Spatiotemporal & Overlap Calibration\n")
    buf.write("# ==========================================================================\n")

    writer = csv.writer(buf)
    writer.writerow(
        [
            "region_code",
            "year",
            "month",
            "month_name",
            "active_sensors",
            "observed_raw_modis_total",
            "observed_raw_modis_terra",
            "observed_raw_modis_aqua",
            "observed_raw_viirs_total",
            "observed_raw_viirs_snpp",
            "observed_raw_viirs_noaa20",
            "observed_raw_viirs_noaa21",
            "unharmonized_raw_sum_warning",
            "derived_colocated_events",
            "harmonized_grid_1km_count",
            "harmonized_calibrated_index",
            "harmonized_frp_mw",
            "selected_metric_value",
            "same_month_historical_median",
            "same_month_historical_mean",
            "pct_anomaly_vs_median",
            "historical_percentile",
            "robust_z_mad",
            "anomaly_classification",
            "provenance_status",
        ]
    )

    rcode = region.get("region_code", "MX-CHH")
    for yr_entry in calendar_data.get("calendar_years", []):
        y = yr_entry["year"]
        months_map = yr_entry.get("months", {})
        for m in range(1, 13):
            c = months_map.get(m) or months_map.get(str(m))
            if not c:
                continue
            writer.writerow(
                [
                    rcode,
                    y,
                    m,
                    c.get("month_name"),
                    c.get("active_sensors"),
                    c.get("raw_modis", 0),
                    c.get("raw_modis_terra", 0),
                    c.get("raw_modis_aqua", 0),
                    c.get("raw_viirs", 0),
                    c.get("raw_viirs_snpp", 0),
                    c.get("raw_viirs_noaa20", 0),
                    c.get("raw_viirs_noaa21", 0),
                    c.get("raw_concatenated", 0),
                    c.get("colocated_events", 0),
                    c.get("harmonized_grid", 0.0),
                    c.get("harmonized_calibrated", 0.0),
                    c.get("harmonized_frp_mw", 0.0),
                    c.get("value"),
                    c.get("month_median"),
                    c.get("month_mean"),
                    c.get("pct_anomaly"),
                    c.get("percentile"),
                    c.get("z_mad"),
                    c.get("anomaly_label"),
                    c.get("provenance_status"),
                ]
            )

    return buf.getvalue()
