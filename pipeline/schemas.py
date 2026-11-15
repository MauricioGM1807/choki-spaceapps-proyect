"""
Pydantic Validation Schemas & Data Contracts for MODIS and VIIRS Harmonization.
Preserves 100% of native sensor attributes while computing standardized physical metrics.
"""

from __future__ import annotations
import math
import hashlib
from datetime import datetime, timezone
from typing import Optional, Literal, List
from pydantic import BaseModel, Field, field_validator, model_validator


def standardize_confidence(instrument: str, raw_conf: str | int | float) -> tuple[str, float]:
    """
    Maps native sensor confidence to a unified tier ('Low', 'Nominal', 'High')
    and a continuous weight score (0-100) without discarding the raw value.
    
    - MODIS (MCD14ML/DL): 0-100 integer (<30 Low, 30-79 Nominal, >=80 High)
    - VIIRS (VNP14IMG/VJ114IMG): 'l'/'low', 'n'/'nominal', 'h'/'high'
    """
    inst = instrument.upper().strip()
    s = str(raw_conf).strip().lower()
    if inst == "VIIRS" or s in ("l", "n", "h", "low", "nominal", "high"):
        if s.startswith("l"):
            return "Low", 20.0
        elif s.startswith("h"):
            return "High", 90.0
        else:
            return "Nominal", 60.0
    try:
        val = float(s)
        val = max(0.0, min(100.0, val))
        if val < 30.0:
            return "Low", val
        elif val < 80.0:
            return "Nominal", val
        else:
            return "High", val
    except ValueError:
        return "Nominal", 50.0


def normalize_satellite_code(satellite: str, instrument: str) -> str:
    """Normalizes satellite identifiers across FIRMS Archive and NRT conventions."""
    s = str(satellite).strip().upper()
    if s in ("T", "TERRA", "EOS-TERRA"):
        return "Terra"
    if s in ("A", "AQUA", "EOS-AQUA"):
        return "Aqua"
    if s in ("N", "SNPP", "SUOMI-NPP", "SUOMI NPP", "NPP"):
        return "Suomi-NPP"
    if s in ("N20", "NOAA-20", "NOAA20", "JPSS-1", "J1", "1"):
        return "NOAA-20"
    if s in ("N21", "NOAA-21", "NOAA21", "JPSS-2", "J2", "2"):
        return "NOAA-21"
    return "Terra" if instrument.upper() == "MODIS" else "Suomi-NPP"


