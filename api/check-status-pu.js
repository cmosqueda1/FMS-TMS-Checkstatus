// api/check-status-pu.js
// FMS-only PU status check (no TMS yet)

// Helper: normalize PU
const cleanPu = (v) => String(v ?? "").trim();

/**
 * Simple concurrency limiter for async work.
 */
async function runWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let index = 0;

  async function next() {
    const current = index++;
    if (current >= items.length) return;
    results[current] = await worker(items[current], current);
    await next();
  }

  const runners = [];
  const max = Math.min(limit, items.length);
  for (let i = 0; i < max; i++) {
    runners.push(next());
  }
  await Promise.all(runners);
  return results;
}

/**
 * Vercel handler (PU-based, FMS-only)
 */
export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const body = req.body || {};
  const { pu_nos } = body;

  if (!Array.isArray(pu_nos) || pu_nos.length === 0) {
    res.status(400).json({ error: "pu_nos must be a non-empty array" });
    return;
  }

  const MAX_PUS = 150;
  const uniquePus = [...new Set(pu_nos.map(cleanPu).filter(Boolean))];
  const trimmedPus = uniquePus.slice(0, MAX_PUS);

  try {
    const results = await checkAll(trimmedPus);
    res.status(200).json({ results });
  } catch (err) {
    console.error("check-status-pu handler error:", err);
    res.status(500).json({ error: "Internal error running PU status check" });
  }
}

/* ========================
   CONFIG (same as PRO)
======================== */
const FMS_BASE       = process.env.FMS_BASE_URL   || "https://fms.item.com";
const FMS_COMPANY_ID = process.env.FMS_COMPANY_ID || "SBFH";
const FMS_CLIENT     = process.env.FMS_CLIENT     || "FMS_WEB";
const FMS_USER       = process.env.FMS_USER;
const FMS_PASS       = process.env.FMS_PASS;

const FMS_LOGIN_URL   = `${FMS_BASE}/fms-platform-user/Auth/Login`;
const FMS_SEARCH_URL  = `${FMS_BASE}/fms-platform-order/shipment-orders/query`;
const FMS_ORDER_BASIC = `${FMS_BASE}/fms-platform-order/shipper/getshipment-orderbasic/`;
const FMS_ORDER_HEAD  = `${FMS_BASE}/fms-platform-order/shipper/getshipment-orderbasic-headinfo/`;

let FMS_TOKEN = null;

/* ========================
   MAIN FLOW (FMS only)
======================== */
async function checkAll(pus) {
  if (!FMS_USER || !FMS_PASS) {
    throw new Error("Missing FMS_USER / FMS_PASS in environment");
  }

  // 1) FMS: auth + search by PU + PU→DO mapping
  const fmsToken   = await authFms();
  const searchJson = await fmsSearchOrdersByPu(fmsToken, pus);
  const fmsMap     = buildFmsMapByPu(searchJson);

  // 2) Build results with limited concurrency (same as PRO)
  const CONCURRENCY = 5;

  const results = await runWithConcurrency(pus, CONCURRENCY, async (pu) => {
    const DO = fmsMap[pu];

    // ---- FMS result ----
    let fmsRes;
    if (!DO) {
      fmsRes = {
        hasDO: false,
        DO: null,
        ok: false,
        loc: null,
        status: null,
        substatus: null,
        partial: false,
        networkError: false,
        generalError: false
      };
    } else {
      fmsRes = await fetchFmsDetails(fmsToken, DO);
      fmsRes.DO    = DO;
      fmsRes.hasDO = true;
    }

    // For now, no TMS. Frontend does `const t = r.tms || {}`, so it's safe.
    return { pu, fms: fmsRes };
  });

  return results;
}

/* ========================
   FMS HELPERS
======================== */
async function authFms(force = false) {
  if (FMS_TOKEN && !force) return FMS_TOKEN;

  const r = await fetch(FMS_LOGIN_URL, {
    method: "POST",
    headers: {
      "fms-client": FMS_CLIENT,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ account: FMS_USER, password: FMS_PASS })
  });

  if (!r.ok) throw new Error(`FMS auth HTTP ${r.status}`);
  const j = await r.json().catch(() => ({}));
  FMS_TOKEN = j.token || j?.data?.token || j?.result?.token || "";
  if (!FMS_TOKEN) throw new Error("FMS auth: no token returned");
  return FMS_TOKEN;
}

