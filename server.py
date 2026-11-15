"""
Global Fire Intelligence (GFI) — High-Performance Scientific HTTP/REST Server.
Serves the Geospatial Web Platform and the Harmonization/Analytics API.
"""

from __future__ import annotations
from datetime import datetime, timezone
import gzip
import hashlib
import os
import re
import sys
import threading
import time
import mimetypes
import traceback
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler
from pathlib import Path
from urllib.parse import urlparse, parse_qs
from typing import Dict, Any, Optional, List, Tuple
import orjson

ROOT_DIR = Path(__file__).resolve().parent
WEB_DIR = ROOT_DIR / "web"
if str(ROOT_DIR) not in sys.path:
    sys.path.insert(0, str(ROOT_DIR))

# Load local .env secrets securely into process environment (never exposed to frontend)
_env_path = ROOT_DIR / ".env"
if _env_path.is_file():
    for _line in _env_path.read_text(encoding="utf-8").splitlines():
        _line = _line.strip()
        if not _line or _line.startswith("#") or "=" not in _line:
            continue
        _k, _v = _line.split("=", 1)
        os.environ.setdefault(_k.strip(), _v.strip().strip('"').strip("'"))

from pipeline.database import init_database, get_connection, DEFAULT_DB_PATH
from pipeline.ingestor import (
    seed_calibrated_reference_archive,
    ingest_firms_csv_content,
    fetch_nasa_firms_live,
    sync_firms_date_range,
)
from pipeline.harmonizer import colocate_region_dates
from pipeline.analytics import (
    compute_burning_calendar,
    compare_month_against_history,
    compute_historical_fire_fingerprint,
    query_spatial_hotspots,
)
from pipeline.exporter import (
    export_hotspots_csv,
    export_hotspots_geojson,
    export_calendar_series_csv,
)
from pipeline.harmonized_exporter import (
    query_harmonized_export_preview,
    export_harmonized_dataset,
)
from pipeline.choki_ai import (
    audit_harmonization_quality,
    analyze_zone_or_query,
)


def parse_float_opt(val: Optional[str]) -> Optional[float]:
    if val is None or val == "":
        return None
    return float(val)


def parse_int_opt(val: Optional[str]) -> Optional[int]:
    if val is None or val == "":
        return None
    return int(val)


_CSP_POLICY = (
    "default-src 'self'; "
    "script-src 'self' https://unpkg.com; "
    "style-src 'self' 'unsafe-inline' https://unpkg.com https://fonts.googleapis.com; "
    "font-src 'self' https://fonts.gstatic.com data:; "
    "img-src 'self' data: blob: https://*.arcgisonline.com https://*.cartocdn.com "
    "https://*.openstreetmap.org https://gibs.earthdata.nasa.gov; "
    "connect-src 'self' blob: http://127.0.0.1:8766 http://localhost:8766 https://unpkg.com "
    "https://*.arcgisonline.com https://*.cartocdn.com https://*.openstreetmap.org "
    "https://nominatim.openstreetmap.org https://gibs.earthdata.nasa.gov https://firms.modaps.eosdis.nasa.gov; "
    "worker-src 'self' blob:; "
    "base-uri 'self'; "
    "frame-ancestors 'none';"
)

_ASSET_CACHE: Dict[Path, Tuple[int, bytes, bytes, str]] = {}


def _minify_html(raw: str) -> str:
    no_comments = re.sub(r"<!--[\s\S]*?-->", "", raw)
    lines = [ln.strip() for ln in no_comments.splitlines() if ln.strip()]
    return "\n".join(lines)


def _minify_css(raw: str) -> str:
    no_comments = re.sub(r"/\*[\s\S]*?\*/", "", raw)
    compact = re.sub(r"\s+", " ", no_comments)
    compact = re.sub(r"\s*([{}:;,])\s*", r"\1", compact)
    return compact.replace(";}", "}").strip()


