"""
Mandatory Scientific Validation & Verification Suite (Section 12).
Tests all 11 core requirements:
1. Data integrity & Pydantic validation
2. UTC date/time conversion
3. Geographic coordinate bounds, Haversine distance & 1km equal-area grid
4. Exact duplicate rejection vs Spatiotemporal multi-sensor co-location (preserving provenance)
5. Monthly aggregation consistency
6. Annual aggregation consistency
7. Month-conditional anomaly detection (August 2026 vs Historical Augusts)
8. Cross-sensor MODIS-VIIRS harmonization & elimination of artificial step-changes
9. Statistical consistency & sample sufficiency warnings (N < 10)
10. CSV & GeoJSON export with scientific provenance metadata
11. R-Tree spatial bounding-box & polygon ray-casting queries
"""

from __future__ import annotations
import json
import sys
import unittest
from pathlib import Path

ROOT_DIR = Path(__file__).resolve().parent.parent
if str(ROOT_DIR) not in sys.path:
    sys.path.insert(0, str(ROOT_DIR))

from pipeline.database import init_database
from pipeline.schemas import RawHotspotRecord, standardize_confidence
from pipeline.harmonizer import (
    haversine_km,
    compute_1km_grid_key,
    colocate_thermal_events,
    fit_robust_calibration,
)
from pipeline.ingestor import ingest_firms_csv_content, seed_calibrated_reference_archive
from pipeline.analytics import (
    compute_burning_calendar,
    compare_month_against_history,
    compute_historical_fire_fingerprint,
    query_spatial_hotspots,
    classify_anomaly,
)
from pipeline.exporter import (
    export_hotspots_csv,
    export_hotspots_geojson,
    export_calendar_series_csv,
)


