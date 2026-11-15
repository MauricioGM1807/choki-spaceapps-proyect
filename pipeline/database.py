"""
Geospatial SQLite 3.54 Database Layer with R-Tree 2D Spatial Indexing
and Full Provenance Traceability for MODIS and VIIRS Active Fire Products.
"""

from __future__ import annotations
import os
import sqlite3
from pathlib import Path
from typing import Optional

BASE_DIR = Path(__file__).resolve().parent.parent
DATA_DIR = BASE_DIR / "data"
DEFAULT_DB_PATH = DATA_DIR / "gfi_fire_intelligence.sqlite"


REFERENCE_REGIONS = [
    {
        "region_code": "MX-CHH",
        "name": "Chihuahua & Sierra Madre Occidental, México",
        "country": "México",
        "biome": "Bosque Templado de Pino-Encino y Pastizal Semiárido",
        "min_lat": 25.55,
        "max_lat": 31.78,
        "min_lon": -109.08,
        "max_lon": -103.30,
        "center_lat": 28.63,
        "center_lon": -106.08,
        "default_zoom": 6,
        "peak_season_months": "Abril – Agosto",
        "description": (
            "Ecorregión de bosques de pino-encino de la Sierra Madre Occidental y pastizales "
            "del Desierto Chihuahuense. Presenta un régimen bimodal con pico primario en "
            "primavera seca (abril-junio) y actividad estival (julio-agosto) modulada por "
            "sequías del Monzón de Norteamérica."
        ),
    },
    {
        "region_code": "BR-AMZ",
        "name": "Arco de Deforestación Amazónico (Mato Grosso / Pará), Brasil",
        "country": "Brasil",
        "biome": "Bosque Tropical Húmedo y Transición Cerrado",
        "min_lat": -13.50,
        "max_lat": -6.00,
        "min_lon": -59.50,
        "max_lon": -50.50,
        "center_lat": -9.75,
        "center_lon": -55.00,
        "default_zoom": 6,
        "peak_season_months": "Julio – Octubre",
        "description": (
            "Frente activo del sur de la cuenca amazónica con intensa actividad térmica "
            "durante la estación seca austral (julio-octubre), combinando incendios forestales "
            "de sotobosque y quemas agropecuarias fragmentadas."
        ),
    },
    {
        "region_code": "US-CAL",
        "name": "California & Sierra Nevada, Estados Unidos",
        "country": "Estados Unidos",
        "biome": "Bosque Mediterráneo, Chaparral y Coníferas Montanas",
        "min_lat": 33.50,
        "max_lat": 41.80,
        "min_lon": -124.20,
        "max_lon": -117.00,
        "center_lat": 37.65,
        "center_lon": -120.60,
        "default_zoom": 6,
        "peak_season_months": "Julio – Octubre",
        "description": (
            "Complejo mediterráneo y montano caracterizado por incendios de alta potencia "
            "radiativa (FRP) entre julio y octubre, impulsados por déficit de presión de "
            "vapor y vientos catabáticos."
        ),
    },
    {
        "region_code": "AU-NSW",
        "name": "New South Wales & Victoria Oriental, Australia",
        "country": "Australia",
        "biome": "Bosque Esclerófilo de Eucalipto y Matorral Templado",
        "min_lat": -37.80,
        "max_lat": -29.00,
        "min_lon": 146.50,
        "max_lon": 153.50,
        "center_lat": -33.40,
        "center_lon": 150.00,
        "default_zoom": 6,
        "peak_season_months": "Noviembre – Febrero",
        "description": (
            "Bosques de eucalipto del sureste australiano con máximo en el verano austral "
            "(noviembre-febrero), incluyendo la anomalía histórica extrema del 'Black Summer' "
            "(2019–2020)."
        ),
    },
    {
        "region_code": "RU-SAK",
        "name": "Taiga Boreal de Sajá (Yakutia), Siberia",
        "country": "Rusia",
        "biome": "Bosque Boreal de Alerce (Taiga) y Turberas Subárticas",
        "min_lat": 59.50,
        "max_lat": 66.80,
        "min_lon": 121.00,
        "max_lon": 136.00,
        "center_lat": 63.15,
        "center_lon": 128.50,
        "default_zoom": 5,
        "peak_season_months": "Junio – Agosto",
        "description": (
            "Ecosistema boreal de alta latitud con temporada de incendios concentrada en "
            "el verano boreal (junio-agosto) asociada a ondas de calor árticas e igniciones "
            "por tormentas eléctricas secas."
        ),
    },
    {
        "region_code": "ES-IBE",
        "name": "Noroeste Ibérico y Meseta Mediterránea (España / Portugal)",
        "country": "España / Portugal",
        "biome": "Bosque Mediterráneo y Matorral Atlántico-Mediterráneo",
        "min_lat": 37.00,
        "max_lat": 43.20,
        "min_lon": -9.00,
        "max_lon": -1.50,
        "center_lat": 40.10,
        "center_lon": -5.25,
        "default_zoom": 6,
        "peak_season_months": "Julio – Septiembre",
        "description": (
            "Región mediterránea europea con alta recurrencia estival (julio-septiembre) "
            "y fuerte contraste entre pequeños conatos detectados por VIIRS 375m y grandes "
            "incendios forestales captados por MODIS y VIIRS."
        ),
    },
]