def _minify_js(raw: str) -> str:
    """Safely strip comments and redundant indentation without breaking regex or template literals."""
    out: List[str] = []
    i = 0
    n = len(raw)
    in_str: Optional[str] = None
    in_regex = False
    last_sig = ""
    regex_prev_tokens = set("=(,[!:;&|?{}~+-*/%^<>")

    while i < n:
        ch = raw[i]
        nxt = raw[i + 1] if i + 1 < n else ""

        if in_str:
            out.append(ch)
            if ch == "\\":
                if i + 1 < n:
                    out.append(nxt)
                    i += 2
                    continue
            elif ch == in_str:
                in_str = None
                last_sig = ch
            i += 1
            continue

        if in_regex:
            out.append(ch)
            if ch == "\\":
                if i + 1 < n:
                    out.append(nxt)
                    i += 2
                    continue
            elif ch == "[":
                i += 1
                while i < n:
                    out.append(raw[i])
                    if raw[i] == "\\" and i + 1 < n:
                        i += 1
                        out.append(raw[i])
                    elif raw[i] == "]":
                        break
                    i += 1
            elif ch == "/":
                in_regex = False
                last_sig = "/"
            i += 1
            continue

        if ch == "/" and nxt == "/":
            i += 2
            while i < n and raw[i] != "\n":
                i += 1
            continue
        if ch == "/" and nxt == "*":
            i += 2
            while i + 1 < n and not (raw[i] == "*" and raw[i + 1] == "/"):
                i += 1
            i += 2
            continue

        if ch in ("'", '"', "`"):
            in_str = ch
            out.append(ch)
            i += 1
            continue

        if ch == "/" and (last_sig == "" or last_sig in regex_prev_tokens):
            in_regex = True
            out.append(ch)
            i += 1
            continue

        out.append(ch)
        if not ch.isspace():
            last_sig = ch
        i += 1

    lines = [ln.strip() for ln in "".join(out).splitlines() if ln.strip()]
    return "\n".join(lines)


def _get_optimized_asset(target: Path, ext: str) -> Tuple[bytes, bytes, str]:
    mtime_ns = target.stat().st_mtime_ns
    cached = _ASSET_CACHE.get(target)
    if cached and cached[0] == mtime_ns:
        return cached[1], cached[2], cached[3]

    raw_bytes = target.read_bytes()
    if target.name.endswith(".min.js"):
        min_bytes = raw_bytes
    elif ext == ".html":
        min_bytes = _minify_html(raw_bytes.decode("utf-8")).encode("utf-8")
    elif ext == ".css":
        min_bytes = _minify_css(raw_bytes.decode("utf-8")).encode("utf-8")
    else:
        min_bytes = raw_bytes

    gz_bytes = gzip.compress(min_bytes, compresslevel=6) if len(min_bytes) > 512 else b""
    etag = f'"{hashlib.sha256(min_bytes).hexdigest()[:16]}"'
    _ASSET_CACHE[target] = (mtime_ns, min_bytes, gz_bytes, etag)
    return min_bytes, gz_bytes, etag


class GFIRequestHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, format: str, *args: Any) -> None:
        # Concise structured server log
        sys.stderr.write(f"[GFI-API] {self.address_string()} - {format % args}\n")

    def _send_security_headers(self, include_csp: bool = False) -> None:
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("Referrer-Policy", "strict-origin-when-cross-origin")
        self.send_header("Permissions-Policy", "camera=(), microphone=(), payment=(), usb=()")
        if include_csp:
            self.send_header("Content-Security-Policy", _CSP_POLICY)

    def _send_cors_headers(self) -> None:
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Accept, Origin, X-Requested-With")
        self.send_header("Access-Control-Allow-Private-Network", "true")
        self.send_header("Access-Control-Max-Age", "86400")

    def do_OPTIONS(self) -> None:
        self.send_response(204)
        self.send_header("Content-Length", "0")
        self._send_cors_headers()
        self.end_headers()

    _HTTP_JSON_CACHE: Dict[str, bytes] = {}
    _NRT_SYNC_LOCK = threading.Lock()
    _NRT_SYNC_STATE: Dict[str, Any] = {
        "interval_seconds": 900,
        "syncing": False,
        "last_sync_epoch": 0.0,
        "last_inserted": 0,
        "last_status": "idle",
        "total_cycles": 0,
    }

    def _send_json(self, payload: Any, status: int = 200) -> None:
        body = orjson.dumps(payload, option=orjson.OPT_NON_STR_KEYS)
        accept_enc = self.headers.get("Accept-Encoding", "")
        use_gzip = "gzip" in accept_enc and len(body) > 1024
        out_body = gzip.compress(body, compresslevel=4) if use_gzip else body
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(out_body)))
        if use_gzip:
            self.send_header("Content-Encoding", "gzip")
        self.send_header("Cache-Control", "no-store")
        self._send_security_headers(include_csp=False)
        self._send_cors_headers()
        self.end_headers()
        self.wfile.write(out_body)

    def _send_cached_json(self, cache_key: str, builder_fn: Any) -> None:
        gz_bytes = GFIRequestHandler._HTTP_JSON_CACHE.get(cache_key)
        if gz_bytes is None:
            payload = builder_fn()
            raw_bytes = orjson.dumps(payload, option=orjson.OPT_NON_STR_KEYS)
            gz_bytes = gzip.compress(raw_bytes, compresslevel=4)
            if len(GFIRequestHandler._HTTP_JSON_CACHE) >= 64:
                try:
                    GFIRequestHandler._HTTP_JSON_CACHE.pop(next(iter(GFIRequestHandler._HTTP_JSON_CACHE)))
                except StopIteration:
                    pass
            GFIRequestHandler._HTTP_JSON_CACHE[cache_key] = gz_bytes
        else:
            raw_bytes = None

        accept_enc = self.headers.get("Accept-Encoding", "")
        use_gzip = "gzip" in accept_enc
        if use_gzip:
            out_body = gz_bytes
        else:
            out_body = raw_bytes if raw_bytes is not None else gzip.decompress(gz_bytes)
        self.send_response(200)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(out_body)))
        if use_gzip:
            self.send_header("Content-Encoding", "gzip")
        self.send_header("Cache-Control", "no-store")
        self._send_security_headers(include_csp=False)
        self._send_cors_headers()
        self.end_headers()
        self.wfile.write(out_body)

    def _send_download(self, content: bytes | str, filename: str, mime: str) -> None:
        body = content.encode("utf-8") if isinstance(content, str) else content
        self.send_response(200)
        self.send_header("Content-Type", mime)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Content-Disposition", f'attachment; filename="{filename}"')
        self.send_header("X-Content-Type-Options", "nosniff")
        self._send_cors_headers()
        self.end_headers()
        self.wfile.write(body)

    def _read_json_body(self) -> Dict[str, Any]:
        length = int(self.headers.get("Content-Length", "0"))
        if length <= 0 or length > 15 * 1024 * 1024:
            return {}
        raw = self.rfile.read(length)
        return orjson.loads(raw)

    def do_GET(self) -> None:
        parsed = urlparse(self.path)
        path = parsed.path
        qs = {k: v[0] for k, v in parse_qs(parsed.query).items()}

        if path.startswith("/api/"):
            try:
                self._handle_api_get(path, qs)
            except (BrokenPipeError, ConnectionResetError):
                return
            except ValueError as ve:
                self._send_json({"error": str(ve), "type": "ValidationError"}, status=400)
            except Exception as exc:
                traceback.print_exc()
                self._send_json({"error": str(exc), "type": "ServerError"}, status=500)
            return

        self._serve_static(path)

    def do_POST(self) -> None:
        parsed = urlparse(self.path)
        path = parsed.path
        try:
            body = self._read_json_body()
            self._handle_api_post(path, body)
        except (BrokenPipeError, ConnectionResetError):
            return
        except ValueError as ve:
            self._send_json({"error": str(ve), "type": "ValidationError"}, status=400)
        except Exception as exc:
            traceback.print_exc()
            self._send_json({"error": str(exc), "type": "ServerError"}, status=500)

    def _handle_api_get(self, path: str, qs: Dict[str, str]) -> None:
        conn = get_connection(DEFAULT_DB_PATH)
        try:
            if path == "/api/health":
                counts = conn.execute(
                    """
                    SELECT
                        (SELECT COUNT(*) FROM regions) AS regions_count,
                        (SELECT COUNT(*) FROM raw_hotspots) AS raw_hotspots_count,
                        (SELECT COUNT(*) FROM thermal_events) AS thermal_events_count,
                        (SELECT COUNT(*) FROM harmonized_monthly_series) AS monthly_series_count
                    """
                ).fetchone()
                self._send_json(
                    {
                        "status": "ok",
                        "engine": "Global Fire Intelligence Scientific Core v1.0",
                        "database": dict(counts),
                        "firms_api_configured": bool(os.environ.get("FIRMS_MAP_KEY")),
                        "nrt_sync": dict(GFIRequestHandler._NRT_SYNC_STATE),
                    }
                )
                return

            if path == "/api/regions":
                def _build_regions() -> Dict[str, Any]:
                    rows = conn.execute(
                        """
                        SELECT r.*,
                               COUNT(h.id) AS sample_hotspots_count,
                               SUM(CASE WHEN h.instrument = 'MODIS' THEN 1 ELSE 0 END) AS modis_sample_count,
                               SUM(CASE WHEN h.instrument = 'VIIRS' THEN 1 ELSE 0 END) AS viirs_sample_count
                        FROM regions r
                        LEFT JOIN raw_hotspots h ON r.region_code = h.region_code
                        GROUP BY r.region_code
                        ORDER BY CASE WHEN r.region_code = 'MX-CHH' THEN 0 ELSE 1 END, r.name ASC
                        """
                    ).fetchall()
                    return {"regions": [dict(r) for r in rows]}
                self._send_cached_json("GET:/api/regions", _build_regions)
                return

            if path == "/api/overview":
                region_code = qs.get("region_code", "MX-CHH")
                metric_mode = qs.get("metric_mode", "harmonized_calibrated")
                target_year = int(qs.get("target_year", "2026"))
                target_month = int(qs.get("target_month", "8"))
                cache_key = f"GET:/api/overview:{region_code}:{metric_mode}:{target_year}:{target_month}"

                def _build_overview() -> Dict[str, Any]:
                    calendar = compute_burning_calendar(conn, region_code, metric_mode)
                    month_comp = compare_month_against_history(
                        conn, region_code, target_year, target_month, metric_mode
                    )
                    fingerprint = compute_historical_fire_fingerprint(conn, region_code)
                    provenance_logs = [
                        dict(r)
                        for r in conn.execute(
                            "SELECT * FROM ingestion_log ORDER BY batch_id DESC LIMIT 10"
                        ).fetchall()
                    ]
                    return {
                        "calendar": calendar,
                        "month_comparison": month_comp,
                        "fingerprint": fingerprint,
                        "provenance_logs": provenance_logs,
                    }

                self._send_cached_json(cache_key, _build_overview)
                return

            if path == "/api/calendar":
                region_code = qs.get("region_code", "MX-CHH")
                metric_mode = qs.get("metric_mode", "harmonized_calibrated")
                start_year = int(qs.get("start_year", "2001"))
                end_year = int(qs.get("end_year", "2026"))
                cal = compute_burning_calendar(conn, region_code, metric_mode, start_year, end_year)
                self._send_json(cal)
                return

            if path == "/api/month-comparison":
                region_code = qs.get("region_code", "MX-CHH")
                target_year = int(qs.get("year", "2026"))
                target_month = int(qs.get("month", "8"))
                metric_mode = qs.get("metric_mode", "harmonized_calibrated")
                comp = compare_month_against_history(
                    conn, region_code, target_year, target_month, metric_mode
                )
                self._send_json(comp)
                return

            if path == "/api/fingerprint":
                region_code = qs.get("region_code", "MX-CHH")
                fp = compute_historical_fire_fingerprint(conn, region_code)
                self._send_json(fp)
                return

            if path == "/api/regional-comparison":
                reg_a = qs.get("region_a", "MX-CHH")
                reg_b = qs.get("region_b", "BR-AMZ")
                metric_mode = qs.get("metric_mode", "harmonized_calibrated")

                cal_a = compute_burning_calendar(conn, reg_a, metric_mode)
                cal_b = compute_burning_calendar(conn, reg_b, metric_mode)
                fp_a = compute_historical_fire_fingerprint(conn, reg_a)
                fp_b = compute_historical_fire_fingerprint(conn, reg_b)
                self._send_json(
                    {
                        "metric_mode": metric_mode,
                        "region_a": {"calendar": cal_a, "fingerprint": fp_a},
                        "region_b": {"calendar": cal_b, "fingerprint": fp_b},
                    }
                )
                return

            if path == "/api/hotspots":
                res = query_spatial_hotspots(
                    conn,
                    region_code=qs.get("region_code", "MX-CHH"),
                    min_lat=parse_float_opt(qs.get("min_lat")),
                    max_lat=parse_float_opt(qs.get("max_lat")),
                    min_lon=parse_float_opt(qs.get("min_lon")),
                    max_lon=parse_float_opt(qs.get("max_lon")),
                    start_date=qs.get("start_date"),
                    end_date=qs.get("end_date"),
                    year=parse_int_opt(qs.get("year")),
                    month=parse_int_opt(qs.get("month")),
                    instrument=qs.get("instrument", "ALL"),
                    satellite=qs.get("satellite", "ALL"),
                    min_confidence_tier=qs.get("min_confidence_tier", "ALL"),
                    min_frp=float(qs.get("min_frp") or 0.0),
                    daynight=qs.get("daynight", "ALL"),
                    limit=min(20000, int(qs.get("limit") or 2500)),
                    offset=int(qs.get("offset") or 0),
                )
                self._send_json(res)
                return

            if path == "/api/ai/audit":
                rcode = qs.get("region_code", "ALL")
                self._send_json(audit_harmonization_quality(conn, region_code=rcode))
                return

            if path.startswith("/api/event/"):
                event_id = int(path.split("/api/event/")[1])
                ev_row = conn.execute(
                    "SELECT * FROM thermal_events WHERE event_id = ?", (event_id,)
                ).fetchone()
                if not ev_row:
                    self._send_json({"error": "Thermal event not found"}, status=404)
                    return
                members = conn.execute(
                    """
                    SELECT em.*, h.latitude, h.longitude, h.acq_date, h.acq_time,
                           h.product_code, h.version, h.confidence_raw, h.confidence_tier,
                           h.bright_mir, h.bright_tir, h.frp, h.scan, h.track,
                           h.pixel_area_km2, h.daynight, h.record_hash, h.source_provenance
                    FROM event_members em
                    JOIN raw_hotspots h ON em.hotspot_id = h.id
                    WHERE em.event_id = ?
                    ORDER BY h.acq_time ASC
                    """,
                    (event_id,),
                ).fetchall()
                self._send_json(
                    {
                        "event": dict(ev_row),
                        "constituent_detections": [dict(m) for m in members],
                    }
                )
                return

            if path == "/api/export/hotspots.csv":
                rcode = qs.get("region_code", "MX-CHH")
                yr = parse_int_opt(qs.get("year"))
                mo = parse_int_opt(qs.get("month"))
                inst = qs.get("instrument", "ALL")
                res = query_spatial_hotspots(
                    conn,
                    region_code=rcode,
                    min_lat=parse_float_opt(qs.get("min_lat")),
                    max_lat=parse_float_opt(qs.get("max_lat")),
                    min_lon=parse_float_opt(qs.get("min_lon")),
                    max_lon=parse_float_opt(qs.get("max_lon")),
                    year=yr,
                    month=mo,
                    instrument=inst,
                    min_confidence_tier=qs.get("min_confidence_tier", "ALL"),
                    min_frp=float(qs.get("min_frp") or 0.0),
                    limit=10000,
                )
                period_lbl = f"{yr or '2001-2026'}-{mo or 'ALL'}"
                csv_str = export_hotspots_csv(
                    res,
                    {"region_code": rcode, "period_label": period_lbl, "instrument": inst},
                )
                fname = f"GFI_Hotspots_{rcode}_{period_lbl}.csv"
                self._send_download(csv_str, fname, "text/csv; charset=utf-8")
                return

            if path == "/api/export/hotspots.geojson":
                rcode = qs.get("region_code", "MX-CHH")
                yr = parse_int_opt(qs.get("year"))
                mo = parse_int_opt(qs.get("month"))
                inst = qs.get("instrument", "ALL")
                res = query_spatial_hotspots(
                    conn,
                    region_code=rcode,
                    min_lat=parse_float_opt(qs.get("min_lat")),
                    max_lat=parse_float_opt(qs.get("max_lat")),
                    min_lon=parse_float_opt(qs.get("min_lon")),
                    max_lon=parse_float_opt(qs.get("max_lon")),
                    year=yr,
                    month=mo,
                    instrument=inst,
                    min_confidence_tier=qs.get("min_confidence_tier", "ALL"),
                    min_frp=float(qs.get("min_frp") or 0.0),
                    limit=10000,
                )
                period_lbl = f"{yr or '2001-2026'}-{mo or 'ALL'}"
                gj_bytes = export_hotspots_geojson(
                    res,
                    {"region_code": rcode, "period_label": period_lbl, "instrument": inst},
                )
                fname = f"GFI_Hotspots_{rcode}_{period_lbl}.geojson"
                self._send_download(gj_bytes, fname, "application/geo+json; charset=utf-8")
                return

            if path == "/api/export/calendar.csv":
                rcode = qs.get("region_code", "MX-CHH")
                metric = qs.get("metric_mode", "harmonized_calibrated")
                cal = compute_burning_calendar(conn, rcode, metric)
                csv_str = export_calendar_series_csv(cal)
                fname = f"GFI_Harmonized_Calendar_{rcode}_{metric}_2001_2026.csv"
                self._send_download(csv_str, fname, "text/csv; charset=utf-8")
                return

            if path in (
                "/api/export/harmonized/preview",
                "/api/export/harmonized.csv",
                "/api/export/harmonized.geojson",
            ):
                yr_raw = (qs.get("year") or "").strip()
                mo_raw = (qs.get("month") or "").strip()
                exp_params = {
                    "dataset": qs.get("dataset", "events"),
                    "region_code": qs.get("region_code", "ALL"),
                    "scope": qs.get("scope", "full_year"),
                    "year": parse_int_opt(yr_raw) if yr_raw.upper() != "ALL" else None,
                    "month": parse_int_opt(mo_raw) if mo_raw.upper() != "ALL" else None,
                    "date": qs.get("date", ""),
                    "start_date": qs.get("start_date", ""),
                    "end_date": qs.get("end_date", ""),
                    "min_lat": parse_float_opt(qs.get("min_lat")),
                    "max_lat": parse_float_opt(qs.get("max_lat")),
                    "min_lon": parse_float_opt(qs.get("min_lon")),
                    "max_lon": parse_float_opt(qs.get("max_lon")),
                }
                if path == "/api/export/harmonized/preview":
                    self._send_json(query_harmonized_export_preview(conn, exp_params))
                    return
                fmt = "geojson" if path.endswith(".geojson") else "csv"
                content, fname, mime = export_harmonized_dataset(conn, exp_params, fmt=fmt)
                self._send_download(content, fname, mime)
                return

            self._send_json({"error": f"Unknown endpoint {path}"}, status=404)
        finally:
            conn.close()

    def _handle_api_post(self, path: str, body: Dict[str, Any]) -> None:
        conn = get_connection(DEFAULT_DB_PATH)
        try:
            if path == "/api/hotspots/query":
                q_region = body.get("region_code")
                q_min_lat = parse_float_opt(body.get("min_lat"))
                q_max_lat = parse_float_opt(body.get("max_lat"))
                q_min_lon = parse_float_opt(body.get("min_lon"))
                q_max_lon = parse_float_opt(body.get("max_lon"))
                q_poly = body.get("polygon_coords")
                q_sdate = body.get("start_date")
                q_edate = body.get("end_date")
                q_year = parse_int_opt(body.get("year"))
                q_month = parse_int_opt(body.get("month"))
                q_inst = body.get("instrument", "ALL")
                q_sat = body.get("satellite", "ALL")
                q_conf = body.get("min_confidence_tier", "ALL")
                q_frp = float(body.get("min_frp") or 0.0)
                q_dn = body.get("daynight", "ALL")
                q_limit = min(20000, int(body.get("limit") or 3000))
                q_offset = int(body.get("offset") or 0)

                now_utc = datetime.now(timezone.utc)
                utc_today = now_utc.strftime("%Y-%m-%d")
                utc_hhmm = now_utc.strftime("%H%M")
                is_live_window = (not q_edate or q_edate >= utc_today) and (not q_year or int(q_year) >= now_utc.year)
                time_bucket = f"{utc_today}:{utc_hhmm}" if is_live_window else "hist"

                cache_key = (
                    f"POST:/api/hotspots/query:{q_region}:{q_min_lat}:{q_max_lat}:{q_min_lon}:{q_max_lon}:"
                    f"{q_poly}:{q_sdate}:{q_edate}:{q_year}:{q_month}:{q_inst}:{q_sat}:{q_conf}:{q_frp}:{q_dn}:{q_limit}:{q_offset}:{time_bucket}"
                )

                def _build_hotspots() -> Dict[str, Any]:
                    out = query_spatial_hotspots(
                        conn,
                        region_code=q_region,
                        min_lat=q_min_lat,
                        max_lat=q_max_lat,
                        min_lon=q_min_lon,
                        max_lon=q_max_lon,
                        polygon_coords=q_poly,
                        start_date=q_sdate,
                        end_date=q_edate,
                        year=q_year,
                        month=q_month,
                        instrument=q_inst,
                        satellite=q_sat,
                        min_confidence_tier=q_conf,
                        min_frp=q_frp,
                        daynight=q_dn,
                        limit=q_limit,
                        offset=q_offset,
                    )
                    if is_live_window:
                        _maybe_trigger_nrt_sync(conn, utc_today)
                        out["nrt_sync"] = dict(GFIRequestHandler._NRT_SYNC_STATE)
                    return out

                if is_live_window:
                    self._send_json(_build_hotspots())
                else:
                    self._send_cached_json(cache_key, _build_hotspots)
                return

            if path == "/api/ai/analyze":
                res = analyze_zone_or_query(
                    conn,
                    records=body.get("records"),
                    region_code=body.get("region_code", "ALL"),
                    question=body.get("question", ""),
                )
                self._send_json(res)
                return

            if path == "/api/ingest/csv":
                csv_text = body.get("csv_text", "")
                region_code = body.get("region_code", "MX-CHH")
                filename = body.get("filename", "firms_upload.csv")
                if not csv_text or len(csv_text.strip()) < 20:
                    raise ValueError("El archivo CSV está vacío o no contiene cabeceras FIRMS válidas.")
                result = ingest_firms_csv_content(
                    conn,
                    csv_text=csv_text,
                    region_code=region_code,
                    source_provenance="NASA_FIRMS_CSV_IMPORT",
                    source_identifier=filename,
                )
                GFIRequestHandler._HTTP_JSON_CACHE.clear()
                self._send_json(result)
                return

            if path == "/api/nrt/sync":
                triggered = _trigger_nrt_sync_async(force=True)
                self._send_json({"triggered": triggered, "nrt_sync": dict(GFIRequestHandler._NRT_SYNC_STATE)})
                return

            if path == "/api/ingest/firms-api":
                map_key = body.get("map_key") or os.environ.get("FIRMS_MAP_KEY", "")
                if not map_key:
                    raise ValueError(
                        "Se requiere un MAP_KEY válido de NASA FIRMS (obtenible gratis en https://firms.modaps.eosdis.nasa.gov/api/area/)."
                    )
                bbox = body.get("bbox", [-109.08, 25.55, -103.30, 31.78])
                bbox_tuple = (float(bbox[0]), float(bbox[1]), float(bbox[2]), float(bbox[3]))
                region_code = body.get("region_code", "MX-CHH")

                try:
                    if body.get("start_date") and body.get("end_date"):
                        sources = body.get("sources") or ["MODIS_NRT", "VIIRS_NOAA20_NRT", "VIIRS_NOAA21_NRT"]
                        result = sync_firms_date_range(
                            conn,
                            map_key=map_key,
                            sources=sources,
                            bbox_west_south_east_north=bbox_tuple,
                            start_date=body["start_date"],
                            end_date=body["end_date"],
                            region_code=region_code,
                        )
                    else:
                        source = body.get("source", "VIIRS_NOAA20_NRT")
                        day_range = int(body.get("day_range", 5))
                        date_str = body.get("date_str")
                        result = fetch_nasa_firms_live(
                            conn,
                            map_key=map_key,
                            source=source,
                            bbox_west_south_east_north=bbox_tuple,
                            day_range=day_range,
                            date_str=date_str,
                            region_code=region_code,
                        )
                except ValueError:
                    raise
                except Exception as net_err:
                    safe_err = str(net_err).replace(map_key, "***")
                    self._send_json({"error": f"NASA FIRMS API unreachable: {safe_err}", "type": "UpstreamUnavailable"}, status=503)
                    return
                GFIRequestHandler._HTTP_JSON_CACHE.clear()
                self._send_json(result)
                return

            self._send_json({"error": f"Unknown POST endpoint {path}"}, status=404)
        finally:
            conn.close()

    def _serve_static(self, url_path: str) -> None:
        if url_path in ("", "/"):
            target = WEB_DIR / "index.html"
        else:
            rel = url_path.lstrip("/")
            target = (WEB_DIR / rel).resolve()
            if not str(target).startswith(str(WEB_DIR.resolve())):
                self.send_error(403, "Forbidden")
                return

        if not target.exists() or not target.is_file():
            self.send_error(404, "File Not Found")
            return

        ext = target.suffix.lower()
        mime, _ = mimetypes.guess_type(str(target))
        if not mime:
            mime = "application/octet-stream"
        if mime.startswith("text/") or mime in ("application/javascript", "application/json"):
            mime = f"{mime}; charset=utf-8"

        min_bytes, gz_bytes, etag = _get_optimized_asset(target, ext)
        if self.headers.get("If-None-Match") == etag:
            self.send_response(304)
            self.send_header("ETag", etag)
            self._send_security_headers(include_csp=(ext == ".html"))
            self.end_headers()
            return

        accept_enc = self.headers.get("Accept-Encoding", "")
        use_gzip = bool(gz_bytes) and ("gzip" in accept_enc)
        out_bytes = gz_bytes if use_gzip else min_bytes

        self.send_response(200)
        self.send_header("Content-Type", mime)
        self.send_header("Content-Length", str(len(out_bytes)))
        self.send_header("ETag", etag)
        self.send_header("Vary", "Accept-Encoding")
        if use_gzip:
            self.send_header("Content-Encoding", "gzip")
        self.send_header("Cache-Control", "no-cache")
        self._send_security_headers(include_csp=(ext == ".html"))
        self.end_headers()
        self.wfile.write(out_bytes)


