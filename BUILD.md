# Build, Local Run & Docker Guide — Choki (GFI)

[English](README.md) | [Español](README-es.md)

This document describes how to build, validate, and run **Choki — Global Fire Intelligence (GFI)** locally or inside a Docker container.

---

## 1. Native Local Execution (Python)

### Prerequisites
- Python `3.10+` (verified on Python `3.14.10`) with SQLite `R-Tree` support (`sqlite3 3.54.0` verified).
- Python packages (`requirements.txt` is `[TO BE ADDED]`):
  - `numpy`
  - `orjson`
  - `pydantic`
  - `requests`

### Steps

```bash
# Install dependencies
python3 -m pip install numpy orjson pydantic requests

# (Optional) Verify/initialize database schema without starting the server
python3 server.py --init-only

# Start HTTP/REST server on default port 8766 (override with PORT=<port>)
python3 server.py
```

Access the application at `http://127.0.0.1:8766`.

### Optional Live NASA FIRMS Ingestion

Create a `.env` file in the project root (ignored by `.gitignore`):

```bash
FIRMS_MAP_KEY=your_firms_map_key_here
```

Manual CLI sync utilities:
- `scripts/sync_firms_area.py`
- `scripts/sync_global_firms_live.py`

---

## 2. Frontend Assets

The frontend (`web/`) is served directly by `server.py` using vanilla HTML5/CSS3/JS and pre-bundled vendor libraries in `web/vendor/` (`React 18.3.1`, `html2canvas 1.4.1`). No Node.js or external bundler step is required. `server.py` performs runtime HTML/CSS minification, gzip compression, and `ETag` caching.

---

## 3. Running in Docker (Step-by-Step Guide for Judges)

> **Note:** `Dockerfile` is not currently committed in the repository (`[TO BE ADDED]`). Create the following `Dockerfile` in the repository root to package and run the full web platform and pre-seeded 191 MB SQLite archive without installing Python dependencies on the host.

### 3.1 Create `Dockerfile`

```dockerfile
FROM python:3.12-slim

WORKDIR /app

RUN pip install --no-cache-dir \
    numpy \
    orjson \
    pydantic \
    requests

COPY . /app

ENV PORT=8766
EXPOSE 8766

CMD ["python3", "server.py"]
```

### 3.2 Build the Image

```bash
docker build -t choki-gfi:latest .
```

### 3.3 Start the Container

Offline evaluation mode (uses `data/gfi_fire_intelligence.sqlite` bundled in the image):

```bash
docker run --rm -p 8766:8766 --name choki-app choki-gfi:latest
```

With optional live NASA FIRMS synchronization:

```bash
docker run --rm -p 8766:8766 -e FIRMS_MAP_KEY="your_key_here" --name choki-app choki-gfi:latest
```

### 3.4 Open in Browser & Stop

- Visit `http://localhost:8766`
- Stop with `Ctrl + C` or `docker stop choki-app`

---

## 4. Scientific Test Suite

Run the 12 automated mathematical and pipeline verification tests (`tests/test_scientific_pipeline.py`):

```bash
python3 tests/test_scientific_pipeline.py
```
