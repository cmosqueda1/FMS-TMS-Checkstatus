// api/check-status-pu.js
// Vercel Node serverless function for comparing FMS vs TMS status
// when searching by PU numbers.

// Helper: normalize strings
const clean = (v) => String(v ?? "").trim();
const cleanPu = (v) => clean(v);
const cleanPro = (v) => clean(v);

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
 * Vercel handler
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

  // Unique, trimmed PUs, cap at 150
  const MAX_PUS = 150;
  const uniquePus = [...new Set(pu_nos.map((p) => cleanPu(p)).filter(Boolean))];
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
   CONFIG
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

  // 1) FMS: auth + search by PU + build PU -> { DO, pro } map
  const fmsToken   = await authFms();
  const searchJson = await fmsSearchOrdersByPu(fmsToken, pus);
  const { mapByPu, uniquePros } = buildFmsMapByPu(searchJson);

  // 2) TMS: auth + change group + trace for all PROs in one request
  let tmsAuth = null;
  let tmsMap  = null;
  if (uniquePros.length > 0) {
    try {
      tmsAuth = await authTms();
      tmsMap  = await tmsTraceForPros(tmsAuth, uniquePros);
    } catch (e) {
      console.error("TMS PU flow failed:", e?.message || e);
    }
  }

  // 3) Build combined result list with limited concurrency
  const CONCURRENCY = 5;

  const results = await runWithConcurrency(pus, CONCURRENCY, async (pu) => {
    const puClean = cleanPu(pu);
    const entry   = mapByPu[puClean] || null; // { DO, pro } or null

    const proFromFms = entry?.pro || null;
    const DO         = entry?.DO  || null;

    // ---- FMS result ----
    let fmsRes;
    if (!entry || !DO) {
      // No FMS record for this PU
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

    if (tmsAuth && tmsMap && proFromFms) {
      tmsRes.attempted = true;
      try {
        const row = tmsMap.get(cleanPro(proFromFms));
        if (!row) {
          // TMS didn't return anything for that PRO
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
    } else {
      // We couldn't even look it up in TMS (no PRO from FMS or TMS auth failed).
      // For front-end messaging we treat this as "no TMS record found for this PU".
      tmsRes.attempted = true;
      tmsRes.notFound  = true;
    }

    // Top-level result carries both PU and PRO (if known)
    return { pu: puClean, pro: proFromFms, fms: fmsRes, tms: tmsRes };
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

// Search FMS by PU numbers (pu_nos array)
async function fmsSearchOrdersByPu(token, pu_nos) {
  const headers = {
    "fms-client": FMS_CLIENT,
    "fms-token": token,
    "Content-Type": "application/json",
    "Company-Id": FMS_COMPANY_ID
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
    pickup_appointment: [],
    current_locations: [],
    service_terminals: [],
    lhs: [],
    lh_etd_date: [],
    lh_eta_date: [],
    consignee_terminals: [],
    consignee_state: [],
    consignee_zip_codes: [],
    desired_delivery_date: [],
    delivery_appointment: [],
    delivery_date: [],
    pickup_complete_date: [],
    pu_nos: pu_nos.map(cleanPu),
    po_nos: [],
    exception: false,
    delayed: false,
    hold: false,
    business_client: "",
    record_status: "0",
    page_number: 1,
    page_size: Math.min(pu_nos.length || 1, 150)
  };

  const r = await fetch(FMS_SEARCH_URL, {
    method: "POST",
    headers,
    body: JSON.stringify(body)
  });

  if (!r.ok) throw new Error(`FMS PU search HTTP ${r.status}`);
  return r.json();
}

/**
 * Build PU -> { DO, pro } map and gather unique PRO list
 * from FMS search response.
 */
function buildFmsMapByPu(searchJson) {
  const mapByPu = {};
  const proSet = new Set();

  let items = [];
  if (Array.isArray(searchJson?.items)) items = searchJson.items;
  else if (Array.isArray(searchJson?.data?.items)) items = searchJson.data.items;

  for (const it of items) {
    const pu   = cleanPu(it.reference5 ?? it.pu_no ?? it.puNo ?? "");
    const pro  = cleanPro(it.tracking_no ?? it.trackingNo ?? "");
    const order = String(it.order_no ?? it.orderNo ?? "").trim();

    if (!pu) continue;
    if (!order) continue;

    // Collect mapping and PRO list for TMS lookup
    mapByPu[pu] = {
      DO: order,
      pro: pro || null
    };

    if (pro) {
      proSet.add(pro);
    }
  }

  return {
    mapByPu,
    uniquePros: Array.from(proSet)
  };
}

async function fetchFmsDetails(token, DO) {
  const headers = {
    accept: "application/json, text/plain, */*",
    "fms-client": FMS_CLIENT,
    "fms-token": token,
    "company-id": FMS_COMPANY_ID
  };

  let loc = null,
    statusDesc = null,
    subStatusDesc = null;
  let basicOk = false,
    headOk = false;
  let networkError = false,
    generalError = false;

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
    statusDesc = root?.order_status_describe ?? null;
    subStatusDesc = root?.order_sub_status_describe ?? null;
    headOk = true;
  } catch (e) {
    if (e && e.name === "TypeError") networkError = true;
    else generalError = true;
  }

  if (networkError) {
    return {
      ok: false,
      loc: null,
      status: null,
      substatus: null,
      basicOk,
      headOk,
      networkError: true,
      generalError: false,
      partial: false
    };
  }
  if (!basicOk && !headOk && generalError) {
    return {
      ok: false,
      loc: null,
      status: null,
      substatus: null,
      basicOk,
      headOk,
      networkError: false,
      generalError: true,
      partial: false
    };
  }

  const ok = basicOk || headOk;
  const partial = basicOk ^ headOk ? true : false;

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
   TMS HELPERS (same as PRO)
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
      Origin: "https://tms.freightapp.com",
      Referer: "https://tms.freightapp.com/index.html",
      "User-Agent": "Mozilla/5.0"
    },
    body,
    redirect: "follow"
  });

  if (!r.ok) throw new Error(`TMS auth HTTP ${r.status}`);
  const j = await r.json().catch(() => ({}));

  const uid = j.UserID ?? j.user_id ?? null;
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
      Origin: "https://tms.freightapp.com",
      Referer: "https://tms.freightapp.com/dev.html",
      "User-Agent": "Mozilla/5.0"
    },
    body
  });

  if (!r.ok) {
    console.warn("TMS group change HTTP", r.status);
  }
}

/**
 * Single TMS trace call for ALL PROs at once,
 * using the real browser payload structure.
 */
async function tmsTraceForPros(auth, pros) {
  const { userId, token } = auth;
  const body = new URLSearchParams();

  body.set("input_filter_tracking_num", "");
  body.set("input_billing_reference", "");
  body.set("input_filter_pro", pros.map(cleanPro).join("\n"));
  body.set("input_filter_trip", "");
  body.set("input_filter_order", "");
  body.set("input_filter_pu", "");
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
      Origin: "https://tms.freightapp.com",
      Referer: "https://tms.freightapp.com/dev.html",
      "User-Agent": "Mozilla/5.0"
    },
    body
  });

  if (!r.ok) {
    throw new Error(`TMS trace HTTP ${r.status}`);
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

  // Build a map from cleaned PRO -> row
  const map = new Map();
  for (const rw of rows) {
    const key = cleanPro(rw.tms_order_pro);
    if (key) {
      map.set(key, rw);
    }
  }

  return map;
}
