/**
 * CHOKÍ — React 18 Declarative UI Components (Zero-XSS Virtual DOM Layer)
 * Renders live UTC/Local mission clock, Dual-AI Neural Consensus Inspector (IA-1 + IA-2),
 * and Cloud False-Positive Veto & Harmonization Verification tables.
 */
(function (global) {
  if (typeof React === "undefined" || typeof ReactDOM === "undefined") {
    return;
  }

  const h = React.createElement;
  const { useState, useEffect } = React;
  const _roots = new WeakMap();

  function getOrCreateRoot(el) {
    if (!el) return null;
    let r = _roots.get(el);
    if (!r) {
      el.textContent = "";
      r = ReactDOM.createRoot(el);
      _roots.set(el, r);
    }
    return r;
  }

  function LiveClockBadge() {
    const [label, setLabel] = useState(() => formatNow());

    function formatNow() {
      const now = new Date();
      const p = (n) => String(n).padStart(2, "0");
      const localStr = `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())} ${p(now.getHours())}:${p(now.getMinutes())}:${p(now.getSeconds())}`;
      const utcStr = `${p(now.getUTCHours())}:${p(now.getUTCMinutes())} UTC`;
      return `${localStr} • ${utcStr}`;
    }

    useEffect(() => {
      const id = setInterval(() => setLabel(formatNow()), 1000);
      return () => clearInterval(id);
    }, []);

    return h("span", { id: "hud-clock-label" }, label);
  }

  function DualAiQcCard({ out, loading, errorMsg }) {
    if (loading) {
      return h(
        "div",
        { className: "qc-auto-strip" },
        h(
          "div",
          { className: "qc-auto-strip-header" },
          h("span", null, "Fire Verification"),
          h("span", { style: { fontSize: "10.5px", color: "#94a3b8" } }, "Screening pixels...")
        )
      );
    }

    if (errorMsg || !out) {
      return h(
        "div",
        { className: "qc-auto-strip warn" },
        h(
          "div",
          { className: "qc-auto-strip-header" },
          h("span", null, "Fire Verification"),
          h("span", { className: "provenance-pill pill-harmonized" }, errorMsg || "Offline")
        )
      );
    }

    const zc = out.zone_classification_counts || {};
    const active = zc.ACTIVE_BIOMASS_FIRE ?? 0;
    const clouds = zc.CLOUD_EDGE_OR_CONTAMINATED ?? 0;
    const flares = zc.PERSISTENT_INDUSTRIAL_FLARE ?? 0;
    const noise = zc.SUNGLINT_OR_WARM_SOIL_NOISE ?? 0;
    const flagged = clouds + flares + noise;

    return h(
      "div",
      { className: `qc-auto-strip ${flagged > active ? "warn" : ""}` },
      h(
        "div",
        { className: "qc-auto-strip-header" },
        h("span", null, "✓ Fire Verification"),
        h(
          "span",
          { className: `provenance-pill ${flagged > 0 ? "pill-harmonized" : "pill-observed"}` },
          `${out.mean_wildfire_probability_pct ?? 0}% Fire Confidence`
        )
      ),
      h(
        "div",
        { style: { fontSize: "10.5px", color: "#cbd5e1", marginTop: "2px" } },
        `${out.zone_screened_count ?? 0} px screened • Cloud/Glint Risk ${out.mean_cloud_glint_risk_pct ?? 0}%`
      ),
      h(
        "div",
        { className: "qc-auto-metrics" },
        h(
          "div",
          { className: "qc-mini-stat" },
          h("span", { className: "qc-mini-val", style: { color: "#10b981" } }, String(active)),
          h("span", { className: "qc-mini-lbl" }, "Active Fire")
        ),
        h(
          "div",
          { className: "qc-mini-stat" },
          h("span", { className: "qc-mini-val", style: { color: "#38bdf8" } }, String(clouds)),
          h("span", { className: "qc-mini-lbl" }, "Cloud Veto")
        ),
        h(
          "div",
          { className: "qc-mini-stat" },
          h("span", { className: "qc-mini-val", style: { color: "#f59e0b" } }, String(flares)),
          h("span", { className: "qc-mini-lbl" }, "Static Flare")
        ),
        h(
          "div",
          { className: "qc-mini-stat" },
          h("span", { className: "qc-mini-val", style: { color: "#f43f5e" } }, String(noise)),
          h("span", { className: "qc-mini-lbl" }, "Glint Noise")
        )
      )
    );
  }

  function ValidationBreakdown({ out }) {
    const zc = out?.zone_classification_counts || {};
    const dual = out?.dual_ai_summary || {};
    return h(
      "div",
      { className: "sci-callout", style: { marginBottom: "8px" } },
      h(
        "strong",
        null,
        `Dual-AI Audit (${out.zone_screened_count ?? 0} px • IA-1/IA-2 Agreement ${dual.consensus_agreement_pct ?? 100}% • H_cal Audit ${dual.ia2_harmonization_score_pct ?? 0}%):`
      ),
      h("br"),
      h("span", { style: { color: "#10b981" } }, `Active Fire: ${zc.ACTIVE_BIOMASS_FIRE ?? 0}`),
      " | ",
      h("span", { style: { color: "#38bdf8" } }, `Cloud-Edge FP Blocked: ${zc.CLOUD_EDGE_OR_CONTAMINATED ?? 0}`),
      " | ",
      h("span", { style: { color: "#f59e0b" } }, `Industrial Flare: ${zc.PERSISTENT_INDUSTRIAL_FLARE ?? 0}`),
      " | ",
      h("span", { style: { color: "#f43f5e" } }, `Sunglint Noise: ${zc.SUNGLINT_OR_WARM_SOIL_NOISE ?? 0}`),
      " | ",
      h("span", { style: { color: "#94a3b8" } }, `Ambiguous: ${zc.AMBIGUOUS_THERMAL_ANOMALY ?? 0}`)
    );
  }

  function ValidationPredictionsTable({ preds }) {
    const colorOf = (cls) => {
      if (cls === "ACTIVE_BIOMASS_FIRE") return "#10b981";
      if (cls === "CLOUD_EDGE_OR_CONTAMINATED") return "#38bdf8";
      if (cls === "PERSISTENT_INDUSTRIAL_FLARE") return "#f59e0b";
      return "#f43f5e";
    };

    return h(
      React.Fragment,
      null,
      h(
        "thead",
        null,
        h(
          "tr",
          null,
          h("th", null, "Hotspot"),
          h("th", null, "Consensus Verdict"),
          h("th", null, "IA-1 Transformer"),
          h("th", null, "IA-2 VerifierNet"),
          h("th", null, "Cloud Risk"),
          h("th", null, "ΔT (MIR−TIR)"),
          h("th", null, "Physical Evidence")
        )
      ),
      h(
        "tbody",
        null,
        (preds || []).map((p, idx) =>
          h(
            "tr",
            { key: p.hotspot_id ?? idx },
            h("td", null, `#${p.hotspot_id ?? "—"}`),
            h(
              "td",
              { style: { color: colorOf(p.classification), fontWeight: 700 } },
              `${p.classification} (${p.wildfire_probability_pct}%)`
            ),
            h("td", { className: "mono-val" }, `${p.ia1_classification ?? "—"} (${p.ia1_fire_prob_pct ?? 0}%)`),
            h("td", { className: "mono-val" }, `${p.ia2_classification ?? "—"} (${p.ia2_fire_prob_pct ?? 0}%)`),
            h("td", { className: "mono-val", style: { color: p.cloud_veto_applied ? "#38bdf8" : "#94a3b8" } }, `${p.cloud_glint_risk_pct ?? 0}%${p.cloud_veto_applied ? " VETO" : ""}`),
            h("td", { className: "mono-val" }, `${p.delta_t_kelvin} K`),
            h("td", { style: { fontSize: "10.5px" } }, (p.evidence || []).slice(0, 2).join("; "))
          )
        )
      )
    );
  }

  global.ChokiReactUI = {
    mountClock: function () {
      const pill = document.getElementById("hud-clock-pill");
      const root = getOrCreateRoot(pill);
      if (root) root.render(h(LiveClockBadge));
    },
    renderDualAiQcCard: function (slotEl, out, opts = {}) {
      const root = getOrCreateRoot(slotEl);
      if (root) {
        root.render(
          h(DualAiQcCard, {
            out,
            loading: Boolean(opts.loading),
            errorMsg: opts.errorMsg || null,
          })
        );
      }
    },
    renderValidationProof: function (breakdownEl, predTableEl, out) {
      const bRoot = getOrCreateRoot(breakdownEl);
      if (bRoot) bRoot.render(h(ValidationBreakdown, { out }));
      const tRoot = getOrCreateRoot(predTableEl);
      if (tRoot) tRoot.render(h(ValidationPredictionsTable, { preds: out?.sample_predictions || [] }));
    },
  };
})(window);