class RawHotspotRecord(BaseModel):
    """Validated representation of a single MODIS or VIIRS thermal anomaly detection."""
    latitude: float = Field(..., ge=-90.0, le=90.0)
    longitude: float = Field(..., ge=-180.0, le=180.0)
    acq_date: str = Field(..., pattern=r"^\d{4}-\d{2}-\d{2}$")
    acq_time: str = Field(..., pattern=r"^\d{4}$")
    satellite: str
    instrument: Literal["MODIS", "VIIRS"]
    product_code: str
    version: str = "6.1"
    confidence_raw: str
    confidence_tier: Literal["Low", "Nominal", "High"] = "Nominal"
    confidence_score: float = Field(default=60.0, ge=0.0, le=100.0)
    bright_mir: float = Field(..., gt=200.0, lt=2000.0, description="Brightness temp in MIR (Ch21/22 or I4) in Kelvin")
    bright_tir: float = Field(default=295.0, gt=150.0, lt=1000.0, description="Brightness temp in TIR (Ch31 or I5) in Kelvin")
    frp: float = Field(..., ge=0.0, le=100000.0, description="Fire Radiative Power in MW")
    scan: float = Field(..., gt=0.05, le=10.0, description="Along-scan pixel size in km")
    track: float = Field(..., gt=0.05, le=10.0, description="Along-track pixel size in km")
    daynight: Literal["D", "N"] = "D"
    anomaly_type: int = Field(default=0, ge=0, le=3, description="0=veg fire, 1=volcano, 2=static land, 3=offshore")
    region_code: str = Field(default="GLOBAL")
    source_provenance: Literal[
        "NASA_FIRMS_API",
        "NASA_FIRMS_CSV_IMPORT",
        "CALIBRATED_REFERENCE_SERIES"
    ] = "NASA_FIRMS_CSV_IMPORT"
    pixel_area_km2: float = 0.0
    footprint_radius_km: float = 0.0
    acq_year: int = 2001
    acq_month: int = 1
    acq_timestamp_utc: int = 0
    record_hash: str = ""

    @field_validator("acq_time", mode="before")
    @classmethod
    def pad_acq_time(cls, v: str | int) -> str:
        s = str(v).strip().replace(":", "")
        if len(s) > 4:
            s = s[:4]
        s = s.zfill(4)
        hh = int(s[:2])
        mm = int(s[2:])
        if not (0 <= hh <= 23 and 0 <= mm <= 59):
            raise ValueError(f"Invalid UTC acquisition time HHMM: {v}")
        return s

    @field_validator("daynight", mode="before")
    @classmethod
    def clean_daynight(cls, v: str) -> str:
        s = str(v).strip().upper()
        return "N" if s.startswith("N") else "D"

    @model_validator(mode="after")
    def compute_derived_physical_fields(self) -> "RawHotspotRecord":
        self.satellite = normalize_satellite_code(self.satellite, self.instrument)
        tier, score = standardize_confidence(self.instrument, self.confidence_raw)
        self.confidence_tier = tier  # type: ignore
        self.confidence_score = score
        self.pixel_area_km2 = round(self.scan * self.track, 5)
        self.footprint_radius_km = round(0.5 * math.sqrt(self.scan ** 2 + self.track ** 2), 5)

        dt = datetime.strptime(f"{self.acq_date} {self.acq_time}", "%Y-%m-%d %H%M").replace(tzinfo=timezone.utc)
        self.acq_year = dt.year
        self.acq_month = dt.month
        self.acq_timestamp_utc = int(dt.timestamp())

        if not self.record_hash:
            key = (
                f"{self.instrument}|{self.satellite}|{self.acq_date}|{self.acq_time}|"
                f"{self.latitude:.5f}|{self.longitude:.5f}|{self.frp:.2f}"
            )
            self.record_hash = hashlib.sha1(key.encode("utf-8")).hexdigest()[:20]
        return self


class SpatialFilterParams(BaseModel):
    """Validated query parameters for spatial and temporal filtering."""
    region_code: Optional[str] = None
    min_lat: Optional[float] = Field(default=None, ge=-90.0, le=90.0)
    max_lat: Optional[float] = Field(default=None, ge=-90.0, le=90.0)
    min_lon: Optional[float] = Field(default=None, ge=-180.0, le=180.0)
    max_lon: Optional[float] = Field(default=None, ge=-180.0, le=180.0)
    polygon_coords: Optional[List[List[float]]] = None  # [[lat, lon], ...]
    start_date: Optional[str] = Field(default=None, pattern=r"^\d{4}-\d{2}-\d{2}$")
    end_date: Optional[str] = Field(default=None, pattern=r"^\d{4}-\d{2}-\d{2}$")
    year: Optional[int] = Field(default=None, ge=2000, le=2030)
    month: Optional[int] = Field(default=None, ge=1, le=12)
    instrument: Optional[Literal["ALL", "MODIS", "VIIRS"]] = "ALL"
    satellite: Optional[str] = "ALL"
    min_confidence_tier: Optional[Literal["ALL", "Nominal", "High"]] = "ALL"
    min_frp: float = Field(default=0.0, ge=0.0)
    daynight: Optional[Literal["ALL", "D", "N"]] = "ALL"
    vegetation_only: bool = True
    limit: int = Field(default=5000, ge=1, le=25000)
    offset: int = Field(default=0, ge=0)
