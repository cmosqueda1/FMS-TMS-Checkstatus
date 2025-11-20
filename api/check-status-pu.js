// api/check-status-pu.js
// Backend handler for comparing FMS vs TMS status by PU number

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

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const { pu_nos } = req.body || {};

  if (!Array.isArray(pu_nos) || pu_nos.length === 0) {
    res.status(400).json({ error: "pu_nos must be a non-empty array" });
    return;
  }

  const MAX = 150;
  const uniqueList = [...new Set(pu_nos.map(cleanPu).filter(Boolean))];
  const trimmedList = uniqueList.slice(0, MAX);

  try {
    const results = await checkAll(trimmedList);
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

const TMS_BASE = process.env.TMS_BASE_URL || "https://tms.freightapp.com";
const TMS_LOGIN_URL = `${TMS_BASE}/write/check_login.php`;
const TMS_GROUP_URL = `${TMS_BASE}/write_new/write_change_user_group.php`;
const TMS_TRACE_URL = `${TMS_BASE}/write_new/get_tms_trace.php`;

const TMS_USER      = process.env.TMS_USER || "cmosqueda";
const TMS_PASS      = process.env.TMS_PASS || "UWF2NjUyODk=";
const TMS_GROUP_ID  = process.env.TMS_GROUP_ID || "28";

let FMS_TOKEN = null;

/* ========================
   MAIN FLOW
======================== */
async function checkAll(puList) {
  const token = await authFms();
  const searchJson = await fmsSearchOrdersByPu(token, puList);
  const fmsMap = buildFmsMap(searchJson);

  let tmsAuth = null;
  let tmsMap = null;
  try {
    tmsAuth = await authTms();
    tmsMap = await tmsTraceForPu(tmsAuth, puList);
  } catch (e) {
    console.error("TMS PU flow failed:", e?.message || e);
  }

  const results = await runWithConcurrency(puList, 5, async (pu) => {
    // ---- FMS ----
    let fmsRes;
    const DO = fmsMap[pu];

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
      fmsRes = await fetchFmsDetails(token, DO);
      fmsRes.DO = DO;
      fmsRes.hasDO = true;
    }

    // ---- TMS ----
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
          tmsRes.orderId   = row.tms_order_id   ?? null;
          tmsRes.loc       = row.wa2_code       ?? null;
          tmsRes.status    = row.tms_order_stage ?? null;
          tmsRes.substatus = row.tms_order_status ?? null;
        }
      } catch (e) {
        if (e && e.name === "TypeError") tmsRes.networkError = true;
        else tmsRes.generalError = true;
      }
    }

    return { pu, fms: fmsRes, tms: tmsRes };
  });

  return results;
}

/* ========================
   FMS HELPERS (PU VERSION)
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

async function fmsSearchOrdersByPu(token, puNos) {
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
    page_size: Math.min(puNos.length, 150),
    pickup_appointment: [], pickup_complete_date: [], po_nos: [],
    pu_nos: puNos,            // <-- MAIN FLAG
    tracking_nos: [],         // <-- DISABLE PRO SEARCH
    record_status: "0", request_pickup_date: [],
    service_levels: [], service_terminals: [], shipment_types: [],
    shipper_terminals: [], status: [], sub_status: [], trips: []
  };

  const r = await fetch(FMS_SEARCH_URL, {
    method: "POST",
    headers,
    body: JSON.stringify(body)
  });

  if (!r.ok) throw new Error(`FMS PU search HTTP ${r.status}`);
  return r.json();
}

function buildFmsMap(searchJson) {
  const map = {};
  let items = [];

  if (Array.isArray(searchJson?.items)) items = searchJson.items;
  else if (Array.isArray(searchJson?.data?.items)) items = searchJson.data.items;

  for (const it of items) {
    const pu = cleanPu(it.pu_no ?? it.puNo ?? "");
    const order = String(it.order_no ?? it.orderNo ?? "").trim();

    if (/^\d{6,14}$/.test(pu) && /^DO\d{6,}$/.test(order)) {
      map[pu] = order;
    }
  }
  return map;
}

/* ========================
   TMS (PU SEARCH VERSION)
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
    body
  });

  const j = await r.json();
  const uid = j.UserID;
  const token = j.UserToken;

  await tmsChangeGroup(uid, token);

  return { userId: uid, token };
}

async function tmsChangeGroup(userId, userToken) {
  const body = new URLSearchParams();
  body.set("group_id", String(TMS_GROUP_ID));
  body.set("UserID", String(userId));
  body.set("UserToken", String(userToken));
  body.set("pageName", "dashboard");

  await fetch(TMS_GROUP_URL, {
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
}

async function tmsTraceForPu(auth, puNos) {
  const { userId, token } = auth;
  const body = new URLSearchParams();

  body.set("input_filter_pro", "");
  body.set("input_filter_pu", puNos.map(cleanPu).join("\n"));
  body.set("input_page_size", "10000");
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

  const j = await r.json().catch(() => ({}));

  let rows = j?.data || j?.rows || j?.result || j;

  const map = new Map();
  for (const rw of rows) {
    const key = cleanPu(rw.tms_order_pu);
    if (key) map.set(key, rw);
  }

  return map;
}
