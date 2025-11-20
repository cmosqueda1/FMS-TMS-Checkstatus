// api/check-status-pu.js
// Search based on PU instead of PRO

const cleanVal = v => String(v ?? "").trim();

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

  const MAX = 150;
  const unique = [...new Set(pu_nos.map(cleanVal).filter(Boolean))].slice(0, MAX);

  try {
    const results = await checkAllPU(unique);
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

const TMS_USER     = process.env.TMS_USER      || "cmosqueda";
const TMS_PASS     = process.env.TMS_PASS      || "UWF2NjUyODk=";
const TMS_GROUP_ID = process.env.TMS_GROUP_ID  || "28";

let FMS_TOKEN = null;


/* ========================
   MAIN PU SEARCH
======================== */
async function checkAllPU(puList) {
  const fmsToken = await authFms();
  const searchJson = await fmsSearchByPU(fmsToken, puList);
  const fmsMap = buildFmsMap(searchJson, "pu");

  // TMS
  let tmsAuth = null;
  let tmsMap  = null;
  try {
    tmsAuth = await authTms();
    tmsMap  = await tmsTraceForPUs(tmsAuth, puList);
  } catch (e) {
    console.error("TMS flow failed:", e);
  }

  // Build results
  return puList.map(pu => {
    const f = fmsMap[pu] || { hasDO:false, DO:null, loc:null, status:null, substatus:null };
    const trow = tmsMap?.get(pu);

    let t = {
      attempted: true,
      ok: false,
      notFound: false,
      orderId: null,
      loc: null,
      status: null,
      substatus: null,
      networkError: false,
      generalError: false,
    };

    if (trow) {
      t.ok = true;
      t.orderId   = trow.tms_order_id ?? null;
      t.loc       = trow.wa2_code ?? null;
      t.status    = trow.tms_order_stage ?? null;
      t.substatus = trow.tms_order_status ?? null;
    } else {
      t.notFound = true;
    }

    return { pu, fms: f, tms: t };
  });
}


/* ========================
   FMS HELPERS
======================== */

async function authFms(force = false) {
  if (FMS_TOKEN && !force) return FMS_TOKEN;

  const r = await fetch(FMS_LOGIN_URL, {
    method: "POST",
    headers: { "fms-client": FMS_CLIENT, "Content-Type": "application/json" },
    body: JSON.stringify({ account: FMS_USER, password: FMS_PASS })
  });

  const j = await r.json();
  FMS_TOKEN = j.token || j?.data?.token;
  return FMS_TOKEN;
}

async function fmsSearchByPU(token, puList) {
  const headers = {
    "fms-client": FMS_CLIENT,
    "fms-token": token,
    "Content-Type": "application/json",
    "Company-Id": FMS_COMPANY_ID
  };

  const body = {
    page_number: 1,
    page_size: Math.min(puList.length,150),
    pu_nos: puList,
    tracking_nos: [], // disable PRO search
  };

  const r = await fetch(FMS_SEARCH_URL, {
    method: "POST",
    headers,
    body: JSON.stringify(body)
  });

  return r.json();
}

// Same mapper, but key by pu instead of pro
function buildFmsMap(searchJson) {
  const map = {};
  let items = searchJson?.items || searchJson?.data?.items || [];

  for (const it of items) {
    const pu  = cleanVal(it.pu_no ?? it.puNo ?? "");
    const order = String(it.order_no ?? it.orderNo ?? "").trim();

    if (pu && /^DO\d+/.test(order)) {
      map[pu] = {
        hasDO: true,
        DO: order,
        loc: it.current_location ?? null,
        status: it.order_status_describe ?? null,
        substatus: it.order_sub_status_describe ?? null
      };
    }
  }
  return map;
}


/* ========================
   TMS HELPERS
======================== */

async function authTms() {
  const body = new URLSearchParams();
  body.set("username", TMS_USER);
  body.set("password", TMS_PASS);
  body.set("UserID", "null");
  body.set("UserToken", "null");

  const r = await fetch(TMS_LOGIN_URL, {
    method: "POST",
    headers: {
      "Content-Type":"application/x-www-form-urlencoded; charset=UTF-8",
      "X-Requested-With":"XMLHttpRequest",
      "Origin": "https://tms.freightapp.com"
    },
    body
  });

  const j = await r.json();
  const uid = j.UserID;
  const token = j.UserToken;

  await tmsChangeGroup(uid, token);
  return { userId: uid, token };
}

async function tmsChangeGroup(userId, token) {
  const body = new URLSearchParams();
  body.set("group_id", String(TMS_GROUP_ID));
  body.set("UserID", String(userId));
  body.set("UserToken", String(token));

  await fetch(TMS_GROUP_URL, { method:"POST", body });
}

async function tmsTraceForPUs(auth, puList) {
  const { userId, token } = auth;
  const body = new URLSearchParams();

  // Set PU instead of PRO
  body.set("input_filter_pu", puList.join("\n"));
  body.set("input_filter_pro", "");
  body.set("UserID", String(userId));
  body.set("UserToken", String(token));
  body.set("pageName", "dashboardTmsTrace");
  body.set("input_page_num", "1");
  body.set("input_page_size", "10000");

  const r = await fetch(TMS_TRACE_URL, {
    method:"POST",
    headers:{
      "Content-Type":"application/x-www-form-urlencoded; charset=UTF-8",
      "X-Requested-With":"XMLHttpRequest",
    },
    body
  });

  const j = await r.json();
  const rows = j?.data || j?.rows || j || [];

  const map = new Map();
  for (const row of rows) {
    const key = cleanVal(row.tms_order_pu);
    if (key) map.set(key, row);
  }
  return map;
}