// Same shape as PRO, but now using pu_nos instead of tracking_nos
async function fmsSearchOrdersByPu(token, pu_nos) {
  const headers = {
    "fms-client": FMS_CLIENT,
    "fms-token": token,
    "Company-Id": FMS_COMPANY_ID,
    "Content-Type": "application/json"
  };

  const body = {
    order_nos: [],
    tracking_nos: [],
    customer_references: [],
    bols: [],
    bill_to_accounts: [],
    master_order_ids: [],
    status: [],
    sub_status: [],
    shipment_types: [],
    service_levels: [],
    trips: [],
    shipper_terminals: [],
    origin_states: [],
    origin_zip_codes: [],
    request_pickup_date: [],
    delivery_appointment: [],
    delivery_date: [],
    pickup_complete_date: [],
    pu_nos,   // 🔹 KEY FIELD
    po_nos: [],
    exception: false,
    delayed: false,
    hold: false,
    business_client: "",
    record_status: "0",
    page_number: 1,
    page_size: Math.min(pu_nos.length, 150)
  };

  const r = await fetch(FMS_SEARCH_URL, {
    method: "POST",
    headers,
    body: JSON.stringify(body)
  });

  if (!r.ok) throw new Error(`FMS PU search HTTP ${r.status}`);
  return r.json();
}

// Build FMS map keyed by PU -> DO
function buildFmsMapByPu(searchJson) {
  const map = {};
  let items = [];
  if (Array.isArray(searchJson?.items)) items = searchJson.items;
  else if (Array.isArray(searchJson?.data?.items)) items = searchJson.data.items;

  for (const it of items) {
    // Try to extract the PU from a few likely fields
    const pu = cleanPu(
      it.pu_no ??
      it.puNo ??
      (Array.isArray(it.pu_nos) ? it.pu_nos[0] : "") ??
      (Array.isArray(it.puNos) ? it.puNos[0] : "") ??
      ""
    );

    const order = String(it.order_no ?? it.orderNo ?? "").trim();

    // Same DO pattern as PRO logic
    if (pu && /^DO\d{6,}$/.test(order)) {
      map[pu] = order;
    }
  }
  return map;
}

// Same DO-detail logic as PRO
async function fetchFmsDetails(token, DO) {
  const headers = {
    "accept": "application/json, text/plain, */*",
    "fms-client": FMS_CLIENT,
    "fms-token": token,
    "company-id": FMS_COMPANY_ID
  };

  let loc = null, statusDesc = null, subStatusDesc = null;
  let basicOk = false, headOk = false;
  let networkError = false, generalError = false;

  // /getshipment-orderbasic
  try {
    const r = await fetch(FMS_ORDER_BASIC + encodeURIComponent(DO), {
      method: "GET",
      headers
    });
    if (!r.ok) throw new Error("bad status");
    const j = await r.json();
    const root = j?.data || j;
    loc = root?.current_location ?? root?.currentLocation ?? null;
    basicOk = true;
  } catch (e) {
    if (e && e.name === "TypeError") networkError = true;
    else generalError = true;
  }

  // /getshipment-orderbasic-headinfo
  try {
    const r = await fetch(FMS_ORDER_HEAD + encodeURIComponent(DO), {
      method: "GET",
      headers
    });
    if (!r.ok) throw new Error("bad status");
    const j = await r.json();
    const root = j?.data || j;
    statusDesc    = root?.order_status_describe ?? null;
    subStatusDesc = root?.order_sub_status_describe ?? null;
    headOk = true;
  } catch (e) {
    if (e && e.name === "TypeError") networkError = true;
    else generalError = true;
  }

  if (networkError) {
    return {
      ok: false, loc: null, status: null, substatus: null,
      basicOk, headOk, networkError: true, generalError: false, partial: false
    };
  }
  if (!basicOk && !headOk && generalError) {
    return {
      ok: false, loc: null, status: null, substatus: null,
      basicOk, headOk, networkError: false, generalError: true, partial: false
    };
  }

  const ok = basicOk || headOk;
  const partial = (basicOk ^ headOk) ? true : false;

  return {
    ok,
    loc,
    status: statusDesc,
    substatus: subStatusDesc,
    basicOk,
    headOk,
    partial,
    networkError: false,
    generalError: false
  };
}
