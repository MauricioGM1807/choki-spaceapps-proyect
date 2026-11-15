# Security Policy — Choki (Global Fire Intelligence)

[English](README.md) | [Español](README-es.md)

## Supported Scope

This security policy applies to the **Choki — Global Fire Intelligence (GFI)** platform (`v1.0.0`), including:

- Local HTTP/REST server ([`server.py`](server.py))
- Scientific ingestion, harmonization, analytics, and neural auditing modules ([`pipeline/`](pipeline/))
- Synchronization scripts ([`scripts/`](scripts/))
- Frontend web client and PWA assets ([`web/`](web/))

---

## Secrets & Credentials Handling

- **Never commit API keys or `.env` files.** The `FIRMS_MAP_KEY` credential required for live NASA FIRMS near-real-time synchronization must remain exclusively in a local `.env` file (which is ignored by [`.gitignore`](.gitignore)) or injected at runtime as an environment variable (for example via `docker run -e FIRMS_MAP_KEY=...`).
- If `FIRMS_MAP_KEY` is accidentally exposed or committed, rotate the key immediately through NASA FIRMS and purge it from version history before pushing changes.

---

## Built-In Runtime Protections

- **Content Security Policy (CSP) & HTTP Headers:** [`server.py`](server.py) enforces strict Content Security Policy headers and serves bundled third-party frontend dependencies locally from `web/vendor/` (`React 18.3.1`, `html2canvas 1.4.1`) instead of relying on unpinned external CDN scripts.
- **Input & Schema Validation:** Incoming hotspot records and spatial filter parameters are validated with **Pydantic v2** schemas in [`pipeline/schemas.py`](pipeline/schemas.py) before storage or harmonization.
- **Isolated Database Execution:** Automated verification in [`tests/test_scientific_pipeline.py`](tests/test_scientific_pipeline.py) runs against in-memory SQLite (`:memory:`) so testing never mutates production or seeded local archives (`data/gfi_fire_intelligence.sqlite`).

---

## Safe Deployment Practices

- **Local Development vs. Public Exposure:** `server.py` uses Python's `ThreadingHTTPServer` and is intended for local evaluation (`127.0.0.1:8766`) or containerized execution behind a reverse proxy with TLS termination when deployed to cloud infrastructure.
- **Container Isolation:** When running for evaluation or judging, follow the Docker steps in [BUILD.md](BUILD.md) so dependencies and runtime permissions remain isolated from the host machine.

---

## Reporting a Vulnerability

If you discover a security vulnerability, data-integrity risk, or unintended credential exposure in Choki:

1. **Do not open a public issue** containing exploit details or sensitive tokens.
2. Contact the **Chokí Harmonized Fire Data** maintainers privately via the repository's GitHub Security Advisories / private maintainer channel, including:
   - Affected file path or endpoint (e.g., `server.py`, `pipeline/ingestor.py`, `web/js/app.js`)
   - Steps to reproduce or minimal proof of concept
   - Expected vs. observed behavior and potential impact
3. Allow maintainers time to verify and patch the issue prior to public disclosure.
