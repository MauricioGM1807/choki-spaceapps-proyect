# Credits & Attributions — Choki (Global Fire Intelligence)

[English](README.md) | [Español](README-es.md)

## Development Team (Chokí Harmonized Fire Data)

This project was designed and built by the **Chokí Harmonized Fire Data** team:

- **Kevin Alejandro Arzola Martinez**
- **Angela Karyme Gamboa Enriquez**
- **Said Lobato Mende**
- **Mauricio Gómez Márquez**
- **Paulina Villalba Anchondo**

---

## Satellite Data Sources & Scientific References

- **NASA FIRMS (Fire Information for Resource Management System):**
  - MODIS Collection (`MCD14ML` standard science archive and `MCD14DL` near-real-time detections)
  - VIIRS 375 m I-band Collections (`VNP14IMGML` Suomi NPP, `VJ114IMGML` NOAA-20, `VJ214IMGML` NOAA-21)
  - https://firms.modaps.eosdis.nasa.gov/
- **EFFIS (European Forest Fire Information System / Copernicus EMS):**
  - European Union 2025 wildfire devastation baseline reference (`1,079,538 hectares` burned across EU countries)
  - https://effis.jrc.ec.europa.eu/

---

## Open-Source Libraries & Software Stack

### Backend & Scientific Pipeline
- **Python** — Core runtime, HTTP/REST server (`server.py`), and scientific pipeline (`pipeline/`)
- **SQLite with R-Tree extension** — Embedded spatial indexing (`hotspots_rtree`) and relational storage
- **NumPy** — Vectorized numerical computation
- **Pydantic** — Data schema validation (`pipeline/schemas.py`)
- **orjson** — High-speed JSON serialization
- **Requests** — NASA FIRMS HTTP ingestion client

### Frontend & User Interface
- **React 18.3.1** (`web/vendor/` & `web/js/choki-react.js`) — Interactive UI components
- **html2canvas 1.4.1** (`web/vendor/`) — Client-side visual capture & export support
- **HTML5 / CSS3 / ES6+ JavaScript / PWA Service Worker** — Map, burning calendar, and offline fallback interface

---

## License

Released under the **MIT License** — Copyright (c) 2026 Chokí Harmonized Fire Data. See [LICENSE](LICENSE).
