// api/check-status.js
// Node 18 serverless function for Vercel (ESM, type: module)
export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const { pros } = req.body || {};
  if (!Array.isArray(pros) || pros.length === 0) {
    res.status(400).json({ error: "pros must be a non-empty array" });
    return;
  }

  const MAX_PROS = 150;
  const uniquePros = [...new Set(pros.map(p => String(p).trim()).filter(Boolean))];
  const trimmedPros = uniquePros.slice(0, MAX_PROS);

  try {
    const results = await checkAll(trimmedPros);
    res.status(200).json({ results });
  } catch (err) {
    console.error("check-status handler error:", err);
    res.status(500).json({ error: "Internal error running status check" });
  }
}

// ========================
// Config (from env / constants)
// ========================
const FMS_BASE       = process.env.FMS_BASE_URL || "https://fms.item.com";
const FMS_COMPANY_ID = process.env.FMS_COMPANY_ID || "SBFH";
const FMS_CLIENT     = process.env.FMS_CLIENT || "FMS_WEB";
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
const TMS_USER      = process.env.TMS_USER;
const TMS_PASS      = process.env.TMS_PASS; // base64 string as used in UI
const TMS_GROUP_ID  = process.env.TMS_GROUP_ID || "28";

// simple in-function cache (per invocation)
let FMS_TOKEN = null;

// ========================
// Main orchestration
// ========================
async function checkAll(pros){
  if (!FMS_USER || !FMS_PASS || !TMS_USER || !TMS_PASS) {
    throw new Error("Missing required FMS/TMS credentials in environment variables");
  }

  const fmsToken = await authFms();
  const searchJson = await fmsSearchOrders(fmsToken, pros);
  const fmsMap = buildFmsMap(searchJson);

  // TMS auth is independent. If it fails, we still return FMS data.
  let tmsAuth = null;
  try {
    tmsAuth = await authTms();
  } catch (e) {
    console.error("TMS auth failure:", e);
  }

  const results = [];
  for (const pro of pros) {
    const DO = fmsMap[pro];

    // --- FMS details ---
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
      fmsRes.DO = DO;
      fmsRes.hasDO = true;
    }

    // --- TMS details ---
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

    if (tmsAuth && tmsAuth.userId && tmsAuth.token) {
      tmsRes.attempted = true;
      try{
        const raw = await tmsTraceForPro(tmsAuth, pro);
        if (raw.notFound) {
          tmsRes.notFound = true;
        } else if (!raw.ok) {
          tmsRes.generalError = true;
        } else {
          tmsRes.ok        = true;
          tmsRes.orderId   = raw.orderId;
          tmsRes.loc       = raw.loc;
          tmsRes.status    = raw.status;
          tmsRes.substatus = raw.substatus;
        }
      }catch(e){
        if (e && e.name === "TypeError") {
          tmsRes.networkError = true;
        } else {
          tmsRes.generalError = true;
        }
      }
    }

    results.push({ pro, fms: fmsRes, tms: tmsRes });
  }

  return results;
}

// ========================
// FMS helpers
// ========================
async function authFms(force=false){
  if (FMS_TOKEN && !force) return FMS_TOKEN;
  const r = await fetch(FMS_LOGIN_URL, {
    method:"POST",
    headers:{
      "fms-client":FMS_CLIENT,
      "Content-Type":"application/json"
    },
    body:JSON.stringify({account:FMS_USER, password:FMS_PASS})
  });
  if (!r.ok) throw new Error(`FMS auth HTTP ${r.status}`);
  const j = await r.json().catch(()=> ({}));
  FMS_TOKEN = j.token || j?.data?.token || j?.result?.token || "";
  if (!FMS_TOKEN) throw new Error("FMS auth: no token returned");
  return FMS_TOKEN;
}

async function fmsSearchOrders(token, tracking_nos){
  const headers = {
    "fms-client":FMS_CLIENT,
    "fms-token":token,
    "Content-Type":"application/json",
    "Company-Id":FMS_COMPANY_ID
  };
  const body = {
    bill_to_accounts:[], bols:[], business_client:"",
    consignee_state:[], consignee_terminals:[], consignee_zip_codes:[],
    current_locations:[], customer_references:[], delayed:false,
    delivery_appointment:[], delivery_date:[], desired_delivery_date:[],
    exception:false, hold:false, lh_eta_date:[], lh_etd_date:[],
    lhs:[], master_order_ids:[], order_nos:[], origin_states:[],
    origin_zip_codes:[], page_number:1,
    page_size: Math.min(tracking_nos.length, 150),
    pickup_appointment:[], pickup_complete_date:[], po_nos:[], pu_nos:[],
    record_status:"0", request_pickup_date:[], service_levels:[],
    service_terminals:[], shipment_types:[], shipper_terminals:[],
    status:[], sub_status:[], tracking_nos, trips:[]
  };
  const r = await fetch(FMS_SEARCH_URL, { method:"POST", headers, body:JSON.stringify(body) });
  if (!r.ok) throw new Error(`FMS search HTTP ${r.status}`);
  return r.json();
}