class TestScientificFirePipeline(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        # Use an in-memory SQLite instance for fast, isolated scientific unit tests
        cls.conn = init_database(":memory:")
        cls.seed_info = seed_calibrated_reference_archive(cls.conn)

    def test_01_data_integrity_and_schema_validation(self) -> None:
        """Validates MODIS & VIIRS physical schema constraints and confidence normalization."""
        modis_rec = RawHotspotRecord(
            latitude=28.635,
            longitude=-106.082,
            acq_date="2026-08-14",
            acq_time="1335",
            satellite="A",
            instrument="MODIS",
            product_code="MCD14ML",
            version="6.1",
            confidence_raw="88",
            bright_mir=342.5,
            bright_tir=298.1,
            frp=64.2,
            scan=1.1,
            track=1.0,
            daynight="D",
        )
        self.assertEqual(modis_rec.satellite, "Aqua")
        self.assertEqual(modis_rec.confidence_tier, "High")
        self.assertAlmostEqual(modis_rec.pixel_area_km2, 1.1, places=3)

        viirs_rec = RawHotspotRecord(
            latitude=28.636,
            longitude=-106.081,
            acq_date="2026-08-14",
            acq_time="1340",
            satellite="N20",
            instrument="VIIRS",
            product_code="VJ114IMGML",
            version="2.0",
            confidence_raw="n",
            bright_mir=355.0,
            bright_tir=301.2,
            frp=19.4,
            scan=0.38,
            track=0.37,
            daynight="D",
        )
        self.assertEqual(viirs_rec.satellite, "NOAA-20")
        self.assertEqual(viirs_rec.confidence_tier, "Nominal")
        self.assertAlmostEqual(viirs_rec.pixel_area_km2, 0.38 * 0.37, places=4)

        # Out-of-bounds latitude must raise ValidationError
        with self.assertRaises(Exception):
            RawHotspotRecord(
                latitude=95.0,
                longitude=-106.0,
                acq_date="2026-08-14",
                acq_time="1200",
                satellite="T",
                instrument="MODIS",
                product_code="MCD14ML",
                confidence_raw="75",
                bright_mir=320.0,
                frp=10.0,
                scan=1.0,
                track=1.0,
            )

    def test_02_utc_datetime_and_timestamp_conversion(self) -> None:
        """Verifies integer/string HHMM padding and UTC epoch timestamp extraction."""
        rec = RawHotspotRecord(
            latitude=28.1,
            longitude=-107.2,
            acq_date="2026-05-03",
            acq_time="415",  # Should pad to '0415'
            satellite="T",
            instrument="MODIS",
            product_code="MCD14ML",
            confidence_raw="65",
            bright_mir=318.0,
            frp=22.0,
            scan=1.0,
            track=1.0,
            daynight="N",
        )
        self.assertEqual(rec.acq_time, "0415")
        self.assertEqual(rec.acq_year, 2026)
        self.assertEqual(rec.acq_month, 5)
        self.assertGreater(rec.acq_timestamp_utc, 1700000000)

    def test_03_geographic_coordinates_and_1km_grid(self) -> None:
        """Verifies spherical Haversine distance and 1km latitude-compensated grid projection."""
        # 1 degree of latitude is ~111.195 km
        d_lat = haversine_km(28.0, -106.0, 29.0, -106.0)
        self.assertTrue(110.5 <= d_lat <= 111.8)

        # Two sub-pixel VIIRS points 150m apart fall into the same or adjacent 1km grid cell
        g1 = compute_1km_grid_key(28.5001, -106.5001)
        g2 = compute_1km_grid_key(28.5004, -106.5003)
        self.assertEqual(g1, g2)

    def test_04_duplicate_detection_and_colocation_provenance(self) -> None:
        """
        Ensures:
        1) Exact duplicate CSV lines are skipped on ingestion.
        2) Coincident MODIS (1km) + VIIRS (375m) detections of the same physical fire
           are grouped into a DUAL_SENSOR_COINCIDENT thermal event without losing raw records
           or double-counting FRP.
        """
        csv_sample = (
            "latitude,longitude,brightness,scan,track,acq_date,acq_time,satellite,instrument,confidence,version,bright_t31,frp,daynight,type\n"
            "28.5000,-107.5000,340.2,1.05,1.02,2026-08-10,1330,A,MODIS,85,6.1,298.0,60.0,D,0\n"
            "28.5000,-107.5000,340.2,1.05,1.02,2026-08-10,1330,A,MODIS,85,6.1,298.0,60.0,D,0\n"
            "28.5012,-107.5010,352.0,0.38,0.37,2026-08-10,1336,N,VIIRS,h,2.0,300.0,32.0,D,0\n"
            "28.4992,-107.4995,348.5,0.38,0.37,2026-08-10,1336,N,VIIRS,n,2.0,299.0,30.0,D,0\n"
        )
        res = ingest_firms_csv_content(
            self.conn, csv_text=csv_sample, region_code="TEST-REG"
        )
        self.assertEqual(res["records_received"], 4)
        self.assertEqual(res["records_inserted"], 3)
        self.assertEqual(res["duplicates_skipped"], 1)

        # Verify co-location grouped the 1 MODIS + 2 VIIRS detections into 1 physical event
        ev = self.conn.execute(
            "SELECT * FROM thermal_events WHERE region_code = 'TEST-REG'"
        ).fetchone()
        self.assertIsNotNone(ev)
        self.assertEqual(ev["sensor_composition"], "DUAL_SENSOR_COINCIDENT")
        self.assertEqual(ev["modis_pixel_count"], 1)
        self.assertEqual(ev["viirs_pixel_count"], 2)
        self.assertEqual(ev["total_pixel_count"], 3)
        # Consolidated FRP should average MODIS (60 MW) and summed VIIRS (32+30=62 MW) -> ~61 MW, NOT 122 MW!
        self.assertAlmostEqual(ev["consolidated_frp_mw"], 61.0, delta=1.5)

    def test_05_monthly_aggregation_consistency(self) -> None:
        """Verifies that every year 2001-2026 has all 12 months aggregated in MX-CHH."""
        cal = compute_burning_calendar(self.conn, "MX-CHH", "harmonized_calibrated")
        self.assertEqual(len(cal["calendar_years"]), 26)
        self.assertEqual(len(cal["monthly_baselines"]), 12)
        for yr in cal["calendar_years"]:
            self.assertEqual(len(yr["months"]), 12)

    def test_06_annual_aggregation_consistency(self) -> None:
        """Verifies that annual totals equal the sum of their 12 constituent months."""
        cal = compute_burning_calendar(self.conn, "MX-CHH", "harmonized_calibrated")
        for yr in cal["calendar_years"]:
            m_sum = sum(c["value"] for c in yr["months"].values() if c["available"])
            self.assertAlmostEqual(yr["annual_total"], m_sum, delta=1.5)

    def test_07_month_conditional_anomaly_detection(self) -> None:
        """
        Verifies the prompt's flagship case study:
        Selecting August 2026 in Chihuahua (MX-CHH) compares strictly against
        historical Augusts (2001-2026) and detects a statistically significant high anomaly.
        """
        comp = compare_month_against_history(
            self.conn,
            region_code="MX-CHH",
            target_year=2026,
            target_month=8,
            metric_mode="harmonized_calibrated",
        )
        card = comp["indicator_card"]
        self.assertEqual(comp["target_month_name"], "August")
        self.assertEqual(card["total_years_evaluated"], 26)
        self.assertGreater(card["month_activity"], card["historical_month_median"])
        self.assertGreater(card["difference_pct"], 80.0)
        self.assertGreaterEqual(card["historical_percentile"], 90.0)
        self.assertIn(card["classification_code"], ("EXTREME_HIGH", "UNUSUALLY_HIGH"))
        # Verify all entries in same_month_history are month=8
        for item in comp["same_month_history"]:
            self.assertEqual(item["month"], 8)

    def test_08_cross_sensor_harmonization_vs_naive_concatenation(self) -> None:
        """
        Verifies that naive concatenation (MODIS + VIIRS) produces a massive artificial jump
        (>350%) after 2012, whereas our Harmonized Calibrated series eliminates the
        sensor discontinuity while preserving true climate variability.
        """
        cal = compute_burning_calendar(self.conn, "MX-CHH", "harmonized_calibrated")
        diag = cal["trend_diagnostics"]
        self.assertGreater(diag["naive_concat_artificial_jump_pct"], 350.0)
        self.assertLess(abs(diag["harmonized_epoch_change_pct"]), 45.0)

    def test_09_statistical_consistency_and_small_sample_guard(self) -> None:
        """Verifies that sample sizes N < 10 trigger an explicit scientific sufficiency warning."""
        res = classify_anomaly(percentile=98.0, z_mad=3.1, pct_diff_median=120.0, sample_count=6)
        self.assertEqual(res["code"], "INSUFFICIENT_DATA")
        self.assertIsNotNone(res["warning"])

        fp = compute_historical_fire_fingerprint(self.conn, "MX-CHH")
        total_share = sum(s["share_of_annual_pct"] for s in fp["seasonality_profile"])
        self.assertAlmostEqual(total_share, 100.0, delta=0.5)

    def test_10_csv_and_geojson_scientific_export(self) -> None:
        """Verifies that CSV and GeoJSON exports include provenance headers and valid geometries."""
        q = query_spatial_hotspots(self.conn, region_code="MX-CHH", year=2026, limit=50)
        meta = {"region_code": "MX-CHH", "period_label": "2026", "instrument": "ALL"}

        csv_out = export_hotspots_csv(q, meta)
        self.assertIn("# GLOBAL FIRE INTELLIGENCE (GFI)", csv_out)
        self.assertIn("event_sensor_composition", csv_out)

        geojson_bytes = export_hotspots_geojson(q, meta)
        gj = json.loads(geojson_bytes.decode("utf-8"))
        self.assertEqual(gj["type"], "FeatureCollection")
        self.assertGreater(len(gj["features"]), 0)
        self.assertEqual(gj["features"][0]["geometry"]["type"], "Point")

        cal = compute_burning_calendar(self.conn, "MX-CHH", "harmonized_calibrated")
        cal_csv = export_calendar_series_csv(cal)
        self.assertIn("harmonized_calibrated_index", cal_csv)

    def test_11_spatial_rtree_and_polygon_queries(self) -> None:
        """Verifies R-Tree bounding box and custom polygon ray-casting filtering."""
        poly = [
            [27.5, -108.8],
            [29.8, -108.8],
            [29.8, -106.5],
            [27.5, -106.5],
        ]
        q = query_spatial_hotspots(self.conn, polygon_coords=poly, limit=200)
        self.assertGreater(q["summary"]["returned_records"], 0)
        for h in q["hotspots"]:
            self.assertTrue(27.5 <= h["latitude"] <= 29.8)
            self.assertTrue(-108.8 <= h["longitude"] <= -106.5)

    def test_12_event_provenance_and_regional_comparison(self) -> None:
        """Verifies full provenance chain from thermal_events -> event_members -> raw_hotspots."""
        ev = self.conn.execute(
            "SELECT * FROM thermal_events WHERE sensor_composition = 'DUAL_SENSOR_COINCIDENT' LIMIT 1"
        ).fetchone()
        self.assertIsNotNone(ev)
        members = self.conn.execute(
            """
            SELECT em.*, h.instrument, h.satellite, h.scan, h.track, h.frp
            FROM event_members em
            JOIN raw_hotspots h ON em.hotspot_id = h.id
            WHERE em.event_id = ?
            """,
            (ev["event_id"],),
        ).fetchall()
        self.assertGreaterEqual(len(members), 2)
        instruments = {m["instrument"] for m in members}
        self.assertEqual(instruments, {"MODIS", "VIIRS"})


if __name__ == "__main__":
    unittest.main(verbosity=2)
