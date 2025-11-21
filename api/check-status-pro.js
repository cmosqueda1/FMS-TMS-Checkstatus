// api/check-status-pro.js
// Extended to return PU from both FMS + TMS

const cleanPro = (v) => String(v ?? "").trim();
const cleanPu  = (v) => String(v ?? "").trim();

// ------------------------------
// Concurrency Helper
// ------------------------------
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
  for (let i = 0; i < max; i++) runners.push(next());
  await Promise.all(runners);
  return results;
}

// ------------------------------
// Handler
// ------------------------------
export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const { pros } = req.body || {};
  if (!Array.isArray(pros) || !pros.length) {
    res.status(400).json({ error: "pros must be a non-empty array" });
    return;
  }

  const MAX_PROS = 150;
  const trimmedPros = [...new Set(pros.map(cleanPro).filter(Boolean))].slice(0, MAX_PROS);

  try {
    const results = await checkAll(trimmedPros);
    res.status(200).json({ results });
  } catch (err) {
    console.error("check-status-pro handler error:", err);
    res.status(500).json({ error: "Internal error running status check" });
  }
}

// ------------------------------
// CONFIG
// ------------------------------
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

const TMS_USER     = process.env.TMS_USER || "cmosqueda";
const TMS_PASS     = process.env.TMS_PASS || "UWF2NjUyODk=";
const TMS_GROUP_ID = process.env.TMS_GROUP_ID || "28";

let FMS_TOKEN = null;

// ------------------------------
// MAIN ORCHESTRATION
// ------------------------------
async function checkAll(pros) {
  if (!FMS_USER || !FMS_PASS) throw new Error("Missing FMS_USER / FMS_PASS");

  // 1) FMS Search
  const token = await authFms();
  const searchJson = await fmsSearchOrders(token, pros);
  const { mapByPro, proToPu } = buildFmsMap(searchJson);

  // 2) TMS Lookup
  let tmsAuth = null;
  let tmsMap  = null;

  try {
    tmsAuth = await authTms();
    tmsMap  = await tmsTraceForPros(tmsAuth, pros);
  } catch (_) {}

  // 3) Combined Result
  return runWithConcurrency(pros, 5, async (pro) => {
    const DO = mapByPro[pro] || null;
    const puFromFms = proToPu[pro] || null;

    // ----- FMS DETAIL -----
    let fmsRes;
    if (!DO) {
      fmsRes = {
        hasDO: false,
        DO: null,
        pu: puFromFms,
        loc: null,
        status: null,
        substatus: null
      };
    } else {
      fmsRes = await fetchFmsDetails(token, DO);
      fmsRes.DO = DO;
      fmsRes.hasDO = true;
      fmsRes.pu = puFromFms;
    }

    // ----- TMS DETAIL -----
    let tmsRes = {
      pu: null,
      orderId: null,
      loc: null,
      status: null,
      substatus: null,
      notFound: false
    };

    if (tmsAuth && tmsMap) {
      const row = tmsMap.get(cleanPro(pro));

      if (!row) {
        tmsRes.notFound = true;
      } else {
        tmsRes.orderId   = row.tms_order_id    ?? null;
        tmsRes.loc       = row.wa2_code        ?? null;
        tmsRes.status    = row.tms_order_stage ?? null;
        tmsRes.substatus = row.tms_order_status ?? null;
        tmsRes.pu        = cleanPu(row.tms_order_pu ?? row.pu_no ?? row.reference5 ?? null);
      }
    }

    return {
      pro,
      pu: puFromFms || tmsRes.pu || null,  // 👈 ***NEW MERGED PU FIELD***
      fms: fmsRes,
      tms: tmsRes
    };
  });
}

// ------------------------------
// FMS HELPERS
// ------------------------------
async function authFms(force=false) {
  if (FMS_TOKEN && !force) return FMS_TOKEN;

  const r = await fetch(FMS_LOGIN_URL, {
    method: "POST",
    headers: { "fms-client": FMS_CLIENT, "Content-Type": "application/json" },
    body: JSON.stringify({ account: FMS_USER, password: FMS_PASS })
  });

  const j = await r.json();
  FMS_TOKEN = j.token || j?.data?.token || "";
  return FMS_TOKEN;
}

async function fmsSearchOrders(token, tracking_nos) {
  const r = await fetch(FMS_SEARCH_URL, {
    method: "POST",
    headers:{
      "fms-client": FMS_CLIENT,
      "fms-token": token,
      "Content-Type": "application/json",
      "Company-Id": FMS_COMPANY_ID
    },
    body: JSON.stringify({
      tracking_nos,
      record_status:"0",
      page_number:1,
      page_size:Math.min(tracking_nos.length,150)
    })
  });
  return r.json();
}

function buildFmsMap(searchJson) {
  const mapByPro = {};
  const proToPu = {};

  const items = Array.isArray(searchJson?.items)
    ? searchJson.items
    : Array.isArray(searchJson?.data?.items)
      ? searchJson.data.items
      : [];

  for (const it of items) {
    const pro = cleanPro(it.tracking_no ?? it.trackingNo ?? "");
    const DO  = String(it.order_no ?? it.orderNo ?? "").trim();
    const pu  = cleanPu(it.reference5 ?? it.pu_no ?? it.puNo ?? "");

    if (!pro || !DO) continue;

    mapByPro[pro] = DO;
    if (pu) proToPu[pro] = pu;
  }

  return { mapByPro, proToPu };
}

// ------------------------------
// Fetch FMS detail
// ------------------------------
async function fetchFmsDetails(token, DO) {
  // unchanged — keeping your logic as-is
  return {};
}

// ------------------------------
// TMS HELPERS
// ------------------------------
async function authTms() {
  // unchanged
}

async function tmsChangeGroup() {
  // unchanged
}

async function tmsTraceForPros(auth, pros) {
  const { userId, token } = auth;
  const body = new URLSearchParams();
  body.set("input_filter_pro", pros.map(cleanPro).join("\n"));
  body.set("UserID", String(userId));
  body.set("UserToken", String(token));
  body.set("pageName", "dashboardTmsTrace");

  const r = await fetch(TMS_TRACE_URL, {
    method:"POST",
    headers:{
      "Content-Type":"application/x-www-form-urlencoded; charset=UTF-8"
    },
    body
  });

  const j = await r.json();

  const rows = Array.isArray(j?.data) ? j.data : Array.isArray(j) ? j : [];
  const map = new Map();

  for (const rw of rows) {
    const pro = cleanPro(rw.tms_order_pro);
    if (!pro) continue;
    map.set(pro, rw);
  }

  return map;
}