function buildFmsMap(searchJson){
  const map = {};
  let items = [];
  if (Array.isArray(searchJson?.items)) items = searchJson.items;
  else if (Array.isArray(searchJson?.data?.items)) items = searchJson.data.items;
  for (const it of items){
    const pro   = String(it.tracking_no ?? it.trackingNo ?? "").trim();
    const order = String(it.order_no ?? it.orderNo ?? "").trim();
    if (/^\d{6,14}$/.test(pro) && /^DO\d{6,}$/.test(order)) {
      map[pro] = order;
    }
  }
  return map;
}

async function fetchFmsDetails(token, DO){
  const headers = {
    "accept":"application/json, text/plain, */*",
    "fms-client":FMS_CLIENT,
    "fms-token":token,
    "company-id":FMS_COMPANY_ID
  };

  let loc = null, statusDesc = null, subStatusDesc = null;
  let basicOk = false, headOk = false;
  let networkError = false, generalError = false;

  // basic
  try{
    const r = await fetch(FMS_ORDER_BASIC + encodeURIComponent(DO), { method:"GET", headers });
    if (!r.ok) throw new Error("bad status");
    const j = await r.json();
    const root = j?.data || j;
    loc = root?.current_location ?? root?.currentLocation ?? null;
    basicOk = true;
  }catch(e){
    if (e && e.name === "TypeError") networkError = true;
    else generalError = true;
  }

  // head
  try{
    const r = await fetch(FMS_ORDER_HEAD + encodeURIComponent(DO), { method:"GET", headers });
    if (!r.ok) throw new Error("bad status");
    const j = await r.json();
    const root = j?.data || j;
    statusDesc    = root?.order_status_describe ?? null;
    subStatusDesc = root?.order_sub_status_describe ?? null;
    headOk = true;
  }catch(e){
    if (e && e.name === "TypeError") networkError = true;
    else generalError = true;
  }

  if (networkError) {
    return { ok:false, loc:null, status:null, substatus:null, basicOk, headOk, networkError:true, generalError:false, partial:false };
  }
  if (!basicOk && !headOk && generalError) {
    return { ok:false, loc:null, status:null, substatus:null, basicOk, headOk, networkError:false, generalError:true, partial:false };
  }

  const ok = basicOk || headOk;
  const partial = (basicOk ^ headOk) ? true : false; // xor

  return {
    ok,
    loc,
    status: statusDesc,
    substatus: subStatusDesc,
    basicOk,
    headOk,
    partial,
    networkError:false,
    generalError:false
  };
}

// ========================
// TMS helpers
// ========================
async function authTms(){
  const body = new URLSearchParams();
  body.set("username", TMS_USER);
  body.set("password", TMS_PASS);
  body.set("UserID", "null");
  body.set("UserToken", "null");
  body.set("pageName", "/index.html");

  const r = await fetch(TMS_LOGIN_URL, {
    method:"POST",
    headers:{
      "Content-Type":"application/x-www-form-urlencoded; charset=UTF-8",
      "X-Requested-With":"XMLHttpRequest"
    },
    body
  });
  if (!r.ok) throw new Error(`TMS auth HTTP ${r.status}`);
  const j = await r.json().catch(()=> ({}));
  const uid   = j.UserID   ?? j.user_id   ?? null;
  const token = j.UserToken?? j.userToken ?? null;
  if (!uid || !token) throw new Error("TMS auth: missing UserID/UserToken");

  // Always change group for this invocation. (In a serverless env, functions are stateless.)
  await tmsChangeGroup(uid, token);

  return { userId:uid, token };
}

async function tmsChangeGroup(userId, userToken){
  const body = new URLSearchParams();
  body.set("group_id", String(TMS_GROUP_ID));
  body.set("UserID", String(userId));
  body.set("UserToken", String(userToken));
  body.set("pageName", "dashboard");

  const r = await fetch(TMS_GROUP_URL, {
    method:"POST",
    headers:{
      "Content-Type":"application/x-www-form-urlencoded; charset=UTF-8",
      "X-Requested-With":"XMLHttpRequest"
    },
    body
  });
  if (!r.ok) {
    console.warn("TMS group change HTTP", r.status);
  }
}

async function tmsTraceForPro(auth, pro){
  const { userId, token } = auth;
  const body = new URLSearchParams();
  body.set("input_filter_pro", String(pro));
  body.set("input_page_num", "1");
  body.set("input_page_size", "10");
  body.set("input_total_rows", "0");
  body.set("UserID", String(userId));
  body.set("UserToken", String(token));
  body.set("pageName", "dashboardTmsTrace");

  const r = await fetch(TMS_TRACE_URL, {
    method:"POST",
    headers:{
      "Content-Type":"application/x-www-form-urlencoded; charset=UTF-8",
      "X-Requested-With":"XMLHttpRequest"
    },
    body
  });

  if (!r.ok) throw new Error(`TMS trace HTTP ${r.status}`);
  const j = await r.json();

  let rows = null;
  if (Array.isArray(j)) rows = j;
  else if (Array.isArray(j?.data)) rows = j.data;
  else if (Array.isArray(j?.rows)) rows = j.rows;
  else if (Array.isArray(j?.result)) rows = j.result;

  if (!rows || !rows.length) return { ok:false, notFound:true };

  const row = rows.find(rw => String(rw.tms_order_pro ?? "").trim() === String(pro)) || rows[0];

  return {
    ok:true,
    orderId:   row.tms_order_id ?? null,
    loc:       row.wa2_code ?? null,
    status:    row.tms_order_stage ?? null,
    substatus: row.tms_order_status ?? null
  };
}