SCHEMA_SQL = """
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA foreign_keys = ON;
PRAGMA temp_store = MEMORY;

CREATE TABLE IF NOT EXISTS regions (
    region_code TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    country TEXT NOT NULL,
    biome TEXT NOT NULL,
    min_lat REAL NOT NULL,
    max_lat REAL NOT NULL,
    min_lon REAL NOT NULL,
    max_lon REAL NOT NULL,
    center_lat REAL NOT NULL,
    center_lon REAL NOT NULL,
    default_zoom INTEGER NOT NULL DEFAULT 6,
    peak_season_months TEXT NOT NULL,
    description TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS raw_hotspots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    record_hash TEXT UNIQUE NOT NULL,
    region_code TEXT NOT NULL,
    latitude REAL NOT NULL,
    longitude REAL NOT NULL,
    acq_date TEXT NOT NULL,
    acq_time TEXT NOT NULL,
    acq_year INTEGER NOT NULL,
    acq_month INTEGER NOT NULL,
    acq_timestamp_utc INTEGER NOT NULL,
    satellite TEXT NOT NULL,
    instrument TEXT NOT NULL,
    product_code TEXT NOT NULL,
    version TEXT NOT NULL,
    confidence_raw TEXT NOT NULL,
    confidence_tier TEXT NOT NULL,
    confidence_score REAL NOT NULL,
    bright_mir REAL NOT NULL,
    bright_tir REAL NOT NULL,
    frp REAL NOT NULL,
    scan REAL NOT NULL,
    track REAL NOT NULL,
    pixel_area_km2 REAL NOT NULL,
    footprint_radius_km REAL NOT NULL,
    daynight TEXT NOT NULL,
    anomaly_type INTEGER NOT NULL DEFAULT 0,
    source_provenance TEXT NOT NULL,
    grid_1km_key TEXT NOT NULL,
    thermal_event_id INTEGER DEFAULT NULL
);

CREATE INDEX IF NOT EXISTS idx_raw_region_ym
    ON raw_hotspots(region_code, acq_year, acq_month, instrument);
CREATE INDEX IF NOT EXISTS idx_raw_date
    ON raw_hotspots(acq_date, instrument, confidence_tier);
CREATE INDEX IF NOT EXISTS idx_raw_event
    ON raw_hotspots(thermal_event_id);
CREATE INDEX IF NOT EXISTS idx_raw_anom_ym_frp
    ON raw_hotspots(anomaly_type, acq_year, acq_month, frp DESC);
CREATE INDEX IF NOT EXISTS idx_raw_anom_dn_inst
    ON raw_hotspots(anomaly_type, daynight, instrument);
CREATE INDEX IF NOT EXISTS idx_raw_anom_date
    ON raw_hotspots(anomaly_type, acq_date, confidence_tier, frp DESC);
CREATE INDEX IF NOT EXISTS idx_raw_anom_reg_date
    ON raw_hotspots(anomaly_type, region_code, acq_date, acq_time DESC);
CREATE INDEX IF NOT EXISTS idx_raw_anom_reg_ym
    ON raw_hotspots(anomaly_type, region_code, acq_year, acq_month, acq_date DESC, acq_time DESC);
DROP INDEX IF EXISTS idx_raw_anom_reg_dn;
CREATE INDEX IF NOT EXISTS idx_raw_anom_reg_dn_id
    ON raw_hotspots(anomaly_type, region_code, daynight, id);

CREATE VIRTUAL TABLE IF NOT EXISTS hotspots_rtree USING rtree(
    id,
    min_lon, max_lon,
    min_lat, max_lat
);

CREATE TABLE IF NOT EXISTS thermal_events (
    event_id INTEGER PRIMARY KEY AUTOINCREMENT,
    region_code TEXT NOT NULL,
    acq_date TEXT NOT NULL,
    acq_year INTEGER NOT NULL,
    acq_month INTEGER NOT NULL,
    center_lat REAL NOT NULL,
    center_lon REAL NOT NULL,
    start_timestamp_utc INTEGER NOT NULL,
    end_timestamp_utc INTEGER NOT NULL,
    sensor_composition TEXT NOT NULL,
    modis_pixel_count INTEGER NOT NULL DEFAULT 0,
    viirs_pixel_count INTEGER NOT NULL DEFAULT 0,
    total_pixel_count INTEGER NOT NULL DEFAULT 0,
    consolidated_frp_mw REAL NOT NULL DEFAULT 0.0,
    effective_area_km2 REAL NOT NULL DEFAULT 0.0,
    max_bright_mir REAL NOT NULL DEFAULT 0.0,
    confidence_tier TEXT NOT NULL DEFAULT 'Nominal'
);

CREATE INDEX IF NOT EXISTS idx_events_region_ym
    ON thermal_events(region_code, acq_year, acq_month);

CREATE TABLE IF NOT EXISTS event_members (
    event_id INTEGER NOT NULL,
    hotspot_id INTEGER NOT NULL,
    instrument TEXT NOT NULL,
    satellite TEXT NOT NULL,
    distance_to_centroid_km REAL NOT NULL,
    time_offset_min REAL NOT NULL,
    PRIMARY KEY (event_id, hotspot_id)
);

CREATE TABLE IF NOT EXISTS calibration_models (
    region_code TEXT NOT NULL,
    month INTEGER NOT NULL,
    overlap_years_count INTEGER NOT NULL,
    alpha_slope REAL NOT NULL,
    beta_intercept REAL NOT NULL,
    viirs_to_modis_raw_ratio REAL NOT NULL,
    viirs_grid_to_modis_ratio REAL NOT NULL,
    terra_only_adjustment REAL NOT NULL,
    frp_scaling_factor REAL NOT NULL,
    r_squared REAL NOT NULL,
    rmse REAL NOT NULL,
    ci95_low REAL NOT NULL,
    ci95_high REAL NOT NULL,
    validation_status TEXT NOT NULL,
    PRIMARY KEY (region_code, month)
);

CREATE TABLE IF NOT EXISTS harmonized_monthly_series (
    region_code TEXT NOT NULL,
    year INTEGER NOT NULL,
    month INTEGER NOT NULL,
    raw_modis_count INTEGER NOT NULL DEFAULT 0,
    raw_modis_terra_count INTEGER NOT NULL DEFAULT 0,
    raw_modis_aqua_count INTEGER NOT NULL DEFAULT 0,
    raw_viirs_count INTEGER NOT NULL DEFAULT 0,
    raw_viirs_snpp_count INTEGER NOT NULL DEFAULT 0,
    raw_viirs_noaa20_count INTEGER NOT NULL DEFAULT 0,
    raw_viirs_noaa21_count INTEGER NOT NULL DEFAULT 0,
    raw_concatenated_count INTEGER NOT NULL DEFAULT 0,
    colocated_event_count INTEGER NOT NULL DEFAULT 0,
    dual_sensor_event_count INTEGER NOT NULL DEFAULT 0,
    modis_1km_grid_cells INTEGER NOT NULL DEFAULT 0,
    viirs_1km_grid_cells INTEGER NOT NULL DEFAULT 0,
    effort_factor_modis REAL NOT NULL DEFAULT 1.0,
    effort_factor_viirs REAL NOT NULL DEFAULT 1.0,
    harmonized_grid_count REAL NOT NULL DEFAULT 0.0,
    harmonized_calibrated_count REAL NOT NULL DEFAULT 0.0,
    calibration_alpha REAL NOT NULL DEFAULT 1.0,
    calibration_r2 REAL NOT NULL DEFAULT 0.0,
    raw_modis_frp_mw REAL NOT NULL DEFAULT 0.0,
    raw_viirs_frp_mw REAL NOT NULL DEFAULT 0.0,
    harmonized_frp_mw REAL NOT NULL DEFAULT 0.0,
    active_sensors_label TEXT NOT NULL DEFAULT 'MODIS',
    provenance_status TEXT NOT NULL DEFAULT 'CALIBRATED_REFERENCE_SERIES',
    PRIMARY KEY (region_code, year, month)
);

CREATE TABLE IF NOT EXISTS ingestion_log (
    batch_id INTEGER PRIMARY KEY AUTOINCREMENT,
    ingested_at_utc TEXT NOT NULL,
    source_type TEXT NOT NULL,
    source_identifier TEXT NOT NULL,
    region_code TEXT NOT NULL,
    records_received INTEGER NOT NULL,
    records_inserted INTEGER NOT NULL,
    duplicates_skipped INTEGER NOT NULL,
    invalid_rejected INTEGER NOT NULL,
    notes TEXT NOT NULL
);
"""


