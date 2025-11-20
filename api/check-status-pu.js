// api/check-status-pu.js
// Vercel Node serverless function for comparing FMS vs TMS status by PU number

// Helper: normalize PU values for strict-but-trimmed matching
const cleanPu = (v) => String(v ?? "").trim();

/**
 * Simple concurrency limiter for async work.
 * Runs at most `limit` workers in parallel while preserving result order.
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
 * Vercel handler (PU-based)
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

  // Unique, trimmed PUs, cap at 150 (same as PRO cap)
  const MAX_PUS = 150;
  const uniquePus = [...new Set(pu_nos.map(p => cleanPu(p)).filter(Boolean))];
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

const TMS_BASE      = process.env.TMS_BASE_URL || "https://tms.freightapp.com";
const TMS_LOGIN_URL = `${TMS_BASE}/write/check_login.php`;
const TMS_GROUP_URL = `${TMS_BASE}/write_new/write_change_user_group.php`;
const TMS_TRACE_URL = `${TMS_BASE}/write_new/get_tms_trace.php`;

// Defaults to your known credentials if env not set
const TMS_USER      = process.env.TMS_USER || "cmosqueda";
const TMS_PASS      = process.env.TMS_PASS || "UWF2NjUyODk="; // base64 string as used by UI
const TMS_GROUP_ID  = process.env.TMS_GROUP_ID || "28";

let FMS_TOKEN = null;

/* ========================
   MAIN ORCHESTRATION (PU)
======================== */
async function checkAll(pus) {
  if (!FMS_USER || !FMS_PASS) {
    throw new Error("Missing FMS_USER / FMS_PASS in environment");
  }

  // 1) FMS: auth + search by PU + DO mapping (single batched search)
  const fmsToken   = await authFms();
  const searchJson = await fmsSearchOrdersByPu(fmsToken, pus);
  const fmsMap     = buildFmsMapByPu(searchJson);

  // 2) TMS: auth + change group + trace for all PUs in one request
  let tmsAuth = null;
  let tmsMap  = null;
  try {
    tmsAuth = await authTms();
    tmsMap  = await tmsTraceForPus(tmsAuth, pus);
  } catch (e) {
    console.error("TMS PU flow failed:", e?.message || e);
  }

  // 3) Build combined result list with limited concurrency
  const CONCURRENCY = 5; // same as PRO

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

    // ---- TMS result ----
    let tmsRes = {
      attempted: false,
      ok: false,
      notFound: false,
      orderId: null,
      loc: null,
      status: null,
      substatus: null,
      networkError: false,
      generalError: false
    };

    if (tmsAuth && tmsMap) {
      tmsRes.attempted = true;
      try {
        const row = tmsMap.get(cleanPu(pu));
        if (!row) {
          tmsRes.notFound = true;
        } else {
          tmsRes.ok        = true;
          tmsRes.orderId   = row.tms_order_id    ?? null;
          tmsRes.loc       = row.wa2_code        ?? null;
          tmsRes.status    = row.tms_order_stage ?? null;
          tmsRes.substatus = row.tms_order_status ?? null;
        }
      } catch (e) {
        if (e && e.name === "TypeError") {
          tmsRes.networkError = true;
        } else {
          tmsRes.generalError = true;
        }
      }
    }

    // NOTE: For PU mode we return `pu` instead of `pro`
    return { pu, fms: fmsRes, tms: tmsRes };
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

// New: search orders by PU instead of tracking_nos
async function fmsSearchOrdersByPu(token, pu_nos) {
  const headers = {
    "fms-client": FMS_CLIENT,
    "fms-token": token,
    "Content-Type": "application/json",
    "Company-Id": FMS_COMPANY_ID
  };

  const body = {
    bill_to_accounts: [], bols: [], business_client: "",
    consignee_state: [], consignee_terminals: [], consignee_zip_codes: [],
    current_locations: [], customer_references: [], delayed: false,
    delivery_appointment: [], delivery_date: [], desired_delivery_date: [],
    exception: false, hold: false, lh_eta_date: [], lh_etd_date: [],
    lhs: [], master_order_ids: [], order_nos: [], origin_states: [],
    origin_zip_codes: [], page_number: 1,
    page_size: Math.min(pu_nos.length, 150),
    pickup_appointment: [], pickup_complete_date: [], po_nos: [],
    pu_nos,                         // 🔹 filter by PU(s)
    record_status: "0", request_pickup_date: [], service_levels: [],
    service_terminals: [], shipment_types: [], shipper_terminals: [],
    status: [], sub_status: [],
    tracking_nos: [],               // 🔹 empty so search is PU-based only
    trips: []
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
    // Try to find the PU in the result item
    const pu = cleanPu(
      it.pu_no ??
      it.puNo ??
      (Array.isArray(it.pu_nos) ? it.pu_nos[0] : "") ??
      (Array.isArray(it.puNos) ? it.puNos[0] : "") ??
      ""
    );

    const order = String(it.order_no ?? it.orderNo ?? "").trim();

    // Keep the same DO pattern check as PRO route
    if (pu && /^DO\d{6,}$/.test(order)) {
      map[pu] = order;
    }
  }
  return map;
}

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

/* ========================
   TMS HELPERS (PU)
======================== */
async function authTms() {
  const body = new URLSearchParams();
  body.set("username", TMS_USER);
  body.set("password", TMS_PASS);
  body.set("UserID", "null");
  body.set("UserToken", "null");
  body.set("pageName", "/index.html");

  const r = await fetch(TMS_LOGIN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
      "X-Requested-With": "XMLHttpRequest",
      "Origin": "https://tms.freightapp.com",
      "Referer": "https://tms.freightapp.com/index.html",
      "User-Agent": "Mozilla/5.0"
    },
    body,
    redirect: "follow"
  });

  if (!r.ok) throw new Error(`TMS auth HTTP ${r.status}`);
  const j = await r.json().catch(() => ({}));

  const uid   = j.UserID    ?? j.user_id   ?? null;
  const token = j.UserToken ?? j.userToken ?? null;

  if (!uid || !token) {
    throw new Error("TMS auth: missing UserID/UserToken");
  }

  // Change group every time for safety
  await tmsChangeGroup(uid, token);

  return { userId: uid, token };
}