def _run_nrt_firms_sync_once(map_key: str) -> int:
    """Fetches last-24h NRT hotspots from NASA FIRMS into SQLite cleanly (fails soft offline)."""
    if not GFIRequestHandler._NRT_SYNC_LOCK.acquire(blocking=False):
        return 0
    conn = get_connection(DEFAULT_DB_PATH)
    inserted = 0
    success_feeds = 0
    errors: List[str] = []
    GFIRequestHandler._NRT_SYNC_STATE["syncing"] = True
    try:
        # Global / Continental bounding box for live NRT monitoring (Americas + Global NRT swath)
        # Uses modest chunked bbox or configured focal region so we stay well below NASA FIRMS 5,000 tx/10m quota.
        sources = ["VIIRS_NOAA20_NRT", "VIIRS_NOAA21_NRT", "MODIS_NRT"]
        world_boxes = [
            ("LIVE-WORLD", (-179.9, -60.0, 179.9, 75.0)),
        ]
        for reg_code, bbox in world_boxes:
            affected_dates = set()
            for src in sources:
                try:
                    res = fetch_nasa_firms_live(
                        conn,
                        map_key=map_key,
                        source=src,
                        bbox_west_south_east_north=bbox,
                        day_range=1,
                        region_code=reg_code,
                        defer_harmonize=True,
                    )
                    inserted += int(res.get("records_inserted") or 0)
                    affected_dates.update(res.get("affected_dates") or [])
                    success_feeds += 1
                except Exception as sync_err:
                    safe_msg = str(sync_err).replace(map_key, "***") if map_key else str(sync_err)
                    errors.append(type(sync_err).__name__)
                    sys.stderr.write(f"[GFI-NRT] {src} note: {safe_msg}\n")
            if affected_dates:
                colocate_region_dates(conn, reg_code, sorted(affected_dates))
        if inserted > 0:
            GFIRequestHandler._HTTP_JSON_CACHE.clear()
        GFIRequestHandler._NRT_SYNC_STATE["last_sync_epoch"] = time.time()
        GFIRequestHandler._NRT_SYNC_STATE["last_inserted"] = inserted
        GFIRequestHandler._NRT_SYNC_STATE["last_status"] = "ok" if success_feeds > 0 else f"error:{errors[0] if errors else 'unavailable'}"
        GFIRequestHandler._NRT_SYNC_STATE["total_cycles"] += 1
    except Exception as err:
        GFIRequestHandler._NRT_SYNC_STATE["last_sync_epoch"] = time.time()
        GFIRequestHandler._NRT_SYNC_STATE["last_status"] = f"error:{type(err).__name__}"
        GFIRequestHandler._NRT_SYNC_STATE["total_cycles"] += 1
    finally:
        GFIRequestHandler._NRT_SYNC_STATE["syncing"] = False
        GFIRequestHandler._NRT_SYNC_LOCK.release()
        conn.close()
    return inserted