def get_connection(db_path: Optional[Path | str] = None) -> sqlite3.Connection:
    """Returns a configured SQLite connection with row factory and WAL mode."""
    target = Path(db_path) if db_path else DEFAULT_DB_PATH
    target.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(target), timeout=30.0)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode = WAL;")
    conn.execute("PRAGMA synchronous = NORMAL;")
    return conn


def init_database(db_path: Optional[Path | str] = None) -> sqlite3.Connection:
    """Initializes the SQLite database schema and seeds metadata for reference regions."""
    conn = get_connection(db_path)
    conn.executescript(SCHEMA_SQL)
    with conn:
        for reg in REFERENCE_REGIONS:
            conn.execute(
                """
                INSERT INTO regions (
                    region_code, name, country, biome,
                    min_lat, max_lat, min_lon, max_lon,
                    center_lat, center_lon, default_zoom,
                    peak_season_months, description
                ) VALUES (
                    :region_code, :name, :country, :biome,
                    :min_lat, :max_lat, :min_lon, :max_lon,
                    :center_lat, :center_lon, :default_zoom,
                    :peak_season_months, :description
                )
                ON CONFLICT(region_code) DO UPDATE SET
                    name = excluded.name,
                    biome = excluded.biome,
                    peak_season_months = excluded.peak_season_months,
                    description = excluded.description
                """,
                reg,
            )
    return conn