async function tmsChangeGroup(userId, userToken) {
  const body = new URLSearchParams();
  body.set("group_id", String(TMS_GROUP_ID));
  body.set("UserID", String(userId));
  body.set("UserToken", String(userToken));
  body.set("pageName", "dashboard");

  const r = await fetch(TMS_GROUP_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
      "X-Requested-With": "XMLHttpRequest",
      "Origin": "https://tms.freightapp.com",
      "Referer": "https://tms.freightapp.com/dev.html",
      "User-Agent": "Mozilla/5.0"
    },
    body
  });

  if (!r.ok) {
    console.warn("TMS group change HTTP", r.status);
  }
}

/**
 * Single TMS trace call for ALL PUs at once,
 * using input_filter_pu instead of input_filter_pro.
 */
async function tmsTraceForPus(auth, pus) {
  const { userId, token } = auth;
  const body = new URLSearchParams();

  // Match HAR-style payload but swap PRO->PU
  body.set("input_filter_tracking_num", "");
  body.set("input_billing_reference", "");
  body.set("input_filter_pro", ""); // clear PRO
  body.set("input_filter_trip", "");
  body.set("input_filter_order", "");
  body.set("input_filter_pu", pus.map(cleanPu).join("\n")); // PU filter
  body.set("input_filter_pickup_from", "");
  body.set("input_filter_pickup_to", "");
  body.set("input_filter_delivery_from", "");
  body.set("input_filter_delivery_to", "");
  body.set("input_filter_shipper", "");
  body.set("input_filter_shipper_code", "");
  body.set("input_filter_shipper_street", "");
  body.set("input_filter_shipper_city", "");
  body.set("input_filter_shipper_state", "0");
  body.set("input_filter_shipper_phone", "");
  body.set("input_filter_shipper_zip", "");
  body.set("input_filter_consignee", "");
  body.set("input_filter_consignee_code", "");
  body.set("input_filter_consignee_street", "");
  body.set("input_filter_consignee_city", "");
  body.set("input_filter_consignee_state", "0");
  body.set("input_filter_consignee_phone", "");
  body.set("input_filter_consignee_zip", "");
  body.set("input_filter_billto", "");
  body.set("input_filter_billto_code", "");
  body.set("input_filter_billto_street", "");
  body.set("input_filter_billto_city", "");
  body.set("input_filter_billto_state", "0");
  body.set("input_filter_billto_phone", "");
  body.set("input_filter_billto_zip", "");
  body.set("input_filter_manifest", "");
  body.set("input_filter_interline", "");
  body.set("input_filter_pieces", "");
  body.set("input_filter_trailer", "");
  body.set("input_filter_weight", "");
  body.set("input_filter_pallet", "");
  body.set("input_filter_ref", "");
  body.set("input_filter_load", "");
  body.set("input_filter_po", "");
  body.set("input_filter_pickup_apt", "");
  body.set("input_filter_pickup_actual_from", "");
  body.set("input_filter_pickup_actual_to", "");
  body.set("input_filter_delivery_apt", "");
  body.set("input_filter_delivery_actual_from", "");
  body.set("input_filter_delivery_actual_to", "");
  body.set("input_filter_cust_po", "");
  body.set("input_filter_cust_ref", "");
  body.set("input_filter_cust_pro", "");
  body.set("input_filter_cust_bol", "");
  body.set("input_filter_cust_dn", "");
  body.set("input_filter_cust_so", "");
  body.set("input_filter_tender_pro", "");
  body.set("input_carrier_name", "");
  body.set("input_carrier_pro", "");
  body.set("input_carrier_inv", "");
  body.set("input_hold", "0");
  body.set("input_filter_group", "0");
  body.set("input_wa1", "0");
  body.set("input_wa2", "0");
  body.set("input_has_pro", "0");
  body.set("input_filter_scac", "");
  body.set("input_exclude_delivered", "0");
  body.set("input_filter_created_by", "");
  body.set("input_include_cancel", "0");
  body.set("input_carrier_type", "1");
  body.set("input_approved", "-1");
  body.set("input_fk_revenue_id", "0");
  body.set("input_stage_id", "");
  body.set("input_status_id", "");
  body.set("input_filter_create_date_from", "");
  body.set("input_filter_create_date_to", "");
  body.set("input_filter_tracking_no", "");
  body.set("input_filter_contriner", "");
  body.set("input_filter_cust_rn", "");
  body.set("input_page_num", "1");
  body.set("input_page_size", "10000");
  body.set("input_total_rows", "0");
  body.set("UserID", String(userId));
  body.set("UserToken", String(token));
  body.set("pageName", "dashboardTmsTrace");

  const r = await fetch(TMS_TRACE_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
      "X-Requested-With": "XMLHttpRequest",
      "Origin": "https://tms.freightapp.com",
      "Referer": "https://tms.freightapp.com/dev.html",
      "User-Agent": "Mozilla/5.0"
    },
    body
  });

  if (!r.ok) {
    throw new Error(`TMS PU trace HTTP ${r.status}`);
  }

  const j = await r.json().catch(() => ({}));

  let rows = null;
  if (Array.isArray(j)) rows = j;
  else if (Array.isArray(j?.data)) rows = j.data;
  else if (Array.isArray(j?.rows)) rows = j.rows;
  else if (Array.isArray(j?.result)) rows = j.result;

  if (!rows || !rows.length) {
    return new Map();
  }

  // Build a map from cleaned PU -> row
  const map = new Map();
  for (const rw of rows) {
    const key = cleanPu(
      rw.tms_order_pu ??
      rw.pu_no ??
      rw.pu ??
      rw.pickup_no ??
      ""
    );
    if (key) {
      map.set(key, rw);
    }
  }

  return map;
}