def _trigger_nrt_sync_async(force: bool = False) -> bool:
    map_key = os.environ.get("FIRMS_MAP_KEY", "").strip()
    if not map_key:
        GFIRequestHandler._NRT_SYNC_STATE["last_status"] = "awaiting_key"
        return False
    if GFIRequestHandler._NRT_SYNC_STATE.get("syncing"):
        return False
    now_ep = time.time()
    last_ep = float(GFIRequestHandler._NRT_SYNC_STATE.get("last_sync_epoch") or 0.0)
    if not force and last_ep > 0 and (now_ep - last_ep) < 45.0:
        return False

    threading.Thread(
        target=_run_nrt_firms_sync_once,
        args=(map_key,),
        name="GFI-FIRMS-OnDemand-Sync",
        daemon=True,
    ).start()
    return True


def _maybe_trigger_nrt_sync(conn: Any, utc_today: str) -> None:
    if GFIRequestHandler._NRT_SYNC_STATE.get("syncing"):
        return
    last_status = str(GFIRequestHandler._NRT_SYNC_STATE.get("last_status") or "")
    has_today = conn.execute(
        "SELECT 1 FROM raw_hotspots WHERE acq_date = ? AND source_provenance = 'NASA_FIRMS_API' LIMIT 1",
        (utc_today,),
    ).fetchone()
    if has_today is None or last_status != "ok":
        _trigger_nrt_sync_async(force=False)


def _start_nrt_auto_sync_loop(interval_seconds: int = 900) -> None:
    map_key = os.environ.get("FIRMS_MAP_KEY", "").strip()
    if not map_key:
        GFIRequestHandler._NRT_SYNC_STATE["last_status"] = "awaiting_key"
        return

    def _loop() -> None:
        # Start immediately once HTTP server binds so today's live NRT detections load automatically
        time.sleep(0.5)
        while True:
            _run_nrt_firms_sync_once(map_key)
            time.sleep(interval_seconds)

    t = threading.Thread(target=_loop, name="GFI-FIRMS-15m-Watchdog", daemon=True)
    t.start()
    print(f"[GFI] 15-minute live NASA FIRMS NRT auto-sync enabled (interval={interval_seconds}s).")


def bootstrap_application(port: int = 8766, serve: bool = True) -> None:
    print("[GFI] Initializing geospatial database and verifying scientific archive...")
    conn = init_database(DEFAULT_DB_PATH)
    seed_stats = seed_calibrated_reference_archive(conn)
    try:
        conn.execute("PRAGMA optimize")
        compute_burning_calendar(conn, "ALL", "harmonized_calibrated")
        compute_historical_fire_fingerprint(conn, "ALL")
    except Exception as warm_err:
        print(f"[GFI] Cache pre-warm note: {warm_err}")
    conn.close()
    print(f"[GFI] Archive ready: {seed_stats}")

    if serve:
        _start_nrt_auto_sync_loop(900)
        server = ThreadingHTTPServer(("0.0.0.0", port), GFIRequestHandler)
        print(f"[GFI] Global Fire Intelligence platform listening at http://127.0.0.1:{port} and http://localhost:{port}")
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            print("\n[GFI] Shutting down server.")
            server.server_close()


if __name__ == "__main__":
    port_arg = int(os.environ.get("PORT", "8766"))
    bootstrap_application(port=port_arg, serve=("--init-only" not in sys.argv))
