const TelegramBot = require("node-telegram-bot-api");
const crypto = require("crypto");
const axios = require("axios");
const fs = require("fs");
const FormData = require("form-data");
let mammoth = null;
try {
  mammoth = require("mammoth");
} catch (e) {
  console.warn("[startup] mammoth is not installed. DOCX import for Video Projects is disabled until you run: npm install mammoth");
}

process.on("unhandledRejection", (reason) => {
  console.error("[unhandledRejection]", reason);
});
process.on("uncaughtException", (err) => {
  console.error("[uncaughtException]", err);
});

function loadEnvFileIfPresent(file = ".env") {
  try {
    if (!fs.existsSync(file)) return;
    const lines = fs.readFileSync(file, "utf-8").split(/\r?\n/);
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const idx = trimmed.indexOf("=");
      if (idx < 0) continue;
      const key = trimmed.slice(0, idx).trim();
      let value = trimmed.slice(idx + 1).trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      if (key && !process.env[key]) process.env[key] = value;
    }
  } catch (e) {
    console.warn(`[startup] .env read skipped: ${e.message}`);
  }
}
loadEnvFileIfPresent();

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN || process.env.BOT_TOKEN || process.env.TG_TOKEN || process.env.TELEGRAM_BOT_TOKEN;
const FASTGEN_API_KEY = process.env.FASTGEN_API_KEY || process.env.FASTGEN_KEY || process.env.FAST_GEN_API_KEY;
const BASE_URL = "https://googler.fast-gen.ai";
const STORAGE_URL = "https://storage.fast-gen.ai";

if (!TELEGRAM_TOKEN) {
  console.error("[startup] Missing TELEGRAM_TOKEN environment variable. Also accepted: BOT_TOKEN, TG_TOKEN, TELEGRAM_BOT_TOKEN");
  process.exit(1);
}
if (!FASTGEN_API_KEY) {
  console.warn("[startup] FASTGEN_API_KEY is not set. /start will work, but generation will fail until the key is added.");
}

const bot = new TelegramBot(TELEGRAM_TOKEN, {
  polling: {
    interval: 300,
    autoStart: false,
    params: { timeout: 10 },
  },
});

bot.on("polling_error", (err) => {
  console.error("[polling_error]", err?.message || err);
});
bot.on("webhook_error", (err) => {
  console.error("[webhook_error]", err?.message || err);
});

// \u2500\u2500\u2500 \u041F\u0435\u0440\u0441\u0438\u0441\u0442\u0435\u043D\u0442\u043D\u043E\u0435 \u0441\u043E\u0441\u0442\u043E\u044F\u043D\u0438\u0435 \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
const STATE_FILE = "./user_states.json";
const BALANCE_FILE = "./balance_state.json";
const HISTORY_FILE = "./history_state.json";
const VIDEO_PROJECTS_FILE = "./video_projects.json";
const VIDEO_PROJECT_HISTORY_FILE = "./video_project_history.json";
const VIDEO_REF_PRESETS_FILE = "./video_ref_presets.json";

function loadJSON(file, def) {
  try { return JSON.parse(fs.readFileSync(file, "utf-8")); } catch { return def; }
}
function saveJSON(file, data) {
  try { fs.writeFileSync(file, JSON.stringify(data, null, 2)); } catch(e) { console.error("saveJSON error:", e.message); }
}

const persistedStates = loadJSON(STATE_FILE, {});
const persistedHistory = loadJSON(HISTORY_FILE, {});
const videoProjects = loadJSON(VIDEO_PROJECTS_FILE, {});
const videoProjectHistory = loadJSON(VIDEO_PROJECT_HISTORY_FILE, {});
const videoRefPresets = loadJSON(VIDEO_REF_PRESETS_FILE, {});

// \u2500\u2500\u2500 \u041E\u0447\u0435\u0440\u0435\u0434\u044C \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
function createQueue(concurrency) {
  let running = 0;
  const queue = [];
  function next() {
    while (running < concurrency && queue.length > 0) {
      const { fn, resolve, reject } = queue.shift();
      running++;
      fn().then(v => { running--; resolve(v); next(); })
          .catch(e => { running--; reject(e); next(); });
    }
  }
  return function enqueue(fn) {
    return new Promise((resolve, reject) => { queue.push({ fn, resolve, reject }); next(); });
  };
}

const imageQueue = createQueue(10);
const videoQueue = createQueue(10);
// \u041E\u0442\u0434\u0435\u043B\u044C\u043D\u0430\u044F \u043E\u0447\u0435\u0440\u0435\u0434\u044C \u043E\u0442\u043F\u0440\u0430\u0432\u043A\u0438 \u0432 Telegram (2 \u043F\u043E\u0442\u043E\u043A\u0430) \u2014 \u0437\u0430\u0449\u0438\u0442\u0430 \u043E\u0442 flood
const tgSendQueue = createQueue(2);

// \u2500\u2500\u2500 \u041A\u044D\u0448 \u0440\u0435\u0444\u0435\u0440\u0435\u043D\u0441\u043E\u0432 (fileId \u2192 dataUri, TTL 30 \u043C\u0438\u043D) \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
const refCache = new Map();
const REF_CACHE_TTL = 30 * 60 * 1000;

function refCacheGet(fileId) {
  const entry = refCache.get(fileId);
  if (!entry) return null;
  if (Date.now() - entry.ts > REF_CACHE_TTL) { refCache.delete(fileId); return null; }
  return entry.value;
}
function refCacheSet(fileId, value) {
  refCache.set(fileId, { value, ts: Date.now() });
}

// \u2500\u2500\u2500 Storage upload \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
async function uploadToStorage(buffer, filename = "image.jpg") {
  assertFastGenApiKey();
  const form = new FormData();
  form.append("file", buffer, { filename, contentType: "image/jpeg" });
  const { data } = await axios.post(`${STORAGE_URL}/upload`, form, {
    headers: { ...form.getHeaders(), "X-API-Key": FASTGEN_API_KEY },
    timeout: 30000,
  });
  if (!data.file_hash) throw new Error("Storage upload: no file_hash returned");
  return `file:${data.file_hash}`;
}

// \u2500\u2500\u2500 \u0417\u0430\u0433\u0440\u0443\u0437\u0438\u0442\u044C \u0444\u043E\u0442\u043E \u0438\u0437 Telegram \u2192 base64 data URI (\u0441 \u043A\u044D\u0448\u0435\u043C) \u2500\u2500
async function tgPhotoToDataUri(fileId) {
  const cached = refCacheGet(fileId);
  if (cached) return cached;
  const f = await bot.getFile(fileId);
  const resp = await axios.get(`https://api.telegram.org/file/bot${TELEGRAM_TOKEN}/${f.file_path}`, { responseType: "arraybuffer" });
  const ext = f.file_path.split(".").pop().toLowerCase();
  const mime = ext === "png" ? "image/png" : ext === "webp" ? "image/webp" : "image/jpeg";
  const result = `data:${mime};base64,${Buffer.from(resp.data).toString("base64")}`;
  refCacheSet(fileId, result);
  return result;
}

// \u2500\u2500\u2500 \u0417\u0430\u0433\u0440\u0443\u0437\u0438\u0442\u044C \u0444\u043E\u0442\u043E \u0438\u0437 Telegram \u2192 storage ref \u2500\u2500
async function tgPhotoToRef(fileId) {
  const f = await bot.getFile(fileId);
  const resp = await axios.get(`https://api.telegram.org/file/bot${TELEGRAM_TOKEN}/${f.file_path}`, { responseType: "arraybuffer" });
  const buf = Buffer.from(resp.data);
  return uploadToStorage(buf);
}

// \u2500\u2500\u2500 V6 API helpers \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
function assertFastGenApiKey() {
  if (!FASTGEN_API_KEY) {
    throw new Error("FASTGEN_API_KEY \u043D\u0435 \u0437\u0430\u0434\u0430\u043D. \u0414\u043E\u0431\u0430\u0432\u044C API-\u043A\u043B\u044E\u0447 FastGen \u0432 \u043F\u0435\u0440\u0435\u043C\u0435\u043D\u043D\u044B\u0435 \u043E\u043A\u0440\u0443\u0436\u0435\u043D\u0438\u044F \u0438 \u043F\u0435\u0440\u0435\u0437\u0430\u043F\u0443\u0441\u0442\u0438 \u0431\u043E\u0442\u0430.");
  }
}

function v6Headers() {
  assertFastGenApiKey();
  return { "X-API-Key": FASTGEN_API_KEY, "Content-Type": "application/json" };
}

const NO_SEED_OPERATIONS = new Set([
  "grok_video_from_text",
  "grok_video_from_image",
]);

function generationSupportsSeed(operation) {
  return !NO_SEED_OPERATIONS.has(String(operation || ""));
}

function sanitizeV6GenerationBody(body = {}) {
  const clean = { ...body };

  // V6 has a generic `seed` field in the request schema, but Grok Video rejects it:
  // [HTTP 400] Model 'grok-video' does not support option 'seed'.
  // Remove seed only for Grok Video operations; other models keep deterministic seeds.
  if (!generationSupportsSeed(clean.operation)) {
    delete clean.seed;
  }

  return clean;
}

function getFastGenErrorText(e) {
  const detail = e?.response?.data?.detail || e?.response?.data?.message || e?.response?.data?.error || e?.message || "Unknown error";
  return typeof detail === "object" ? JSON.stringify(detail) : String(detail);
}

function isPermanentCreateError(e) {
  const status = Number(e?.response?.status || 0);
  const text = getFastGenErrorText(e).toLowerCase();

  // Retrying the same invalid request only repeats the same error and can create noisy/expensive loops.
  if (status === 400 || status === 422) return true;
  return /does not support option|unsupported option|unsupported model|invalid request|validation error|not supported/.test(text);
}

async function v6Create(body) {
  const cleanBody = sanitizeV6GenerationBody(body);
  const { data } = await axios.post(`${BASE_URL}/api/v6/generations`, cleanBody, {
    headers: v6Headers(), timeout: 120000,
  });
  return data;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function readPositiveIntEnv(name, fallback, min = 1, max = Number.MAX_SAFE_INTEGER) {
  const raw = process.env[name];
  if (raw === undefined || raw === null || raw === "") return fallback;
  const n = Number.parseInt(String(raw), 10);
  if (!Number.isFinite(n) || n < min) return fallback;
  return Math.min(n, max);
}

function stripErrorControlTags(text) {
  return String(text ?? "")
    .replace(/\|REFUNDED:(true|false|unknown)/g, "")
    .replace(/\|NO_RETRY:(true|false)/g, "");
}

function isNoRetryErrorMessage(text) {
  return /\|NO_RETRY:true/.test(String(text ?? ""));
}

function getRefundStatusFromUsage(usage) {
  if (!usage || typeof usage.refunded !== "boolean") return "unknown";
  return usage.refunded ? "true" : "false";
}

function getRefundStatusFromErrorMessage(text) {
  const match = String(text ?? "").match(/\|REFUNDED:(true|false|unknown)/);
  return match ? match[1] : "unknown";
}

function canAutoRetryAfterGenerationError(text) {
  return !isNoRetryErrorMessage(text) && getRefundStatusFromErrorMessage(text) === "true";
}

function refundStatusLabel(status) {
  if (status === "true" || status === true) return "✅ возвращены";
  if (status === "false" || status === false) return "❌ не возвращены";
  return "❓ API не вернул статус возврата";
}

// После успешной генерации storage-файл иногда становится доступен не мгновенно.
// Поэтому отправку результата в Telegram повторяем, пока видео реально не уйдёт в чат.
const SEND_MEDIA_ATTEMPTS = 12;
const SEND_MEDIA_RETRY_MS = 10000;

// ─── Watchdog: ждёт долгие видео до 1 часа и не запускает платные дубли при timeout ──
const POLL_INTERVAL_MS = readPositiveIntEnv("FASTGEN_POLL_INTERVAL_MS", 5000, 1000, 60000);
const WATCHDOG_MINUTES = readPositiveIntEnv("FASTGEN_WATCHDOG_MINUTES", 60, 1, 360);
const WATCHDOG_MS = WATCHDOG_MINUTES * 60 * 1000;

async function v6Poll(genId, maxAttempts = null, interval = POLL_INTERVAL_MS) {
  const effectiveMaxAttempts = maxAttempts ?? (Math.ceil(WATCHDOG_MS / interval) + 3);
  const deadline = Date.now() + WATCHDOG_MS;
  for (let i = 0; i < effectiveMaxAttempts; i++) {
    // Если вышли за дедлайн, задача могла ещё идти на стороне FastGen.
    // Не запускаем автоперегенерацию, чтобы не создать ещё одну платную задачу.
    if (Date.now() > deadline) {
      console.warn(`[watchdog] genId=${genId} exceeded ${Math.round(WATCHDOG_MS/1000)}s, aborting poll without retry`);
      throw new Error(`Generation watchdog timeout (${Math.round(WATCHDOG_MS/1000)}s)|REFUNDED:unknown|NO_RETRY:true`);
    }
    await new Promise(r => setTimeout(r, interval));
    let data;
    try {
      const resp = await axios.get(`${BASE_URL}/api/v6/generations/${genId}`, {
        headers: v6Headers(), timeout: 15000,
      });
      data = resp.data;
    } catch(e) {
      console.log(`[poll] network error attempt ${i}: ${e.message}`);
      continue;
    }
    const st = data.status;
    console.log(`[poll] id=${genId} attempt=${i} status=${st}`);
    if (st === "succeeded") return { results: data.results || [], usage: data.usage, raw: data, seed: extractGenerationSeed(null, data, null) };
    if (st === "failed") {
      const reason = data.error || JSON.stringify(data).slice(0, 300);
      const refundStatus = getRefundStatusFromUsage(data.usage);
      const noRetry = refundStatus === "true" ? "false" : "true";
      throw new Error(`Generation failed: ${reason}|REFUNDED:${refundStatus}|NO_RETRY:${noRetry}`);
    }
  }
  throw new Error(`Generation timed out after polling (${Math.round((effectiveMaxAttempts * interval) / 1000)}s)|REFUNDED:unknown|NO_RETRY:true`);
}

async function sendV6Media(chatId, media, caption, replyMarkup = null) {
  return tgSendQueue(async () => {
    let lastError = null;
    for (let attempt = 1; attempt <= SEND_MEDIA_ATTEMPTS; attempt++) {
      try {
        return await _sendV6MediaImpl(chatId, media, caption, replyMarkup);
      } catch (e) {
        lastError = e;
        console.warn(`[sendV6Media] attempt ${attempt}/${SEND_MEDIA_ATTEMPTS} failed: ${e.message}`);
        if (attempt < SEND_MEDIA_ATTEMPTS) await sleep(SEND_MEDIA_RETRY_MS);
      }
    }
    throw lastError || new Error("sendV6Media failed");
  });
}

function mediaExtFromUrlOrType(url, contentType, isImage) {
  const ct = String(contentType || "").toLowerCase();
  if (ct.includes("png")) return "png";
  if (ct.includes("webp")) return "webp";
  if (ct.includes("jpeg") || ct.includes("jpg")) return "jpg";
  if (ct.includes("quicktime")) return "mov";
  if (ct.includes("mp4")) return "mp4";
  try {
    const pathname = new URL(url).pathname;
    const match = pathname.match(/\.([a-z0-9]{2,5})$/i);
    if (match) return match[1].toLowerCase();
  } catch {}
  return isImage ? "jpg" : "mp4";
}

async function downloadMediaUrlToTemp(url, isImage) {
  let tmp = null;
  try {
    const resp = await axios.get(url, {
      responseType: "stream",
      timeout: 5 * 60 * 1000,
      maxContentLength: Infinity,
      maxBodyLength: Infinity,
    });
    const ext = mediaExtFromUrlOrType(url, resp.headers?.["content-type"], isImage);
    tmp = `/tmp/fg_${crypto.randomUUID()}.${ext}`;
    await new Promise((resolve, reject) => {
      const ws = fs.createWriteStream(tmp);
      resp.data.on("error", reject);
      ws.on("error", reject);
      ws.on("finish", resolve);
      resp.data.pipe(ws);
    });
    return tmp;
  } catch (e) {
    if (tmp) { try { fs.unlinkSync(tmp); } catch {} }
    throw e;
  }
}

async function sendLocalMediaFile(chatId, tmp, isImage, opts) {
  if (isImage) {
    try {
      await bot.sendPhoto(chatId, fs.createReadStream(tmp), opts);
    } catch (e) {
      console.warn(`[sendLocalMediaFile] sendPhoto failed, sending as document: ${e.message}`);
      await bot.sendDocument(chatId, fs.createReadStream(tmp), opts);
    }
    return;
  }

  try {
    await bot.sendVideo(chatId, fs.createReadStream(tmp), opts);
  } catch (e) {
    console.warn(`[sendLocalMediaFile] sendVideo failed, sending as document: ${e.message}`);
    const docOpts = { ...opts };
    delete docOpts.supports_streaming;
    await bot.sendDocument(chatId, fs.createReadStream(tmp), docOpts);
  }
}

async function _sendV6MediaImpl(chatId, media, caption, replyMarkup = null) {
  const isImage = media.mediaType === "image";
  const opts = { caption, parse_mode: "Markdown", ...(!isImage && { supports_streaming: true }), ...(replyMarkup && { reply_markup: replyMarkup }) };

  if (media.type === "url") {
    try {
      if (isImage) await bot.sendPhoto(chatId, media.value, opts);
      else await bot.sendVideo(chatId, media.value, opts);
      return;
    } catch (e) {
      console.warn(`[sendV6Media] Telegram direct URL send failed, downloading fallback: ${e.message}`);
    }

    const tmp = await downloadMediaUrlToTemp(media.value, isImage);
    try {
      await sendLocalMediaFile(chatId, tmp, isImage, opts);
    } finally {
      try { fs.unlinkSync(tmp); } catch {}
    }
    return;
  }

  let b64 = media.value;
  let ext = isImage ? "jpg" : "mp4";
  if (b64.includes(";base64,")) {
    const parts = b64.split(";base64,");
    b64 = parts[1];
    if (parts[0].includes("png")) ext = "png";
    else if (parts[0].includes("webp")) ext = "webp";
    else if (parts[0].includes("mp4")) ext = "mp4";
  }
  // UUID \u0434\u043B\u044F \u0443\u043D\u0438\u043A\u0430\u043B\u044C\u043D\u044B\u0445 \u0432\u0440\u0435\u043C\u0435\u043D\u043D\u044B\u0445 \u0444\u0430\u0439\u043B\u043E\u0432 \u2014 \u0438\u0441\u043A\u043B\u044E\u0447\u0430\u0435\u0442 \u043A\u043E\u043B\u043B\u0438\u0437\u0438\u0438 \u043F\u0440\u0438 \u043F\u0430\u0440\u0430\u043B\u043B\u0435\u043B\u044C\u043D\u044B\u0445 \u0437\u0430\u0434\u0430\u0447\u0430\u0445
  const tmp = `/tmp/fg_${crypto.randomUUID()}.${ext}`;
  fs.writeFileSync(tmp, Buffer.from(b64, "base64"));
  try {
    await sendLocalMediaFile(chatId, tmp, isImage, opts);
  } finally {
    try { fs.unlinkSync(tmp); } catch {}
  }
}

function resultDownloadUrl(item) {
  if (!item) return null;
  if (item.download_url) return String(item.download_url);
  if (item.url) return String(item.url);
  if (item.download_path) {
    const path = String(item.download_path);
    return `${STORAGE_URL}${path.startsWith("/") ? "" : "/"}${path}`;
  }
  const ref = item.file_ref || item.file || item.file_id || item.file_hash || item.storage_file;
  if (typeof ref === "string" && ref) {
    const hash = ref.startsWith("file:") ? ref.slice(5) : ref;
    if (/^[a-zA-Z0-9_-]{16,}$/.test(hash)) return `${STORAGE_URL}/file/${hash}/raw`;
  }
  return null;
}

function resultToMedia(item, fallbackType = "image") {
  if (!item) return null;
  const mediaType = item.type || fallbackType;
  if (item.data) {
    const value = String(item.data);
    if (/^https?:\/\//i.test(value)) return { type: "url", value, mediaType };
    return { type: "data_uri", value, mediaType };
  }
  const url = resultDownloadUrl(item);
  return url ? { type: "url", value: url, mediaType } : null;
}

function hasResultMedia(item) {
  return Boolean(item?.data || resultDownloadUrl(item));
}

// \u2500\u2500\u2500 \u041F\u0440\u043E\u043C\u043F\u0442 \u0447\u0435\u0440\u0435\u0437 v6 \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
async function v6EnhancePrompt(rawPrompt, isVideo = false) {
  const mediaType = isVideo ? "video generation" : "image generation";
  const systemPrompt = `You are an expert prompt engineer for AI ${mediaType} models (NanoBanana, Flower, Flow/Veo, Grok, OpenAI Image).
Take the user's raw prompt and rewrite it into a highly detailed, optimized prompt.
- Detect content type: portrait, landscape, abstract, anime, realistic, cinematic, etc.
- Add: lighting, camera angle, atmosphere, color palette, quality boosters (photorealistic, 8K, sharp focus)
${isVideo ? "- Add: motion description, camera movement, pacing" : ""}
- Keep the core idea intact \u2014 only expand and improve, never change the subject
Output ONLY the improved prompt, nothing else.

User prompt: ${rawPrompt}`;

  const { data } = await axios.post(`${BASE_URL}/api/v6/prompts/generate`, {
    user_prompt: systemPrompt,
  }, { headers: v6Headers(), timeout: 30000 });

  return data.generated_text?.trim() || null;
}

// \u2500\u2500\u2500 \u0411\u0430\u043B\u0430\u043D\u0441 \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
const HOURLY_LIMITS = { images: 500, videos: 15, tokens: 200000 };

function nextHourResetUTC() {
  const now = new Date();
  // \u0421\u0431\u0440\u043E\u0441 \u0432 \u043D\u0430\u0447\u0430\u043B\u0435 \u043A\u0430\u0436\u0434\u043E\u0433\u043E \u0447\u0430\u0441\u0430 \u043F\u043E UTC (00:00, 01:00, 02:00, ...)
  const nextHour = new Date(Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
    now.getUTCHours() + 1,
    0, 0, 0
  ));
  return nextHour.getTime();
}

let balanceState = loadJSON(BALANCE_FILE, { images: 0, videos: 0, tokens: 0, resetAt: nextHourResetUTC() });
if (!balanceState.resetAt || balanceState.resetAt < Date.now()) {
  balanceState = { images: 0, videos: 0, tokens: 0, resetAt: nextHourResetUTC() };
  saveJSON(BALANCE_FILE, balanceState);
}

function checkResetBalance() {
  if (Date.now() >= balanceState.resetAt) {
    balanceState = { images: 0, videos: 0, tokens: 0, resetAt: nextHourResetUTC() };
    saveJSON(BALANCE_FILE, balanceState);
  }
}

function spendBalance(type, amount = 1) {
  checkResetBalance();
  balanceState[type] = (balanceState[type] || 0) + amount;
  saveJSON(BALANCE_FILE, balanceState);
}

function getTimeUntilNextHourUTC() {
  const now = Date.now();
  const nextReset = nextHourResetUTC();
  return Math.max(0, nextReset - now);
}

async function formatBalance() {
  checkResetBalance();
  const b = balanceState;
  const imgLeft = Math.max(0, HOURLY_LIMITS.images - b.images);
  const vidLeft = Math.max(0, HOURLY_LIMITS.videos - b.videos);
  const msLeft = Math.max(0, b.resetAt - Date.now());
  const totalMin = Math.ceil(msLeft / 60000);
  const h = Math.floor(totalMin / 60), m = totalMin % 60;
  const resetStr = h > 0 ? `${h}\u0447 ${m}\u043C` : `${m}\u043C`;
  const resetTime = new Date(b.resetAt).toLocaleTimeString("ru", { hour: "2-digit", minute: "2-digit", timeZone: "UTC" });

  let realBlock = "";
  try {
    const { data } = await axios.get(`${BASE_URL}/api/v6/usage`, {
      headers: v6Headers(), timeout: 10000,
    });
    const lim = data.account_limits || {};
    const threads = data.current_usage?.active_threads || {};
    realBlock =
      `\n\u{1F4E1} *API (\u0440\u0435\u0430\u043B\u044C\u043D\u044B\u0439):*\n` +
      `\u{1F5BC} \u041B\u0438\u043C\u0438\u0442 \u0444\u043E\u0442\u043E/\u0447\u0430\u0441: *${lim.img_gen_per_hour_limit ?? "?"}*\n` +
      `\u{1F3AC} \u041B\u0438\u043C\u0438\u0442 \u0432\u0438\u0434\u0435\u043E/\u0447\u0430\u0441: *${lim.video_gen_per_hour_limit ?? "?"}*\n` +
      `\u26A1 \u0410\u043A\u0442\u0438\u0432\u043D\u044B\u0445 \u043F\u043E\u0442\u043E\u043A\u043E\u0432: \u0444\u043E\u0442\u043E=${threads.image_threads || 0}, \u0432\u0438\u0434\u0435\u043E=${threads.video_threads || 0}\n`;
  } catch(e) {
    realBlock = `\n\u{1F4E1} API: \u043D\u0435 \u0443\u0434\u0430\u043B\u043E\u0441\u044C \u043F\u043E\u043B\u0443\u0447\u0438\u0442\u044C (${e.message})\n`;
  }

  return (
    `\u{1F4CA} *\u0411\u0430\u043B\u0430\u043D\u0441*\n\n` +
    `\u{1F5BC} \u0418\u0437\u043E\u0431\u0440\u0430\u0436\u0435\u043D\u0438\u0439 \u043E\u0441\u0442\u0430\u043B\u043E\u0441\u044C: *${imgLeft}/${HOURLY_LIMITS.images}*\n` +
    `\u{1F3AC} \u0412\u0438\u0434\u0435\u043E \u043E\u0441\u0442\u0430\u043B\u043E\u0441\u044C: *${vidLeft}/${HOURLY_LIMITS.videos}*\n` +
    `\u23F1 \u0421\u0431\u0440\u043E\u0441 \u0447\u0435\u0440\u0435\u0437: *${resetStr}* (\u0432 ${resetTime} UTC)\n` +
    realBlock +
    `\n*\u0421\u0442\u043E\u0438\u043C\u043E\u0441\u0442\u044C \u043C\u043E\u0434\u0435\u043B\u0435\u0439:*\n` +
    `\u{1F5BC} NanoBanana Pro / NanoBanana 2 (Flow): 4 \u043A\u0440\u0435\u0434\n` +
    `\u{1F5BC} Flower: 1 \u043A\u0440\u0435\u0434 | OpenAI Image: 2 \u043A\u0440\u0435\u0434 | Grok: 1/3 \u043A\u0440\u0435\u0434\n` +
    `\u{1F3AC} Veo 3.1 Fast/Light/Ultra-Light/Flower: 1 \u043A\u0440\u0435\u0434\n` +
    `\u{1F3AC} Grok Video text: 480p 1 \u043A\u0440\u0435\u0434 | 720p 3 \u043A\u0440\u0435\u0434; image: 480p 2 \u043A\u0440\u0435\u0434 | 720p 4 \u043A\u0440\u0435\u0434\n` +
    `\u{1F3AC} Omni Flash 4/6/8/10s: 1 \u043A\u0440\u0435\u0434\n` +
    `\u{1F3AC} Veo 3.1 Quality: 10 \u043A\u0440\u0435\u0434 \u26A0\uFE0F\n` +
    `\n\u041E\u0431\u043D\u043E\u0432\u043B\u0435\u043D\u043E: ${new Date().toLocaleTimeString("ru")}`
  );
}

// \u2500\u2500\u2500 \u041C\u043E\u0434\u0435\u043B\u0438 \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
const IMAGE_MODELS = {
  // В v6 нет operation `imagen_4_image_generate`; ключ `imagen4` оставлен как алиас, чтобы старые состояния пользователей не ломались.
  "imagen4":    { label: "NanoBanana Pro",      operation: "nano_banana_pro_image_generate",  credits: "4 кред/фото" },
  "nanopro":    { label: "NanoBanana Pro",      operation: "nano_banana_pro_image_generate",  credits: "4 кред/фото" },
  "nanob2":     { label: "NanoBanana 2 Flow",   operation: "nano_banana_2_image_generate",    credits: "4 кред/фото" },
  "flower":     { label: "Flower Image",        operation: "flower_image_generate",           credits: "1 кред/фото" },
  "grok_fast":  { label: "Grok (быстро)",       operation: "grok_image_generate",             credits: "1 кред/фото", quality: "speed" },
  "grok_qual":  { label: "Grok (качество)",     operation: "grok_image_generate",             credits: "3 кред/фото", quality: "quality" },
  "chatgpt":    { label: "OpenAI Image",        operation: "openai_image_generate",           credits: "2 кред/фото" },
};

const GROK_DURATIONS = {
  "6s":  { label: "6 \u0441\u0435\u043A",  seconds: 6 },
  "10s": { label: "10 \u0441\u0435\u043A", seconds: 10 },
};

function getGrokDurationSeconds(duration) {
  return GROK_DURATIONS[duration]?.seconds || 6;
}

function getGrokVideoCredits(resolution) {
  return resolution === "720p" ? 3 : 1;
}

function getImageGenerationCredits(model) {
  const operation = model?.operation;
  if (operation === "nano_banana_pro_image_generate" || operation === "nano_banana_2_image_generate") return 4;
  if (operation === "openai_image_generate") return 2;
  if (operation === "grok_image_generate") return model?.quality === "quality" ? 3 : 1;
  return 1;
}

function getVideoGenerationCredits(model, resolution = "720p", operation = null) {
  const op = operation || model?.opText || model?.opImg || model?.opKf || "";
  if (op === "grok_video_from_image") return resolution === "720p" ? 4 : 2;
  if (op === "grok_video_from_text") return resolution === "720p" ? 3 : 1;
  if (op.includes("quality")) return 10;
  return 1;
}

const VIDEO_MODELS = {
  "veo_fast":   { label: "Veo 3.1 Fast",        opText: "flow_video_from_text",         opImg: "flow_video_from_ingredients",         opKf: "flow_video_from_keyframes",         credits: "1 \u043A\u0440\u0435\u0434/\u0432\u0438\u0434\u0435\u043E" },
  "veo_light":  { label: "Veo 3.1 Light",       opText: "flow_video_light_from_text",   opImg: "flow_video_light_from_ingredients",   opKf: "flow_video_light_from_keyframes",   credits: "1 \u043A\u0440\u0435\u0434/\u0432\u0438\u0434\u0435\u043E" },
  "veo_ultra":  { label: "Veo 3.1 Ultra-Light", opText: "flow_video_ultra_light_from_text", opImg: "flow_video_ultra_light_from_ingredients", opKf: "flow_video_ultra_light_from_keyframes", credits: "1 \u043A\u0440\u0435\u0434/\u0432\u0438\u0434\u0435\u043E" },
  "veo_qual":   { label: "Veo 3.1 Quality",     opText: "flow_video_quality_from_text", opImg: null,                                  opKf: "flow_video_quality_from_keyframes", credits: "10 \u043A\u0440\u0435\u0434/\u0432\u0438\u0434\u0435\u043E \u26A0\uFE0F" },
  "flower_vid": { label: "Veo 3.1 Flower",      opText: "flower_video_from_text",       opImg: "flower_video_from_image",             opKf: null,                                credits: "1 \u043A\u0440\u0435\u0434/\u0432\u0438\u0434\u0435\u043E" },
  "grok_vid":   { label: "Grok Video",          opText: "grok_video_from_text",         opImg: "grok_video_from_image",               opKf: null,                                credits: "480p: 1 \u043A\u0440\u0435\u0434 | 720p: 3 \u043A\u0440\u0435\u0434", hasResolution: true, hasDuration: true },
  "omni_4s":    { label: "Omni Flash 4s",       opText: "flow_video_omni_flash_from_text_4s",  opImg: "flow_video_omni_flash_from_ingredients_4s",  opKf: null, credits: "1 \u043A\u0440\u0435\u0434/\u0432\u0438\u0434\u0435\u043E" },
  "omni_6s":    { label: "Omni Flash 6s",       opText: "flow_video_omni_flash_from_text_6s",  opImg: "flow_video_omni_flash_from_ingredients_6s",  opKf: null, credits: "1 \u043A\u0440\u0435\u0434/\u0432\u0438\u0434\u0435\u043E" },
  "omni_8s":    { label: "Omni Flash 8s",       opText: "flow_video_omni_flash_from_text_8s",  opImg: "flow_video_omni_flash_from_ingredients_8s",  opKf: null, credits: "1 \u043A\u0440\u0435\u0434/\u0432\u0438\u0434\u0435\u043E" },
  "omni_10s":   { label: "Omni Flash 10s",      opText: "flow_video_omni_flash_from_text_10s", opImg: "flow_video_omni_flash_from_ingredients_10s", opKf: null, credits: "1 \u043A\u0440\u0435\u0434/\u0432\u0438\u0434\u0435\u043E" },
};

const RATIOS = ["16:9", "9:16", "1:1", "4:3", "3:4", "3:2", "2:3"];

// \u2500\u2500\u2500 \u0421\u043E\u0441\u0442\u043E\u044F\u043D\u0438\u0435 \u043F\u043E\u043B\u044C\u0437\u043E\u0432\u0430\u0442\u0435\u043B\u0435\u0439 \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
const DEFAULT_STATE = () => ({
  step: null,
  imgModel: "imagen4",
  vidModel: "veo_fast",
  ratio: "16:9",
  count: 1,
  perPrompt: 1,
  seed: "random",
  resolution: "720p",
  grokDuration: "6s",
  batchType: "image",
  batchPrompts: [],
  batchPhotos: [],
  batchPromptIdx: 0,
  batchImgModel: null,
  batchVidModel: null,
  batchRatio: null,
  batchResolution: null,
  batchGrokDuration: null,
  batchHourlyLimit: 15,
  keyframeStart: null,
  keyframeEnd: null,
  pendingRefImages: [],
  menuMsgId: null,
  enhanceMode: "ask",
  videoProjectDraft: null,
  videoProjectSelectedId: null,
  pgSplitMode: "lines",
  pgParallel: 5,
  pgProvider: "fastgen",
  storyScenes: 10,
  storyParallel: 3,
  storyVideoHourlyLimit: 15,
  pgApiKey: null,
  pgTemplate: `I'll send you a paragraph from a story. Generate a detailed image prompt for image generation.
Keep total response under 1000 symbols.

Prompt: Create a vivid 1-line prompt with: visual focus, atmosphere, style, lighting, color palette, camera angle.
Negative: list what to avoid.

Text: {TEXT}`,
});

const userState = {};
const history = {};

function getState(chatId) {
  const key = String(chatId);
  if (!userState[key]) {
    const saved = persistedStates[key] || {};
    userState[key] = Object.assign(DEFAULT_STATE(), saved);
    userState[key].step = null;
    userState[key].menuMsgId = null;
  }
  return userState[key];
}

function saveState(chatId) {
  const key = String(chatId);
  const s = userState[key];
  if (!s) return;
  persistedStates[key] = {
    imgModel: s.imgModel, vidModel: s.vidModel, ratio: s.ratio,
    count: s.count, perPrompt: s.perPrompt, seed: s.seed,
    resolution: s.resolution, grokDuration: s.grokDuration,
    batchType: s.batchType,
    batchImgModel: s.batchImgModel, batchVidModel: s.batchVidModel,
    batchRatio: s.batchRatio, batchResolution: s.batchResolution,
    batchGrokDuration: s.batchGrokDuration,
    batchHourlyLimit: s.batchHourlyLimit,
    pgSplitMode: s.pgSplitMode, pgParallel: s.pgParallel,
    pgProvider: s.pgProvider, pgApiKey: s.pgApiKey, pgTemplate: s.pgTemplate,
    storyScenes: s.storyScenes, storyParallel: s.storyParallel, storyVideoHourlyLimit: s.storyVideoHourlyLimit,
    enhanceMode: s.enhanceMode,
  };
  saveJSON(STATE_FILE, persistedStates);
}

function getHistory(chatId) {
  const key = String(chatId);
  if (!history[key]) history[key] = persistedHistory[key] || [];
  return history[key];
}

function addHistory(chatId, entry) {
  const key = String(chatId);
  const h = getHistory(chatId);
  entry.ts = Date.now();
  h.unshift(entry);
  if (h.length > 50) h.pop();
  persistedHistory[key] = h;
  saveJSON(HISTORY_FILE, persistedHistory);
}

// \u2500\u2500\u2500 Pending generators \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
const pendingGenerators = new Map();

// \u2500\u2500\u2500 \u0425\u0440\u0430\u043D\u0438\u043B\u0438\u0449\u0435 \u0437\u0430\u0434\u0430\u0447 \u0441 \u043E\u0448\u0438\u0431\u043A\u0430\u043C\u0438 \u0434\u043B\u044F \u043F\u0435\u0440\u0435\u0433\u0435\u043D\u0435\u0440\u0430\u0446\u0438\u0438 \u2500\u2500
const failedTasks = new Map();

function storeFailedTask(chatId, errKey, taskData) {
  failedTasks.set(`${chatId}_${errKey}`, taskData);
  setTimeout(() => failedTasks.delete(`${chatId}_${errKey}`), 24 * 60 * 60 * 1000);
}

function getFailedTask(chatId, errKey) {
  return failedTasks.get(`${chatId}_${errKey}`);
}

// \u2500\u2500\u2500 \u041F\u043E\u043B\u0443\u0447\u0435\u043D\u0438\u0435 \u0440\u0435\u0430\u043B\u044C\u043D\u043E\u0433\u043E \u0441\u043E\u0441\u0442\u043E\u044F\u043D\u0438\u044F \u043B\u0438\u043C\u0438\u0442\u043E\u0432 \u0438\u0437 API \u2500\u2500
async function getRealVideoUsage() {
  try {
    const { data } = await axios.get(`${BASE_URL}/api/v6/usage`, {
      headers: v6Headers(), timeout: 10000,
    });
    const lim = data.account_limits || {};
    const usage = data.current_usage?.hourly_usage?.video_generation || {};
    return {
      hourLimit: lim.video_gen_per_hour_limit || 15,
      usedThisHour: usage.current_usage || 0,
      windowStart: usage.window_start || null,
    };
  } catch(e) {
    console.log(`[getRealVideoUsage] failed: ${e.message}`);
    return null;
  }
}


// \u2500\u2500\u2500 Video Projects: \u043F\u043E\u0441\u0442\u043E\u044F\u043D\u043D\u044B\u0435 \u0432\u0438\u0434\u0435\u043E-\u043F\u0440\u043E\u0435\u043A\u0442\u044B \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
const VIDEO_PROJECT_LIMITS = [5, 10, 15, 20];
const VIDEO_PROJECT_MAX_REFS = 7;
const VIDEO_PROJECT_MAX_RETRIES = 5;
const VIDEO_PROJECT_PROCESS_MS = 60 * 1000;
let videoProjectsProcessorBusy = false;

// \u0412\u0441\u0442\u0440\u043E\u0435\u043D\u043D\u044B\u0435 \u043D\u0430\u0431\u043E\u0440\u044B \u043F\u043E\u0434\u043F\u0438\u0441\u0435\u0439 refs. \u041F\u043E\u043B\u044C\u0437\u043E\u0432\u0430\u0442\u0435\u043B\u044C\u0441\u043A\u0438\u0435 \u043F\u0440\u0435\u0441\u0435\u0442\u044B \u0445\u0440\u0430\u043D\u044F\u0442\u0441\u044F \u0432 video_ref_presets.json.
const VIDEO_PROJECT_BUILTIN_REF_PRESETS = [
  { id: "char", name: "\u{1F464} Character", labels: ["hero", "face", "outfit", "pose", "background", "lighting", "style"] },
  { id: "scene", name: "\u{1F3D9} Scene", labels: ["location", "hero", "main_object", "weather", "camera", "lighting", "style"] },
  { id: "product", name: "\u{1F4E6} Product Ad", labels: ["product", "logo", "hand", "background", "lighting", "camera", "style"] },
  { id: "fashion", name: "\u{1F455} Fashion", labels: ["model", "outfit", "shoes", "accessory", "location", "pose", "lighting"] },
  { id: "vehicle", name: "\u{1F697} Vehicle", labels: ["vehicle", "driver", "road", "city", "camera", "lighting", "style"] },
  { id: "story", name: "\u{1F39E} Story", labels: ["character", "second_character", "location", "prop", "mood", "camera", "style"] },
];

function saveVideoProjects() {
  saveJSON(VIDEO_PROJECTS_FILE, videoProjects);
}

function saveVideoProjectHistory() {
  saveJSON(VIDEO_PROJECT_HISTORY_FILE, videoProjectHistory);
}

function saveVideoRefPresets() {
  saveJSON(VIDEO_REF_PRESETS_FILE, videoRefPresets);
}

function shortId(prefix = "vp") {
  return `${prefix}_${crypto.randomBytes(6).toString("hex")}`;
}

function md(text) {
  return String(text ?? "").replace(/([_*`\[])/g, "\\$1");
}

function cut(text, max = 180) {
  const s = String(text ?? "");
  return s.length > max ? `${s.slice(0, max - 1)}\u2026` : s;
}

function cleanErrorMessage(err, max = 700) {
  const raw = err?.response?.data?.detail || err?.response?.data?.message || err?.response?.data?.error || err?.message || err || "\u041D\u0435\u0438\u0437\u0432\u0435\u0441\u0442\u043D\u0430\u044F \u043E\u0448\u0438\u0431\u043A\u0430";
  const str = typeof raw === "object" ? JSON.stringify(raw) : String(raw);
  return stripErrorControlTags(str).slice(0, max);
}

const FASTGEN_MAX_SEED = 2147483647;

function makeGenerationSeed(seedMode = "random") {
  const explicitSeed = normalizeSeedValue(seedMode);
  if (explicitSeed !== null) return explicitSeed;
  const mode = String(seedMode || "random").toLowerCase();
  if (mode === "fixed") return 42;
  return crypto.randomInt(0, FASTGEN_MAX_SEED + 1);
}

function normalizeSeedValue(value) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value === "number" && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return null;
    if (/^\d+$/.test(trimmed)) {
      const num = Number(trimmed);
      if (Number.isSafeInteger(num) && num >= 0 && num <= FASTGEN_MAX_SEED) return num;
    }
  }
  return null;
}

function extractGenerationSeed(resultItem = null, pollResult = null, requestedSeed = null) {
  const raw = pollResult?.raw || pollResult || {};
  const candidates = [
    resultItem?.seed,
    resultItem?.actual_seed,
    resultItem?.actualSeed,
    resultItem?.generation_seed,
    resultItem?.generationSeed,
    resultItem?.request_seed,
    resultItem?.requestSeed,
    resultItem?.metadata?.seed,
    resultItem?.metadata?.actual_seed,
    resultItem?.metadata?.actualSeed,
    resultItem?.metadata?.generation_seed,
    resultItem?.metadata?.generationSeed,
    resultItem?.metadata?.request_seed,
    resultItem?.metadata?.requestSeed,
    pollResult?.seed,
    pollResult?.actual_seed,
    pollResult?.actualSeed,
    pollResult?.generation_seed,
    pollResult?.generationSeed,
    pollResult?.metadata?.seed,
    pollResult?.metadata?.actual_seed,
    pollResult?.metadata?.actualSeed,
    raw.seed,
    raw.actual_seed,
    raw.actualSeed,
    raw.generation_seed,
    raw.generationSeed,
    raw.request_seed,
    raw.requestSeed,
    raw.metadata?.seed,
    raw.metadata?.actual_seed,
    raw.metadata?.actualSeed,
    requestedSeed,
  ];

  for (const value of candidates) {
    const normalized = normalizeSeedValue(value);
    if (normalized !== null) return normalized;
  }
  return null;
}

function seedCaptionLine(resultItem = null, pollResult = null, requestedSeed = null) {
  const seed = extractGenerationSeed(resultItem, pollResult, requestedSeed);
  return seed === null ? "" : `\n\u{1F331} Seed: \`${md(seed)}\``;
}

function withSeedCaption(caption, resultItem = null, pollResult = null, requestedSeed = null) {
  return `${caption}${seedCaptionLine(resultItem, pollResult, requestedSeed)}`;
}

function utcHourKey(ts = Date.now()) {
  const d = new Date(ts);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}T${String(d.getUTCHours()).padStart(2, "0")}:00Z`;
}

function getProjectProgress(project) {
  const total = project.prompts?.length || 0;
  const finished = (project.done || 0) + (project.failed || 0);
  return total > 0 ? Math.floor((finished / total) * 100) : 0;
}

function getRemainingProjectPrompts(project) {
  return (project.prompts || []).filter(p => !["completed", "failed", "cancelled"].includes(p.status)).length;
}

function normalizeVideoProject(project) {
  if (!project) return project;
  project.id = project.id || shortId();
  project.status = project.status || "draft";
  project.model = VIDEO_MODELS[project.model] ? project.model : "veo_fast";
  project.hourlyLimit = VIDEO_PROJECT_LIMITS.includes(project.hourlyLimit) ? project.hourlyLimit : 15;
  project.createdAt = project.createdAt || Date.now();
  project.nextIndex = Number.isInteger(project.nextIndex) ? project.nextIndex : 0;
  project.done = project.done || 0;
  project.failed = project.failed || 0;
  project.defaultRefs = normalizeVideoProjectRefs(project.defaultRefs, "project_ref").slice(0, VIDEO_PROJECT_MAX_REFS);
  project.prompts = Array.isArray(project.prompts) ? project.prompts : [];
  for (const prompt of project.prompts) {
    prompt.refs = normalizeVideoProjectRefs(prompt.refs, `prompt_${(prompt.index ?? 0) + 1}_ref`).slice(0, VIDEO_PROJECT_MAX_REFS);
    prompt.status = prompt.status || "pending";
    prompt.retries = prompt.retries || 0;
  }
  project.hourlyUsage = project.hourlyUsage || { hourKey: utcHourKey(), used: 0 };
  project.ratio = project.ratio || "16:9";
  project.resolution = project.resolution || "720p";
  project.grokDuration = project.grokDuration || "6s";
  project.seed = project.seed || "random";
  project.name = project.name || `Project ${project.id}`;
  return project;
}

function normalizeAllVideoProjects() {
  for (const id of Object.keys(videoProjects)) normalizeVideoProject(videoProjects[id]);
}

function restoreVideoProjectsAfterRestart() {
  normalizeAllVideoProjects();
  let changed = false;
  for (const project of Object.values(videoProjects)) {
    if (!["running", "paused", "draft"].includes(project.status)) continue;
    for (const prompt of project.prompts || []) {
      if (["running", "queued"].includes(prompt.status)) {
        prompt.status = "pending";
        prompt.startedAt = null;
        changed = true;
      }
    }
  }
  if (changed) saveVideoProjects();
}

function getChatVideoProjects(chatId, includeDeleted = false) {
  return Object.values(videoProjects)
    .map(normalizeVideoProject)
    .filter(p => String(p.chatId) === String(chatId) && (includeDeleted || p.status !== "deleted"))
    .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
}

function makeVideoProjectPrompt(prompt, index) {
  return {
    id: shortId("vpp"),
    index,
    prompt,
    status: "pending",
    retries: 0,
    refs: [],
    result: null,
    error: null,
    createdAt: Date.now(),
  };
}

function addPromptsToVideoProject(projectId, rawPrompts) {
  const project = videoProjects[projectId];
  if (!project) return 0;
  normalizeVideoProject(project);
  const clean = rawPrompts.map(p => String(p || "").trim()).filter(Boolean);
  const start = project.prompts.length;
  for (let i = 0; i < clean.length; i++) {
    project.prompts.push(makeVideoProjectPrompt(clean[i], start + i));
  }
  project.updatedAt = Date.now();
  saveVideoProjects();
  return clean.length;
}

function findVideoProjectPrompt(project, promptId) {
  return (project.prompts || []).find(p => p.id === promptId);
}

function getVideoProjectModelRefLimit(project) {
  const modelKey = typeof project === "string" ? project : project?.model;
  const model = VIDEO_MODELS[modelKey];
  if (!model?.opImg) return 0;
  // \u041B\u0438\u043C\u0438\u0442\u044B \u043F\u043E \u0442\u0435\u043A\u0443\u0449\u0438\u043C video-\u043C\u043E\u0434\u0435\u043B\u044F\u043C FastGen/API:
  // Flower image-to-video: 1 image; Flow/Veo ingredients: 1-3 images; Grok video: up to 7 images.
  if (modelKey === "flower_vid") return 1;
  if (modelKey === "grok_vid") return 7;
  if (String(model?.opImg || "").includes("ingredients")) return 3;
  return VIDEO_PROJECT_MAX_REFS;
}

function getVideoProjectPromptRefLimit(project) {
  return Math.min(VIDEO_PROJECT_MAX_REFS, getVideoProjectModelRefLimit(project));
}

function sanitizeVideoProjectRefLabel(label, fallback = "ref") {
  const raw = String(label || "").trim().replace(/\s+/g, " ");
  return cut(raw || fallback, 80);
}

function sanitizeVideoProjectRefFilename(label, index = 0, prefix = "ref") {
  const raw = String(label || `${prefix}_${index + 1}`)
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "_")
    .replace(/[^a-z0-9\u0430-\u044F\u0451_\-]+/gi, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
  const base = (raw || `${prefix}_${index + 1}`).slice(0, 80);
  return base.match(/\.(jpg|jpeg|png|webp)$/i) ? base : `${base}.jpg`;
}

function normalizeVideoProjectRef(ref, index = 0, prefix = "ref") {
  if (!ref) return null;
  if (typeof ref === "string") {
    const label = sanitizeVideoProjectRefLabel(`${prefix} ${index + 1}`, `${prefix} ${index + 1}`);
    return {
      input: ref,
      label,
      filename: sanitizeVideoProjectRefFilename(label, index, prefix),
      createdAt: Date.now(),
    };
  }
  if (typeof ref === "object") {
    const input = ref.input || ref.value || ref.data || ref.ref || ref.url || ref.file || null;
    if (!input) return null;
    const label = sanitizeVideoProjectRefLabel(ref.label || ref.name || ref.title || ref.filename || `${prefix} ${index + 1}`, `${prefix} ${index + 1}`);
    return {
      input,
      label,
      filename: sanitizeVideoProjectRefFilename(ref.filename || label, index, prefix),
      createdAt: ref.createdAt || Date.now(),
    };
  }
  return null;
}

function normalizeVideoProjectRefs(refs, prefix = "ref") {
  if (!Array.isArray(refs)) return [];
  return refs.map((ref, i) => normalizeVideoProjectRef(ref, i, prefix)).filter(Boolean);
}

function makeVideoProjectRef(input, label, index = 0, prefix = "ref") {
  const cleanLabel = sanitizeVideoProjectRefLabel(label, `${prefix} ${index + 1}`);
  return {
    input,
    label: cleanLabel,
    filename: sanitizeVideoProjectRefFilename(cleanLabel, index, prefix),
    createdAt: Date.now(),
  };
}

function videoProjectRefInput(ref) {
  if (!ref) return null;
  return typeof ref === "string" ? ref : (ref.input || ref.value || ref.data || null);
}

function videoProjectRefLabel(ref, index = 0, prefix = "ref") {
  if (!ref || typeof ref === "string") return `${prefix} ${index + 1}`;
  return sanitizeVideoProjectRefLabel(ref.label || ref.filename, `${prefix} ${index + 1}`);
}

function videoProjectRefsForApi(refs, prefix = "ref") {
  return normalizeVideoProjectRefs(refs, prefix)
    .map((ref, i) => ({
      filename: sanitizeVideoProjectRefFilename(ref.filename || ref.label, i, prefix),
      input: videoProjectRefInput(ref),
    }))
    .filter(item => item.input);
}

function videoProjectRefsPromptBlock(refs, prefix = "ref") {
  const normalized = normalizeVideoProjectRefs(refs, prefix);
  if (!normalized.length) return "";
  const lines = normalized.map((ref, i) => {
    const filename = sanitizeVideoProjectRefFilename(ref.filename || ref.label, i, prefix);
    const label = videoProjectRefLabel(ref, i, prefix);
    return `- ${filename}: ${label}`;
  }).join("\n");
  return `\n\nReference images available by filename:\n${lines}\nUse these filenames/labels exactly when following the prompt.`;
}

function formatVideoProjectRefsList(refs, prefix = "ref") {
  const normalized = normalizeVideoProjectRefs(refs, prefix);
  if (!normalized.length) return "_Refs \u043D\u0435\u0442_";
  return normalized.map((ref, i) => {
    const filename = sanitizeVideoProjectRefFilename(ref.filename || ref.label, i, prefix);
    const label = videoProjectRefLabel(ref, i, prefix);
    return `${i + 1}. *${md(label)}* \u2192 \`${md(filename)}\``;
  }).join("\n");
}

function parseVideoProjectRefLabels(text) {
  return String(text || "")
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)
    .map(line => {
      const m = line.match(/^(\d+)\s*[:=\-.]\s*(.+)$/);
      if (m) return { index: parseInt(m[1], 10) - 1, label: m[2].trim() };
      return { index: null, label: line };
    });
}

function applyVideoProjectRefLabels(refs, labels, prefix = "ref") {
  const normalized = normalizeVideoProjectRefs(refs, prefix);
  const sequential = [];
  for (const item of labels) {
    if (Number.isInteger(item.index) && item.index >= 0 && item.index < normalized.length) {
      normalized[item.index].label = sanitizeVideoProjectRefLabel(item.label, `${prefix} ${item.index + 1}`);
      normalized[item.index].filename = sanitizeVideoProjectRefFilename(normalized[item.index].label, item.index, prefix);
    } else {
      sequential.push(item.label);
    }
  }
  for (let i = 0; i < sequential.length && i < normalized.length; i++) {
    normalized[i].label = sanitizeVideoProjectRefLabel(sequential[i], `${prefix} ${i + 1}`);
    normalized[i].filename = sanitizeVideoProjectRefFilename(normalized[i].label, i, prefix);
  }
  return normalized;
}

function getVideoProjectPhotoLabel(msg, fallback) {
  return sanitizeVideoProjectRefLabel(msg.caption || fallback, fallback);
}

function cloneVideoProjectRefs(refs, prefix = "ref") {
  return normalizeVideoProjectRefs(refs, prefix).map((ref, i) => ({
    input: videoProjectRefInput(ref),
    label: videoProjectRefLabel(ref, i, prefix),
    filename: sanitizeVideoProjectRefFilename(ref.filename || ref.label, i, prefix),
    createdAt: Date.now(),
  })).filter(ref => ref.input);
}

function getChatRefPresets(chatId) {
  const key = String(chatId);
  if (!Array.isArray(videoRefPresets[key])) videoRefPresets[key] = [];
  return videoRefPresets[key];
}

function normalizeRefPresetLabels(labels) {
  return (Array.isArray(labels) ? labels : [])
    .map((label, i) => sanitizeVideoProjectRefLabel(label, `ref ${i + 1}`))
    .filter(Boolean)
    .slice(0, VIDEO_PROJECT_MAX_REFS);
}

function parseCustomRefPreset(text) {
  const raw = String(text || "").trim();
  if (!raw) return null;

  let name = "Custom preset";
  let labelsText = raw;
  const firstLine = raw.split(/\r?\n/)[0] || "";
  const colon = firstLine.indexOf(":");

  if (colon > 0) {
    name = firstLine.slice(0, colon).trim();
    labelsText = `${firstLine.slice(colon + 1)}\n${raw.split(/\r?\n/).slice(1).join("\n")}`;
  } else {
    const lines = raw.split(/\r?\n/).map(x => x.trim()).filter(Boolean);
    if (lines.length > 1) {
      name = lines[0];
      labelsText = lines.slice(1).join("\n");
    }
  }

  const labels = labelsText
    .split(/[\n,;]+/)
    .map(x => x.trim())
    .filter(Boolean);

  const cleanLabels = normalizeRefPresetLabels(labels);
  if (!cleanLabels.length) return null;
  return {
    id: shortId("rps"),
    name: cut(sanitizeVideoProjectRefLabel(name, "Custom preset"), 40),
    labels: cleanLabels,
    createdAt: Date.now(),
  };
}

function getVideoProjectPresetById(chatId, type, presetId) {
  if (type === "builtin") return VIDEO_PROJECT_BUILTIN_REF_PRESETS.find(p => p.id === presetId) || null;
  return getChatRefPresets(chatId).find(p => p.id === presetId) || null;
}

function getVideoProjectPresetTarget(chatId) {
  const s = getState(chatId);
  const target = s.vpPresetTarget || {};
  const project = videoProjects[target.projectId];
  if (!project || String(project.chatId) !== String(chatId) || project.status === "deleted") return null;
  normalizeVideoProject(project);
  const prompt = target.promptId ? findVideoProjectPrompt(project, target.promptId) : null;
  if (target.promptId && !prompt) return null;
  return { project, prompt };
}

function applyVideoProjectRefPresetToTarget(chatId, preset) {
  const target = getVideoProjectPresetTarget(chatId);
  if (!target || !preset) return { ok: false, message: "\u274C Target \u0438\u043B\u0438 preset \u043D\u0435 \u043D\u0430\u0439\u0434\u0435\u043D." };
  const { project, prompt } = target;
  const labels = normalizeRefPresetLabels(preset.labels);
  if (!labels.length) return { ok: false, message: "\u274C \u0412 preset \u043D\u0435\u0442 labels." };

  if (prompt) {
    if (!Array.isArray(prompt.refs) || prompt.refs.length === 0) return { ok: false, message: "\u274C \u0423 \u044D\u0442\u043E\u0433\u043E prompt \u043D\u0435\u0442 refs. \u0421\u043D\u0430\u0447\u0430\u043B\u0430 \u0434\u043E\u0431\u0430\u0432\u044C \u0444\u043E\u0442\u043E." };
    prompt.refs = applyVideoProjectRefLabels(prompt.refs, labels.map((label, index) => ({ index, label })), `prompt_${(prompt.index ?? 0) + 1}_ref`);
    prompt.updatedAt = Date.now();
    project.updatedAt = Date.now();
    saveVideoProjects();
    return { ok: true, message: `\u2705 Preset \u043F\u0440\u0438\u043C\u0435\u043D\u0451\u043D \u043A prompt #${(prompt.index ?? 0) + 1}: *${md(preset.name)}*` };
  }

  if (!Array.isArray(project.defaultRefs) || project.defaultRefs.length === 0) return { ok: false, message: "\u274C \u0423 \u043F\u0440\u043E\u0435\u043A\u0442\u0430 \u043D\u0435\u0442 refs. \u0421\u043D\u0430\u0447\u0430\u043B\u0430 \u0434\u043E\u0431\u0430\u0432\u044C Project refs." };
  project.defaultRefs = applyVideoProjectRefLabels(project.defaultRefs, labels.map((label, index) => ({ index, label })), "project_ref");
  project.updatedAt = Date.now();
  saveVideoProjects();
  return { ok: true, message: `\u2705 Preset \u043F\u0440\u0438\u043C\u0435\u043D\u0451\u043D \u043A Project refs: *${md(preset.name)}*` };
}

function cloneRefsToVideoProjectPrompts(project, sourceRefs, mode, sourcePrompt = null) {
  normalizeVideoProject(project);
  const prompts = [...(project.prompts || [])].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
  const cleanSource = normalizeVideoProjectRefs(sourceRefs, "clone_ref").slice(0, getVideoProjectPromptRefLimit(project));
  if (!cleanSource.length) return 0;

  let targets = prompts;
  if (sourcePrompt) targets = targets.filter(p => p.id !== sourcePrompt.id);
  if (mode === "missing") targets = targets.filter(p => !Array.isArray(p.refs) || p.refs.length === 0);
  if (mode === "next10" && sourcePrompt) {
    const start = (sourcePrompt.index ?? 0) + 1;
    targets = targets.filter(p => (p.index ?? 0) >= start).slice(0, 10);
  }

  let changed = 0;
  for (const prompt of targets) {
    prompt.refs = cloneVideoProjectRefs(cleanSource, `prompt_${(prompt.index ?? 0) + 1}_ref`).slice(0, getVideoProjectPromptRefLimit(project));
    prompt.updatedAt = Date.now();
    changed++;
  }
  if (changed) {
    project.updatedAt = Date.now();
    saveVideoProjects();
  }
  return changed;
}

function countVideoProjectPromptRefs(project) {
  return (project.prompts || []).reduce((sum, p) => sum + (Array.isArray(p.refs) ? p.refs.length : 0), 0);
}

function getVideoProjectPromptByNumber(project, num) {
  const idx = Number(num) - 1;
  if (!Number.isInteger(idx) || idx < 0) return null;
  const sorted = [...(project.prompts || [])].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
  return sorted[idx] || null;
}

function addVideoProjectHistory(chatId, entry) {
  const key = String(chatId);
  if (!videoProjectHistory[key]) videoProjectHistory[key] = [];
  videoProjectHistory[key].unshift({ ...entry, ts: Date.now() });
  if (videoProjectHistory[key].length > 100) videoProjectHistory[key] = videoProjectHistory[key].slice(0, 100);
  saveVideoProjectHistory();
}

function videoProjectStatusText(project) {
  normalizeVideoProject(project);
  const total = project.prompts.length;
  const remaining = getRemainingProjectPrompts(project);
  const model = VIDEO_MODELS[project.model];
  const created = new Date(project.createdAt).toLocaleString("ru");
  return (
    `\u{1F4CA} *Project Status*\n\n` +
    `Project: *${md(project.name)}*\n` +
    `Status: *${md(project.status)}*\n` +
    `Model: *${md(model?.label || project.model)}*\n` +
    `Created: *${md(created)}*\n\n` +
    `Completed: *${project.done || 0}*\n` +
    `Failed: *${project.failed || 0}*\n` +
    `Remaining: *${remaining}*\n\n` +
    `Progress: *${getProjectProgress(project)}%*\n\n` +
    `Hourly Limit: *${project.hourlyLimit}/hour*\n` +
    `Project refs stored: *${project.defaultRefs.length}/${VIDEO_PROJECT_MAX_REFS}*\n` +
    `Per-prompt usable refs for model: *${getVideoProjectPromptRefLimit(project)}*\n` +
    `Prompt refs: *${countVideoProjectPromptRefs(project)}*`
  );
}

async function showVideoProjectsMenu(chatId, msgId = null) {
  const text =
    `\u{1F3AC} *Video Projects*\n\n` +
    `\u0421\u0438\u0441\u0442\u0435\u043C\u0430 \u0434\u043B\u044F \u0434\u043E\u043B\u0433\u043E\u0439 \u043F\u0430\u043A\u0435\u0442\u043D\u043E\u0439 \u0433\u0435\u043D\u0435\u0440\u0430\u0446\u0438\u0438 \u0432\u0438\u0434\u0435\u043E \u0441 \u0441\u043E\u0445\u0440\u0430\u043D\u0435\u043D\u0438\u0435\u043C \u0441\u043E\u0441\u0442\u043E\u044F\u043D\u0438\u044F \u043F\u043E\u0441\u043B\u0435 Railway restart.`;
  const kb = { inline_keyboard: [
    [{ text: "\u{1F4C2} New Project", callback_data: "vp_new" }, { text: "\u{1F4CA} My Projects", callback_data: "vp_list" }],
    [{ text: "\u23F8 Pause Project", callback_data: "vp_pause_menu" }, { text: "\u25B6 Resume Project", callback_data: "vp_resume_menu" }],
    [{ text: "\u{1F5D1} Delete Project", callback_data: "vp_delete_menu" }, { text: "\u{1F4DC} History", callback_data: "vp_history" }],
    [{ text: "\u2699 Settings", callback_data: "vp_settings" }],
    [{ text: "\u25C0\uFE0F \u041D\u0430\u0437\u0430\u0434", callback_data: "back_menu" }],
  ]};
  if (msgId) return bot.editMessageText(text, { chat_id: chatId, message_id: msgId, parse_mode: "Markdown", reply_markup: kb }).catch(() => {});
  return bot.sendMessage(chatId, text, { parse_mode: "Markdown", reply_markup: kb });
}

function showVideoProjectModelMenu(chatId, msgId = null) {
  const rows = Object.entries(VIDEO_MODELS).map(([key, model]) => ([{
    text: `${model.label} (${model.credits})`,
    callback_data: `vp_model_${key}`,
  }]));
  rows.push([{ text: "\u274C \u041E\u0442\u043C\u0435\u043D\u0430", callback_data: "open_video_projects" }]);
  const text = "\u{1F3A5} *Video Project model*\n\n\u0412\u044B\u0431\u0435\u0440\u0438 \u043C\u043E\u0434\u0435\u043B\u044C \u0432\u0438\u0434\u0435\u043E. \u0418\u0441\u043F\u043E\u043B\u044C\u0437\u0443\u044E\u0442\u0441\u044F \u0442\u043E\u043B\u044C\u043A\u043E \u043C\u043E\u0434\u0435\u043B\u0438, \u043A\u043E\u0442\u043E\u0440\u044B\u0435 \u0443\u0436\u0435 \u0435\u0441\u0442\u044C \u0432 \u0431\u043E\u0442\u0435.";
  const opts = { parse_mode: "Markdown", reply_markup: { inline_keyboard: rows } };
  if (msgId) return bot.editMessageText(text, { chat_id: chatId, message_id: msgId, ...opts }).catch(() => {});
  return bot.sendMessage(chatId, text, opts);
}

function showVideoProjectLimitMenu(chatId, msgId = null) {
  const s = getState(chatId);
  const selected = s.videoProjectDraft?.hourlyLimit || 15;
  const rows = [VIDEO_PROJECT_LIMITS.map(n => ({
    text: selected === n ? `\u2705 ${n}/hour` : `${n}/hour`,
    callback_data: `vp_limit_${n}`,
  }))];
  rows.push([{ text: "\u25C0\uFE0F \u041D\u0430\u0437\u0430\u0434", callback_data: "vp_back_model" }]);
  const text = "\u23F1 *Hourly Limit*\n\n\u041B\u0438\u043C\u0438\u0442 \u0441\u0447\u0438\u0442\u0430\u0435\u0442\u0441\u044F \u043F\u043E UTC-\u0447\u0430\u0441\u0430\u043C: 14:00 UTC, 15:00 UTC \u0438 \u0442.\u0434.";
  const opts = { parse_mode: "Markdown", reply_markup: { inline_keyboard: rows } };
  if (msgId) return bot.editMessageText(text, { chat_id: chatId, message_id: msgId, ...opts }).catch(() => {});
  return bot.sendMessage(chatId, text, opts);
}

function createVideoProject(chatId, draft) {
  const s = getState(chatId);
  const id = shortId("vp");
  const project = {
    id,
    chatId,
    name: draft.name || `Video Project ${new Date().toLocaleDateString("ru")}`,
    status: "draft",
    model: draft.model,
    hourlyLimit: draft.hourlyLimit,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    startedAt: null,
    completedAt: null,
    nextIndex: 0,
    done: 0,
    failed: 0,
    defaultRefs: [],
    prompts: [],
    hourlyUsage: { hourKey: utcHourKey(), used: 0 },
    ratio: s.ratio || "16:9",
    resolution: s.resolution || "720p",
    grokDuration: s.grokDuration || "6s",
    seed: s.seed || "random",
  };
  videoProjects[id] = project;
  saveVideoProjects();
  return project;
}

function showVideoProjectEditor(chatId, projectId, msgId = null) {
  const project = videoProjects[projectId];
  if (!project || project.status === "deleted") return showVideoProjectsMenu(chatId, msgId);
  normalizeVideoProject(project);
  const model = VIDEO_MODELS[project.model];
  const text =
    `\u{1F4C2} *Video Project*\n\n` +
    `Name: *${md(project.name)}*\n` +
    `Status: *${md(project.status)}*\n` +
    `Model: *${md(model?.label || project.model)}*\n` +
    `Hourly Limit: *${project.hourlyLimit}/hour*\n` +
    `Prompts: *${project.prompts.length}*\n` +
    `Project refs stored: *${project.defaultRefs.length}/${VIDEO_PROJECT_MAX_REFS}*\n` +
    `Refs usable per prompt now: *${getVideoProjectPromptRefLimit(project)}*\n` +
    `Prompt refs: *${countVideoProjectPromptRefs(project)}*\n` +
    `Progress: *${getProjectProgress(project)}%*\n\n` +
    `*Project ref labels:*\n${formatVideoProjectRefsList(project.defaultRefs, "project_ref")}`;
  const kb = { inline_keyboard: [
    [{ text: "\u{1F4C4} Import TXT/DOCX", callback_data: `vp_import_${project.id}` }, { text: "\u270F\uFE0F Paste prompts", callback_data: `vp_paste_${project.id}` }],
    [{ text: "\u{1F5BC} Project refs", callback_data: `vp_refs_${project.id}` }, { text: "\u{1F9F7} Refs per prompt", callback_data: `vp_promptrefs_${project.id}_0` }],
    [{ text: "\u{1F3F7} Project presets", callback_data: `vp_presets_${project.id}` }, { text: "\u{1F9EC} Clone refs", callback_data: `vp_clone_${project.id}` }],
    ...(project.defaultRefs.length ? [[{ text: "\u270F\uFE0F Rename project refs", callback_data: `vp_refs_rename_${project.id}` }]] : []),
    [{ text: "\u{1F4CA} Project Status", callback_data: `vp_status_${project.id}` }],
    ...(project.status === "draft" || project.status === "paused" ? [[{ text: "\u{1F680} Start / Resume", callback_data: `vp_start_${project.id}` }]] : []),
    ...(project.status === "running" ? [[{ text: "\u23F8 Pause", callback_data: `vp_pause_${project.id}` }]] : []),
    [{ text: "\u{1F5D1} Delete", callback_data: `vp_del_${project.id}` }, { text: "\u25C0\uFE0F Back", callback_data: "open_video_projects" }],
  ]};
  if (msgId) return bot.editMessageText(text, { chat_id: chatId, message_id: msgId, parse_mode: "Markdown", reply_markup: kb }).catch(() => {});
  return bot.sendMessage(chatId, text, { parse_mode: "Markdown", reply_markup: kb });
}

function showVideoProjectList(chatId, msgId = null, mode = "details") {
  const projects = getChatVideoProjects(chatId).filter(p => {
    if (mode === "pause") return p.status === "running";
    if (mode === "resume") return p.status === "paused";
    if (mode === "delete") return p.status !== "deleted";
    return true;
  }).slice(0, 20);

  const title = mode === "pause" ? "\u23F8 *Pause Project*" : mode === "resume" ? "\u25B6 *Resume Project*" : mode === "delete" ? "\u{1F5D1} *Delete Project*" : "\u{1F4CA} *My Projects*";
  if (projects.length === 0) {
    const text = `${title}\n\n\u041F\u0440\u043E\u0435\u043A\u0442\u043E\u0432 \u043D\u0435\u0442.`;
    const kb = { inline_keyboard: [[{ text: "\u25C0\uFE0F Back", callback_data: "open_video_projects" }]] };
    if (msgId) return bot.editMessageText(text, { chat_id: chatId, message_id: msgId, parse_mode: "Markdown", reply_markup: kb }).catch(() => {});
    return bot.sendMessage(chatId, text, { parse_mode: "Markdown", reply_markup: kb });
  }

  const rows = projects.map(p => {
    const icon = p.status === "running" ? "\u{1F7E2}" : p.status === "paused" ? "\u23F8" : p.status === "completed" ? "\u2705" : p.status === "draft" ? "\u{1F4C4}" : "\u26AA";
    const action = mode === "pause" ? `vp_pause_${p.id}` : mode === "resume" ? `vp_resume_${p.id}` : mode === "delete" ? `vp_del_${p.id}` : `vp_project_${p.id}`;
    return [{ text: `${icon} ${p.name.slice(0, 26)} | ${getProjectProgress(p)}%`, callback_data: action }];
  });
  rows.push([{ text: "\u25C0\uFE0F Back", callback_data: "open_video_projects" }]);
  const opts = { parse_mode: "Markdown", reply_markup: { inline_keyboard: rows } };
  if (msgId) return bot.editMessageText(title, { chat_id: chatId, message_id: msgId, ...opts }).catch(() => {});
  return bot.sendMessage(chatId, title, opts);
}


function showVideoProjectPromptRefsMenu(chatId, projectId, msgId = null, page = 0) {
  const project = videoProjects[projectId];
  if (!project || String(project.chatId) !== String(chatId) || project.status === "deleted") {
    return showVideoProjectsMenu(chatId, msgId);
  }
  normalizeVideoProject(project);
  const prompts = [...(project.prompts || [])].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
  const PAGE = 8;
  const totalPages = Math.max(1, Math.ceil(prompts.length / PAGE));
  const safePage = Math.min(Math.max(parseInt(page) || 0, 0), totalPages - 1);
  const slice = prompts.slice(safePage * PAGE, safePage * PAGE + PAGE);
  const limit = getVideoProjectPromptRefLimit(project);

  const text =
    `\u{1F9F7} *Refs per prompt*\n\n` +
    `Project: *${md(project.name)}*\n` +
    `Prompts: *${prompts.length}*\n` +
    `Global fallback refs stored: *${project.defaultRefs.length}/${VIDEO_PROJECT_MAX_REFS}*\n` +
    `Refs usable by this model: *${limit}*\n\n` +
    `\u0415\u0441\u043B\u0438 \u0443 prompt \u0435\u0441\u0442\u044C \u0441\u0432\u043E\u0438 refs, \u0431\u043E\u0442 \u0438\u0441\u043F\u043E\u043B\u044C\u0437\u0443\u0435\u0442 \u0438\u0445. \u0415\u0441\u043B\u0438 \u043D\u0435\u0442 \u2014 \u0438\u0441\u043F\u043E\u043B\u044C\u0437\u0443\u0435\u0442 \u043E\u0431\u0449\u0438\u0435 Project refs.`;

  const rows = [];
  if (prompts.length === 0) {
    rows.push([{ text: "\u{1F4C4} Import TXT/DOCX", callback_data: `vp_import_${project.id}` }, { text: "\u270F\uFE0F Paste prompts", callback_data: `vp_paste_${project.id}` }]);
  } else {
    for (const prompt of slice) {
      const n = (prompt.index ?? prompts.indexOf(prompt)) + 1;
      const refCount = Array.isArray(prompt.refs) ? prompt.refs.length : 0;
      const firstRefLabel = refCount ? ` | ${videoProjectRefLabel(prompt.refs[0], 0, `prompt_${n}_ref`).slice(0, 16)}` : "";
      rows.push([{ text: `${n}. \u{1F5BC} ${refCount}/${limit}${firstRefLabel} | ${cut(prompt.prompt, 28)}`, callback_data: `vp_promptref_${project.id}_${prompt.id}` }]);
    }
    const nav = [];
    if (safePage > 0) nav.push({ text: "\u25C0\uFE0F", callback_data: `vp_promptrefs_${project.id}_${safePage - 1}` });
    nav.push({ text: `${safePage + 1}/${totalPages}`, callback_data: "noop" });
    if (safePage < totalPages - 1) nav.push({ text: "\u25B6\uFE0F", callback_data: `vp_promptrefs_${project.id}_${safePage + 1}` });
    rows.push(nav);
  }
  rows.push([{ text: "\u25C0\uFE0F Project", callback_data: `vp_project_${project.id}` }]);

  const opts = { parse_mode: "Markdown", reply_markup: { inline_keyboard: rows } };
  if (msgId) return bot.editMessageText(text, { chat_id: chatId, message_id: msgId, ...opts }).catch(() => {});
  return bot.sendMessage(chatId, text, opts);
}

function showVideoProjectPromptRefEditor(chatId, projectId, promptId, msgId = null) {
  const project = videoProjects[projectId];
  if (!project || String(project.chatId) !== String(chatId) || project.status === "deleted") {
    return showVideoProjectsMenu(chatId, msgId);
  }
  normalizeVideoProject(project);
  const prompt = findVideoProjectPrompt(project, promptId);
  if (!prompt) return showVideoProjectPromptRefsMenu(chatId, projectId, msgId, 0);

  const limit = getVideoProjectPromptRefLimit(project);
  const refs = Array.isArray(prompt.refs) ? prompt.refs : [];
  const promptNo = (prompt.index ?? 0) + 1;
  const text =
    `\u{1F9F7} *Prompt refs*\n\n` +
    `Project: *${md(project.name)}*\n` +
    `Prompt #${promptNo}\n` +
    `Refs: *${refs.length}/${limit}*\n\n` +
    `*Ref labels:*\n${formatVideoProjectRefsList(refs, `prompt_${promptNo}_ref`)}\n\n` +
    `_${md(cut(prompt.prompt, 500))}_\n\n` +
    `\u041F\u0440\u0438 \u0433\u0435\u043D\u0435\u0440\u0430\u0446\u0438\u0438 \u044D\u0442\u043E\u0442 prompt \u0431\u0443\u0434\u0435\u0442 \u0438\u0441\u043F\u043E\u043B\u044C\u0437\u043E\u0432\u0430\u0442\u044C \u0441\u0432\u043E\u0438 refs. \u0415\u0441\u043B\u0438 refs \u043E\u0447\u0438\u0441\u0442\u0438\u0442\u044C, \u0431\u0443\u0434\u0435\u0442 \u0438\u0441\u043F\u043E\u043B\u044C\u0437\u043E\u0432\u0430\u043D fallback \u043F\u0440\u043E\u0435\u043A\u0442\u0430: ${project.defaultRefs.length}/${VIDEO_PROJECT_MAX_REFS}. \u0412 prompt \u043C\u043E\u0436\u043D\u043E \u043F\u0438\u0441\u0430\u0442\u044C \u0438\u043C\u0435\u043D\u0430 refs: \u043D\u0430\u043F\u0440\u0438\u043C\u0435\u0440 \`${refs[0]?.filename || "character.jpg"}\`.`;

  const kb = { inline_keyboard: [
    [{ text: "\u2795 Add refs to this prompt", callback_data: `vp_promptref_add_${project.id}_${prompt.id}` }],
    [{ text: "\u{1F3F7} Apply preset", callback_data: `vp_presets_${project.id}_${prompt.id}` }, { text: "\u{1F9EC} Clone refs", callback_data: `vp_pclone_${project.id}_${prompt.id}` }],
    ...(refs.length ? [[{ text: "\u270F\uFE0F Rename prompt refs", callback_data: `vp_promptref_rename_${project.id}_${prompt.id}` }]] : []),
    ...(refs.length ? [[{ text: "\u{1F9F9} Clear prompt refs", callback_data: `vp_promptref_clear_${project.id}_${prompt.id}` }]] : []),
    [{ text: "\u25C0\uFE0F Refs per prompt", callback_data: `vp_promptrefs_${project.id}_${Math.floor((prompt.index || 0) / 8)}` }],
  ]};

  if (msgId) return bot.editMessageText(text, { chat_id: chatId, message_id: msgId, parse_mode: "Markdown", reply_markup: kb }).catch(() => {});
  return bot.sendMessage(chatId, text, { parse_mode: "Markdown", reply_markup: kb });
}


function showVideoProjectCloneRefsMenu(chatId, projectId, promptId = null, msgId = null) {
  const project = videoProjects[projectId];
  if (!project || String(project.chatId) !== String(chatId) || project.status === "deleted") return showVideoProjectsMenu(chatId, msgId);
  normalizeVideoProject(project);
  const prompt = promptId ? findVideoProjectPrompt(project, promptId) : null;
  if (promptId && !prompt) return showVideoProjectPromptRefsMenu(chatId, projectId, msgId, 0);

  const sourceRefs = prompt ? (prompt.refs || []) : (project.defaultRefs || []);
  const promptNo = prompt ? (prompt.index ?? 0) + 1 : null;
  const text = prompt
    ? `\u{1F9EC} *Clone prompt refs*\n\nProject: *${md(project.name)}*\nSource: *Prompt #${promptNo}*\nRefs: *${sourceRefs.length}/${getVideoProjectPromptRefLimit(project)}*\n\n\u041A\u043B\u043E\u043D\u0438\u0440\u0443\u0435\u0442 \u044D\u0442\u0438 refs \u0432 \u0434\u0440\u0443\u0433\u0438\u0435 prompts.`
    : `\u{1F9EC} *Clone Project refs*\n\nProject: *${md(project.name)}*\nSource: *Project refs*\nRefs: *${sourceRefs.length}/${VIDEO_PROJECT_MAX_REFS}*\n\n\u041A\u043B\u043E\u043D\u0438\u0440\u0443\u0435\u0442 Project refs \u0432 prompts.`;

  const rows = [];
  if (prompt) {
    rows.push([{ text: "\u27A1\uFE0F To prompts without refs", callback_data: `vp_clone_pr_missing_${project.id}_${prompt.id}` }]);
    rows.push([{ text: "\u{1F51F} To next 10 prompts", callback_data: `vp_clone_pr_next10_${project.id}_${prompt.id}` }]);
    rows.push([{ text: "\u267B\uFE0F To all other prompts", callback_data: `vp_clone_pr_all_${project.id}_${prompt.id}` }]);
    rows.push([{ text: "\u25C0\uFE0F Prompt refs", callback_data: `vp_promptref_${project.id}_${prompt.id}` }]);
  } else {
    rows.push([{ text: "\u27A1\uFE0F To prompts without refs", callback_data: `vp_clone_proj_missing_${project.id}` }]);
    rows.push([{ text: "\u267B\uFE0F To all prompts", callback_data: `vp_clone_proj_all_${project.id}` }]);
    rows.push([{ text: "\u25C0\uFE0F Project", callback_data: `vp_project_${project.id}` }]);
  }

  const opts = { parse_mode: "Markdown", reply_markup: { inline_keyboard: rows } };
  if (msgId) return bot.editMessageText(text, { chat_id: chatId, message_id: msgId, ...opts }).catch(() => {});
  return bot.sendMessage(chatId, text, opts);
}

function showVideoProjectRefPresetMenu(chatId, projectId, promptId = null, msgId = null) {
  const project = videoProjects[projectId];
  if (!project || String(project.chatId) !== String(chatId) || project.status === "deleted") return showVideoProjectsMenu(chatId, msgId);
  normalizeVideoProject(project);
  const prompt = promptId ? findVideoProjectPrompt(project, promptId) : null;
  if (promptId && !prompt) return showVideoProjectPromptRefsMenu(chatId, projectId, msgId, 0);

  const s = getState(chatId);
  s.vpPresetTarget = { projectId, promptId: prompt ? prompt.id : null };

  const custom = getChatRefPresets(chatId);
  const targetName = prompt ? `Prompt #${(prompt.index ?? 0) + 1}` : "Project refs";
  const targetRefs = prompt ? (prompt.refs || []) : (project.defaultRefs || []);
  const text =
    `\u{1F3F7} *Ref presets*\n\n` +
    `Target: *${md(targetName)}*\n` +
    `Refs \u0441\u0435\u0439\u0447\u0430\u0441: *${targetRefs.length}*\n\n` +
    `Preset \u043F\u0435\u0440\u0435\u0438\u043C\u0435\u043D\u0443\u0435\u0442 refs \u043F\u043E \u043F\u043E\u0440\u044F\u0434\u043A\u0443 \u0438 \u043E\u0431\u043D\u043E\u0432\u0438\u0442 filenames \u0434\u043B\u044F FastGen. \u0424\u043E\u0442\u043E \u043D\u0435 \u0434\u043E\u0431\u0430\u0432\u043B\u044F\u044E\u0442\u0441\u044F \u0430\u0432\u0442\u043E\u043C\u0430\u0442\u0438\u0447\u0435\u0441\u043A\u0438.`;

  const rows = [];
  for (const preset of VIDEO_PROJECT_BUILTIN_REF_PRESETS) {
    rows.push([{ text: `${preset.name} (${preset.labels.slice(0, 3).join(", ")})`, callback_data: `vp_rpreset_builtin_${preset.id}` }]);
  }
  if (custom.length) {
    rows.push([{ text: "\u2014 \u041F\u043E\u043B\u044C\u0437\u043E\u0432\u0430\u0442\u0435\u043B\u044C\u0441\u043A\u0438\u0435 \u2014", callback_data: "noop" }]);
    for (const preset of custom.slice(0, 10)) {
      rows.push([{ text: `\u{1F3F7} ${preset.name} (${preset.labels.slice(0, 3).join(", ")})`, callback_data: `vp_rpreset_custom_${preset.id}` }]);
    }
  }
  rows.push([{ text: "\u2795 Create custom preset", callback_data: "vp_rpreset_new" }, { text: "\u{1F5D1} Manage", callback_data: "vp_rpreset_manage" }]);
  rows.push([{ text: "\u25C0\uFE0F \u041D\u0430\u0437\u0430\u0434", callback_data: prompt ? `vp_promptref_${project.id}_${prompt.id}` : `vp_project_${project.id}` }]);

  const opts = { parse_mode: "Markdown", reply_markup: { inline_keyboard: rows } };
  if (msgId) return bot.editMessageText(text, { chat_id: chatId, message_id: msgId, ...opts }).catch(() => {});
  return bot.sendMessage(chatId, text, opts);
}

function showVideoProjectRefPresetManage(chatId, msgId = null) {
  const custom = getChatRefPresets(chatId);
  const text = custom.length
    ? `\u{1F5D1} *Custom ref presets*\n\n\u0412\u044B\u0431\u0435\u0440\u0438 preset \u0434\u043B\u044F \u0443\u0434\u0430\u043B\u0435\u043D\u0438\u044F.`
    : `\u{1F5D1} *Custom ref presets*\n\n\u041F\u043E\u043B\u044C\u0437\u043E\u0432\u0430\u0442\u0435\u043B\u044C\u0441\u043A\u0438\u0445 presets \u043F\u043E\u043A\u0430 \u043D\u0435\u0442.`;
  const rows = custom.slice(0, 20).map(p => [{ text: `\u{1F5D1} ${p.name} (${p.labels.join(", ")})`, callback_data: `vp_rpreset_del_${p.id}` }]);
  rows.push([{ text: "\u25C0\uFE0F Presets", callback_data: "vp_rpreset_back" }]);
  const opts = { parse_mode: "Markdown", reply_markup: { inline_keyboard: rows } };
  if (msgId) return bot.editMessageText(text, { chat_id: chatId, message_id: msgId, ...opts }).catch(() => {});
  return bot.sendMessage(chatId, text, opts);
}

function showVideoProjectHistory(chatId, msgId = null) {
  const h = (videoProjectHistory[String(chatId)] || []).slice(0, 10);
  if (h.length === 0) {
    const text = "\u{1F4ED} Video Projects history \u043F\u0443\u0441\u0442\u0430\u044F.";
    const kb = { inline_keyboard: [[{ text: "\u25C0\uFE0F Back", callback_data: "open_video_projects" }]] };
    if (msgId) return bot.editMessageText(text, { chat_id: chatId, message_id: msgId, reply_markup: kb }).catch(() => {});
    return bot.sendMessage(chatId, text, { reply_markup: kb });
  }
  const lines = h.map((item, i) => {
    const time = item.ts ? new Date(item.ts).toLocaleString("ru") : "\u2014";
    return `${i + 1}. \u{1F3AC} *${md(item.projectName || "Project")}* \u2014 ${md(time)}\n_${md(cut(item.prompt, 80))}_`;
  }).join("\n\n");
  const text = `\u{1F4DC} *Video Projects History*\n\n${lines}`;
  const kb = { inline_keyboard: [[{ text: "\u25C0\uFE0F Back", callback_data: "open_video_projects" }]] };
  if (msgId) return bot.editMessageText(text, { chat_id: chatId, message_id: msgId, parse_mode: "Markdown", reply_markup: kb }).catch(() => {});
  return bot.sendMessage(chatId, text, { parse_mode: "Markdown", reply_markup: kb });
}

function showVideoProjectSettings(chatId, msgId = null) {
  const s = getState(chatId);
  const text =
    `\u2699 *Video Projects Settings*\n\n` +
    `\u041D\u043E\u0432\u044B\u0435 \u043F\u0440\u043E\u0435\u043A\u0442\u044B \u0431\u0435\u0440\u0443\u0442 \u0442\u0435\u043A\u0443\u0449\u0438\u0435 \u043D\u0430\u0441\u0442\u0440\u043E\u0439\u043A\u0438 \u0431\u043E\u0442\u0430:\n` +
    `\u{1F4D0} Ratio: *${s.ratio}*\n` +
    `\u{1F5A5} Grok resolution: *${s.resolution || "720p"}*\n` +
    `\u23F1 Grok duration: *${s.grokDuration || "6s"}*\n` +
    `\u{1F331} Seed mode: *${s.seed === "fixed" ? "fixed 42" : "random numeric"}*\n\n` +
    `\u041B\u0438\u043C\u0438\u0442 \u0445\u0440\u0430\u043D\u0435\u043D\u0438\u044F refs: *${VIDEO_PROJECT_MAX_REFS}* \u043D\u0430 project fallback \u0438 prompt. \u041F\u0440\u0438 \u0433\u0435\u043D\u0435\u0440\u0430\u0446\u0438\u0438 \u0431\u043E\u0442 \u0430\u0432\u0442\u043E\u043C\u0430\u0442\u0438\u0447\u0435\u0441\u043A\u0438 \u0440\u0435\u0436\u0435\u0442 refs \u0434\u043E \u043B\u0438\u043C\u0438\u0442\u0430 \u0432\u044B\u0431\u0440\u0430\u043D\u043D\u043E\u0439 \u043C\u043E\u0434\u0435\u043B\u0438: Grok \u0434\u043E 7, Veo/Flow \u0434\u043E 3, Flower \u0434\u043E 1. Presets \u043C\u0435\u043D\u044F\u044E\u0442 \u043F\u043E\u0434\u043F\u0438\u0441\u0438 refs, Clone refs \u043A\u043E\u043F\u0438\u0440\u0443\u0435\u0442 refs \u043C\u0435\u0436\u0434\u0443 prompts.`;
  const kb = { inline_keyboard: [
    [{ text: "\u{1F4D0} Change ratio", callback_data: "open_ratio" }],
    ...(VIDEO_MODELS[s.vidModel]?.hasResolution ? [[{ text: "\u{1F5A5} Grok resolution", callback_data: "open_resolution" }]] : []),
    ...(VIDEO_MODELS[s.vidModel]?.hasDuration ? [[{ text: "\u23F1 Grok duration", callback_data: "open_grok_duration" }]] : []),
    [{ text: "\u25C0\uFE0F Back", callback_data: "open_video_projects" }],
  ]};
  if (msgId) return bot.editMessageText(text, { chat_id: chatId, message_id: msgId, parse_mode: "Markdown", reply_markup: kb }).catch(() => {});
  return bot.sendMessage(chatId, text, { parse_mode: "Markdown", reply_markup: kb });
}

async function readTelegramDocumentBuffer(fileId) {
  const f = await bot.getFile(fileId);
  const resp = await axios.get(`https://api.telegram.org/file/bot${TELEGRAM_TOKEN}/${f.file_path}`, { responseType: "arraybuffer" });
  return Buffer.from(resp.data);
}

async function extractVideoProjectPrompts(buffer, filename) {
  const name = String(filename || "").toLowerCase();
  let text = "";
  if (name.endsWith(".txt")) {
    text = buffer.toString("utf-8");
  } else if (name.endsWith(".docx")) {
    if (!mammoth) {
      throw new Error("DOCX import \u043E\u0442\u043A\u043B\u044E\u0447\u0451\u043D: \u043D\u0435 \u0443\u0441\u0442\u0430\u043D\u043E\u0432\u043B\u0435\u043D \u043F\u0430\u043A\u0435\u0442 mammoth. \u0412\u044B\u043F\u043E\u043B\u043D\u0438: npm install mammoth");
    }
    const out = await mammoth.extractRawText({ buffer });
    text = out.value || "";
  } else {
    throw new Error("\u041D\u0443\u0436\u0435\u043D .txt \u0438\u043B\u0438 .docx \u0444\u0430\u0439\u043B");
  }
  return text.split(/\r?\n/).map(p => p.trim()).filter(Boolean);
}


async function extractTextFromDocumentBuffer(buffer, filename) {
  const name = String(filename || "").toLowerCase();
  if (name.endsWith(".txt")) {
    return buffer.toString("utf-8").replace(/^\uFEFF/, "").trim();
  }
  if (name.endsWith(".docx")) {
    if (!mammoth) {
      throw new Error("DOCX import disabled: package mammoth is not installed. Run: npm install mammoth");
    }
    const out = await mammoth.extractRawText({ buffer });
    return String(out.value || "").trim();
  }
  throw new Error("Only .txt and .docx files are supported");
}

async function showLatestVideoProjectStatus(chatId) {
  const projects = getChatVideoProjects(chatId).filter(p => p.status !== "deleted");
  const active = projects.find(p => p.status === "running") || projects[0];
  if (!active) return bot.sendMessage(chatId, "\u{1F4ED} Video Projects \u043F\u043E\u043A\u0430 \u043D\u0435\u0442.");
  return bot.sendMessage(chatId, videoProjectStatusText(active), { parse_mode: "Markdown" });
}

function completeVideoProjectIfFinished(projectId) {
  const project = videoProjects[projectId];
  if (!project || project.status !== "running") return false;
  const prompts = project.prompts || [];
  if (prompts.length === 0) return false;
  const unfinished = prompts.some(p => !["completed", "failed", "cancelled"].includes(p.status));
  if (unfinished) return false;

  project.status = "completed";
  project.completedAt = Date.now();
  project.durationMs = (project.completedAt || Date.now()) - (project.startedAt || project.createdAt || Date.now());
  project.updatedAt = Date.now();
  saveVideoProjects();

  const minutes = Math.max(1, Math.ceil(project.durationMs / 60000));
  bot.sendMessage(project.chatId,
    `\u{1F389} *Project Completed*\n\n` +
    `Project: *${md(project.name)}*\n` +
    `Total: *${project.prompts.length}*\n` +
    `Completed: *${project.done || 0}*\n` +
    `Failed: *${project.failed || 0}*\n` +
    `Duration: *${minutes} \u043C\u0438\u043D*`,
    { parse_mode: "Markdown" }
  ).catch(() => {});
  return true;
}

async function generateVideoProjectPrompt(projectId, promptId) {
  const project = videoProjects[projectId];
  if (!project) return;
  normalizeVideoProject(project);
  const promptItem = findVideoProjectPrompt(project, promptId);
  if (!promptItem) return;

  if (project.status !== "running") {
    if (promptItem.status === "running") promptItem.status = "pending";
    saveVideoProjects();
    return;
  }

  const model = VIDEO_MODELS[project.model];
  if (!model) {
    promptItem.status = "failed";
    promptItem.error = `Unsupported model: ${project.model}`;
    project.failed++;
    saveVideoProjects();
    completeVideoProjectIfFinished(projectId);
    return;
  }

  const rawRefs = (promptItem.refs && promptItem.refs.length ? promptItem.refs : project.defaultRefs || []).slice(0, getVideoProjectPromptRefLimit(project));
  const refPrefix = promptItem.refs && promptItem.refs.length ? `prompt_${(promptItem.index ?? 0) + 1}_ref` : "project_ref";
  const refs = normalizeVideoProjectRefs(rawRefs, refPrefix);
  const apiInputs = videoProjectRefsForApi(refs, refPrefix);
  const operation = apiInputs.length > 0 ? model.opImg : model.opText;
  if (!operation) {
    promptItem.status = "failed";
    promptItem.error = `\u041C\u043E\u0434\u0435\u043B\u044C ${model.label} \u043D\u0435 \u043F\u043E\u0434\u0434\u0435\u0440\u0436\u0438\u0432\u0430\u0435\u0442 \u0432\u044B\u0431\u0440\u0430\u043D\u043D\u044B\u0439 \u0440\u0435\u0436\u0438\u043C \u0441 \u0440\u0435\u0444\u0435\u0440\u0435\u043D\u0441\u0430\u043C\u0438`;
    project.failed++;
    saveVideoProjects();
    await bot.sendMessage(project.chatId, `\u274C Project prompt failed: ${md(promptItem.error)}`, { parse_mode: "Markdown" }).catch(() => {});
    completeVideoProjectIfFinished(projectId);
    return;
  }

  const requestSeed = normalizeSeedValue(promptItem.seed) ?? makeGenerationSeed(project.seed || "random");
  promptItem.seed = requestSeed;
  project.updatedAt = Date.now();
  saveVideoProjects();

  let lastError = null;
  while ((promptItem.retries || 0) < VIDEO_PROJECT_MAX_RETRIES) {
    let genId = null;
    try {
      const body = {
        operation,
        prompt: `${promptItem.prompt}${videoProjectRefsPromptBlock(refs, refPrefix)}`,
        aspect_ratio: project.ratio || "16:9",
        seed: requestSeed,
        ...(apiInputs.length > 0 && { inputs: apiInputs }),
        ...(model.hasResolution && { resolution: project.resolution || "720p" }),
        ...(model.hasDuration && project.grokDuration && { duration_seconds: getGrokDurationSeconds(project.grokDuration) }),
      };

      const created = await v6Create(body);
      genId = created.id;
      if (!genId) throw new Error(`v6Create returned no id: ${JSON.stringify(created).slice(0, 200)}`);
      promptItem.genId = genId;
      promptItem.updatedAt = Date.now();
      saveVideoProjects();

      const pollResult = await v6Poll(genId);
      if (!pollResult.usage || pollResult.usage.refunded !== true) {
        const cost = getVideoGenerationCredits(model, project.resolution || "720p", operation);
        spendBalance("videos", cost);
      }

      const resultItems = [];
      for (const item of pollResult.results || []) {
        const media = resultToMedia(item, "video");
        if (!media) continue;
        resultItems.push({
          type: item.type || "video",
          url: resultDownloadUrl(item),
          hasData: Boolean(item.data),
          download_url: resultDownloadUrl(item),
          seed: extractGenerationSeed(item, pollResult, requestSeed),
        });
      }

      promptItem.status = "completed";
      promptItem.result = { genId, results: resultItems, completedAt: Date.now() };
      promptItem.error = null;
      project.done++;
      project.nextIndex = Math.max(project.nextIndex || 0, (promptItem.index || 0) + 1);
      project.updatedAt = Date.now();
      saveVideoProjects();

      const progress = getProjectProgress(project);
      const caption =
        `\u{1F3AC} *Video Ready*\n\n` +
        `Project: *${md(project.name)}*\n` +
        `Prompt: _${md(cut(promptItem.prompt, 180))}_\n` +
        (refs.length ? `Refs: *${md(refs.map((r, i) => videoProjectRefLabel(r, i, refPrefix)).join(", "))}*\n` : "") +
        `Progress: *${progress}%*`;

      for (const item of pollResult.results || []) {
        const media = resultToMedia(item, "video");
        if (media) await sendV6Media(project.chatId, media, withSeedCaption(caption, item, pollResult, requestSeed));
      }

      addHistory(project.chatId, { model: model.label, prompt: promptItem.prompt, genId, operation, isImage: false, ratio: project.ratio, projectId: project.id, seed: requestSeed });
      addVideoProjectHistory(project.chatId, {
        projectId: project.id,
        projectName: project.name,
        promptId: promptItem.id,
        prompt: promptItem.prompt,
        model: model.label,
        genId,
        seed: requestSeed,
        result: resultItems[0] || null,
      });
      completeVideoProjectIfFinished(projectId);
      return;
    } catch(e) {
      lastError = getFastGenErrorText(e);
      const permanentCreateError = !genId && isPermanentCreateError(e);
      const noRetry = permanentCreateError || (genId ? !canAutoRetryAfterGenerationError(lastError) : isNoRetryErrorMessage(lastError));
      promptItem.retries = noRetry ? VIDEO_PROJECT_MAX_RETRIES : ((promptItem.retries || 0) + 1);
      promptItem.error = stripErrorControlTags(lastError).slice(0, 700);
      promptItem.updatedAt = Date.now();
      saveVideoProjects();
      console.error(`[VideoProject] project=${projectId} prompt=${promptId} retry=${promptItem.retries}/${VIDEO_PROJECT_MAX_RETRIES}: ${promptItem.error}`);
      if (promptItem.retries < VIDEO_PROJECT_MAX_RETRIES) await new Promise(r => setTimeout(r, 5000));
    }
  }

  promptItem.status = "failed";
  promptItem.failedAt = Date.now();
  project.failed++;
  project.updatedAt = Date.now();
  saveVideoProjects();
  await bot.sendMessage(project.chatId,
    `\u274C *Video Project prompt failed*\n\n` +
    `Project: *${md(project.name)}*\n` +
    `Prompt: _${md(cut(promptItem.prompt, 150))}_\n` +
    `Retries: *${promptItem.retries || 0}/${VIDEO_PROJECT_MAX_RETRIES}*\n` +
    `Error: ${md(cut(promptItem.error || lastError || "Unknown error", 250))}`,
    { parse_mode: "Markdown" }
  ).catch(() => {});
  completeVideoProjectIfFinished(projectId);
}

async function processVideoProjects() {
  if (videoProjectsProcessorBusy) return;
  videoProjectsProcessorBusy = true;
  try {
    normalizeAllVideoProjects();
    const hour = utcHourKey();
    let changed = false;

    for (const project of Object.values(videoProjects)) {
      normalizeVideoProject(project);
      if (project.status !== "running") continue;

      if (!project.hourlyUsage || project.hourlyUsage.hourKey !== hour) {
        project.hourlyUsage = { hourKey: hour, used: 0 };
        changed = true;
      }

      completeVideoProjectIfFinished(project.id);
      if (project.status !== "running") continue;

      const used = project.hourlyUsage.used || 0;
      const available = Math.max(0, (project.hourlyLimit || 15) - used);
      if (available <= 0) continue;

      const pending = (project.prompts || [])
        .filter(p => p.status === "pending")
        .sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
        .slice(0, available);

      for (const promptItem of pending) {
        promptItem.status = "running";
        promptItem.startedAt = Date.now();
        promptItem.updatedAt = Date.now();
        project.hourlyUsage.used = (project.hourlyUsage.used || 0) + 1;
        project.updatedAt = Date.now();
        changed = true;
        videoQueue(() => generateVideoProjectPrompt(project.id, promptItem.id)).catch(e => {
          console.error(`[VideoProject] queue task error: ${e.message}`);
        });
      }
    }

    if (changed) saveVideoProjects();
  } finally {
    videoProjectsProcessorBusy = false;
  }
}

async function handleVideoProjectCallback(query, helpers) {
  const chatId = query.message.chat.id;
  const msgId = query.message.message_id;
  const data = query.data;
  const s = getState(chatId);
  const { edit, del, cancelKb } = helpers;

  if (data === "open_video_projects" || data === "vp_menu") {
    s.step = null;
    s.videoProjectDraft = null;
    s.videoProjectSelectedId = null;
    return showVideoProjectsMenu(chatId, msgId);
  }

  if (data === "vp_new") {
    s.videoProjectDraft = { name: null, model: null, hourlyLimit: 15 };
    s.step = "vp_wait_name";
    return edit("\u{1F4C2} *New Video Project*\n\n\u041E\u0442\u043F\u0440\u0430\u0432\u044C \u043D\u0430\u0437\u0432\u0430\u043D\u0438\u0435 \u043F\u0440\u043E\u0435\u043A\u0442\u0430:", cancelKb);
  }

  if (data === "vp_back_model") return showVideoProjectModelMenu(chatId, msgId);

  if (data.startsWith("vp_model_")) {
    const modelKey = data.replace("vp_model_", "");
    if (!VIDEO_MODELS[modelKey]) return bot.sendMessage(chatId, "\u274C \u041C\u043E\u0434\u0435\u043B\u044C \u043D\u0435 \u043D\u0430\u0439\u0434\u0435\u043D\u0430.");
    if (!s.videoProjectDraft) s.videoProjectDraft = { name: `Video Project ${new Date().toLocaleDateString("ru")}` };
    s.videoProjectDraft.model = modelKey;
    return showVideoProjectLimitMenu(chatId, msgId);
  }

  if (data.startsWith("vp_limit_")) {
    const limit = parseInt(data.replace("vp_limit_", ""));
    if (!VIDEO_PROJECT_LIMITS.includes(limit)) return bot.sendMessage(chatId, "\u274C \u041B\u0438\u043C\u0438\u0442 \u0434\u043E\u043B\u0436\u0435\u043D \u0431\u044B\u0442\u044C 5/10/15/20.");
    if (!s.videoProjectDraft?.model) return showVideoProjectModelMenu(chatId, msgId);
    s.videoProjectDraft.hourlyLimit = limit;
    const project = createVideoProject(chatId, s.videoProjectDraft);
    s.videoProjectDraft = null;
    s.videoProjectSelectedId = project.id;
    s.step = null;
    await bot.sendMessage(chatId, `\u2705 Project created: *${md(project.name)}*`, { parse_mode: "Markdown" });
    return showVideoProjectEditor(chatId, project.id, msgId);
  }

  if (data === "vp_list" || data === "vp_my") return showVideoProjectList(chatId, msgId, "details");
  if (data === "vp_pause_menu") return showVideoProjectList(chatId, msgId, "pause");
  if (data === "vp_resume_menu") return showVideoProjectList(chatId, msgId, "resume");
  if (data === "vp_delete_menu") return showVideoProjectList(chatId, msgId, "delete");
  if (data === "vp_history") return showVideoProjectHistory(chatId, msgId);
  if (data === "vp_settings") return showVideoProjectSettings(chatId, msgId);

  if (data.startsWith("vp_presets_")) {
    const rest = data.replace("vp_presets_", "");
    const idx = rest.indexOf("_vpp_");
    if (idx >= 0) return showVideoProjectRefPresetMenu(chatId, rest.slice(0, idx), rest.slice(idx + 1), msgId);
    return showVideoProjectRefPresetMenu(chatId, rest, null, msgId);
  }

  if (data.startsWith("vp_rpreset_builtin_")) {
    const presetId = data.replace("vp_rpreset_builtin_", "");
    const preset = getVideoProjectPresetById(chatId, "builtin", presetId);
    const result = applyVideoProjectRefPresetToTarget(chatId, preset);
    await bot.sendMessage(chatId, result.message, { parse_mode: "Markdown" });
    const target = getVideoProjectPresetTarget(chatId);
    if (target?.prompt) return showVideoProjectPromptRefEditor(chatId, target.project.id, target.prompt.id, msgId);
    if (target?.project) return showVideoProjectEditor(chatId, target.project.id, msgId);
    return showVideoProjectsMenu(chatId, msgId);
  }

  if (data.startsWith("vp_rpreset_custom_")) {
    const presetId = data.replace("vp_rpreset_custom_", "");
    const preset = getVideoProjectPresetById(chatId, "custom", presetId);
    const result = applyVideoProjectRefPresetToTarget(chatId, preset);
    await bot.sendMessage(chatId, result.message, { parse_mode: "Markdown" });
    const target = getVideoProjectPresetTarget(chatId);
    if (target?.prompt) return showVideoProjectPromptRefEditor(chatId, target.project.id, target.prompt.id, msgId);
    if (target?.project) return showVideoProjectEditor(chatId, target.project.id, msgId);
    return showVideoProjectsMenu(chatId, msgId);
  }

  if (data === "vp_rpreset_new") {
    s.step = "vp_wait_custom_ref_preset";
    return edit(
      `\u2795 *Create custom ref preset*\n\n\u0424\u043E\u0440\u043C\u0430\u0442\u044B:\n\n\`My Pack: hero, outfit, location\`\n\n\u0438\u043B\u0438:\n\`My Pack\`\n\`hero\`\n\`outfit\`\n\`location\`\n\n\u041C\u0430\u043A\u0441\u0438\u043C\u0443\u043C ${VIDEO_PROJECT_MAX_REFS} labels.`,
      { inline_keyboard: [[{ text: "\u274C \u041E\u0442\u043C\u0435\u043D\u0430", callback_data: "vp_rpreset_back" }]] }
    );
  }

  if (data === "vp_rpreset_manage") return showVideoProjectRefPresetManage(chatId, msgId);

  if (data.startsWith("vp_rpreset_del_")) {
    const presetId = data.replace("vp_rpreset_del_", "");
    const list = getChatRefPresets(chatId);
    const before = list.length;
    videoRefPresets[String(chatId)] = list.filter(p => p.id !== presetId);
    if (videoRefPresets[String(chatId)].length !== before) saveVideoRefPresets();
    await bot.sendMessage(chatId, "\u{1F5D1} Custom preset \u0443\u0434\u0430\u043B\u0451\u043D.");
    return showVideoProjectRefPresetManage(chatId, msgId);
  }

  if (data === "vp_rpreset_back") {
    const target = getVideoProjectPresetTarget(chatId);
    if (target?.prompt) return showVideoProjectRefPresetMenu(chatId, target.project.id, target.prompt.id, msgId);
    if (target?.project) return showVideoProjectRefPresetMenu(chatId, target.project.id, null, msgId);
    return showVideoProjectsMenu(chatId, msgId);
  }

  if (data.startsWith("vp_clone_proj_missing_")) {
    const projectId = data.replace("vp_clone_proj_missing_", "");
    const project = videoProjects[projectId];
    if (!project || String(project.chatId) !== String(chatId)) return bot.sendMessage(chatId, "\u274C \u041F\u0440\u043E\u0435\u043A\u0442 \u043D\u0435 \u043D\u0430\u0439\u0434\u0435\u043D.");
    const count = cloneRefsToVideoProjectPrompts(project, project.defaultRefs || [], "missing");
    await bot.sendMessage(chatId, `\u{1F9EC} Project refs \u0441\u043A\u043B\u043E\u043D\u0438\u0440\u043E\u0432\u0430\u043D\u044B \u0432 prompts \u0431\u0435\u0437 refs: *${count}*`, { parse_mode: "Markdown" });
    return showVideoProjectEditor(chatId, projectId, msgId);
  }

  if (data.startsWith("vp_clone_proj_all_")) {
    const projectId = data.replace("vp_clone_proj_all_", "");
    const project = videoProjects[projectId];
    if (!project || String(project.chatId) !== String(chatId)) return bot.sendMessage(chatId, "\u274C \u041F\u0440\u043E\u0435\u043A\u0442 \u043D\u0435 \u043D\u0430\u0439\u0434\u0435\u043D.");
    const count = cloneRefsToVideoProjectPrompts(project, project.defaultRefs || [], "all");
    await bot.sendMessage(chatId, `\u{1F9EC} Project refs \u0441\u043A\u043B\u043E\u043D\u0438\u0440\u043E\u0432\u0430\u043D\u044B \u0432\u043E \u0432\u0441\u0435 prompts: *${count}*`, { parse_mode: "Markdown" });
    return showVideoProjectEditor(chatId, projectId, msgId);
  }

  if (data.startsWith("vp_clone_pr_missing_") || data.startsWith("vp_clone_pr_all_") || data.startsWith("vp_clone_pr_next10_")) {
    const mode = data.startsWith("vp_clone_pr_missing_") ? "missing" : data.startsWith("vp_clone_pr_next10_") ? "next10" : "all";
    const rest = data.replace(/^vp_clone_pr_(missing|all|next10)_/, "");
    const idx = rest.indexOf("_vpp_");
    if (idx < 0) return bot.sendMessage(chatId, "\u274C Prompt \u043D\u0435 \u043D\u0430\u0439\u0434\u0435\u043D.");
    const projectId = rest.slice(0, idx);
    const promptId = rest.slice(idx + 1);
    const project = videoProjects[projectId];
    const prompt = project ? findVideoProjectPrompt(project, promptId) : null;
    if (!project || String(project.chatId) !== String(chatId) || !prompt) return bot.sendMessage(chatId, "\u274C Prompt \u043D\u0435 \u043D\u0430\u0439\u0434\u0435\u043D.");
    const count = cloneRefsToVideoProjectPrompts(project, prompt.refs || [], mode, prompt);
    await bot.sendMessage(chatId, `\u{1F9EC} Prompt refs \u0441\u043A\u043B\u043E\u043D\u0438\u0440\u043E\u0432\u0430\u043D\u044B: *${count}*`, { parse_mode: "Markdown" });
    return showVideoProjectPromptRefEditor(chatId, projectId, promptId, msgId);
  }

  if (data.startsWith("vp_clone_")) {
    const projectId = data.replace("vp_clone_", "");
    return showVideoProjectCloneRefsMenu(chatId, projectId, null, msgId);
  }

  if (data.startsWith("vp_pclone_")) {
    const rest = data.replace("vp_pclone_", "");
    const idx = rest.indexOf("_vpp_");
    if (idx < 0) return bot.sendMessage(chatId, "\u274C Prompt \u043D\u0435 \u043D\u0430\u0439\u0434\u0435\u043D.");
    return showVideoProjectCloneRefsMenu(chatId, rest.slice(0, idx), rest.slice(idx + 1), msgId);
  }

  if (data.startsWith("vp_project_")) return showVideoProjectEditor(chatId, data.replace("vp_project_", ""), msgId);
  if (data.startsWith("vp_addrefs_")) return showVideoProjectEditor(chatId, data.replace("vp_addrefs_", ""), msgId);

  if (data.startsWith("vp_status_")) {
    const id = data.replace("vp_status_", "");
    const project = videoProjects[id];
    if (!project || String(project.chatId) !== String(chatId)) return bot.sendMessage(chatId, "\u274C \u041F\u0440\u043E\u0435\u043A\u0442 \u043D\u0435 \u043D\u0430\u0439\u0434\u0435\u043D.");
    return edit(videoProjectStatusText(project), { inline_keyboard: [[{ text: "\u25C0\uFE0F Back", callback_data: `vp_project_${id}` }]] });
  }

  if (data.startsWith("vp_import_")) {
    const id = data.replace("vp_import_", "");
    const project = videoProjects[id];
    if (!project || String(project.chatId) !== String(chatId)) return bot.sendMessage(chatId, "\u274C \u041F\u0440\u043E\u0435\u043A\u0442 \u043D\u0435 \u043D\u0430\u0439\u0434\u0435\u043D.");
    s.step = `vp_wait_file_${id}`;
    return edit("\u{1F4C4} \u041E\u0442\u043F\u0440\u0430\u0432\u044C .txt \u0438\u043B\u0438 .docx \u0444\u0430\u0439\u043B. \u041A\u0430\u0436\u0434\u0430\u044F \u0441\u0442\u0440\u043E\u043A\u0430 = \u043E\u0434\u0438\u043D prompt.", { inline_keyboard: [[{ text: "\u274C \u041E\u0442\u043C\u0435\u043D\u0430", callback_data: `vp_project_${id}` }]] });
  }

  if (data.startsWith("vp_paste_")) {
    const id = data.replace("vp_paste_", "");
    const project = videoProjects[id];
    if (!project || String(project.chatId) !== String(chatId)) return bot.sendMessage(chatId, "\u274C \u041F\u0440\u043E\u0435\u043A\u0442 \u043D\u0435 \u043D\u0430\u0439\u0434\u0435\u043D.");
    s.step = `vp_wait_prompts_${id}`;
    return edit("\u270F\uFE0F \u041E\u0442\u043F\u0440\u0430\u0432\u044C \u043F\u0440\u043E\u043C\u043F\u0442\u044B \u0442\u0435\u043A\u0441\u0442\u043E\u043C. \u041A\u0430\u0436\u0434\u0430\u044F \u0441\u0442\u0440\u043E\u043A\u0430 = \u043E\u0434\u0438\u043D prompt.", { inline_keyboard: [[{ text: "\u274C \u041E\u0442\u043C\u0435\u043D\u0430", callback_data: `vp_project_${id}` }]] });
  }

  if (data.startsWith("vp_refs_rename_")) {
    const id = data.replace("vp_refs_rename_", "");
    const project = videoProjects[id];
    if (!project || String(project.chatId) !== String(chatId)) return bot.sendMessage(chatId, "\u274C \u041F\u0440\u043E\u0435\u043A\u0442 \u043D\u0435 \u043D\u0430\u0439\u0434\u0435\u043D.");
    normalizeVideoProject(project);
    if (!project.defaultRefs.length) return bot.sendMessage(chatId, "\u274C \u0423 \u043F\u0440\u043E\u0435\u043A\u0442\u0430 \u043D\u0435\u0442 refs \u0434\u043B\u044F \u043F\u043E\u0434\u043F\u0438\u0441\u0438.");
    s.step = `vp_wait_project_ref_labels_${id}`;
    return edit(
      `\u270F\uFE0F *Rename project refs*\n\n\u0422\u0435\u043A\u0443\u0449\u0438\u0435 \u043F\u043E\u0434\u043F\u0438\u0441\u0438:\n${formatVideoProjectRefsList(project.defaultRefs, "project_ref")}\n\n\u041E\u0442\u043F\u0440\u0430\u0432\u044C \u043F\u043E\u0434\u043F\u0438\u0441\u0438 \u0441\u0442\u0440\u043E\u043A\u0430\u043C\u0438:\n\`1=main_character\`\n\`2=outfit\`\n\`3=location\``,
      { inline_keyboard: [[{ text: "\u274C \u041E\u0442\u043C\u0435\u043D\u0430", callback_data: `vp_project_${id}` }]] }
    );
  }

  if (data.startsWith("vp_refs_done_")) {
    const id = data.replace("vp_refs_done_", "");
    s.step = null;
    return showVideoProjectEditor(chatId, id, msgId);
  }

  if (data.startsWith("vp_refs_")) {
    const id = data.replace("vp_refs_", "");
    const project = videoProjects[id];
    if (!project || String(project.chatId) !== String(chatId)) return bot.sendMessage(chatId, "\u274C \u041F\u0440\u043E\u0435\u043A\u0442 \u043D\u0435 \u043D\u0430\u0439\u0434\u0435\u043D.");
    s.step = `vp_wait_refs_${id}`;
    return edit(`\u{1F5BC} \u041E\u0442\u043F\u0440\u0430\u0432\u044C \u043E\u0431\u0449\u0438\u0435 reference images \u0434\u043B\u044F \u043F\u0440\u043E\u0435\u043A\u0442\u0430. \u041E\u043D\u0438 \u0431\u0443\u0434\u0443\u0442 fallback \u0434\u043B\u044F prompts \u0431\u0435\u0437 \u0441\u0432\u043E\u0438\u0445 refs.

\u0427\u0442\u043E\u0431\u044B \u043F\u043E\u0434\u043F\u0438\u0441\u0430\u0442\u044C ref \u0441\u0440\u0430\u0437\u0443, \u043E\u0442\u043F\u0440\u0430\u0432\u044C \u0444\u043E\u0442\u043E \u0441 caption, \u043D\u0430\u043F\u0440\u0438\u043C\u0435\u0440: \`main_character\`, \`outfit\`, \`location\`.

\u0423\u0436\u0435 \u0434\u043E\u0431\u0430\u0432\u043B\u0435\u043D\u043E: ${project.defaultRefs.length}/${VIDEO_PROJECT_MAX_REFS}.`, {
      inline_keyboard: [[{ text: "\u2705 \u0413\u043E\u0442\u043E\u0432\u043E", callback_data: `vp_refs_done_${id}` }], [{ text: "\u274C \u041E\u0442\u043C\u0435\u043D\u0430", callback_data: `vp_project_${id}` }]]
    });
  }

  if (data.startsWith("vp_promptrefs_")) {
    const rest = data.replace("vp_promptrefs_", "");
    const lastUnderscore = rest.lastIndexOf("_");
    const id = rest.slice(0, lastUnderscore);
    const page = parseInt(rest.slice(lastUnderscore + 1)) || 0;
    return showVideoProjectPromptRefsMenu(chatId, id, msgId, page);
  }

  if (data.startsWith("vp_promptref_add_")) {
    const rest = data.replace("vp_promptref_add_", "");
    const idx = rest.indexOf("_vpp_");
    if (idx < 0) return bot.sendMessage(chatId, "\u274C Prompt \u043D\u0435 \u043D\u0430\u0439\u0434\u0435\u043D.");
    const projectId = rest.slice(0, idx);
    const promptId = rest.slice(idx + 1);
    const project = videoProjects[projectId];
    const prompt = project ? findVideoProjectPrompt(project, promptId) : null;
    if (!project || String(project.chatId) !== String(chatId) || !prompt) return bot.sendMessage(chatId, "\u274C Prompt \u043D\u0435 \u043D\u0430\u0439\u0434\u0435\u043D.");
    const limit = getVideoProjectPromptRefLimit(project);
    const current = Array.isArray(prompt.refs) ? prompt.refs.length : 0;
    if (current >= limit) return bot.sendMessage(chatId, `\u274C \u0423 \u044D\u0442\u043E\u0433\u043E prompt \u0443\u0436\u0435 \u043C\u0430\u043A\u0441\u0438\u043C\u0443\u043C ${limit} refs.`);
    s.step = `vp_wait_prompt_refs_${projectId}_${promptId}`;
    return edit(`\u{1F9F7} *Add refs to prompt*

\u041E\u0442\u043F\u0440\u0430\u0432\u044C \u0444\u043E\u0442\u043E \u0434\u043B\u044F \u044D\u0442\u043E\u0433\u043E prompt. \u041C\u043E\u0436\u043D\u043E \u0434\u043E\u0431\u0430\u0432\u0438\u0442\u044C \u0435\u0449\u0451 ${limit - current}.

\u0427\u0442\u043E\u0431\u044B \u043F\u043E\u0434\u043F\u0438\u0441\u0430\u0442\u044C ref \u0441\u0440\u0430\u0437\u0443, \u043E\u0442\u043F\u0440\u0430\u0432\u044C \u0444\u043E\u0442\u043E \u0441 caption, \u043D\u0430\u043F\u0440\u0438\u043C\u0435\u0440: \`hero\`, \`outfit\`, \`location\`.

\u041A\u043E\u0433\u0434\u0430 \u0437\u0430\u043A\u043E\u043D\u0447\u0438\u0448\u044C \u2014 \u043D\u0430\u0436\u043C\u0438 \u00AB\u0413\u043E\u0442\u043E\u0432\u043E\u00BB.`, {
      inline_keyboard: [[{ text: "\u2705 \u0413\u043E\u0442\u043E\u0432\u043E", callback_data: `vp_promptref_${projectId}_${promptId}` }], [{ text: "\u274C \u041E\u0442\u043C\u0435\u043D\u0430", callback_data: `vp_promptref_${projectId}_${promptId}` }]]
    });
  }

  if (data.startsWith("vp_promptref_rename_")) {
    const rest = data.replace("vp_promptref_rename_", "");
    const idx = rest.indexOf("_vpp_");
    if (idx < 0) return bot.sendMessage(chatId, "\u274C Prompt \u043D\u0435 \u043D\u0430\u0439\u0434\u0435\u043D.");
    const projectId = rest.slice(0, idx);
    const promptId = rest.slice(idx + 1);
    const project = videoProjects[projectId];
    const prompt = project ? findVideoProjectPrompt(project, promptId) : null;
    if (!project || String(project.chatId) !== String(chatId) || !prompt) return bot.sendMessage(chatId, "\u274C Prompt \u043D\u0435 \u043D\u0430\u0439\u0434\u0435\u043D.");
    normalizeVideoProject(project);
    if (!prompt.refs.length) return bot.sendMessage(chatId, "\u274C \u0423 prompt \u043D\u0435\u0442 refs \u0434\u043B\u044F \u043F\u043E\u0434\u043F\u0438\u0441\u0438.");
    s.step = `vp_wait_prompt_ref_labels_${projectId}_${promptId}`;
    const promptNo = (prompt.index ?? 0) + 1;
    return edit(
      `\u270F\uFE0F *Rename prompt refs*\n\n\u0422\u0435\u043A\u0443\u0449\u0438\u0435 \u043F\u043E\u0434\u043F\u0438\u0441\u0438:\n${formatVideoProjectRefsList(prompt.refs, `prompt_${promptNo}_ref`)}\n\n\u041E\u0442\u043F\u0440\u0430\u0432\u044C \u043F\u043E\u0434\u043F\u0438\u0441\u0438 \u0441\u0442\u0440\u043E\u043A\u0430\u043C\u0438:\n\`1=hero\`\n\`2=outfit\`\n\`3=background\``,
      { inline_keyboard: [[{ text: "\u274C \u041E\u0442\u043C\u0435\u043D\u0430", callback_data: `vp_promptref_${projectId}_${promptId}` }]] }
    );
  }

  if (data.startsWith("vp_promptref_clear_")) {
    const rest = data.replace("vp_promptref_clear_", "");
    const idx = rest.indexOf("_vpp_");
    if (idx < 0) return bot.sendMessage(chatId, "\u274C Prompt \u043D\u0435 \u043D\u0430\u0439\u0434\u0435\u043D.");
    const projectId = rest.slice(0, idx);
    const promptId = rest.slice(idx + 1);
    const project = videoProjects[projectId];
    const prompt = project ? findVideoProjectPrompt(project, promptId) : null;
    if (!project || String(project.chatId) !== String(chatId) || !prompt) return bot.sendMessage(chatId, "\u274C Prompt \u043D\u0435 \u043D\u0430\u0439\u0434\u0435\u043D.");
    prompt.refs = [];
    prompt.updatedAt = Date.now();
    project.updatedAt = Date.now();
    saveVideoProjects();
    await bot.sendMessage(chatId, "\u{1F9F9} Refs \u044D\u0442\u043E\u0433\u043E prompt \u043E\u0447\u0438\u0449\u0435\u043D\u044B.");
    return showVideoProjectPromptRefEditor(chatId, projectId, promptId, msgId);
  }

  if (data.startsWith("vp_promptref_")) {
    const rest = data.replace("vp_promptref_", "");
    const idx = rest.indexOf("_vpp_");
    if (idx < 0) return bot.sendMessage(chatId, "\u274C Prompt \u043D\u0435 \u043D\u0430\u0439\u0434\u0435\u043D.");
    const projectId = rest.slice(0, idx);
    const promptId = rest.slice(idx + 1);
    s.step = null;
    return showVideoProjectPromptRefEditor(chatId, projectId, promptId, msgId);
  }

  if (data.startsWith("vp_start_")) {
    const id = data.replace("vp_start_", "");
    const project = videoProjects[id];
    if (!project || String(project.chatId) !== String(chatId)) return bot.sendMessage(chatId, "\u274C \u041F\u0440\u043E\u0435\u043A\u0442 \u043D\u0435 \u043D\u0430\u0439\u0434\u0435\u043D.");
    normalizeVideoProject(project);
    if (project.prompts.length === 0) return bot.sendMessage(chatId, "\u274C \u0421\u043D\u0430\u0447\u0430\u043B\u0430 \u0434\u043E\u0431\u0430\u0432\u044C prompts \u0447\u0435\u0440\u0435\u0437 TXT/DOCX \u0438\u043B\u0438 \u0442\u0435\u043A\u0441\u0442\u043E\u043C.");
    project.status = "running";
    project.startedAt = project.startedAt || Date.now();
    project.updatedAt = Date.now();
    saveVideoProjects();
    await bot.sendMessage(chatId, `\u{1F680} Project started: *${md(project.name)}*\nProcessor \u0437\u0430\u043F\u0443\u0441\u043A\u0430\u0435\u0442\u0441\u044F \u043A\u0430\u0436\u0434\u0443\u044E \u043C\u0438\u043D\u0443\u0442\u0443.`, { parse_mode: "Markdown" });
    processVideoProjects().catch(e => console.error(`[VideoProject] manual process error: ${e.message}`));
    return showVideoProjectEditor(chatId, id, msgId);
  }

  if (data.startsWith("vp_pause_")) {
    const id = data.replace("vp_pause_", "");
    const project = videoProjects[id];
    if (!project || String(project.chatId) !== String(chatId)) return bot.sendMessage(chatId, "\u274C \u041F\u0440\u043E\u0435\u043A\u0442 \u043D\u0435 \u043D\u0430\u0439\u0434\u0435\u043D.");
    project.status = "paused";
    for (const prompt of project.prompts || []) if (prompt.status === "running") prompt.status = "pending";
    project.updatedAt = Date.now();
    saveVideoProjects();
    await bot.sendMessage(chatId, `\u23F8 Project paused: *${md(project.name)}*`, { parse_mode: "Markdown" });
    return showVideoProjectEditor(chatId, id, msgId);
  }

  if (data.startsWith("vp_resume_")) {
    const id = data.replace("vp_resume_", "");
    const project = videoProjects[id];
    if (!project || String(project.chatId) !== String(chatId)) return bot.sendMessage(chatId, "\u274C \u041F\u0440\u043E\u0435\u043A\u0442 \u043D\u0435 \u043D\u0430\u0439\u0434\u0435\u043D.");
    project.status = "running";
    project.startedAt = project.startedAt || Date.now();
    project.updatedAt = Date.now();
    saveVideoProjects();
    processVideoProjects().catch(e => console.error(`[VideoProject] resume process error: ${e.message}`));
    await bot.sendMessage(chatId, `\u25B6 Project resumed: *${md(project.name)}*`, { parse_mode: "Markdown" });
    return showVideoProjectEditor(chatId, id, msgId);
  }

  if (data.startsWith("vp_delete_")) {
    data = "vp_del_" + data.replace("vp_delete_", "");
  }
  if (data.startsWith("vp_del_")) {
    const id = data.replace("vp_del_", "");
    const project = videoProjects[id];
    if (!project || String(project.chatId) !== String(chatId)) return bot.sendMessage(chatId, "\u274C \u041F\u0440\u043E\u0435\u043A\u0442 \u043D\u0435 \u043D\u0430\u0439\u0434\u0435\u043D.");
    project.status = "deleted";
    project.deletedAt = Date.now();
    project.updatedAt = Date.now();
    saveVideoProjects();
    await bot.sendMessage(chatId, `\u{1F5D1} Project deleted: *${md(project.name)}*`, { parse_mode: "Markdown" });
    return showVideoProjectsMenu(chatId, msgId);
  }

  console.warn(`[callback] unsupported video project callback: ${data}`);
  return showVideoProjectsMenu(chatId, msgId);
}

// \u2500\u2500\u2500 \u0411\u0430\u043B\u0430\u043D\u0441 UI \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
async function showBalance(chatId, msgId = null) {
  const s = getState(chatId);
  const text = await formatBalance();
  const kb = { inline_keyboard: [
    [{ text: "\u{1F504} \u041E\u0431\u043D\u043E\u0432\u0438\u0442\u044C", callback_data: "refresh_balance" }],
    [{ text: "\u{1F534} \u041E\u0442\u043C\u0435\u043D\u0438\u0442\u044C \u0432\u0441\u0435 \u0437\u0430\u0434\u0430\u0447\u0438", callback_data: "cancel_all_ops" }],
    [{ text: "\u25C0\uFE0F \u041D\u0430\u0437\u0430\u0434", callback_data: "close_balance" }],
  ]};
  const targetId = msgId || s.menuMsgId;
  if (targetId) {
    const ok = await bot.editMessageText(text, { chat_id: chatId, message_id: targetId, parse_mode: "Markdown", reply_markup: kb }).catch(() => null);
    if (ok) return;
  }
  if (s.menuMsgId) await bot.deleteMessage(chatId, s.menuMsgId).catch(() => {});
  const m = await bot.sendMessage(chatId, text, { parse_mode: "Markdown", reply_markup: kb });
  s.menuMsgId = m.message_id;
}

// \u2500\u2500\u2500 \u0418\u0441\u0442\u043E\u0440\u0438\u044F UI \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
function showHistoryMenu(chatId, msgId = null, page = 0) {
  const h = getHistory(chatId);
  if (h.length === 0) {
    const text = "\u{1F4ED} \u0418\u0441\u0442\u043E\u0440\u0438\u044F \u043F\u0443\u0441\u0442\u0430.";
    const kb = { inline_keyboard: [[{ text: "\u25C0\uFE0F \u041D\u0430\u0437\u0430\u0434", callback_data: "open_misc" }]] };
    if (msgId) bot.editMessageText(text, { chat_id: chatId, message_id: msgId, reply_markup: kb }).catch(() => {});
    else bot.sendMessage(chatId, text, { reply_markup: kb });
    return;
  }
  const PAGE = 8;
  const totalPages = Math.ceil(h.length / PAGE);
  const slice = h.slice(page * PAGE, page * PAGE + PAGE);
  const rows = slice.map((item, i) => {
    const idx = page * PAGE + i;
    const icon = item.isImage ? "\u{1F5BC}" : "\u{1F3AC}";
    const time = item.ts ? new Date(item.ts).toLocaleTimeString("ru", { hour: "2-digit", minute: "2-digit" }) : "";
    return [{ text: `${icon} ${time} | ${item.model.slice(0, 14)} | ${item.prompt.slice(0, 18)}`, callback_data: `hist_${idx}` }];
  });
  const nav = [];
  if (page > 0) nav.push({ text: "\u25C0\uFE0F", callback_data: `hist_page_${page - 1}` });
  nav.push({ text: `${page + 1}/${totalPages}`, callback_data: "noop" });
  if (page < totalPages - 1) nav.push({ text: "\u25B6\uFE0F", callback_data: `hist_page_${page + 1}` });
  rows.push(nav);
  rows.push([{ text: "\u{1F5D1} \u041E\u0447\u0438\u0441\u0442\u0438\u0442\u044C", callback_data: "hist_clear" }, { text: "\u25C0\uFE0F \u041D\u0430\u0437\u0430\u0434", callback_data: "open_misc" }]);
  const text = `\u{1F4CB} *\u0418\u0441\u0442\u043E\u0440\u0438\u044F* (${h.length}):`;
  const opts = { parse_mode: "Markdown", reply_markup: { inline_keyboard: rows } };
  if (msgId) bot.editMessageText(text, { chat_id: chatId, message_id: msgId, ...opts }).catch(() => {});
  else bot.sendMessage(chatId, text, opts);
}

// \u2500\u2500\u2500 \u0413\u043B\u0430\u0432\u043D\u043E\u0435 \u043C\u0435\u043D\u044E \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
async function showMainMenu(chatId) {
  const s = getState(chatId);
  const im = IMAGE_MODELS[s.imgModel];
  const vm = VIDEO_MODELS[s.vidModel];
  const enhLabel = { always: "\u2728 \u0412\u0441\u0435\u0433\u0434\u0430", never: "\u23ED \u041D\u0438\u043A\u043E\u0433\u0434\u0430", ask: "\u2753 \u0421\u043F\u0440\u0430\u0448\u0438\u0432\u0430\u0442\u044C" }[s.enhanceMode];
  const grokDurLabel = s.vidModel === "grok_vid" ? ` | \u23F1 ${s.grokDuration || "6s"}` : "";
  const text =
    `\u{1F916} *FastGen Bot v6*\n\n` +
    `\u{1F5BC} \u0424\u043E\u0442\u043E: *${im.label}* \u2014 ${im.credits}\n` +
    `\u{1F3AC} \u0412\u0438\u0434\u0435\u043E: *${vm.label}* \u2014 ${vm.credits}\n` +
    `\u{1F4D0} ${s.ratio} | \u{1F522} ${s.count} \u0448\u0442. | \u{1F331} ${s.seed === "fixed" ? "\u0424\u0438\u043A\u0441. seed" : "\u0421\u043B\u0443\u0447. seed"}${grokDurLabel}\n` +
    `\u2728 \u041F\u0440\u043E\u043C\u043F\u0442: *${enhLabel}*`;
  const kb = { inline_keyboard: [
    [{ text: "\u{1F5BC} \u0418\u0437\u043E\u0431\u0440\u0430\u0436\u0435\u043D\u0438\u0435", callback_data: "do_image" }, { text: "\u{1F5BC}\u{1F4F8} \u0418\u0437 \u0440\u0435\u0444\u0435\u0440\u0435\u043D\u0441\u043E\u0432", callback_data: "do_image_ref" }],
    [{ text: "\u{1F3AC} \u0412\u0438\u0434\u0435\u043E \u0438\u0437 \u0442\u0435\u043A\u0441\u0442\u0430", callback_data: "do_vtext" }, { text: "\u{1F4F8} \u0412\u0438\u0434\u0435\u043E \u0438\u0437 \u0444\u043E\u0442\u043E", callback_data: "do_vimage" }],
    [{ text: "\u{1F4E6} \u041F\u0430\u043A\u0435\u0442\u043D\u044B\u0439 \u0440\u0435\u0436\u0438\u043C", callback_data: "do_batch" }],
    [{ text: "\u{1F39E} \u0422\u0435\u043A\u0441\u0442 \u2192 \u0444\u043E\u0442\u043E \u2192 \u0432\u0438\u0434\u0435\u043E", callback_data: "story2video" }],
    [{ text: "\u{1F3AC} Video Projects", callback_data: "open_video_projects" }],
    [{ text: "\u{1F3A8} \u041C\u043E\u0434\u0435\u043B\u044C \u0444\u043E\u0442\u043E", callback_data: "open_imgmodel" }, { text: "\u{1F3A5} \u041C\u043E\u0434\u0435\u043B\u044C \u0432\u0438\u0434\u0435\u043E", callback_data: "open_vidmodel" }],
    [{ text: "\u{1F4D0} \u0421\u043E\u043E\u0442\u043D\u043E\u0448\u0435\u043D\u0438\u0435", callback_data: "open_ratio" }, { text: "\u{1F522} \u041A\u043E\u043B\u0438\u0447\u0435\u0441\u0442\u0432\u043E", callback_data: "open_count" }],
    [{ text: "\u{1F4CA} \u0411\u0430\u043B\u0430\u043D\u0441", callback_data: "show_balance" }, { text: "\u2699\uFE0F \u041F\u0440\u043E\u0447\u0435\u0435", callback_data: "open_misc" }],
  ]};
  if (s.menuMsgId) {
    const ok = await bot.editMessageText(text, { chat_id: chatId, message_id: s.menuMsgId, parse_mode: "Markdown", reply_markup: kb }).catch(() => null);
    if (ok) return;
    await bot.deleteMessage(chatId, s.menuMsgId).catch(() => {});
    s.menuMsgId = null;
  }
  const m = await bot.sendMessage(chatId, text, { parse_mode: "Markdown", reply_markup: kb });
  s.menuMsgId = m.message_id;
}

// \u2500\u2500\u2500 \u041C\u0435\u043D\u044E \u041F\u0440\u043E\u0447\u0435\u0435 \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
function showMiscMenu(chatId, msgId = null) {
  const s = getState(chatId);
  const enhLabel = { always: "\u2728 \u0412\u0441\u0435\u0433\u0434\u0430", never: "\u23ED \u041D\u0438\u043A\u043E\u0433\u0434\u0430", ask: "\u2753 \u0421\u043F\u0440\u0430\u0448\u0438\u0432\u0430\u0442\u044C" }[s.enhanceMode];
  const seedLabel = s.seed === "fixed" ? "\u{1F331} Seed: \u0424\u0438\u043A\u0441." : "\u{1F331} Seed: \u0421\u043B\u0443\u0447.";
  const text = `\u2699\uFE0F *\u041F\u0440\u043E\u0447\u0435\u0435*`;
  const kb = { inline_keyboard: [
    [{ text: "\u{1F39E} \u041A\u043B\u044E\u0447. \u043A\u0430\u0434\u0440\u044B", callback_data: "do_keyframes" }],
    [{ text: seedLabel, callback_data: "open_seed" }],
    ...(VIDEO_MODELS[s.vidModel]?.hasResolution ? [[{ text: `\u{1F5A5} \u0420\u0430\u0437\u0440\u0435\u0448\u0435\u043D\u0438\u0435 Grok: ${s.resolution}`, callback_data: "open_resolution" }]] : []),
    ...(VIDEO_MODELS[s.vidModel]?.hasDuration ? [[{ text: `\u23F1 \u0414\u043B\u0438\u0442\u0435\u043B\u044C\u043D\u043E\u0441\u0442\u044C Grok: ${s.grokDuration || "6s"}`, callback_data: "open_grok_duration" }]] : []),
    [{ text: `\u2728 \u041F\u0440\u043E\u043C\u043F\u0442: ${enhLabel}`, callback_data: "open_enhance" }],
    [{ text: "\u{1F9E0} \u0413\u0435\u043D\u0435\u0440\u0430\u0446\u0438\u044F \u043F\u0440\u043E\u043C\u043F\u0442\u043E\u0432", callback_data: "open_promptgen" }],
    [{ text: "\u{1F4CB} \u0418\u0441\u0442\u043E\u0440\u0438\u044F", callback_data: "show_history" }],
    [{ text: "\u25C0\uFE0F \u041D\u0430\u0437\u0430\u0434", callback_data: "back_menu" }],
  ]};
  if (msgId) bot.editMessageText(text, { chat_id: chatId, message_id: msgId, parse_mode: "Markdown", reply_markup: kb }).catch(() => {});
  else bot.sendMessage(chatId, text, { parse_mode: "Markdown", reply_markup: kb });
}

// \u2500\u2500\u2500 \u041C\u0435\u043D\u044E \u0434\u043B\u0438\u0442\u0435\u043B\u044C\u043D\u043E\u0441\u0442\u0438 Grok \u2500\u2500\u2500\u2500\u2500\u2500
function showGrokDurationMenu(chatId, msgId = null) {
  const s = getState(chatId);
  const cur = s.grokDuration || "6s";
  const text = `\u23F1 *\u0414\u043B\u0438\u0442\u0435\u043B\u044C\u043D\u043E\u0441\u0442\u044C Grok Video*\n\n\u0414\u043E\u0441\u0442\u0443\u043F\u043D\u043E: 6 \u0441\u0435\u043A \u0438 10 \u0441\u0435\u043A.\n\u0421\u0442\u043E\u0438\u043C\u043E\u0441\u0442\u044C \u0437\u0430\u0432\u0438\u0441\u0438\u0442 \u043E\u0442 \u0440\u0430\u0437\u0440\u0435\u0448\u0435\u043D\u0438\u044F: 480p = 1 \u043A\u0440\u0435\u0434, 720p = 3 \u043A\u0440\u0435\u0434.`;
  const kb = { inline_keyboard: [
    [{ text: cur === "6s" ? "\u2705 6 \u0441\u0435\u043A" : "6 \u0441\u0435\u043A", callback_data: "set_grok_dur_6s" },
     { text: cur === "10s" ? "\u2705 10 \u0441\u0435\u043A" : "10 \u0441\u0435\u043A", callback_data: "set_grok_dur_10s" }],
    [{ text: "\u25C0\uFE0F \u041D\u0430\u0437\u0430\u0434", callback_data: "open_misc" }],
  ]};
  if (msgId) bot.editMessageText(text, { chat_id: chatId, message_id: msgId, parse_mode: "Markdown", reply_markup: kb }).catch(() => {});
  else bot.sendMessage(chatId, text, { parse_mode: "Markdown", reply_markup: kb });
}

// \u2500\u2500\u2500 \u041F\u0430\u043A\u0435\u0442\u043D\u044B\u0439 \u0440\u0435\u0436\u0438\u043C \u2014 \u0443\u0442\u0438\u043B\u0438\u0442\u044B \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
function batchEffective(s) {
  const bt = s.batchType || "image";
  const isImage = bt === "image";
  const imgModelKey = s.batchImgModel || s.imgModel;
  const vidModelKey = s.batchVidModel || s.vidModel;
  const model = isImage ? IMAGE_MODELS[imgModelKey] : VIDEO_MODELS[vidModelKey];
  const ratio = s.batchRatio || s.ratio;
  const resolution = s.batchResolution || s.resolution || "720p";
  const grokDuration = s.batchGrokDuration || s.grokDuration || "6s";
  return { bt, isImage, imgModelKey, vidModelKey, model, ratio, resolution, grokDuration };
}

function showBatchSettingsMenu(chatId, msgId = null) {
  const s = getState(chatId);
  const { bt, isImage, imgModelKey, vidModelKey, model, ratio, resolution, grokDuration } = batchEffective(s);
  const isGrok = vidModelKey === "grok_vid";
  const text =
    `\u2699\uFE0F *\u041D\u0430\u0441\u0442\u0440\u043E\u0439\u043A\u0438 \u043F\u0430\u043A\u0435\u0442\u0430*\n\n` +
    `\u041C\u043E\u0434\u0435\u043B\u044C: *${model.label}*\n` +
    `\u0421\u043E\u043E\u0442\u043D\u043E\u0448\u0435\u043D\u0438\u0435: *${ratio}*\n` +
    (!isImage && isGrok ? `\u0420\u0430\u0437\u0440\u0435\u0448\u0435\u043D\u0438\u0435: *${resolution}*\n\u0414\u043B\u0438\u0442\u0435\u043B\u044C\u043D\u043E\u0441\u0442\u044C: *${grokDuration}*\n` : "");

  const modelRows = isImage
    ? Object.entries(IMAGE_MODELS).map(([k, v]) => [{ text: `${imgModelKey === k ? "\u2705 " : ""}${v.label}`, callback_data: `bset_im_${k}` }])
    : Object.entries(VIDEO_MODELS).map(([k, v]) => [{ text: `${vidModelKey === k ? "\u2705 " : ""}${v.label}`, callback_data: `bset_vm_${k}` }]);

  const ratioRows = [RATIOS.map(r => ({ text: `${ratio === r ? "\u2705 " : ""}${r}`, callback_data: `bset_ratio_${r.replace(":", "x")}` }))];
  const resRow = !isImage && isGrok ? [["480p", "720p"].map(r => ({ text: `${resolution === r ? "\u2705 " : ""}${r}`, callback_data: `bset_res_${r}` }))] : [];
  const durRow = !isImage && isGrok ? [["6s", "10s"].map(d => ({ text: `${grokDuration === d ? "\u2705 " : ""}${d === "6s" ? "6\u0441" : "10\u0441"}`, callback_data: `bset_dur_${d}` }))] : [];

  const kb = { inline_keyboard: [
    ...modelRows,
    ...ratioRows,
    ...(resRow.length ? resRow : []),
    ...(durRow.length ? durRow : []),
    [{ text: "\u{1F504} \u0421\u0431\u0440\u043E\u0441\u0438\u0442\u044C (= \u0433\u043B\u0430\u0432\u043D\u043E\u0435 \u043C\u0435\u043D\u044E)", callback_data: "bset_reset" }],
    [{ text: "\u25C0\uFE0F \u041D\u0430\u0437\u0430\u0434", callback_data: "do_batch_menu" }],
  ]};
  if (msgId) bot.editMessageText(text, { chat_id: chatId, message_id: msgId, parse_mode: "Markdown", reply_markup: kb }).catch(() => {});
  else bot.sendMessage(chatId, text, { parse_mode: "Markdown", reply_markup: kb });
}

function showBatchTypeMenu(chatId, msgId = null) {
  const s = getState(chatId);
  const bt = s.batchType || "image";
  const im = IMAGE_MODELS[s.imgModel];
  const vm = VIDEO_MODELS[s.vidModel];
  const typeLabels = {
    "image":       `\u{1F5BC} \u0424\u043E\u0442\u043E \u0438\u0437 \u0442\u0435\u043A\u0441\u0442\u0430 (${im.label})`,
    "video_text":  `\u{1F3AC} \u0412\u0438\u0434\u0435\u043E \u0438\u0437 \u0442\u0435\u043A\u0441\u0442\u0430 (${vm.label})`,
    "video_image": `\u{1F4F8} \u0412\u0438\u0434\u0435\u043E \u0438\u0437 \u0444\u043E\u0442\u043E+\u0442\u0435\u043A\u0441\u0442\u0430 (${vm.label})`,
  };
  const text = `\u{1F4E6} *\u041F\u0430\u043A\u0435\u0442\u043D\u044B\u0439 \u0440\u0435\u0436\u0438\u043C \u2014 \u0442\u0438\u043F*\n\n\u0412\u044B\u0431\u0435\u0440\u0438 \u0447\u0442\u043E \u0433\u0435\u043D\u0435\u0440\u0438\u0440\u043E\u0432\u0430\u0442\u044C:\n\u0422\u0435\u043A\u0443\u0449\u0438\u0439: *${typeLabels[bt]}*`;
  const kb = { inline_keyboard: [
    [{ text: bt === "image"      ? "\u2705 \u{1F5BC} \u0424\u043E\u0442\u043E \u0438\u0437 \u0442\u0435\u043A\u0441\u0442\u0430"       : "\u{1F5BC} \u0424\u043E\u0442\u043E \u0438\u0437 \u0442\u0435\u043A\u0441\u0442\u0430",       callback_data: "batch_type_image" }],
    [{ text: bt === "video_text" ? "\u2705 \u{1F3AC} \u0412\u0438\u0434\u0435\u043E \u0438\u0437 \u0442\u0435\u043A\u0441\u0442\u0430"      : "\u{1F3AC} \u0412\u0438\u0434\u0435\u043E \u0438\u0437 \u0442\u0435\u043A\u0441\u0442\u0430",      callback_data: "batch_type_video_text" }],
    [{ text: bt === "video_image"? "\u2705 \u{1F4F8} \u0412\u0438\u0434\u0435\u043E \u0438\u0437 \u0444\u043E\u0442\u043E+\u0442\u0435\u043A\u0441\u0442\u0430" : "\u{1F4F8} \u0412\u0438\u0434\u0435\u043E \u0438\u0437 \u0444\u043E\u0442\u043E+\u0442\u0435\u043A\u0441\u0442\u0430", callback_data: "batch_type_video_image" }],
    [{ text: "\u25B6\uFE0F \u041F\u0440\u043E\u0434\u043E\u043B\u0436\u0438\u0442\u044C \u2192", callback_data: "do_batch_menu" }],
    [{ text: "\u274C \u041E\u0442\u043C\u0435\u043D\u0430", callback_data: "back_menu" }],
  ]};
  if (msgId) bot.editMessageText(text, { chat_id: chatId, message_id: msgId, parse_mode: "Markdown", reply_markup: kb }).catch(() => {});
  else bot.sendMessage(chatId, text, { parse_mode: "Markdown", reply_markup: kb });
}

function showBatchMenu(chatId, msgId = null) {
  const s = getState(chatId);
  const { bt, isImage, model, ratio, resolution, grokDuration, vidModelKey } = batchEffective(s);
  const isVideoImage = bt === "video_image";
  const isGrokVid = vidModelKey === "grok_vid";
  const MAX = isImage ? 500 : 200;
  const idx = s.batchPromptIdx || 0;
  const prompts = s.batchPrompts;
  const photos = s.batchPhotos;

  let totalTasks = 0;
  if (isVideoImage) totalTasks = photos.length * s.perPrompt + Math.max(0, prompts.length - photos.length) * s.perPrompt;
  else totalTasks = prompts.length * s.perPrompt;

  const typeIcon = isImage ? "\u{1F5BC}" : isVideoImage ? "\u{1F4F8}" : "\u{1F3AC}";

  const text =
    `\u{1F4E6} *\u041F\u0430\u043A\u0435\u0442\u043D\u044B\u0439 \u0440\u0435\u0436\u0438\u043C*\n\n` +
    `${typeIcon} \u0422\u0438\u043F: *${isImage ? "\u0424\u043E\u0442\u043E" : isVideoImage ? "\u0412\u0438\u0434\u0435\u043E \u0438\u0437 \u0444\u043E\u0442\u043E" : "\u0412\u0438\u0434\u0435\u043E \u0438\u0437 \u0442\u0435\u043A\u0441\u0442\u0430"}*\n` +
    `\u{1F916} \u041C\u043E\u0434\u0435\u043B\u044C: *${model.label}*\n` +
    `\u{1F4D0} ${ratio}${!isImage && isGrokVid ? ` | \u{1F5A5} ${resolution} | \u23F1 ${grokDuration}` : ""}\n` +
    `\u{1F4DD} \u041F\u0440\u043E\u043C\u043F\u0442\u043E\u0432: *${prompts.length}/${MAX}*\n` +
    (isVideoImage ? `\u{1F4F8} \u0424\u043E\u0442\u043E: *${photos.length}*\n` : "") +
    `\u{1F522} \u041D\u0430 1 \u043F\u0440\u043E\u043C\u043F\u0442: *${s.perPrompt}*\n` +
    (!isImage ? `\u23F1 \u041B\u0438\u043C\u0438\u0442 \u0432\u0438\u0434\u0435\u043E/\u0447\u0430\u0441: *${s.batchHourlyLimit}*\n` : "") +
    `\u0412\u0441\u0435\u0433\u043E \u0437\u0430\u0434\u0430\u0447: *${totalTasks}*\n\n` +
    (prompts.length > 0 ? `*\u041F\u0440\u043E\u043C\u043F\u0442 ${idx + 1}/${prompts.length}:*\n${prompts[idx]}` : "_\u041F\u0440\u043E\u043C\u043F\u0442\u043E\u0432 \u043D\u0435\u0442_");

  const navRow = prompts.length > 0 ? [
    { text: "\u25C0\uFE0F", callback_data: "bp_prev" },
    { text: `${idx + 1}/${prompts.length}`, callback_data: "noop" },
    { text: "\u25B6\uFE0F", callback_data: "bp_next" },
    { text: "\u{1F5D1} \u0423\u0434\u0430\u043B\u0438\u0442\u044C", callback_data: "bp_delete" },
  ] : [];

  const kb = { inline_keyboard: [
    [{ text: `${typeIcon} \u0421\u043C\u0435\u043D\u0438\u0442\u044C \u0442\u0438\u043F`, callback_data: "batch_change_type" }, { text: "\u2699\uFE0F \u041D\u0430\u0441\u0442\u0440\u043E\u0439\u043A\u0438", callback_data: "batch_settings" }],
    ...(navRow.length ? [navRow] : []),
    [{ text: "\u270F\uFE0F \u0414\u043E\u0431\u0430\u0432\u0438\u0442\u044C \u043F\u0440\u043E\u043C\u043F\u0442\u044B", callback_data: "batch_add_text" }, { text: "\u{1F4C4} \u0418\u0437 .txt \u0444\u0430\u0439\u043B\u0430", callback_data: "batch_from_file" }],
    ...(isVideoImage ? [[{ text: "\u{1F4F8} \u0424\u043E\u0442\u043E", callback_data: "batch_photos_menu" }]] : []),
    [{ text: `\u{1F522} \u041D\u0430 1 \u043F\u0440\u043E\u043C\u043F\u0442: ${s.perPrompt}`, callback_data: "batch_per_prompt" }],
    ...(!isImage ? [[{ text: `\u23F1 \u041B\u0438\u043C\u0438\u0442 \u0432\u0438\u0434\u0435\u043E/\u0447\u0430\u0441: ${s.batchHourlyLimit}`, callback_data: "batch_hourly_limit" }]] : []),
    [{ text: "\u{1F680} \u0413\u0435\u043D\u0435\u0440\u0438\u0440\u043E\u0432\u0430\u0442\u044C!", callback_data: "batch_run" }],
    [{ text: "\u{1F5D1} \u041E\u0447\u0438\u0441\u0442\u0438\u0442\u044C \u0432\u0441\u0451", callback_data: "batch_clear" }, { text: "\u274C \u041E\u0442\u043C\u0435\u043D\u0430", callback_data: "back_menu" }],
  ]};
  if (msgId) bot.editMessageText(text, { chat_id: chatId, message_id: msgId, parse_mode: "Markdown", reply_markup: kb }).catch(() => {});
  else bot.sendMessage(chatId, text, { parse_mode: "Markdown", reply_markup: kb });
}

function showBatchPhotosMenu(chatId, msgId) {
  const s = getState(chatId);
  const photos = s.batchPhotos;
  const text = `\u{1F4F8} *\u0424\u043E\u0442\u043E \u0432 \u043F\u0430\u043A\u0435\u0442\u0435: ${photos.length}*\n\n\u041E\u0442\u043F\u0440\u0430\u0432\u044C \u0444\u043E\u0442\u043E \u0432 \u0447\u0430\u0442 \u0447\u0442\u043E\u0431\u044B \u0434\u043E\u0431\u0430\u0432\u0438\u0442\u044C.`;
  const rows = photos.map((_, i) => [{ text: `\u{1F5D1} \u0423\u0434\u0430\u043B\u0438\u0442\u044C \u0444\u043E\u0442\u043E ${i + 1}`, callback_data: `del_photo_${i}` }]);
  rows.push([{ text: "\u25C0\uFE0F \u041D\u0430\u0437\u0430\u0434", callback_data: "do_batch_menu" }]);
  bot.editMessageText(text, { chat_id: chatId, message_id: msgId, parse_mode: "Markdown", reply_markup: { inline_keyboard: rows } }).catch(() => {});
}

// \u2500\u2500\u2500 Enhance \u043C\u0435\u043D\u044E \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
function showEnhanceMenu(chatId, msgId = null) {
  const s = getState(chatId);
  const mode = s.enhanceMode;
  const text = `\u2728 *\u0423\u043B\u0443\u0447\u0448\u0435\u043D\u0438\u0435 \u043F\u0440\u043E\u043C\u043F\u0442\u0430*\n\nFastGen LLM \u0443\u043B\u0443\u0447\u0448\u0430\u0435\u0442 \u043F\u0440\u043E\u043C\u043F\u0442 \u043F\u0435\u0440\u0435\u0434 \u0433\u0435\u043D\u0435\u0440\u0430\u0446\u0438\u0435\u0439.\n\n*\u0420\u0435\u0436\u0438\u043C:*`;
  const kb = { inline_keyboard: [
    [{ text: mode === "always" ? "\u2705 \u0412\u0441\u0435\u0433\u0434\u0430" : "\u0412\u0441\u0435\u0433\u0434\u0430", callback_data: "enhance_always" }],
    [{ text: mode === "ask"    ? "\u2705 \u0421\u043F\u0440\u0430\u0448\u0438\u0432\u0430\u0442\u044C" : "\u0421\u043F\u0440\u0430\u0448\u0438\u0432\u0430\u0442\u044C", callback_data: "enhance_ask" }],
    [{ text: mode === "never"  ? "\u2705 \u041D\u0438\u043A\u043E\u0433\u0434\u0430" : "\u041D\u0438\u043A\u043E\u0433\u0434\u0430", callback_data: "enhance_never" }],
    [{ text: "\u25C0\uFE0F \u041D\u0430\u0437\u0430\u0434", callback_data: "back_menu" }],
  ]};
  if (msgId) bot.editMessageText(text, { chat_id: chatId, message_id: msgId, parse_mode: "Markdown", reply_markup: kb }).catch(() => {});
  else bot.sendMessage(chatId, text, { parse_mode: "Markdown", reply_markup: kb });
}

// \u2500\u2500\u2500 Prompt gen \u043C\u0435\u043D\u044E \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
function showPromptGenMenu(chatId, msgId = null) {
  const s = getState(chatId);
  const provLabel = { fastgen: "FastGen", openai: "OpenAI", gemini: "Gemini", openrouter: "OpenRouter" }[s.pgProvider] || s.pgProvider;
  const text =
    `\u{1F9E0} *\u0413\u0435\u043D\u0435\u0440\u0430\u0446\u0438\u044F \u043F\u0440\u043E\u043C\u043F\u0442\u043E\u0432*\n\n` +
    `\u0417\u0430\u0433\u0440\u0443\u0437\u0438 \u0442\u0435\u043A\u0441\u0442 \u2192 \u0418\u0418 \u0440\u0430\u0437\u043E\u0431\u044C\u0451\u0442 \u0438 \u0441\u0433\u0435\u043D\u0435\u0440\u0438\u0440\u0443\u0435\u0442 \u043F\u0440\u043E\u043C\u043F\u0442 \u0434\u043B\u044F \u043A\u0430\u0436\u0434\u043E\u0439 \u0447\u0430\u0441\u0442\u0438.\n\n` +
    `\u2702\uFE0F \u0420\u0430\u0437\u0431\u0438\u0432\u043A\u0430: *${s.pgSplitMode === "lines" ? "\u041F\u043E \u0441\u0442\u0440\u043E\u043A\u0430\u043C" : "\u041F\u043E \u043F\u0440\u0435\u0434\u043B\u043E\u0436\u0435\u043D\u0438\u044F\u043C"}*\n` +
    `\u26A1 \u041F\u0430\u0440\u0430\u043B\u043B\u0435\u043B\u044C\u043D\u043E: *${s.pgParallel}*\n` +
    `\u{1F916} LLM: *${provLabel}*\n` +
    (s.pgProvider !== "fastgen" ? `\u{1F511} API \u043A\u043B\u044E\u0447: *${s.pgApiKey ? "\u2705 \u0437\u0430\u0434\u0430\u043D" : "\u274C \u043D\u0435\u0442"}*\n` : "");
  const kb = { inline_keyboard: [
    [{ text: `${s.pgSplitMode === "lines" ? "\u2705 " : ""}\u0421\u0442\u0440\u043E\u043A\u0438`, callback_data: "pg_split_lines" },
     { text: `${s.pgSplitMode === "sentences" ? "\u2705 " : ""}\u041F\u0440\u0435\u0434\u043B\u043E\u0436\u0435\u043D\u0438\u044F`, callback_data: "pg_split_sent" }],
    [{ text: `\u26A1 \u041F\u0430\u0440\u0430\u043B\u043B\u0435\u043B\u044C\u043D\u043E: ${s.pgParallel}`, callback_data: "pg_parallel" }],
    [{ text: "\u270F\uFE0F \u0428\u0430\u0431\u043B\u043E\u043D \u043F\u0440\u043E\u043C\u043F\u0442\u0430", callback_data: "pg_template" }],
    [{ text: "\u{1F916} LLM \u043F\u0440\u043E\u0432\u0430\u0439\u0434\u0435\u0440", callback_data: "pg_provider" }],
    ...(s.pgProvider !== "fastgen" ? [[{ text: "\u{1F511} API \u043A\u043B\u044E\u0447", callback_data: "pg_apikey" }]] : []),
    [{ text: "\u{1F4DD} \u0412\u0432\u0435\u0441\u0442\u0438 \u0442\u0435\u043A\u0441\u0442", callback_data: "pg_input_text" }],
    [{ text: "\u{1F4C4} \u0417\u0430\u0433\u0440\u0443\u0437\u0438\u0442\u044C .txt", callback_data: "pg_input_file" }],
    [{ text: "\u{1F39E} \u0424\u0430\u0439\u043B \u2192 \u0444\u043E\u0442\u043E \u2192 \u0432\u0438\u0434\u0435\u043E", callback_data: "story2video" }],
    [{ text: "\u25C0\uFE0F \u041D\u0430\u0437\u0430\u0434", callback_data: "back_menu" }],
  ]};
  if (msgId) bot.editMessageText(text, { chat_id: chatId, message_id: msgId, parse_mode: "Markdown", reply_markup: kb }).catch(() => {});
  else bot.sendMessage(chatId, text, { parse_mode: "Markdown", reply_markup: kb });
}

// \u2500\u2500\u2500 \u041F\u0435\u0440\u0435\u0433\u0435\u043D\u0435\u0440\u0430\u0446\u0438\u044F \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
function showRegenMenu(chatId, histIdx) {
  const h = getHistory(chatId);
  const item = h[histIdx];
  if (!item) return bot.sendMessage(chatId, "\u274C \u0417\u0430\u043F\u0438\u0441\u044C \u043D\u0435 \u043D\u0430\u0439\u0434\u0435\u043D\u0430");
  const isImage = item.isImage;
  const text =
    `\u{1F504} *\u041F\u0435\u0440\u0435\u0433\u0435\u043D\u0435\u0440\u0438\u0440\u043E\u0432\u0430\u0442\u044C*\n\n` +
    `\u{1F4DD} _${item.prompt.slice(0, 200)}_\n` +
    `\u{1F916} *${item.model}*`;
  const modelRows = isImage
    ? Object.entries(IMAGE_MODELS).map(([k, v]) => [{ text: v.label, callback_data: `regen_run_${histIdx}_im_${k}` }])
    : Object.entries(VIDEO_MODELS).map(([k, v]) => [{ text: v.label, callback_data: `regen_run_${histIdx}_vm_${k}` }]);
  const kb = { inline_keyboard: [
    [{ text: "\u270F\uFE0F \u0418\u0437\u043C\u0435\u043D\u0438\u0442\u044C \u043F\u0440\u043E\u043C\u043F\u0442", callback_data: `regen_edit_${histIdx}` }],
    ...modelRows,
    [{ text: "\u{1F504} \u0422\u0430 \u0436\u0435 \u043C\u043E\u0434\u0435\u043B\u044C", callback_data: `regen_same_${histIdx}` }],
    [{ text: "\u274C \u041E\u0442\u043C\u0435\u043D\u0430", callback_data: "back_menu" }],
  ]};
  bot.sendMessage(chatId, text, { parse_mode: "Markdown", reply_markup: kb });
}


// \u2500\u2500\u2500 Story \u2192 prompts \u2192 images \u2192 videos \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
function normalizeStoryText(text) {
  return String(text || "")
    .replace(/\r/g, "")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function splitStorySentences(text) {
  const clean = normalizeStoryText(text);
  if (!clean) return [];
  const parts = clean.match(/[^.!?\u3002\uff01\uff1f\n]+[.!?\u3002\uff01\uff1f]?|\n+/g) || [clean];
  return parts.map(x => x.trim()).filter(x => x && !/^\n+$/.test(x));
}

function splitStoryIntoScenes(text, totalScenes) {
  const count = Math.max(1, Math.min(200, parseInt(totalScenes) || 10));
  const clean = normalizeStoryText(text);
  if (!clean) return Array.from({ length: count }, () => "");
  const sentences = splitStorySentences(clean);
  if (sentences.length === 0) return Array.from({ length: count }, () => clean);

  const targetChars = Math.max(200, Math.ceil(clean.length / count));
  const chunks = [];
  let buf = "";

  for (const sentence of sentences) {
    if (chunks.length < count - 1 && buf.length > 0 && (buf.length + sentence.length) > targetChars) {
      chunks.push(buf.trim());
      buf = sentence;
    } else {
      buf = buf ? `${buf} ${sentence}` : sentence;
    }
  }
  if (buf.trim()) chunks.push(buf.trim());

  while (chunks.length < count) {
    const idx = chunks.length % Math.max(1, chunks.length);
    chunks.push(chunks[idx] || clean.slice(0, targetChars));
  }

  if (chunks.length > count) {
    const merged = chunks.slice(0, count - 1);
    merged.push(chunks.slice(count - 1).join(" "));
    return merged;
  }
  return chunks.slice(0, count);
}

function extractPromptJson(text) {
  if (!text) return null;
  const cleaned = String(text).trim().replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/```$/i, "").trim();
  try { return JSON.parse(cleaned); } catch {}
  const m = cleaned.match(/\{[\s\S]*\}/);
  if (m) {
    try { return JSON.parse(m[0]); } catch {}
  }
  return null;
}

function fallbackStoryPromptPair({ sourceFragment, sceneIndex, totalScenes, aspectRatio }) {
  const base = cut(sourceFragment, 700);
  return {
    image_prompt: `Cinematic realistic scene ${sceneIndex} of ${totalScenes}, based on this story moment: ${base}. Detailed environment, natural lighting, coherent characters, historical consistency, high detail, sharp focus, ${aspectRatio} composition.`,
    video_prompt: `Animate the provided image only. Slow cinematic motion, subtle camera movement, natural character movement, atmospheric particles, no scene cut, no new characters, preserve the exact setting and composition. Story moment: ${base}`,
    negative_prompt: "modern objects, text, watermark, logo, blurry, low quality, distorted hands, extra limbs, inconsistent character, fantasy elements unless present in story",
  };
}

async function generateStoryPromptPair({ title, sourceFragment, sceneIndex, totalScenes, aspectRatio }) {
  const fallback = fallbackStoryPromptPair({ sourceFragment, sceneIndex, totalScenes, aspectRatio });
  const system = `You generate prompts for an automated text-to-image and image-to-video pipeline.
Return ONLY valid JSON. No markdown. No explanations.
JSON schema:
{
  "image_prompt": "English prompt for one static image frame",
  "video_prompt": "English prompt for animating the image, preserving the same scene",
  "negative_prompt": "English comma-separated things to avoid"
}
Rules:
- Keep visual continuity across all scenes.
- Do not add modern objects unless the story has them.
- image_prompt must describe one frame only.
- video_prompt must animate the existing frame only: motion, camera movement, atmosphere. No cuts, no scene changes.
- Use cinematic realistic style unless the story clearly requires another style.
- Keep each prompt under 1200 characters.`;

  const userPrompt = `${system}\n\nJob title: ${title || "Story file"}\nScene: ${sceneIndex}/${totalScenes}\nAspect ratio: ${aspectRatio}\nStory fragment:\n${sourceFragment}`;
  try {
    const { data } = await axios.post(`${BASE_URL}/api/v6/prompts/generate`, {
      user_prompt: userPrompt,
    }, { headers: v6Headers(), timeout: 30000 });
    const parsed = extractPromptJson(data.generated_text || data.text || data.result || "");
    if (parsed?.image_prompt && parsed?.video_prompt) {
      return {
        image_prompt: String(parsed.image_prompt).trim(),
        video_prompt: String(parsed.video_prompt).trim(),
        negative_prompt: String(parsed.negative_prompt || "").trim() || fallback.negative_prompt,
      };
    }
    console.warn(`[story2video] prompt JSON parse failed for scene ${sceneIndex}. Fallback used.`);
    return fallback;
  } catch(e) {
    console.warn(`[story2video] FastGen prompt generation failed for scene ${sceneIndex}: ${e.message}`);
    return fallback;
  }
}

function titleFromStoryText(text, filename = "Story file") {
  const clean = normalizeStoryText(text);
  const first = clean.split(/[.!?\n]/)[0] || filename || "Story file";
  return cut(first.trim() || filename || "Story file", 60);
}

function fileMediaTypeFromUrl(url, fallback = "image/jpeg") {
  const clean = String(url || "").toLowerCase();
  if (clean.endsWith(".png")) return "image/png";
  if (clean.endsWith(".webp")) return "image/webp";
  if (clean.endsWith(".jpg") || clean.endsWith(".jpeg")) return "image/jpeg";
  return fallback;
}

async function imageResultItemToInputRef(item) {
  if (!item) throw new Error("\u041F\u0443\u0441\u0442\u043E\u0439 \u0440\u0435\u0437\u0443\u043B\u044C\u0442\u0430\u0442 \u0438\u0437\u043E\u0431\u0440\u0430\u0436\u0435\u043D\u0438\u044F");
  if (item.data) {
    const data = String(item.data);
    if (data.startsWith("data:")) return data;
    return `data:image/jpeg;base64,${data}`;
  }
  const url = resultDownloadUrl(item);
  if (url) {
    const resp = await axios.get(url, {
      responseType: "arraybuffer",
      timeout: 5 * 60 * 1000,
      maxContentLength: Infinity,
      maxBodyLength: Infinity,
    });
    const mime = resp.headers?.["content-type"]?.split(";")[0] || fileMediaTypeFromUrl(url);
    return `data:${mime};base64,${Buffer.from(resp.data).toString("base64")}`;
  }
  throw new Error("\u0412 \u0440\u0435\u0437\u0443\u043B\u044C\u0442\u0430\u0442\u0435 \u0438\u0437\u043E\u0431\u0440\u0430\u0436\u0435\u043D\u0438\u044F \u043D\u0435\u0442 data/download_url");
}

async function sendStoryPipelineImage(chatId, imageResult, sceneNo, total, promptPair, model) {
  const caption = `\u{1F5BC} *Story image ${sceneNo}/${total}*\n${md(model.label)}\n\u{1F4DD} _${md(cut(promptPair.image_prompt, 120))}_`;
  for (const item of imageResult.results || []) {
    const media = resultToMedia(item, "image");
    if (media) await sendV6Media(chatId, media, withSeedCaption(caption, item, imageResult.pollResult, imageResult.requestSeed));
  }
}

async function runStoryToVideoPipeline(chatId, storyText, filename = "story.txt") {
  const s = getState(chatId);
  const imageModel = IMAGE_MODELS[s.imgModel];
  const videoModel = VIDEO_MODELS[s.vidModel];
  if (!imageModel) return bot.sendMessage(chatId, "\u274C \u041D\u0435 \u0432\u044B\u0431\u0440\u0430\u043D\u0430 \u043C\u043E\u0434\u0435\u043B\u044C \u0438\u0437\u043E\u0431\u0440\u0430\u0436\u0435\u043D\u0438\u044F.");
  if (!videoModel?.opImg) {
    return bot.sendMessage(chatId, `\u274C \u041C\u043E\u0434\u0435\u043B\u044C *${md(videoModel?.label || s.vidModel)}* \u043D\u0435 \u043F\u043E\u0434\u0434\u0435\u0440\u0436\u0438\u0432\u0430\u0435\u0442 \u0432\u0438\u0434\u0435\u043E \u0438\u0437 \u0438\u0437\u043E\u0431\u0440\u0430\u0436\u0435\u043D\u0438\u044F. \u0412\u044B\u0431\u0435\u0440\u0438 \u0434\u0440\u0443\u0433\u0443\u044E \u0432\u0438\u0434\u0435\u043E-\u043C\u043E\u0434\u0435\u043B\u044C.`, { parse_mode: "Markdown" });
  }

  const clean = normalizeStoryText(storyText);
  if (!clean) return bot.sendMessage(chatId, "\u274C \u0424\u0430\u0439\u043B \u043F\u0443\u0441\u0442\u043E\u0439 \u0438\u043B\u0438 \u0442\u0435\u043A\u0441\u0442 \u043D\u0435 \u043F\u0440\u043E\u0447\u0438\u0442\u0430\u043B\u0441\u044F.");

  const scenesCount = Math.max(1, Math.min(200, parseInt(s.storyScenes) || 10));
  const scenes = splitStoryIntoScenes(clean, scenesCount).filter(Boolean);
  const title = titleFromStoryText(clean, filename);
  const statusMsg = await bot.sendMessage(chatId,
    `\u{1F39E} *\u0422\u0435\u043A\u0441\u0442 \u2192 \u0444\u043E\u0442\u043E \u2192 \u0432\u0438\u0434\u0435\u043E*\n\n` +
    `\u0424\u0430\u0439\u043B: *${md(filename)}*\n` +
    `\u0421\u0446\u0435\u043D: *${scenes.length}*\n` +
    `\u0424\u043E\u0442\u043E: *${md(imageModel.label)}*\n` +
    `\u0412\u0438\u0434\u0435\u043E: *${md(videoModel.label)}*\n` +
    `\u{1F4D0} ${s.ratio}\n\n` +
    `\u23F3 \u042D\u0442\u0430\u043F 1/3: \u0434\u0435\u043B\u0430\u044E \u043F\u0440\u043E\u043C\u043F\u0442\u044B \u0447\u0435\u0440\u0435\u0437 FastGen...`,
    { parse_mode: "Markdown" }
  );

  const updateStatus = (text) => bot.editMessageText(text, {
    chat_id: chatId,
    message_id: statusMsg.message_id,
    parse_mode: "Markdown",
  }).catch(() => {});

  const pairs = [];
  let promptDone = 0;
  let promptErrors = 0;
  const parallel = Math.max(1, Math.min(10, parseInt(s.storyParallel || s.pgParallel) || 3));
  for (let i = 0; i < scenes.length; i += parallel) {
    const chunk = scenes.slice(i, i + parallel);
    const results = await Promise.allSettled(chunk.map((fragment, j) => generateStoryPromptPair({
      title,
      sourceFragment: fragment,
      sceneIndex: i + j + 1,
      totalScenes: scenes.length,
      aspectRatio: s.ratio,
    })));
    for (let j = 0; j < results.length; j++) {
      const r = results[j];
      if (r.status === "fulfilled") pairs[i + j] = r.value;
      else {
        promptErrors++;
        pairs[i + j] = fallbackStoryPromptPair({ sourceFragment: chunk[j], sceneIndex: i + j + 1, totalScenes: scenes.length, aspectRatio: s.ratio });
      }
      promptDone++;
    }
    await updateStatus(`\u{1F39E} *\u0422\u0435\u043A\u0441\u0442 \u2192 \u0444\u043E\u0442\u043E \u2192 \u0432\u0438\u0434\u0435\u043E*\n\n\u042D\u0442\u0430\u043F 1/3: \u043F\u0440\u043E\u043C\u043F\u0442\u044B \u0447\u0435\u0440\u0435\u0437 FastGen\n\u2713${promptDone}/${scenes.length}${promptErrors ? ` \u2717${promptErrors}` : ""}`);
  }

  await updateStatus(`\u{1F39E} *\u0422\u0435\u043A\u0441\u0442 \u2192 \u0444\u043E\u0442\u043E \u2192 \u0432\u0438\u0434\u0435\u043E*\n\n\u042D\u0442\u0430\u043F 2/3: \u0433\u0435\u043D\u0435\u0440\u0438\u0440\u0443\u044E \u0438\u0437\u043E\u0431\u0440\u0430\u0436\u0435\u043D\u0438\u044F\n\u27130/${scenes.length}`);
  const batchS = { ...s, ratio: s.ratio, resolution: s.resolution || "720p", grokDuration: s.grokDuration || "6s" };
  const imageSlots = pairs.map(() => {
    let resolve, reject;
    const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
  });

  let imageDone = 0, imageErrors = 0;
  for (let i = 0; i < pairs.length; i++) {
    const pair = pairs[i];
    imageQueue(() => genOneRaw(chatId, batchS, pair.image_prompt, imageModel.operation, imageModel, true, 0, 0, `${i + 1}/${pairs.length}`))
      .then(r => imageSlots[i].resolve(r))
      .catch(e => imageSlots[i].reject(e));
  }

  const imageRefs = Array(pairs.length).fill(null);
  for (let i = 0; i < imageSlots.length; i++) {
    try {
      const imageResult = await imageSlots[i].promise;
      await sendStoryPipelineImage(chatId, imageResult, i + 1, pairs.length, pairs[i], imageModel);
      const firstImage = (imageResult.results || []).find(hasResultMedia);
      imageRefs[i] = await imageResultItemToInputRef(firstImage);
      imageDone++;
    } catch(e) {
      imageErrors++;
      await bot.sendMessage(chatId, `\u274C \u041E\u0448\u0438\u0431\u043A\u0430 \u0438\u0437\u043E\u0431\u0440\u0430\u0436\u0435\u043D\u0438\u044F ${i + 1}/${pairs.length}: ${cleanErrorMessage(e, 400)}`).catch(() => {});
    }
    await updateStatus(`\u{1F39E} *\u0422\u0435\u043A\u0441\u0442 \u2192 \u0444\u043E\u0442\u043E \u2192 \u0432\u0438\u0434\u0435\u043E*\n\n\u042D\u0442\u0430\u043F 2/3: \u0438\u0437\u043E\u0431\u0440\u0430\u0436\u0435\u043D\u0438\u044F\n\u2713${imageDone}/${pairs.length}${imageErrors ? ` \u2717${imageErrors}` : ""}`);
  }

  const videoTasks = imageRefs
    .map((ref, i) => ref ? { ref, pair: pairs[i], index: i + 1 } : null)
    .filter(Boolean);
  if (!videoTasks.length) {
    await updateStatus(`\u274C *\u0422\u0435\u043A\u0441\u0442 \u2192 \u0444\u043E\u0442\u043E \u2192 \u0432\u0438\u0434\u0435\u043E*\n\n\u041D\u0435 \u0443\u0434\u0430\u043B\u043E\u0441\u044C \u043F\u043E\u043B\u0443\u0447\u0438\u0442\u044C \u043D\u0438 \u043E\u0434\u043D\u043E\u0433\u043E \u0438\u0437\u043E\u0431\u0440\u0430\u0436\u0435\u043D\u0438\u044F \u0434\u043B\u044F \u0432\u0438\u0434\u0435\u043E.`);
    return showMainMenu(chatId);
  }

  await updateStatus(`\u{1F39E} *\u0422\u0435\u043A\u0441\u0442 \u2192 \u0444\u043E\u0442\u043E \u2192 \u0432\u0438\u0434\u0435\u043E*\n\n\u042D\u0442\u0430\u043F 3/3: \u0433\u0435\u043D\u0435\u0440\u0438\u0440\u0443\u044E \u0432\u0438\u0434\u0435\u043E \u0438\u0437 \u0438\u0437\u043E\u0431\u0440\u0430\u0436\u0435\u043D\u0438\u0439\n\u27130/${videoTasks.length}`);
  let videoDone = 0, videoErrors = 0;
  const videoPromises = videoTasks.map(task =>
    videoQueue(() => genOne(chatId, batchS, task.pair.video_prompt, videoModel.opImg, videoModel, false, 0, 0, `${task.index}/${pairs.length}`, task.ref, false))
      .then(() => { videoDone++; })
      .catch(e => {
        videoErrors++;
        bot.sendMessage(chatId, `\u274C \u041E\u0448\u0438\u0431\u043A\u0430 \u0432\u0438\u0434\u0435\u043E ${task.index}/${pairs.length}: ${cleanErrorMessage(e, 400)}`).catch(() => {});
      })
      .finally(() => updateStatus(`\u{1F39E} *\u0422\u0435\u043A\u0441\u0442 \u2192 \u0444\u043E\u0442\u043E \u2192 \u0432\u0438\u0434\u0435\u043E*\n\n\u042D\u0442\u0430\u043F 3/3: \u0432\u0438\u0434\u0435\u043E \u0438\u0437 \u0438\u0437\u043E\u0431\u0440\u0430\u0436\u0435\u043D\u0438\u0439\n\u2713${videoDone}/${videoTasks.length}${videoErrors ? ` \u2717${videoErrors}` : ""}`))
  );
  await Promise.allSettled(videoPromises);

  const finalText = videoErrors || imageErrors || promptErrors
    ? `\u26A0\uFE0F *\u041A\u043E\u043D\u0432\u0435\u0439\u0435\u0440 \u0437\u0430\u0432\u0435\u0440\u0448\u0451\u043D \u0447\u0430\u0441\u0442\u0438\u0447\u043D\u043E*\n\n\u041F\u0440\u043E\u043C\u043F\u0442\u044B: \u2713${promptDone}/${scenes.length}${promptErrors ? ` \u2717${promptErrors}` : ""}\n\u0418\u0437\u043E\u0431\u0440\u0430\u0436\u0435\u043D\u0438\u044F: \u2713${imageDone}/${pairs.length}${imageErrors ? ` \u2717${imageErrors}` : ""}\n\u0412\u0438\u0434\u0435\u043E: \u2713${videoDone}/${videoTasks.length}${videoErrors ? ` \u2717${videoErrors}` : ""}`
    : `\u2705 *\u041A\u043E\u043D\u0432\u0435\u0439\u0435\u0440 \u0437\u0430\u0432\u0435\u0440\u0448\u0451\u043D!*\n\n\u0421\u0446\u0435\u043D: *${scenes.length}*\n\u0418\u0437\u043E\u0431\u0440\u0430\u0436\u0435\u043D\u0438\u044F: *${imageDone}*\n\u0412\u0438\u0434\u0435\u043E: *${videoDone}*`;
  await updateStatus(finalText);
  showMainMenu(chatId);
}

function showStoryPipelineMenu(chatId, msgId = null) {
  const s = getState(chatId);
  const im = IMAGE_MODELS[s.imgModel];
  const vm = VIDEO_MODELS[s.vidModel];
  const text =
    `\u{1F39E} *\u0422\u0435\u043A\u0441\u0442 \u2192 \u0444\u043E\u0442\u043E \u2192 \u0432\u0438\u0434\u0435\u043E*\n\n` +
    `\u0417\u0430\u0433\u0440\u0443\u0437\u0438 .txt \u0438\u043B\u0438 .docx \u0444\u0430\u0439\u043B. \u0411\u043E\u0442:\n` +
    `1) \u0440\u0430\u0437\u043E\u0431\u044C\u0451\u0442 \u043F\u043E\u043B\u043D\u044B\u0439 \u0442\u0435\u043A\u0441\u0442 \u043D\u0430 \u0441\u0446\u0435\u043D\u044B;\n` +
    `2) \u0447\u0435\u0440\u0435\u0437 FastGen \u0441\u0434\u0435\u043B\u0430\u0435\u0442 \u043F\u0430\u0440\u0443 prompt'\u043E\u0432 \u0434\u043B\u044F \u043A\u0430\u0436\u0434\u043E\u0439 \u0441\u0446\u0435\u043D\u044B;\n` +
    `3) \u0441\u0433\u0435\u043D\u0435\u0440\u0438\u0440\u0443\u0435\u0442 \u0438\u0437\u043E\u0431\u0440\u0430\u0436\u0435\u043D\u0438\u044F;\n` +
    `4) \u0441\u0434\u0435\u043B\u0430\u0435\u0442 \u0432\u0438\u0434\u0435\u043E \u0438\u0437 \u044D\u0442\u0438\u0445 \u0438\u0437\u043E\u0431\u0440\u0430\u0436\u0435\u043D\u0438\u0439.\n\n` +
    `\u0421\u0446\u0435\u043D: *${s.storyScenes || 10}*\n` +
    `\u0424\u043E\u0442\u043E: *${md(im?.label || s.imgModel)}*\n` +
    `\u0412\u0438\u0434\u0435\u043E: *${md(vm?.label || s.vidModel)}*\n` +
    `\u{1F4D0} ${s.ratio}`;
  const kb = { inline_keyboard: [
    [{ text: `${s.storyScenes === 5 ? "\u2705 " : ""}5`, callback_data: "story_count_5" },
     { text: `${s.storyScenes === 10 ? "\u2705 " : ""}10`, callback_data: "story_count_10" },
     { text: `${s.storyScenes === 20 ? "\u2705 " : ""}20`, callback_data: "story_count_20" },
     { text: `${s.storyScenes === 30 ? "\u2705 " : ""}30`, callback_data: "story_count_30" }],
    [{ text: "\u{1F522} \u0421\u0432\u043E\u0451 \u0447\u0438\u0441\u043B\u043E \u0441\u0446\u0435\u043D", callback_data: "story_count_custom" }],
    [{ text: "\u{1F4C4} \u0417\u0430\u0433\u0440\u0443\u0437\u0438\u0442\u044C \u0444\u0430\u0439\u043B \u0438 \u0437\u0430\u043F\u0443\u0441\u0442\u0438\u0442\u044C", callback_data: "story_upload_file" }],
    [{ text: "\u{1F3A8} \u041C\u043E\u0434\u0435\u043B\u044C \u0444\u043E\u0442\u043E", callback_data: "open_imgmodel" }, { text: "\u{1F3A5} \u041C\u043E\u0434\u0435\u043B\u044C \u0432\u0438\u0434\u0435\u043E", callback_data: "open_vidmodel" }],
    [{ text: "\u{1F4D0} \u0421\u043E\u043E\u0442\u043D\u043E\u0448\u0435\u043D\u0438\u0435", callback_data: "open_ratio" }],
    [{ text: "\u25C0\uFE0F \u041D\u0430\u0437\u0430\u0434", callback_data: "back_menu" }],
  ]};
  if (msgId) return bot.editMessageText(text, { chat_id: chatId, message_id: msgId, parse_mode: "Markdown", reply_markup: kb }).catch(() => {});
  return bot.sendMessage(chatId, text, { parse_mode: "Markdown", reply_markup: kb });
}

// \u2500\u2500\u2500 callLLM \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
async function callLLM(provider, apiKey, template, userText) {
  const prompt = template.replace("{TEXT}", userText);
  if (provider === "fastgen") {
    const { data } = await axios.post(`${BASE_URL}/api/v6/prompts/generate`, {
      user_prompt: prompt,
    }, { headers: v6Headers(), timeout: 30000 });
    return data.generated_text || "";
  }
  if (provider === "openai") {
    const { data } = await axios.post("https://api.openai.com/v1/chat/completions", {
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: prompt }],
      max_tokens: 1000,
    }, { headers: { "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json" }, timeout: 30000 });
    return data.choices?.[0]?.message?.content || "";
  }
  if (provider === "gemini") {
    const { data } = await axios.post(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`,
      { contents: [{ parts: [{ text: prompt }] }] },
      { headers: { "Content-Type": "application/json" }, timeout: 30000 }
    );
    return data.candidates?.[0]?.content?.parts?.[0]?.text || "";
  }
  if (provider === "openrouter") {
    const { data } = await axios.post("https://openrouter.ai/api/v1/chat/completions", {
      model: "google/gemini-2.0-flash-001",
      messages: [{ role: "user", content: prompt }],
      max_tokens: 1000,
    }, { headers: { "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json" }, timeout: 30000 });
    return data.choices?.[0]?.message?.content || "";
  }
  throw new Error(`\u041D\u0435\u0438\u0437\u0432\u0435\u0441\u0442\u043D\u044B\u0439 \u043F\u0440\u043E\u0432\u0430\u0439\u0434\u0435\u0440: ${provider}`);
}

function splitText(text, mode) {
  if (mode === "sentences") return text.match(/[^.!?\n]+[.!?\n]*/g)?.map(s => s.trim()).filter(Boolean) || [text];
  return text.split("\n").map(s => s.trim()).filter(Boolean);
}

async function runPromptGen(chatId, storyText) {
  const s = getState(chatId);
  const parts = splitText(storyText, s.pgSplitMode);
  if (parts.length === 0) return bot.sendMessage(chatId, "\u274C \u0422\u0435\u043A\u0441\u0442 \u043F\u0443\u0441\u0442\u043E\u0439.");
  const statusMsg = await bot.sendMessage(chatId,
    `\u{1F9E0} *\u0413\u0435\u043D\u0435\u0440\u0430\u0446\u0438\u044F \u043F\u0440\u043E\u043C\u043F\u0442\u043E\u0432*\n\u0427\u0430\u0441\u0442\u0435\u0439: ${parts.length} | \u041F\u0430\u0440\u0430\u043B\u043B\u0435\u043B\u044C\u043D\u043E: ${s.pgParallel}\n\u23F3 \u0417\u0430\u043F\u0443\u0441\u043A\u0430\u044E...`,
    { parse_mode: "Markdown" }
  );
  const results = [];
  let done = 0, errors = 0;
  for (let i = 0; i < parts.length; i += s.pgParallel) {
    const batch = parts.slice(i, i + s.pgParallel);
    const batchResults = await Promise.allSettled(batch.map(part => callLLM(s.pgProvider, s.pgApiKey, s.pgTemplate, part)));
    for (const r of batchResults) {
      if (r.status === "fulfilled" && r.value) { results.push(r.value.trim()); done++; }
      else { errors++; }
    }
    await bot.editMessageText(
      `\u{1F9E0} \u0413\u0435\u043D\u0435\u0440\u0430\u0446\u0438\u044F: \u2713${done}/${parts.length}${errors > 0 ? ` \u2717${errors}` : ""}`,
      { chat_id: chatId, message_id: statusMsg.message_id }
    ).catch(() => {});
  }
  if (results.length === 0) {
    await bot.editMessageText("\u274C \u041D\u0435 \u0443\u0434\u0430\u043B\u043E\u0441\u044C \u0441\u0433\u0435\u043D\u0435\u0440\u0438\u0440\u043E\u0432\u0430\u0442\u044C \u043F\u0440\u043E\u043C\u043F\u0442\u044B.", { chat_id: chatId, message_id: statusMsg.message_id });
    return showMainMenu(chatId);
  }
  const bt = s.batchType || "image";
  const MAX = bt === "image" ? 500 : 200;
  const available = MAX - s.batchPrompts.length;
  const toAdd = results.slice(0, available);
  s.batchPrompts.push(...toAdd);
  s.batchPromptIdx = 0;
  await bot.editMessageText(
    `\u2705 \u0421\u0433\u0435\u043D\u0435\u0440\u0438\u0440\u043E\u0432\u0430\u043D\u043E ${toAdd.length} \u043F\u0440\u043E\u043C\u043F\u0442\u043E\u0432!${errors > 0 ? `\n\u26A0\uFE0F \u041E\u0448\u0438\u0431\u043E\u043A: ${errors}` : ""}\n\u0414\u043E\u0431\u0430\u0432\u043B\u0435\u043D\u044B \u0432 \u043F\u0430\u043A\u0435\u0442.`,
    { chat_id: chatId, message_id: statusMsg.message_id }
  ).catch(() => {});
  showBatchMenu(chatId);
}

// \u2500\u2500\u2500 \u041F\u043E\u0447\u0430\u0441\u043E\u0432\u043E\u0439 \u043F\u043B\u0430\u043D\u0438\u0440\u043E\u0432\u0449\u0438\u043A \u0432\u0438\u0434\u0435\u043E \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
const videoScheduler = {};

async function scheduleVideoChunk(chatId) {
  const job = videoScheduler[chatId];
  if (!job || job.stopped) {
    delete videoScheduler[chatId];
    return;
  }
  if (job.tasks.length === 0) {
    await bot.editMessageText(
      `\u2705 *\u041F\u043E\u0447\u0430\u0441\u043E\u0432\u043E\u0439 \u043F\u0430\u043A\u0435\u0442 \u0437\u0430\u0432\u0435\u0440\u0448\u0451\u043D!*\n\u2713${job.doneSoFar} \u2717${job.errorsSoFar}`,
      { chat_id: chatId, message_id: job.statusMsgId, parse_mode: "Markdown" }
    ).catch(() => {});
    delete videoScheduler[chatId];
    showMainMenu(chatId);
    return;
  }

  const { model, batchS, hourlyLimit } = job;
  const total = job.totalTasks;

  let allowedThisChunk = hourlyLimit;
  let waitMs = 0;
  let resetTime = "";

  const realUsage = await getRealVideoUsage();
  if (realUsage) {
    const apiLimit = Math.min(hourlyLimit, realUsage.hourLimit);
    const usedAlready = realUsage.usedThisHour || 0;
    const remaining = Math.max(0, apiLimit - usedAlready);

    console.log(`[scheduler] API usage: used=${usedAlready}/${apiLimit}, remaining=${remaining}`);

    if (remaining === 0) {
      waitMs = getTimeUntilNextHourUTC() + 5000;
      resetTime = new Date(Date.now() + waitMs).toLocaleTimeString("ru", { hour: "2-digit", minute: "2-digit", timeZone: "UTC" });
      await bot.sendMessage(chatId,
        `\u23F3 \u041B\u0438\u043C\u0438\u0442 API \u0438\u0441\u0447\u0435\u0440\u043F\u0430\u043D (\u0438\u0441\u043F\u043E\u043B\u044C\u0437\u043E\u0432\u0430\u043D\u043E ${usedAlready}/${apiLimit}).\n` +
        `\u{1F550} \u0421\u043B\u0435\u0434\u0443\u044E\u0449\u0430\u044F \u043F\u0430\u0447\u043A\u0430 \u0432 *${resetTime}* UTC.\n\u041C\u043E\u0436\u043D\u043E \u0437\u0430\u043A\u0440\u044B\u0442\u044C \u043F\u0440\u0438\u043B\u043E\u0436\u0435\u043D\u0438\u0435 \u2014 \u0431\u043E\u0442 \u043F\u0440\u043E\u0434\u043E\u043B\u0436\u0438\u0442.`,
        { parse_mode: "Markdown" });
      setTimeout(() => scheduleVideoChunk(chatId), waitMs);
      return;
    }
    allowedThisChunk = remaining;
  } else {
    checkResetBalance();
    const usedLocal = balanceState.videos || 0;
    const remaining = Math.max(0, hourlyLimit - usedLocal);
    if (remaining === 0) {
      waitMs = getTimeUntilNextHourUTC() + 5000;
      resetTime = new Date(Date.now() + waitMs).toLocaleTimeString("ru", { hour: "2-digit", minute: "2-digit", timeZone: "UTC" });
      await bot.sendMessage(chatId,
        `\u23F3 \u041B\u043E\u043A\u0430\u043B\u044C\u043D\u044B\u0439 \u043B\u0438\u043C\u0438\u0442 \u0438\u0441\u0447\u0435\u0440\u043F\u0430\u043D.\n\u{1F550} \u0421\u043B\u0435\u0434\u0443\u044E\u0449\u0430\u044F \u043F\u0430\u0447\u043A\u0430 \u0432 *${resetTime}* UTC.\n\u041C\u043E\u0436\u043D\u043E \u0437\u0430\u043A\u0440\u044B\u0442\u044C \u043F\u0440\u0438\u043B\u043E\u0436\u0435\u043D\u0438\u0435 \u2014 \u0431\u043E\u0442 \u043F\u0440\u043E\u0434\u043E\u043B\u0436\u0438\u0442.`,
        { parse_mode: "Markdown" });
      setTimeout(() => scheduleVideoChunk(chatId), waitMs);
      return;
    }
    allowedThisChunk = remaining;
  }

  const chunk = job.tasks.splice(0, allowedThisChunk);

  const statusText = () =>
    `\u23F0 *\u041F\u043E\u0447\u0430\u0441\u043E\u0432\u043E\u0439 \u043F\u0430\u043A\u0435\u0442 (\u0432\u0438\u0434\u0435\u043E)*\n` +
    `\u{1F916} ${model.label}\n` +
    `\u0412\u0441\u0435\u0433\u043E: ${total} | \u041E\u0441\u0442\u0430\u043B\u043E\u0441\u044C: ${job.tasks.length}\n` +
    `\u2713${job.doneSoFar} \u2717${job.errorsSoFar}\n` +
    `\u0422\u0435\u043A\u0443\u0449\u0430\u044F \u043F\u0430\u0447\u043A\u0430: ${chunk.length} \u0437\u0430\u0434\u0430\u0447 (\u043B\u0438\u043C\u0438\u0442/\u0447\u0430\u0441: ${hourlyLimit})`;

  if (!job.statusMsgId) {
    const m = await bot.sendMessage(chatId, statusText(), { parse_mode: "Markdown" });
    job.statusMsgId = m.message_id;
  } else {
    await bot.editMessageText(statusText(), { chat_id: chatId, message_id: job.statusMsgId, parse_mode: "Markdown" }).catch(() => {});
  }

  for (const task of chunk) {
    if (job.stopped) break;

    // \u041F\u0440\u043E\u0432\u0435\u0440\u044F\u0435\u043C: \u0434\u043E \u0441\u043B\u0435\u0434\u0443\u044E\u0449\u0435\u0433\u043E \u0447\u0430\u0441\u0430 UTC \u043E\u0441\u0442\u0430\u043B\u043E\u0441\u044C \u043C\u0435\u043D\u044C\u0448\u0435 5 \u043C\u0438\u043D\u0443\u0442?
    const timeUntilNextHour = getTimeUntilNextHourUTC();
    if (timeUntilNextHour < 5 * 60 * 1000) {
      // \u041D\u0435 \u043F\u0435\u0440\u0435\u0433\u0435\u043D\u0435\u0440\u0438\u0440\u0443\u0435\u043C \u2014 \u0441\u043E\u0445\u0440\u0430\u043D\u044F\u0435\u043C \u0437\u0430\u0434\u0430\u0447\u0443
      const errKey = `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
      storeFailedTask(chatId, errKey, {
        prompt: task.prompt,
        operation: task.operation,
        model: task.model,
        isImage: false,
        ratio: batchS.ratio,
        resolution: batchS.resolution,
        grokDuration: batchS.grokDuration,
        imageRef: task.imageRef,
        seed: batchS.seed,
      });
      await bot.sendMessage(chatId,
        `\u26A0\uFE0F \u041E\u0441\u0442\u0430\u043B\u043E\u0441\u044C <5 \u043C\u0438\u043D\u0443\u0442 \u0434\u043E \u043A\u043E\u043D\u0446\u0430 \u0447\u0430\u0441\u0430. \u0417\u0430\u0434\u0430\u0447\u0430 ${task.idx} \u043E\u0442\u043B\u043E\u0436\u0435\u043D\u0430 \u0434\u043B\u044F \u0440\u0443\u0447\u043D\u043E\u0439 \u043F\u0435\u0440\u0435\u0433\u0435\u043D\u0435\u0440\u0430\u0446\u0438\u0438.`,
        { parse_mode: "Markdown",
          reply_markup: { inline_keyboard: [[{ text: "\u{1F504} \u041F\u0435\u0440\u0435\u0433\u0435\u043D\u0435\u0440\u0438\u0440\u043E\u0432\u0430\u0442\u044C \u044D\u0442\u0443 \u0437\u0430\u0434\u0430\u0447\u0443", callback_data: `retry_err_${errKey}` }]] }
        });
      job.errorsSoFar++;
      continue;
    }

    try {
      await genOne(chatId, batchS, task.prompt, task.operation, model, false, 0, 0, task.idx, task.imageRef, true);
      job.doneSoFar++;
    } catch(e) {
      job.errorsSoFar++;
      await bot.sendMessage(chatId,
        `\u274C \u041E\u0448\u0438\u0431\u043A\u0430 \u0437\u0430\u0434\u0430\u0447\u0438 ${task.idx || ""}
${cleanErrorMessage(e, 500)}`
      ).catch(() => {});
    }
    await bot.editMessageText(statusText(), { chat_id: chatId, message_id: job.statusMsgId, parse_mode: "Markdown" }).catch(() => {});
  }

  if (job.stopped) {
    delete videoScheduler[chatId];
    return;
  }

  if (job.tasks.length > 0) {
    waitMs = getTimeUntilNextHourUTC() + 5000;
    resetTime = new Date(Date.now() + waitMs).toLocaleTimeString("ru", { hour: "2-digit", minute: "2-digit", timeZone: "UTC" });
    await bot.sendMessage(chatId,
      `\u23F3 \u041F\u0430\u0447\u043A\u0430 \u0437\u0430\u0432\u0435\u0440\u0448\u0435\u043D\u0430: \u2713${job.doneSoFar} \u2717${job.errorsSoFar}\n` +
      `\u041E\u0441\u0442\u0430\u043B\u043E\u0441\u044C *${job.tasks.length}* \u0437\u0430\u0434\u0430\u0447.\n` +
      `\u{1F550} \u0421\u043B\u0435\u0434\u0443\u044E\u0449\u0430\u044F \u043F\u0430\u0447\u043A\u0430 \u0432 *${resetTime}* UTC (\u0441\u0431\u0440\u043E\u0441 \u043B\u0438\u043C\u0438\u0442\u0430).\n` +
      `\u041C\u043E\u0436\u043D\u043E \u0437\u0430\u043A\u0440\u044B\u0442\u044C \u043F\u0440\u0438\u043B\u043E\u0436\u0435\u043D\u0438\u0435 \u2014 \u0431\u043E\u0442 \u043F\u0440\u043E\u0434\u043E\u043B\u0436\u0438\u0442.`,
      { parse_mode: "Markdown" });
    setTimeout(() => scheduleVideoChunk(chatId), waitMs);
  } else {
    await bot.editMessageText(
      `\u2705 *\u041F\u043E\u0447\u0430\u0441\u043E\u0432\u043E\u0439 \u043F\u0430\u043A\u0435\u0442 \u0437\u0430\u0432\u0435\u0440\u0448\u0451\u043D!*\n\u2713${job.doneSoFar} \u2717${job.errorsSoFar}`,
      { chat_id: chatId, message_id: job.statusMsgId, parse_mode: "Markdown" }
    ).catch(() => {});
    delete videoScheduler[chatId];
    showMainMenu(chatId);
  }
}

// \u2500\u2500\u2500 \u0413\u0435\u043D\u0435\u0440\u0430\u0446\u0438\u044F \u043E\u0434\u043D\u043E\u0439 \u0437\u0430\u0434\u0430\u0447\u0438 (v6) \u0441 \u0430\u0432\u0442\u043E\u043F\u0435\u0440\u0435\u0433\u0435\u043D\u0435\u0440\u0430\u0446\u0438\u0435\u0439 \u0434\u043E 5 \u0440\u0430\u0437 \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
async function genOne(chatId, s, prompt, operation, model, isImage, index, total, batchIdx = null, imageRef = null, isScheduled = false) {
  const label = batchIdx || (total > 1 ? `${index}/${total}` : "");
  const errKey = `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const MAX_RETRIES = 5;

  const requestSeed = makeGenerationSeed(s.seed);

  const body = {
    operation,
    prompt,
    aspect_ratio: s.ratio,
    seed: requestSeed,
    ...(model.quality && { quality: model.quality }),
    ...(model.hasResolution && { resolution: s.resolution || "720p" }),
    ...(model.hasDuration && s.grokDuration && { duration_seconds: getGrokDurationSeconds(s.grokDuration) }),
  };

  const refs = imageRef ? [imageRef] : (s.pendingRefImages && s.pendingRefImages.length > 0 ? s.pendingRefImages : null);
  if (refs && refs.length > 0) {
    body.inputs = refs;
  }

  console.log(`[genOne] operation=${operation} label=${label} bodyKeys=${Object.keys(body).join(",")}`);

  const taskData = {
    prompt, operation, model,
    isImage, ratio: s.ratio,
    resolution: s.resolution || "720p",
    grokDuration: s.grokDuration || "6s",
    imageRef: imageRef || null,
    imageRefs: refs || null,
    seed: s.seed,
    requestSeed,
  };

  let lastError = null;
  let lastRefunded = false;
  let lastRefundStatus = "unknown";

  for (let retry = 0; retry < MAX_RETRIES; retry++) {
    let genId;
    try {
      const created = await v6Create(body);
      genId = created.id;
      if (!genId) throw new Error(`v6Create returned no id: ${JSON.stringify(created).slice(0, 200)}`);
    } catch(e) {
      const status = e.response?.status ? `[HTTP ${e.response.status}] ` : "";
      const errStr = getFastGenErrorText(e);
      console.error(`[genOne] create failed (retry ${retry + 1}/${MAX_RETRIES}): ${status}${errStr}`);

      lastError = new Error(`${status}${errStr}`);
      const permanentCreateError = isPermanentCreateError(e);
      // Для HTTP 400/422 задача не создаётся, поэтому бот не должен считать кредиты потраченными.
      lastRefunded = permanentCreateError;
      lastRefundStatus = permanentCreateError ? "true" : "unknown";

      if (permanentCreateError) {
        storeFailedTask(chatId, errKey, taskData);
        await bot.sendMessage(chatId,
          `❌ Ошибка создания задачи${label ? ` [${label}]` : ""}
` +
          `🤖 ${model.label}
${status}${errStr.slice(0, 400)}
` +
          `💳 Кредиты: ✅ не списаны ботом
` +
          `🛑 Автоперегенерация не запущена: это постоянная ошибка параметров запроса.`,
          {
            reply_markup: { inline_keyboard: [[{ text: "🔄 Перегенерировать эту задачу", callback_data: `retry_err_${errKey}` }]] }
          }).catch(() => {});
        throw lastError;
      }

      // \u0415\u0441\u043B\u0438 \u0434\u043E \u0441\u043B\u0435\u0434\u0443\u044E\u0449\u0435\u0433\u043E \u0447\u0430\u0441\u0430 UTC \u043E\u0441\u0442\u0430\u043B\u043E\u0441\u044C \u043C\u0435\u043D\u044C\u0448\u0435 5 \u043C\u0438\u043D\u0443\u0442 \u2014 \u043F\u0440\u0435\u043A\u0440\u0430\u0449\u0430\u0435\u043C \u043F\u0435\u0440\u0435\u0433\u0435\u043D\u0435\u0440\u0430\u0446\u0438\u044E
      if (isScheduled && getTimeUntilNextHourUTC() < 5 * 60 * 1000) {
        storeFailedTask(chatId, errKey, taskData);
        await bot.sendMessage(chatId,
          `\u26A0\uFE0F \u0414\u043E \u043A\u043E\u043D\u0446\u0430 \u0447\u0430\u0441\u0430 <5 \u043C\u0438\u043D. \u041F\u0435\u0440\u0435\u0433\u0435\u043D\u0435\u0440\u0430\u0446\u0438\u044F \u043E\u0441\u0442\u0430\u043D\u043E\u0432\u043B\u0435\u043D\u0430 \u043F\u043E\u0441\u043B\u0435 ${retry} \u043F\u043E\u043F\u044B\u0442\u043E\u043A.\n` +
          `\u274C \u041E\u0448\u0438\u0431\u043A\u0430 \u0441\u043E\u0437\u0434\u0430\u043D\u0438\u044F \u0437\u0430\u0434\u0430\u0447\u0438${label ? ` [${label}]` : ""}\n` +
          `\u{1F916} ${model.label}\n${status}${errStr.slice(0, 400)}`,
          {
            reply_markup: { inline_keyboard: [[{ text: "\u{1F504} \u041F\u0435\u0440\u0435\u0433\u0435\u043D\u0435\u0440\u0438\u0440\u043E\u0432\u0430\u0442\u044C \u044D\u0442\u0443 \u0437\u0430\u0434\u0430\u0447\u0443", callback_data: `retry_err_${errKey}` }]] }
          }).catch(() => {});
        throw lastError;
      }

      // \u0418\u043D\u0430\u0447\u0435 \u043F\u0440\u043E\u0434\u043E\u043B\u0436\u0430\u0435\u043C retry
      continue;
    }

    addHistory(chatId, { model: model.label, prompt, genId, operation, isImage, ratio: s.ratio, resolution: s.resolution || "720p", grokDuration: s.grokDuration || "6s", imageRef: imageRef || null, imageRefs: refs || null, seed: requestSeed });

    let results;
    try {
      const pollResult = await v6Poll(genId);
      results = pollResult.results;
      const usage = pollResult.usage;

      // \u0423\u0441\u043F\u0435\u0445! \u0422\u0440\u0430\u0442\u0438\u043C \u0431\u0430\u043B\u0430\u043D\u0441 (\u0442\u043E\u043B\u044C\u043A\u043E \u0435\u0441\u043B\u0438 refunded=false \u0438\u043B\u0438 \u043D\u0435\u0442 \u0434\u0430\u043D\u043D\u044B\u0445)
      if (!usage || usage.refunded !== true) {
        if (isImage) spendBalance("images", getImageGenerationCredits(model));
        else {
          const vidCost = getVideoGenerationCredits(model, s.resolution || "720p", operation);
          spendBalance("videos", vidCost);
        }
      }

      const idxStr = batchIdx ? `*${batchIdx}* ` : "";
      const caption = `${idxStr}${md(model.label)}\n\u{1F4DD} _${md(prompt.slice(0, 100))}_`;
      const regenKb = { inline_keyboard: [[{ text: "\u{1F504} \u041F\u0435\u0440\u0435\u0433\u0435\u043D\u0435\u0440\u0438\u0440\u043E\u0432\u0430\u0442\u044C", callback_data: "show_regen_0" }]] };

      try {
        for (const item of results) {
          const media = resultToMedia(item, isImage ? "image" : "video");
          if (media) await sendV6Media(chatId, media, withSeedCaption(caption, item, pollResult, requestSeed), regenKb);
        }
      } catch(e) {
        console.error(`[genOne] sendMedia failed genId=${genId}: ${e.message}`);
        await bot.sendMessage(chatId,
          `\u26A0\uFE0F \u0413\u0435\u043D\u0435\u0440\u0430\u0446\u0438\u044F \u0437\u0430\u0432\u0435\u0440\u0448\u0435\u043D\u0430, \u043D\u043E \u043E\u0442\u043F\u0440\u0430\u0432\u043A\u0430 \u0444\u0430\u0439\u043B\u0430 \u043D\u0435 \u0443\u0434\u0430\u043B\u0430\u0441\u044C\n${e.message.slice(0, 300)}`,
          { parse_mode: "Markdown" }
        );
      }

      return; // \u0423\u0441\u043F\u0435\u0448\u043D\u043E\u0435 \u0437\u0430\u0432\u0435\u0440\u0448\u0435\u043D\u0438\u0435
    } catch(e) {
      console.error(`[genOne] poll failed genId=${genId} (retry ${retry + 1}/${MAX_RETRIES}): ${e.message}`);

      // \u041F\u0430\u0440\u0441\u0438\u043C refunded \u0438\u0437 \u043E\u0448\u0438\u0431\u043A\u0438
      const errMsg = e.message || "";
      const refundStatus = getRefundStatusFromErrorMessage(errMsg);
      const noRetry = !canAutoRetryAfterGenerationError(errMsg);
      lastRefunded = refundStatus === "true";
      lastRefundStatus = refundStatus;
      lastError = new Error(stripErrorControlTags(errMsg));

      if (noRetry) {
        storeFailedTask(chatId, errKey, taskData);
        await bot.sendMessage(chatId,
          `\u26A0\uFE0F \u041E\u0436\u0438\u0434\u0430\u043D\u0438\u0435 \u0437\u0430\u0434\u0430\u0447\u0438 \u043E\u0441\u0442\u0430\u043D\u043E\u0432\u043B\u0435\u043D\u043E${label ? ` [${label}]` : ""}\n` +
          `\u{1F916} ${model.label}\n${lastError.message.slice(0, 400)}\n` +
          `\u{1F4B3} \u041A\u0440\u0435\u0434\u0438\u0442\u044B: ${refundStatusLabel(refundStatus)}\n` +
          `\u{1F6D1} \u0410\u0432\u0442\u043E\u043F\u0435\u0440\u0435\u0433\u0435\u043D\u0435\u0440\u0430\u0446\u0438\u044F \u043D\u0435 \u0437\u0430\u043F\u0443\u0449\u0435\u043D\u0430, \u0447\u0442\u043E\u0431\u044B \u043D\u0435 \u0442\u0440\u0430\u0442\u0438\u0442\u044C \u043A\u0440\u0435\u0434\u0438\u0442\u044B \u0435\u0449\u0451 \u0440\u0430\u0437.`,
          { reply_markup: { inline_keyboard: [[{ text: "\u{1F504} \u041F\u0435\u0440\u0435\u0433\u0435\u043D\u0435\u0440\u0438\u0440\u043E\u0432\u0430\u0442\u044C \u044D\u0442\u0443 \u0437\u0430\u0434\u0430\u0447\u0443", callback_data: `retry_err_${errKey}` }]] } }
        ).catch(() => {});
        throw lastError;
      }

      // \u0415\u0441\u043B\u0438 \u0434\u043E \u0441\u043B\u0435\u0434\u0443\u044E\u0449\u0435\u0433\u043E \u0447\u0430\u0441\u0430 UTC \u043E\u0441\u0442\u0430\u043B\u043E\u0441\u044C \u043C\u0435\u043D\u044C\u0448\u0435 5 \u043C\u0438\u043D\u0443\u0442 \u2014 \u043F\u0440\u0435\u043A\u0440\u0430\u0449\u0430\u0435\u043C \u043F\u0435\u0440\u0435\u0433\u0435\u043D\u0435\u0440\u0430\u0446\u0438\u044E
      if (isScheduled && getTimeUntilNextHourUTC() < 5 * 60 * 1000) {
        storeFailedTask(chatId, errKey, taskData);
        await bot.sendMessage(chatId,
          `\u26A0\uFE0F \u0414\u043E \u043A\u043E\u043D\u0446\u0430 \u0447\u0430\u0441\u0430 <5 \u043C\u0438\u043D. \u041F\u0435\u0440\u0435\u0433\u0435\u043D\u0435\u0440\u0430\u0446\u0438\u044F \u043E\u0441\u0442\u0430\u043D\u043E\u0432\u043B\u0435\u043D\u0430 \u043F\u043E\u0441\u043B\u0435 ${retry + 1} \u043F\u043E\u043F\u044B\u0442\u043E\u043A.\n` +
          `\u274C \u041E\u0448\u0438\u0431\u043A\u0430 \u0433\u0435\u043D\u0435\u0440\u0430\u0446\u0438\u0438${label ? ` [${label}]` : ""}\n\u{1F916} ${model.label}\n${lastError.message.slice(0, 400)}\n` +
          `\u{1F4B3} \u041A\u0440\u0435\u0434\u0438\u0442\u044B: ${refundStatusLabel(lastRefundStatus)}`,
          {
            reply_markup: { inline_keyboard: [[{ text: "\u{1F504} \u041F\u0435\u0440\u0435\u0433\u0435\u043D\u0435\u0440\u0438\u0440\u043E\u0432\u0430\u0442\u044C \u044D\u0442\u0443 \u0437\u0430\u0434\u0430\u0447\u0443", callback_data: `retry_err_${errKey}` }]] }
          }).catch(() => {});
        throw lastError;
      }

      // \u0418\u043D\u0430\u0447\u0435 \u043F\u0440\u043E\u0434\u043E\u043B\u0436\u0430\u0435\u043C retry
      continue;
    }
  }

  // \u0412\u0441\u0435 5 \u043F\u043E\u043F\u044B\u0442\u043E\u043A \u0438\u0441\u0447\u0435\u0440\u043F\u0430\u043D\u044B
  storeFailedTask(chatId, errKey, taskData);
  await bot.sendMessage(chatId,
    `\u274C \u041E\u0448\u0438\u0431\u043A\u0430 \u043F\u043E\u0441\u043B\u0435 ${MAX_RETRIES} \u043F\u043E\u043F\u044B\u0442\u043E\u043A \u043F\u0435\u0440\u0435\u0433\u0435\u043D\u0435\u0440\u0430\u0446\u0438\u0438${label ? ` [${label}]` : ""}\n` +
    `\u{1F916} ${model.label}\n` +
    `${cleanErrorMessage(lastError, 400)}\n` +
    `\u{1F4B3} \u041A\u0440\u0435\u0434\u0438\u0442\u044B: ${refundStatusLabel(lastRefundStatus)}`,
    {
      reply_markup: { inline_keyboard: [[{ text: "\u{1F504} \u041F\u0435\u0440\u0435\u0433\u0435\u043D\u0435\u0440\u0438\u0440\u043E\u0432\u0430\u0442\u044C \u044D\u0442\u0443 \u0437\u0430\u0434\u0430\u0447\u0443", callback_data: `retry_err_${errKey}` }]] }
    }).catch(() => {});
  throw lastError || new Error("Max retries exceeded");
}

// \u2500\u2500\u2500 \u041F\u0435\u0440\u0435\u0433\u0435\u043D\u0435\u0440\u0430\u0446\u0438\u044F \u0437\u0430\u0434\u0430\u0447\u0438 \u0441 \u043E\u0448\u0438\u0431\u043A\u043E\u0439 \u2500\u2500
async function retryFailedTask(chatId, errKey) {
  const task = getFailedTask(chatId, errKey);
  if (!task) {
    return bot.sendMessage(chatId, "\u274C \u0417\u0430\u0434\u0430\u0447\u0430 \u043D\u0435 \u043D\u0430\u0439\u0434\u0435\u043D\u0430 (\u0432\u043E\u0437\u043C\u043E\u0436\u043D\u043E \u0443\u0441\u0442\u0430\u0440\u0435\u043B\u0430, \u043F\u0440\u043E\u0448\u043B\u043E >24\u0447).");
  }

  const { prompt, operation, model, isImage, ratio, resolution, grokDuration, imageRef, imageRefs, seed, requestSeed } = task;

  const fakeS = {
    ratio,
    resolution: resolution || "720p",
    grokDuration: grokDuration || "6s",
    seed: requestSeed ?? seed ?? "random",
    pendingRefImages: Array.isArray(imageRefs) ? imageRefs : [],
  };

  const statusMsg = await bot.sendMessage(chatId,
    `\u{1F504} *\u041F\u0435\u0440\u0435\u0433\u0435\u043D\u0435\u0440\u0438\u0440\u0443\u044E \u0437\u0430\u0434\u0430\u0447\u0443...*\n\u{1F916} ${md(model.label)}\n\u{1F4DD} _${md(prompt.slice(0, 80))}_`,
    { parse_mode: "Markdown" }
  );

  try {
    await genOne(chatId, fakeS, prompt, operation, model, isImage, 0, 0, null, imageRef, false);
    await bot.editMessageText("\u2705 \u041F\u0435\u0440\u0435\u0433\u0435\u043D\u0435\u0440\u0438\u0440\u043E\u0432\u0430\u043D\u043E!", { chat_id: chatId, message_id: statusMsg.message_id }).catch(() => {});
    failedTasks.delete(`${chatId}_${errKey}`);
  } catch(e) {
    await bot.editMessageText(
      `\u274C \u0421\u043D\u043E\u0432\u0430 \u043E\u0448\u0438\u0431\u043A\u0430: ${e.message.slice(0, 200)}`,
      { chat_id: chatId, message_id: statusMsg.message_id }
    ).catch(() => {});
  }
}

// \u2500\u2500\u2500 handlePromptAndGenerate \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
async function handlePromptAndGenerate(chatId, s, rawPrompt, generatorFn) {
  const mode = s.enhanceMode || "ask";
  const isVideo = s.tab === "video_text" || s.tab === "video_ref";

  if (mode === "never") return generatorFn(rawPrompt);

  if (mode === "always") {
    const waitMsg = await bot.sendMessage(chatId, "\u2728 \u0423\u043B\u0443\u0447\u0448\u0430\u044E \u043F\u0440\u043E\u043C\u043F\u0442...");
    let enhanced = null;
    try {
      enhanced = await v6EnhancePrompt(rawPrompt, isVideo);
    } catch(e) {
      console.log(`[enhance] failed: ${e.message}`);
    }
    await bot.deleteMessage(chatId, waitMsg.message_id).catch(() => {});
    if (enhanced && enhanced !== rawPrompt) {
      await bot.sendMessage(chatId,
        `\u2728 *\u041F\u0440\u043E\u043C\u043F\u0442 \u0443\u043B\u0443\u0447\u0448\u0435\u043D:*\n_${enhanced.slice(0, 300)}${enhanced.length > 300 ? "..." : ""}_`,
        { parse_mode: "Markdown" }
      );
      return generatorFn(enhanced);
    }
    return generatorFn(rawPrompt);
  }

  // ask
  const previewMsg = await bot.sendMessage(chatId,
    `\u2728 *\u0423\u043B\u0443\u0447\u0448\u0438\u0442\u044C \u043F\u0440\u043E\u043C\u043F\u0442?*\n\n\u{1F4DD} _${rawPrompt.slice(0, 200)}${rawPrompt.length > 200 ? "..." : ""}_`,
    { parse_mode: "Markdown", reply_markup: { inline_keyboard: [
      [{ text: "\u2728 \u0423\u043B\u0443\u0447\u0448\u0438\u0442\u044C", callback_data: "enhance_yes" }, { text: "\u23ED \u041E\u0440\u0438\u0433\u0438\u043D\u0430\u043B", callback_data: "enhance_no" }],
    ]}}
  );
  s.pendingPrompt = rawPrompt;
  s.pendingIsVideo = isVideo;
  s.pendingMsgId = previewMsg.message_id;
  s.pendingGenKey = `gen_${Date.now()}`;
  pendingGenerators.set(s.pendingGenKey, generatorFn);
}

// \u2500\u2500\u2500 runNormal \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
async function runNormal(chatId, s, prompt) {
  const isImage = s.tab === "image" || s.tab === "image_ref";
  let model, operation;

  if (s.tab === "image" || s.tab === "image_ref") {
    model = IMAGE_MODELS[s.imgModel];
    operation = model.operation;
  } else if (s.tab === "video_text") {
    model = VIDEO_MODELS[s.vidModel];
    operation = model.opText;
  } else if (s.tab === "video_ref") {
    model = VIDEO_MODELS[s.vidModel];
    operation = model.opImg;
    if (!operation) {
      return bot.sendMessage(chatId, `\u274C \u041C\u043E\u0434\u0435\u043B\u044C *${model.label}* \u043D\u0435 \u043F\u043E\u0434\u0434\u0435\u0440\u0436\u0438\u0432\u0430\u0435\u0442 \u0432\u0438\u0434\u0435\u043E \u0438\u0437 \u0444\u043E\u0442\u043E.`, { parse_mode: "Markdown" });
    }
  } else {
    model = VIDEO_MODELS[s.vidModel];
    operation = model.opImg || model.opText;
  }

  const doGenerate = async (finalPrompt) => {
    const count = s.count;
    const queue = isImage ? imageQueue : videoQueue;
    let done = 0, errors = 0;
    const errorMessages = [];
    const statusMsg = await bot.sendMessage(chatId,
      `\u23F3 *${count} \u0437\u0430\u0434\u0430\u0447 \u0432 \u043E\u0447\u0435\u0440\u0435\u0434\u0438*\n\u{1F3A8} ${model.label}\n\u{1F4B3} ${model.credits}\n(\u043C\u0430\u043A\u0441. 10 \u043F\u0430\u0440\u0430\u043B\u043B\u0435\u043B\u044C\u043D\u043E)`,
      { parse_mode: "Markdown" });

    if (isImage && count > 1) {
      // \u0423\u043F\u043E\u0440\u044F\u0434\u043E\u0447\u0435\u043D\u043D\u0430\u044F \u043E\u0442\u043F\u0440\u0430\u0432\u043A\u0430 \u0434\u043B\u044F \u043D\u0435\u0441\u043A\u043E\u043B\u044C\u043A\u0438\u0445 \u0438\u0437\u043E\u0431\u0440\u0430\u0436\u0435\u043D\u0438\u0439 \u0438\u0437 \u043E\u0434\u043D\u043E\u0433\u043E \u043F\u0440\u043E\u043C\u043F\u0442\u0430
      const resultSlots = Array.from({ length: count }, () => {
        let resolve, reject;
        const p = new Promise((res, rej) => { resolve = res; reject = rej; });
        return { promise: p, resolve, reject };
      });
      // \u0417\u0430\u043F\u0443\u0441\u043A\u0430\u0435\u043C \u0432\u0441\u0435 \u0433\u0435\u043D\u0435\u0440\u0430\u0446\u0438\u0438 \u043F\u0430\u0440\u0430\u043B\u043B\u0435\u043B\u044C\u043D\u043E
      for (let i = 0; i < count; i++) {
        const slot = resultSlots[i];
        queue(() => genOneRaw(chatId, s, finalPrompt, operation, model, isImage, i + 1, count))
          .then(r => slot.resolve(r))
          .catch(e => slot.reject(e));
      }
      // \u041E\u0442\u043F\u0440\u0430\u0432\u043B\u044F\u0435\u043C \u0441\u0442\u0440\u043E\u0433\u043E \u043F\u043E \u043F\u043E\u0440\u044F\u0434\u043A\u0443
      let sendChain = Promise.resolve();
      for (let i = 0; i < count; i++) {
        const slot = resultSlots[i];
        sendChain = sendChain.then(async () => {
          try {
            const result = await slot.promise;
            await sendBatchResult(chatId, result, `${i + 1}/${count}`, model);
            done++;
          } catch(e) {
            errors++;
            errorMessages.push(cleanErrorMessage(e, 350));
          }
          await bot.editMessageText(
            `\u23F3 \u041F\u0440\u043E\u0433\u0440\u0435\u0441\u0441: \u2713${done}/${count}${errors > 0 ? ` \u2717${errors}` : ""}\n\u{1F3A8} ${model.label}`,
            { chat_id: chatId, message_id: statusMsg.message_id, parse_mode: "Markdown" }
          ).catch(() => {});
        });
      }
      await sendChain;
    } else {
      const tasks = Array.from({ length: count }, (_, i) =>
        queue(() => genOne(chatId, s, finalPrompt, operation, model, isImage, i + 1, count))
          .then(() => done++)
          .catch((e) => {
            errors++;
            errorMessages.push(cleanErrorMessage(e, 350));
          })
          .finally(async () => {
            await bot.editMessageText(
              `\u23F3 \u041F\u0440\u043E\u0433\u0440\u0435\u0441\u0441: \u2713${done}/${count}${errors > 0 ? ` \u2717${errors}` : ""}\n\u{1F3A8} ${model.label}`,
              { chat_id: chatId, message_id: statusMsg.message_id, parse_mode: "Markdown" }
            ).catch(() => {});
          })
      );
      await Promise.allSettled(tasks);
    }

    const finalStatusText = errors === 0
      ? `\u2705 \u0413\u043E\u0442\u043E\u0432\u043E! \u2713${done}`
      : done > 0
        ? `\u26A0\uFE0F \u0413\u043E\u0442\u043E\u0432\u043E \u0447\u0430\u0441\u0442\u0438\u0447\u043D\u043E: \u2713${done} \u2717${errors}\n\n\u041F\u043E\u0441\u043B\u0435\u0434\u043D\u044F\u044F \u043E\u0448\u0438\u0431\u043A\u0430:\n${errorMessages[0] || "\u0441\u043C. \u043B\u043E\u0433\u0438 \u0441\u0435\u0440\u0432\u0435\u0440\u0430"}`
        : `\u274C \u0413\u0435\u043D\u0435\u0440\u0430\u0446\u0438\u044F \u043D\u0435 \u0443\u0434\u0430\u043B\u0430\u0441\u044C: \u2713${done} \u2717${errors}\n\n\u041F\u043E\u0441\u043B\u0435\u0434\u043D\u044F\u044F \u043E\u0448\u0438\u0431\u043A\u0430:\n${errorMessages[0] || "\u0441\u043C. \u043B\u043E\u0433\u0438 \u0441\u0435\u0440\u0432\u0435\u0440\u0430"}`;

    await bot.editMessageText(finalStatusText,
      { chat_id: chatId, message_id: statusMsg.message_id }
    ).catch(() => {});
    showMainMenu(chatId);
  };

  await handlePromptAndGenerate(chatId, s, prompt, doGenerate);
}

// \u2500\u2500\u2500 runKeyframes \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
async function runKeyframes(chatId, s, prompt) {
  const doGenerate = async (finalPrompt) => {
    const model = VIDEO_MODELS[s.vidModel];
    if (!model.opKf) {
      return bot.sendMessage(chatId, `\u274C \u041C\u043E\u0434\u0435\u043B\u044C *${model.label}* \u043D\u0435 \u043F\u043E\u0434\u0434\u0435\u0440\u0436\u0438\u0432\u0430\u0435\u0442 \u043A\u043B\u044E\u0447\u0435\u0432\u044B\u0435 \u043A\u0430\u0434\u0440\u044B.`, { parse_mode: "Markdown" });
    }
    const statusMsg = await bot.sendMessage(chatId, `\u23F3 \u041A\u043B\u044E\u0447\u0435\u0432\u044B\u0435 \u043A\u0430\u0434\u0440\u044B...\n\u{1F3A5} ${model.label}`);
    try {
      const inputs = [];
      if (s.keyframeStart) inputs.push(await tgPhotoToDataUri(s.keyframeStart));
      if (s.keyframeEnd) inputs.push(await tgPhotoToDataUri(s.keyframeEnd));

      const requestSeed = makeGenerationSeed(s.seed);
      const body = {
        operation: model.opKf,
        prompt: finalPrompt,
        aspect_ratio: s.ratio,
        inputs,
        keyframes: true,
        seed: requestSeed,
      };
      const created = await v6Create(body);
      const pollResult = await v6Poll(created.id);

      // \u041F\u0440\u043E\u0432\u0435\u0440\u044F\u0435\u043C refunded
      if (!pollResult.usage || pollResult.usage.refunded !== true) {
        spendBalance("videos", getVideoGenerationCredits(model, s.resolution || "720p", model.opKf));
      }

      await bot.editMessageText("\u2705 \u0413\u043E\u0442\u043E\u0432\u043E!", { chat_id: chatId, message_id: statusMsg.message_id });
      for (const item of pollResult.results) {
        const media = resultToMedia(item, "video");
        if (media) await sendV6Media(chatId, media, withSeedCaption(`\u{1F39E} \u041A\u043B\u044E\u0447. \u043A\u0430\u0434\u0440\u044B
\u{1F4DD} _${md(finalPrompt.slice(0, 100))}_`, item, pollResult, requestSeed));
      }
    } catch(e) {
      const errMsg = stripErrorControlTags(e.message) || "\u041D\u0435\u0438\u0437\u0432\u0435\u0441\u0442\u043D\u0430\u044F \u043E\u0448\u0438\u0431\u043A\u0430";
      await bot.editMessageText(`\u274C ${errMsg.slice(0, 300)}`, { chat_id: chatId, message_id: statusMsg.message_id });
    }
    showMainMenu(chatId);
  };
  await handlePromptAndGenerate(chatId, s, prompt, doGenerate);
}

// \u2500\u2500\u2500 genOneRaw: \u0433\u0435\u043D\u0435\u0440\u0438\u0440\u0443\u0435\u0442 \u043D\u043E \u041D\u0415 \u043E\u0442\u043F\u0440\u0430\u0432\u043B\u044F\u0435\u0442, \u0432\u043E\u0437\u0432\u0440\u0430\u0449\u0430\u0435\u0442 \u0440\u0435\u0437\u0443\u043B\u044C\u0442\u0430\u0442 \u2500\u2500\u2500\u2500\u2500\u2500
// \u0418\u0441\u043F\u043E\u043B\u044C\u0437\u0443\u0435\u0442\u0441\u044F \u0434\u043B\u044F \u0443\u043F\u043E\u0440\u044F\u0434\u043E\u0447\u0435\u043D\u043D\u043E\u0439 \u043E\u0442\u043F\u0440\u0430\u0432\u043A\u0438 \u0432 \u043F\u0430\u043A\u0435\u0442\u043D\u043E\u043C \u0440\u0435\u0436\u0438\u043C\u0435 \u0444\u043E\u0442\u043E
async function genOneRaw(chatId, s, prompt, operation, model, isImage, index, total, batchIdx = null, imageRef = null, isScheduled = false) {
  const errKey = `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const MAX_RETRIES = 5;

  const requestSeed = makeGenerationSeed(s.seed);

  const body = {
    operation,
    prompt,
    aspect_ratio: s.ratio,
    seed: requestSeed,
    ...(model.quality && { quality: model.quality }),
    ...(model.hasResolution && { resolution: s.resolution || "720p" }),
    ...(model.hasDuration && s.grokDuration && { duration_seconds: getGrokDurationSeconds(s.grokDuration) }),
  };

  const refs = imageRef ? [imageRef] : (s.pendingRefImages && s.pendingRefImages.length > 0 ? s.pendingRefImages : null);
  if (refs && refs.length > 0) body.inputs = refs;

  const taskData = {
    prompt, operation, model,
    isImage, ratio: s.ratio,
    resolution: s.resolution || "720p",
    grokDuration: s.grokDuration || "6s",
    imageRef: imageRef || null,
    imageRefs: refs || null,
    seed: s.seed,
    requestSeed,
  };

  let lastError = null;
  let lastRefunded = false;
  let lastRefundStatus = "unknown";

  for (let retry = 0; retry < MAX_RETRIES; retry++) {
    let genId;
    try {
      const created = await v6Create(body);
      genId = created.id;
      if (!genId) throw new Error(`v6Create returned no id: ${JSON.stringify(created).slice(0, 200)}`);
    } catch(e) {
      const status = e.response?.status ? `[HTTP ${e.response.status}] ` : "";
      const errStr = getFastGenErrorText(e);
      lastError = new Error(`${status}${errStr}`);
      const permanentCreateError = isPermanentCreateError(e);
      // Для HTTP 400/422 задача не создаётся, поэтому бот не должен считать кредиты потраченными.
      lastRefunded = permanentCreateError;
      lastRefundStatus = permanentCreateError ? "true" : "unknown";
      if (permanentCreateError) {
        storeFailedTask(chatId, errKey, taskData);
        const failMsg =
          `❌ Ошибка создания задачи ${batchIdx || ""}
` +
          `🤖 ${model.label}
` +
          `${status}${errStr.slice(0, 300)}
` +
          `💳 ✅ не списаны ботом
` +
          `🛑 Автоперегенерация не запущена: это постоянная ошибка параметров запроса.`;
        bot.sendMessage(chatId, failMsg, {
          reply_markup: { inline_keyboard: [[{ text: "🔄 Перегенерировать", callback_data: `retry_err_${errKey}` }]] }
        }).catch(() => {});
        throw lastError;
      }
      if (isScheduled && getTimeUntilNextHourUTC() < 5 * 60 * 1000) {
        storeFailedTask(chatId, errKey, taskData);
        throw lastError;
      }
      continue;
    }

    addHistory(chatId, { model: model.label, prompt, genId, operation, isImage, ratio: s.ratio, resolution: s.resolution || "720p", grokDuration: s.grokDuration || "6s", imageRef: imageRef || null, imageRefs: refs || null, seed: requestSeed });

    try {
      const pollResult = await v6Poll(genId);
      if (!pollResult.usage || pollResult.usage.refunded !== true) {
        if (isImage) spendBalance("images", getImageGenerationCredits(model));
        else {
          const vidCost = getVideoGenerationCredits(model, s.resolution || "720p", operation);
          spendBalance("videos", vidCost);
        }
      }
      // \u0412\u043E\u0437\u0432\u0440\u0430\u0449\u0430\u0435\u043C \u0434\u0430\u043D\u043D\u044B\u0435 \u0434\u043B\u044F \u043E\u0442\u043F\u0440\u0430\u0432\u043A\u0438 \u2014 \u041D\u0415 \u043E\u0442\u043F\u0440\u0430\u0432\u043B\u044F\u0435\u043C \u0437\u0434\u0435\u0441\u044C
      return { results: pollResult.results, prompt, model, batchIdx, requestSeed, pollResult };
    } catch(e) {
      const errMsg = e.message || "";
      const refundStatus = getRefundStatusFromErrorMessage(errMsg);
      const noRetry = !canAutoRetryAfterGenerationError(errMsg);
      lastRefunded = refundStatus === "true";
      lastRefundStatus = refundStatus;
      lastError = new Error(stripErrorControlTags(errMsg));
      if (noRetry) {
        storeFailedTask(chatId, errKey, taskData);
        const failMsg =
          `\u26A0\uFE0F \u041E\u0436\u0438\u0434\u0430\u043D\u0438\u0435 \u0437\u0430\u0434\u0430\u0447\u0438 ${batchIdx || ""} \u043E\u0441\u0442\u0430\u043D\u043E\u0432\u043B\u0435\u043D\u043E\n` +
          `\u{1F916} ${model.label}\n` +
          `${cleanErrorMessage(lastError, 300)}\n` +
          `\u{1F4B3} \u041A\u0440\u0435\u0434\u0438\u0442\u044B: ${refundStatusLabel(refundStatus)}\n` +
          `\u{1F6D1} \u0410\u0432\u0442\u043E\u043F\u0435\u0440\u0435\u0433\u0435\u043D\u0435\u0440\u0430\u0446\u0438\u044F \u043D\u0435 \u0437\u0430\u043F\u0443\u0449\u0435\u043D\u0430, \u0447\u0442\u043E\u0431\u044B \u043D\u0435 \u0442\u0440\u0430\u0442\u0438\u0442\u044C \u043A\u0440\u0435\u0434\u0438\u0442\u044B \u0435\u0449\u0451 \u0440\u0430\u0437.`;
        bot.sendMessage(chatId, failMsg, {
          reply_markup: { inline_keyboard: [[{ text: "\u{1F504} \u041F\u0435\u0440\u0435\u0433\u0435\u043D\u0435\u0440\u0438\u0440\u043E\u0432\u0430\u0442\u044C", callback_data: `retry_err_${errKey}` }]] }
        }).catch(() => {});
        throw lastError;
      }
      if (isScheduled && getTimeUntilNextHourUTC() < 5 * 60 * 1000) {
        storeFailedTask(chatId, errKey, taskData);
        throw lastError;
      }
      continue;
    }
  }

  // \u0412\u0441\u0435 5 \u043F\u043E\u043F\u044B\u0442\u043E\u043A \u0438\u0441\u0447\u0435\u0440\u043F\u0430\u043D\u044B \u2014 \u043F\u0440\u043E\u043F\u0443\u0441\u043A\u0430\u0435\u043C \u0437\u0430\u0434\u0430\u0447\u0443, \u043D\u0435 \u0431\u043B\u043E\u043A\u0438\u0440\u0443\u0435\u043C \u043F\u0430\u043A\u0435\u0442
  storeFailedTask(chatId, errKey, taskData);
  const failMsg =
    `\u274C \u041F\u0440\u043E\u043F\u0443\u0449\u0435\u043D\u0430 \u0437\u0430\u0434\u0430\u0447\u0430 ${batchIdx || ""} (5 \u043F\u043E\u043F\u044B\u0442\u043E\u043A)\n` +
    `\u{1F916} ${model.label}\n` +
    `${cleanErrorMessage(lastError, 300)}\n` +
    `\u{1F4B3} ${refundStatusLabel(lastRefundStatus)}`;
  bot.sendMessage(chatId, failMsg, {
    reply_markup: { inline_keyboard: [[{ text: "\u{1F504} \u041F\u0435\u0440\u0435\u0433\u0435\u043D\u0435\u0440\u0438\u0440\u043E\u0432\u0430\u0442\u044C", callback_data: `retry_err_${errKey}` }]] }
  }).catch(() => {});
  throw lastError || new Error("Max retries exceeded");
}

// \u2500\u2500\u2500 sendBatchResult: \u043E\u0442\u043F\u0440\u0430\u0432\u043B\u044F\u0435\u0442 \u0440\u0435\u0437\u0443\u043B\u044C\u0442\u0430\u0442 genOneRaw \u0432 \u043F\u0440\u0430\u0432\u0438\u043B\u044C\u043D\u043E\u043C \u043F\u043E\u0440\u044F\u0434\u043A\u0435 \u2500\u2500
async function sendBatchResult(chatId, result, batchIdx, model) {
  const { results, prompt, requestSeed, pollResult } = result;
  const idxStr = batchIdx ? `*${batchIdx}* ` : "";
  const caption = `${idxStr}${md(model.label)}\n\u{1F4DD} _${md(prompt.slice(0, 100))}_`;
  const regenKb = { inline_keyboard: [[{ text: "\u{1F504} \u041F\u0435\u0440\u0435\u0433\u0435\u043D\u0435\u0440\u0438\u0440\u043E\u0432\u0430\u0442\u044C", callback_data: "show_regen_0" }]] };
  for (const item of results) {
    const media = resultToMedia(item, "image");
    if (media) await sendV6Media(chatId, media, withSeedCaption(caption, item, pollResult, requestSeed), regenKb);
  }
}

// \u2500\u2500\u2500 runBatch \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
async function runBatch(chatId) {
  const s = getState(chatId);
  const { bt, isImage, model, ratio, resolution, grokDuration, vidModelKey } = batchEffective(s);
  const isVideoImage = bt === "video_image";
  const batchS = { ...s, ratio, resolution, grokDuration };
  const prompts = [...s.batchPrompts];
  const photos = [...s.batchPhotos];
  const perPrompt = s.perPrompt || 1;

  if (prompts.length === 0 && photos.length === 0) return bot.sendMessage(chatId, "\u274C \u041D\u0435\u0442 \u043F\u0440\u043E\u043C\u043F\u0442\u043E\u0432 \u0438\u043B\u0438 \u0444\u043E\u0442\u043E!");
  if (isVideoImage && photos.length === 0) return bot.sendMessage(chatId, "\u274C \u0414\u043E\u0431\u0430\u0432\u044C \u0444\u043E\u0442\u043E \u0434\u043B\u044F \u0440\u0435\u0436\u0438\u043C\u0430 \u00AB\u0412\u0438\u0434\u0435\u043E \u0438\u0437 \u0444\u043E\u0442\u043E\u00BB!");

  let photoRefs = [];
  if (isVideoImage && photos.length > 0) {
    const uploadMsg = await bot.sendMessage(chatId, `\u23F3 \u041F\u043E\u0434\u0433\u043E\u0442\u0430\u0432\u043B\u0438\u0432\u0430\u044E ${photos.length} \u0444\u043E\u0442\u043E...`);
    try {
      for (let i = 0; i < photos.length; i += 5) {
        const chunk = photos.slice(i, i + 5);
        const results = await Promise.allSettled(chunk.map(fid => tgPhotoToDataUri(fid)));
        for (const r of results) {
          if (r.status === "fulfilled") photoRefs.push(r.value);
          else throw new Error(`\u041E\u0448\u0438\u0431\u043A\u0430 \u0437\u0430\u0433\u0440\u0443\u0437\u043A\u0438 \u0444\u043E\u0442\u043E ${photoRefs.length + 1}: ${r.reason?.message || r.reason}`);
        }
        await bot.editMessageText(`\u23F3 \u041F\u043E\u0434\u0433\u043E\u0442\u043E\u0432\u043B\u0435\u043D\u043E ${photoRefs.length}/${photos.length} \u0444\u043E\u0442\u043E...`, {
          chat_id: chatId, message_id: uploadMsg.message_id
        }).catch(() => {});
      }
      await bot.editMessageText(`\u2705 \u0424\u043E\u0442\u043E \u0433\u043E\u0442\u043E\u0432\u044B (${photoRefs.length})`, { chat_id: chatId, message_id: uploadMsg.message_id });
    } catch(e) {
      await bot.editMessageText(`\u274C \u041E\u0448\u0438\u0431\u043A\u0430 \u0437\u0430\u0433\u0440\u0443\u0437\u043A\u0438 \u0444\u043E\u0442\u043E: ${e.message}`, { chat_id: chatId, message_id: uploadMsg.message_id });
      return;
    }
  }

  const tasks = [];
  if (isVideoImage) {
    for (let fi = 0; fi < photos.length; fi++) {
      const prompt = prompts[fi] || prompts[0] || "animate";
      const op = model.opImg || model.opText;
      for (let vi = 0; vi < perPrompt; vi++)
        tasks.push({ prompt, idx: `\u0444${fi + 1}.${vi + 1}`, operation: op, imageRef: photoRefs[fi], model });
    }
    for (let pi = photos.length; pi < prompts.length; pi++)
      for (let vi = 0; vi < perPrompt; vi++)
        tasks.push({ prompt: prompts[pi], idx: `\u0442${pi + 1}.${vi + 1}`, operation: model.opText, imageRef: null, model });
  } else {
    const op = isImage ? model.operation : model.opText;
    for (let pi = 0; pi < prompts.length; pi++)
      for (let vi = 0; vi < perPrompt; vi++)
        tasks.push({ prompt: prompts[pi], idx: `${pi + 1}.${vi + 1}`, operation: op, imageRef: null, model });
  }

  const total = tasks.length;
  const hourlyLimit = s.batchHourlyLimit || 15;

  if (!isImage && total > hourlyLimit) {
    videoScheduler[chatId] = {
      tasks: [...tasks],
      totalTasks: total,
      doneSoFar: 0,
      errorsSoFar: 0,
      statusMsgId: null,
      stopped: false,
      hourlyLimit,
      model,
      batchS,
    };
    await bot.sendMessage(chatId,
      `\u23F0 *\u041F\u043E\u0447\u0430\u0441\u043E\u0432\u043E\u0439 \u0432\u0438\u0434\u0435\u043E-\u043F\u0430\u043A\u0435\u0442 \u0437\u0430\u043F\u0443\u0449\u0435\u043D!*\n` +
      `\u0412\u0441\u0435\u0433\u043E \u0437\u0430\u0434\u0430\u0447: *${total}*\n\u041B\u0438\u043C\u0438\u0442/\u0447\u0430\u0441: *${hourlyLimit}*\n` +
      `\u041F\u0430\u0447\u0435\u043A: *${Math.ceil(total / hourlyLimit)}*\n\n` +
      `\u041F\u0435\u0440\u0432\u0430\u044F \u043F\u0430\u0447\u043A\u0430 \u0441\u0442\u0430\u0440\u0442\u0443\u0435\u0442 \u0441\u0435\u0439\u0447\u0430\u0441.`,
      { parse_mode: "Markdown" });
    s.batchPrompts = []; s.batchPhotos = []; s.batchPromptIdx = 0;
    scheduleVideoChunk(chatId);
    return;
  }

  const queue = isImage ? imageQueue : videoQueue;
  let done = 0, errors = 0;
  const errorMessages = [];
  const statusMsg = await bot.sendMessage(chatId,
    `\u{1F4E6} *\u041F\u0430\u043A\u0435\u0442\u043D\u044B\u0439 \u0440\u0435\u0436\u0438\u043C*\n\u0417\u0430\u0434\u0430\u0447: ${total} | \u{1F916} ${model.label}\n\u{1F4B3} ${model.credits}`,
    { parse_mode: "Markdown" });

  if (isImage) {
    // \u2500\u2500\u2500 \u0423\u043F\u043E\u0440\u044F\u0434\u043E\u0447\u0435\u043D\u043D\u0430\u044F \u043E\u0442\u043F\u0440\u0430\u0432\u043A\u0430 \u0434\u043B\u044F \u0444\u043E\u0442\u043E \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
    // \u041A\u0430\u0436\u0434\u0430\u044F \u0437\u0430\u0434\u0430\u0447\u0430 \u043F\u043E\u043B\u0443\u0447\u0430\u0435\u0442 \u0441\u043B\u043E\u0442-\u043F\u0440\u043E\u043C\u0438\u0441. \u0417\u0430\u0434\u0430\u0447\u0430 i \u043D\u0435 \u043E\u0442\u043F\u0440\u0430\u0432\u043B\u044F\u0435\u0442\u0441\u044F,
    // \u043F\u043E\u043A\u0430 \u043D\u0435 \u0437\u0430\u0432\u0435\u0440\u0448\u0438\u043B\u0438\u0441\u044C \u0437\u0430\u0434\u0430\u0447\u0438 0\u2026i-1. \u0413\u0435\u043D\u0435\u0440\u0430\u0446\u0438\u044F \u043F\u0430\u0440\u0430\u043B\u043B\u0435\u043B\u044C\u043D\u0430\u044F (10 \u043F\u043E\u0442\u043E\u043A\u043E\u0432),
    // \u043E\u0442\u043F\u0440\u0430\u0432\u043A\u0430 \u0441\u0442\u0440\u043E\u0433\u043E \u043F\u043E \u043F\u043E\u0440\u044F\u0434\u043A\u0443.
    const resultSlots = tasks.map(() => {
      let resolve, reject;
      const p = new Promise((res, rej) => { resolve = res; reject = rej; });
      return { promise: p, resolve, reject };
    });

    // \u0426\u0435\u043F\u043E\u0447\u043A\u0430 \u0443\u043F\u043E\u0440\u044F\u0434\u043E\u0447\u0435\u043D\u043D\u043E\u0439 \u043E\u0442\u043F\u0440\u0430\u0432\u043A\u0438: \u043A\u0430\u0436\u0434\u044B\u0439 \u0441\u043B\u043E\u0442 \u0436\u0434\u0451\u0442 \u043F\u0440\u0435\u0434\u044B\u0434\u0443\u0449\u0438\u0439
    let sendChain = Promise.resolve();
    for (let i = 0; i < tasks.length; i++) {
      const task = tasks[i];
      const slot = resultSlots[i];
      // \u0417\u0430\u043F\u0443\u0441\u043A\u0430\u0435\u043C \u0433\u0435\u043D\u0435\u0440\u0430\u0446\u0438\u044E \u0447\u0435\u0440\u0435\u0437 \u043E\u0447\u0435\u0440\u0435\u0434\u044C (\u043F\u0430\u0440\u0430\u043B\u043B\u0435\u043B\u044C\u043D\u043E)
      queue(() => genOneRaw(chatId, batchS, task.prompt, task.operation, task.model || model, isImage, 0, 0, task.idx, task.imageRef || null, false))
        .then(result => slot.resolve(result))
        .catch(err => slot.reject(err));
      // \u0414\u043E\u0431\u0430\u0432\u043B\u044F\u0435\u043C \u0432 \u0446\u0435\u043F\u043E\u0447\u043A\u0443 \u043E\u0442\u043F\u0440\u0430\u0432\u043A\u0438
      const idx = i;
      sendChain = sendChain.then(async () => {
        try {
          const result = await slot.promise;
          await sendBatchResult(chatId, result, task.idx, model);
          done++;
        } catch(e) {
          errors++;
          errorMessages.push(`\u0417\u0430\u0434\u0430\u0447\u0430 ${task.idx || idx + 1}: ${cleanErrorMessage(e, 300)}`);
          console.error(`[batch ordered] task ${idx} failed: ${e.message}`);
        }
        bot.editMessageText(
          `\u{1F4E6} \u041F\u0430\u043A\u0435\u0442: \u2713${done}/${total}${errors > 0 ? ` \u2717${errors}` : ""}`,
          { chat_id: chatId, message_id: statusMsg.message_id }
        ).catch(() => {});
      });
    }
    await sendChain;
  } else {
    // \u0412\u0438\u0434\u0435\u043E: \u043F\u043E\u0440\u044F\u0434\u043E\u043A \u043D\u0435 \u0432\u0430\u0436\u0435\u043D, \u043E\u0442\u043F\u0440\u0430\u0432\u043B\u044F\u0435\u043C \u043A\u0430\u043A \u043F\u0440\u0438\u0434\u0451\u0442
    const allTasks = tasks.map(task =>
      queue(() => genOne(chatId, batchS, task.prompt, task.operation, task.model || model, isImage, 0, 0, task.idx, task.imageRef || null, false))
        .then(() => done++)
        .catch((e) => { errors++; errorMessages.push(`\u0417\u0430\u0434\u0430\u0447\u0430 ${task.idx}: ${cleanErrorMessage(e, 300)}`); console.error(`[batch video] task ${task.idx} failed: ${e.message}`); })
        .finally(() => {
          bot.editMessageText(
            `\u{1F4E6} \u041F\u0430\u043A\u0435\u0442: \u2713${done}/${total}${errors > 0 ? ` \u2717${errors}` : ""}`,
            { chat_id: chatId, message_id: statusMsg.message_id }
          ).catch(() => {});
        })
    );
    await Promise.allSettled(allTasks);
  }

  const batchFinalText = errors > 0
    ? `\u26A0\uFE0F \u041F\u0430\u043A\u0435\u0442 \u0433\u043E\u0442\u043E\u0432 \u0447\u0430\u0441\u0442\u0438\u0447\u043D\u043E: \u2713${done} \u2717${errors}

\u041F\u043E\u0441\u043B\u0435\u0434\u043D\u044F\u044F \u043E\u0448\u0438\u0431\u043A\u0430:
${errorMessages[0] || "\u0441\u043C. \u043E\u0442\u0434\u0435\u043B\u044C\u043D\u044B\u0435 \u0441\u043E\u043E\u0431\u0449\u0435\u043D\u0438\u044F/\u043B\u043E\u0433\u0438 \u0441\u0435\u0440\u0432\u0435\u0440\u0430"}`
    : `\u2705 \u041F\u0430\u043A\u0435\u0442 \u0433\u043E\u0442\u043E\u0432! \u2713${done}`;
  await bot.editMessageText(
    batchFinalText,
    { chat_id: chatId, message_id: statusMsg.message_id }
  ).catch(() => {});
  s.batchPrompts = []; s.batchPhotos = []; s.batchPromptIdx = 0;
  showMainMenu(chatId);
}

// \u2500\u2500\u2500 runRegenItem \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
async function runRegenItem(chatId, item, isImage, modelOverride = null) {
  const modelMap = isImage ? IMAGE_MODELS : VIDEO_MODELS;
  const model = modelOverride || Object.values(modelMap).find(m => m.label === item.model) || Object.values(modelMap)[0];
  const s = getState(chatId);

  const imageRefs = Array.isArray(item.imageRefs) ? item.imageRefs : (item.imageRef ? [item.imageRef] : []);
  const canUseInputs = imageRefs.length > 0 && (isImage || Boolean(model.opImg));
  const operation = item.operation && !modelOverride
    ? item.operation
    : (isImage ? model.operation : (canUseInputs && model.opImg ? model.opImg : model.opText));
  const resolution = item.resolution || s.resolution || "720p";
  const grokDuration = item.grokDuration || s.grokDuration || "6s";

  const statusMsg = await bot.sendMessage(chatId, `\u23F3 \u041F\u0435\u0440\u0435\u0433\u0435\u043D\u0435\u0440\u0438\u0440\u0443\u044E...\n\u{1F3A8} ${model.label}`);
  try {
    const requestSeed = makeGenerationSeed(s.seed);
    const body = {
      operation,
      prompt: item.prompt,
      aspect_ratio: item.ratio || s.ratio,
      seed: requestSeed,
      ...(model.quality && { quality: model.quality }),
      ...(canUseInputs && { inputs: imageRefs }),
      ...(model.hasResolution && { resolution }),
      ...(model.hasDuration && grokDuration && { duration_seconds: getGrokDurationSeconds(grokDuration) }),
    };

    const created = await v6Create(body);
    const pollResult = await v6Poll(created.id);

    // \u041F\u0440\u043E\u0432\u0435\u0440\u044F\u0435\u043C refunded
    if (!pollResult.usage || pollResult.usage.refunded !== true) {
      if (isImage) spendBalance("images", getImageGenerationCredits(model));
      else {
        const vidCost = getVideoGenerationCredits(model, resolution, operation);
        spendBalance("videos", vidCost);
      }
    }

    addHistory(chatId, {
      model: model.label,
      prompt: item.prompt,
      genId: created.id,
      operation,
      isImage,
      ratio: item.ratio || s.ratio,
      resolution,
      grokDuration,
      imageRef: imageRefs[0] || null,
      imageRefs,
      seed: requestSeed,
    });

    await bot.editMessageText("\u2705 \u041F\u0435\u0440\u0435\u0433\u0435\u043D\u0435\u0440\u0438\u0440\u043E\u0432\u0430\u043D\u043E!", { chat_id: chatId, message_id: statusMsg.message_id });
    for (const res of pollResult.results) {
      const media = resultToMedia(res, isImage ? "image" : "video");
      if (media) await sendV6Media(chatId, media, withSeedCaption(`\u{1F504} ${md(model.label)}
\u{1F4DD} _${md(item.prompt.slice(0, 100))}_`, res, pollResult, requestSeed),
        { inline_keyboard: [[{ text: "\u{1F504} \u041F\u0435\u0440\u0435\u0433\u0435\u043D\u0435\u0440\u0438\u0440\u043E\u0432\u0430\u0442\u044C", callback_data: "show_regen_0" }]] });
    }
  } catch(e) {
    const detail = e.response?.data?.detail || stripErrorControlTags(e.message) || e.message;
    await bot.editMessageText(`\u274C ${String(detail).slice(0, 300)}`, { chat_id: chatId, message_id: statusMsg.message_id });
  }
  showMainMenu(chatId);
}

// \u2500\u2500\u2500 /check \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
async function checkGeneration(chatId, genId) {
  const msg = await bot.sendMessage(chatId, `\u{1F50D} \u041F\u0440\u043E\u0432\u0435\u0440\u044F\u044E \`${genId}\`...`, { parse_mode: "Markdown" });
  try {
    const { data } = await axios.get(`${BASE_URL}/api/v6/generations/${genId}`, {
      headers: v6Headers(), timeout: 15000,
    });
    const st = data.status;
    await bot.editMessageText(`\u0421\u0442\u0430\u0442\u0443\u0441: *${st}*`, { chat_id: chatId, message_id: msg.message_id, parse_mode: "Markdown" });
    if (st === "succeeded" && data.results?.length > 0) {
      for (const item of data.results) {
        const media = resultToMedia(item, item.type || "image");
        if (media) await sendV6Media(chatId, media, withSeedCaption("\u2705 \u0420\u0435\u0437\u0443\u043B\u044C\u0442\u0430\u0442", item, { raw: data, results: data.results }, null));
      }
    }
  } catch(e) {
    await bot.editMessageText(`\u274C ${e.message.slice(0, 300)}`, { chat_id: chatId, message_id: msg.message_id });
  }
}

// \u2500\u2500\u2500 Callback handler \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
const mediaGroupTimers = new Map();

bot.on("callback_query", async (query) => {
  try {
  const chatId = query.message.chat.id;
  const msgId  = query.message.message_id;
  let data     = query.data;
  const s      = getState(chatId);

  bot.answerCallbackQuery(query.id).catch(() => {});

  function edit(text, kb) {
    return bot.editMessageText(text, { chat_id: chatId, message_id: msgId, parse_mode: "Markdown", reply_markup: kb }).catch(() => {});
  }
  function del() { return bot.deleteMessage(chatId, msgId).catch(() => {}); }
  const cancelKb = { inline_keyboard: [[{ text: "\u274C \u041E\u0442\u043C\u0435\u043D\u0430", callback_data: "back_menu" }]] };

  if (data === "noop") return;
  if (data === "back_menu" || data === "cancel") { s.step = null; del(); return showMainMenu(chatId); }
  if (data === "close_balance") { s.menuMsgId = msgId; return showMainMenu(chatId); }
  if (data === "show_balance")  { s.menuMsgId = msgId; return showBalance(chatId, msgId); }
  if (data === "refresh_balance") return showBalance(chatId, msgId);
  if (data === "open_misc")     { s.menuMsgId = msgId; return showMiscMenu(chatId, msgId); }
  if (data === "show_history")  { s.menuMsgId = msgId; return showHistoryMenu(chatId, msgId, 0); }
  if (data === "open_video_projects" || data.startsWith("vp_")) {
    s.menuMsgId = msgId;
    return handleVideoProjectCallback(query, { edit, del, cancelKb });
  }

  if (data.startsWith("retry_err_")) {
    const errKey = data.replace("retry_err_", "");
    return retryFailedTask(chatId, errKey);
  }

  if (data.startsWith("hist_page_")) {
    return showHistoryMenu(chatId, msgId, parseInt(data.replace("hist_page_", "")));
  }
  if (data === "hist_clear") {
    const key = String(chatId);
    history[key] = []; persistedHistory[key] = [];
    saveJSON(HISTORY_FILE, persistedHistory);
    return showHistoryMenu(chatId, msgId, 0);
  }
  if (data.startsWith("hist_") && !data.startsWith("hist_page_") && !data.startsWith("hist_clear")) {
    const idx = parseInt(data.replace("hist_", ""));
    const h = getHistory(chatId);
    const item = h[idx];
    if (!item) return;
    const time = item.ts ? new Date(item.ts).toLocaleString("ru") : "\u2014";
    const icon = item.isImage ? "\u{1F5BC}" : "\u{1F3AC}";
    return edit(
      `\u{1F4CB} *\u0417\u0430\u043F\u0438\u0441\u044C ${idx + 1}*\n\n${icon} *${item.model}*\n\u{1F550} ${time}\n\u{1F4DD} _${item.prompt}_\n\n\u{1F511} ID: \`${item.genId}\``,
      { inline_keyboard: [
        [{ text: "\u{1F504} \u041F\u0435\u0440\u0435\u0433\u0435\u043D\u0435\u0440\u0438\u0440\u043E\u0432\u0430\u0442\u044C", callback_data: `show_regen_${idx}` }],
        [{ text: "\u25C0\uFE0F \u041D\u0430\u0437\u0430\u0434 \u043A \u0438\u0441\u0442\u043E\u0440\u0438\u0438", callback_data: "show_history" }],
      ]}
    );
  }

  if (data.startsWith("show_regen_")) {
    const idx = parseInt(data.replace("show_regen_", ""));
    return showRegenMenu(chatId, idx);
  }

  if (data.startsWith("regen_")) {
    const parts = data.split("_");
    if (parts[1] === "same") {
      const idx = parseInt(parts[2]);
      const h = getHistory(chatId); const item = h[idx]; if (!item) return;
      return runRegenItem(chatId, item, item.isImage);
    }
    if (parts[1] === "run") {
      const idx = parseInt(parts[2]);
      const type = parts[3];
      const modelKey = parts.slice(4).join("_");
      const h = getHistory(chatId); const item = h[idx]; if (!item) return;
      const isImage = type === "im";
      const model = isImage ? IMAGE_MODELS[modelKey] : VIDEO_MODELS[modelKey];
      if (!model) return;
      return runRegenItem(chatId, item, isImage, model);
    }
    if (parts[1] === "edit") {
      const idx = parseInt(parts[2]);
      s.step = `waiting_regen_prompt_${idx}`;
      return bot.sendMessage(chatId, "\u270F\uFE0F \u041E\u0442\u043F\u0440\u0430\u0432\u044C \u043D\u043E\u0432\u044B\u0439 \u043F\u0440\u043E\u043C\u043F\u0442:", cancelKb);
    }
  }

  // \u2500\u2500 \u0420\u0435\u0436\u0438\u043C\u044B \u0433\u0435\u043D\u0435\u0440\u0430\u0446\u0438\u0438
  if (data === "do_image") {
    s.step = "waiting_prompt"; s.tab = "image"; s.mode = "normal";
    return edit(`\u{1F5BC} *\u0418\u0437\u043E\u0431\u0440\u0430\u0436\u0435\u043D\u0438\u0435*\n${IMAGE_MODELS[s.imgModel].label}\n\n\u041D\u0430\u043F\u0438\u0448\u0438 \u043F\u0440\u043E\u043C\u043F\u0442:`, cancelKb);
  }
  if (data === "do_image_ref") {
    s.pendingRefImages = []; s.tab = "image_ref"; s.mode = "normal"; s.step = "waiting_ref_photos";
    return edit("\u{1F5BC}\u{1F4F8} *\u0418\u0437\u043E\u0431\u0440\u0430\u0436\u0435\u043D\u0438\u0435 \u0438\u0437 \u0440\u0435\u0444\u0435\u0440\u0435\u043D\u0441\u043E\u0432*\n\n\u041E\u0442\u043F\u0440\u0430\u0432\u044C \u0434\u043E 10 \u0444\u043E\u0442\u043E, \u0437\u0430\u0442\u0435\u043C \u043D\u0430\u0436\u043C\u0438 \u043A\u043D\u043E\u043F\u043A\u0443:", {
      inline_keyboard: [
        [{ text: "\u2705 \u0420\u0435\u0444\u0435\u0440\u0435\u043D\u0441\u044B \u0433\u043E\u0442\u043E\u0432\u044B, \u0432\u0432\u0435\u0441\u0442\u0438 \u043F\u0440\u043E\u043C\u043F\u0442", callback_data: "ref_photos_done" }],
        [{ text: "\u274C \u041E\u0442\u043C\u0435\u043D\u0430", callback_data: "back_menu" }],
      ]
    });
  }
  if (data === "refs_done") {
    if (s.tab === "video_ref") data = "vid_ref_photos_done";
    else data = "ref_photos_done";
  }
  if (data === "ref_photos_done") {
    if (!s.pendingRefImages || s.pendingRefImages.length === 0)
      return bot.sendMessage(chatId, "\u274C \u0421\u043D\u0430\u0447\u0430\u043B\u0430 \u043E\u0442\u043F\u0440\u0430\u0432\u044C \u0445\u043E\u0442\u044F \u0431\u044B 1 \u0444\u043E\u0442\u043E!");
    s.step = "waiting_prompt";
    return bot.sendMessage(chatId, `\u2705 \u0420\u0435\u0444\u0435\u0440\u0435\u043D\u0441\u043E\u0432: ${s.pendingRefImages.length}\n\n\u041D\u0430\u043F\u0438\u0448\u0438 \u043F\u0440\u043E\u043C\u043F\u0442:`, {
      reply_markup: { inline_keyboard: [[{ text: "\u274C \u041E\u0442\u043C\u0435\u043D\u0430", callback_data: "back_menu" }]] }
    });
  }
  if (data === "do_vtext") {
    s.step = "waiting_prompt"; s.tab = "video_text"; s.mode = "normal";
    return edit(`\u{1F3AC} *\u0412\u0438\u0434\u0435\u043E \u0438\u0437 \u0442\u0435\u043A\u0441\u0442\u0430*\n${VIDEO_MODELS[s.vidModel].label}\n\n\u041E\u043F\u0438\u0448\u0438 \u0432\u0438\u0434\u0435\u043E:`, cancelKb);
  }
  if (data === "do_vimage") {
    const maxRef = s.vidModel === "grok_vid" ? 7 : 3;
    s.pendingRefImages = []; s.tab = "video_ref"; s.mode = "normal"; s.step = "waiting_vid_ref_photos";
    return edit(`\u{1F4F8} *\u0412\u0438\u0434\u0435\u043E \u0438\u0437 \u0444\u043E\u0442\u043E*\n${VIDEO_MODELS[s.vidModel].label}\n\n\u041E\u0442\u043F\u0440\u0430\u0432\u044C \u0434\u043E ${maxRef} \u0444\u043E\u0442\u043E:`, {
      inline_keyboard: [
        [{ text: "\u2705 \u0413\u043E\u0442\u043E\u0432\u043E, \u0432\u0432\u0435\u0441\u0442\u0438 \u043F\u0440\u043E\u043C\u043F\u0442", callback_data: "vid_ref_photos_done" }],
        [{ text: "\u274C \u041E\u0442\u043C\u0435\u043D\u0430", callback_data: "back_menu" }],
      ]
    });
  }
  if (data === "vid_ref_photos_done") {
    if (!s.pendingRefImages || s.pendingRefImages.length === 0)
      return bot.sendMessage(chatId, "\u274C \u0421\u043D\u0430\u0447\u0430\u043B\u0430 \u043E\u0442\u043F\u0440\u0430\u0432\u044C \u0445\u043E\u0442\u044F \u0431\u044B 1 \u0444\u043E\u0442\u043E!");
    s.step = "waiting_prompt";
    return bot.sendMessage(chatId, `\u2705 \u0424\u043E\u0442\u043E: ${s.pendingRefImages.length}\n\n\u041D\u0430\u043F\u0438\u0448\u0438 \u043E\u043F\u0438\u0441\u0430\u043D\u0438\u0435 \u0432\u0438\u0434\u0435\u043E:`, {
      reply_markup: { inline_keyboard: [[{ text: "\u274C \u041E\u0442\u043C\u0435\u043D\u0430", callback_data: "back_menu" }]] }
    });
  }
  if (data === "do_keyframes") {
    s.step = "waiting_keyframe_start"; s.tab = "video_text"; s.mode = "keyframes";
    s.keyframeStart = null; s.keyframeEnd = null;
    return edit("\u{1F39E} *\u041A\u043B\u044E\u0447\u0435\u0432\u044B\u0435 \u043A\u0430\u0434\u0440\u044B*\n\n\u041E\u0442\u043F\u0440\u0430\u0432\u044C *\u043F\u0435\u0440\u0432\u043E\u0435* \u0444\u043E\u0442\u043E (\u043D\u0430\u0447\u0430\u043B\u043E):", cancelKb);
  }
  if (data === "kf_skip_end") { s.step = "waiting_prompt"; return edit("\u2705 \u0422\u043E\u043B\u044C\u043A\u043E \u043D\u0430\u0447\u0430\u043B\u044C\u043D\u044B\u0439 \u043A\u0430\u0434\u0440.\n\n\u041D\u0430\u043F\u0438\u0448\u0438 \u043E\u043F\u0438\u0441\u0430\u043D\u0438\u0435:", cancelKb); }

  // \u2500\u2500 \u041F\u0430\u043A\u0435\u0442\u043D\u044B\u0439 \u0440\u0435\u0436\u0438\u043C
  if (data === "do_batch") { s.mode = "batch"; return showBatchTypeMenu(chatId, msgId); }
  if (data === "do_batch_menu") { s.mode = "batch"; return showBatchMenu(chatId, msgId); }
  if (data === "batch_change_type") return showBatchTypeMenu(chatId, msgId);
  if (data === "batch_type_image")       { s.batchType = "image";       saveState(chatId); return showBatchTypeMenu(chatId, msgId); }
  if (data === "batch_type_video_text")  { s.batchType = "video_text";  saveState(chatId); return showBatchTypeMenu(chatId, msgId); }
  if (data === "batch_type_video_image") { s.batchType = "video_image"; saveState(chatId); return showBatchTypeMenu(chatId, msgId); }
  if (data === "batch_add_text")  { s.step = "waiting_batch_prompts"; return edit("\u270F\uFE0F \u041D\u0430\u043F\u0438\u0448\u0438 \u043F\u0440\u043E\u043C\u043F\u0442\u044B, \u043A\u0430\u0436\u0434\u044B\u0439 \u0441 \u043D\u043E\u0432\u043E\u0439 \u0441\u0442\u0440\u043E\u043A\u0438:", cancelKb); }
  if (data === "batch_from_file") { s.step = "waiting_txt_file"; return edit("\u{1F4C4} \u041E\u0442\u043F\u0440\u0430\u0432\u044C .txt \u0444\u0430\u0439\u043B \u0441 \u043F\u0440\u043E\u043C\u043F\u0442\u0430\u043C\u0438:", cancelKb); }
  if (data === "batch_photos_menu") return showBatchPhotosMenu(chatId, msgId);
  if (data.startsWith("del_photo_")) { s.batchPhotos.splice(parseInt(data.replace("del_photo_", "")), 1); return showBatchPhotosMenu(chatId, msgId); }
  if (data === "batch_per_prompt") {
    return edit("\u{1F522} \u0421\u043A\u043E\u043B\u044C\u043A\u043E \u043D\u0430 1 \u043F\u0440\u043E\u043C\u043F\u0442/\u0444\u043E\u0442\u043E?", { inline_keyboard: [
      [1, 2, 3, 4, 5].map(n => ({ text: s.perPrompt === n ? `\u2705 ${n}` : `${n}`, callback_data: `set_pp_${n}` })),
      [{ text: "\u25C0\uFE0F \u041D\u0430\u0437\u0430\u0434", callback_data: "do_batch_menu" }],
    ]});
  }
  if (data.startsWith("set_pp_")) { s.perPrompt = parseInt(data.replace("set_pp_", "")); return showBatchMenu(chatId, msgId); }
  if (data === "batch_hourly_limit") {
    const cur = s.batchHourlyLimit || 15;
    return edit(`\u23F1 *\u041B\u0438\u043C\u0438\u0442 \u0432\u0438\u0434\u0435\u043E/\u0447\u0430\u0441*\n\u0421\u0435\u0439\u0447\u0430\u0441: *${cur}*`, { inline_keyboard: [
      [5, 10, 15, 20].map(n => ({ text: cur === n ? `\u2705 ${n}` : `${n}`, callback_data: `set_hl_${n}` })),
      [25, 30, 40, 50].map(n => ({ text: cur === n ? `\u2705 ${n}` : `${n}`, callback_data: `set_hl_${n}` })),
      [{ text: "\u270F\uFE0F \u0421\u0432\u043E\u0451 \u0447\u0438\u0441\u043B\u043E", callback_data: "set_hl_custom" }],
      [{ text: "\u25C0\uFE0F \u041D\u0430\u0437\u0430\u0434", callback_data: "do_batch_menu" }],
    ]});
  }
  if (data.startsWith("set_hl_")) {
    const val = data.replace("set_hl_", "");
    if (val === "custom") { s.step = "waiting_hourly_limit"; return edit("\u23F1 \u0412\u0432\u0435\u0434\u0438 \u0447\u0438\u0441\u043B\u043E (1\u2013500):", { inline_keyboard: [[{ text: "\u274C \u041E\u0442\u043C\u0435\u043D\u0430", callback_data: "do_batch_menu" }]] }); }
    s.batchHourlyLimit = parseInt(val); saveState(chatId); return showBatchMenu(chatId, msgId);
  }
  if (data === "batch_clear") { s.batchPrompts = []; s.batchPhotos = []; s.batchPromptIdx = 0; return showBatchMenu(chatId, msgId); }
  if (data === "batch_run") { del(); return runBatch(chatId); }

  // \u2500\u2500 \u041D\u0430\u0441\u0442\u0440\u043E\u0439\u043A\u0438 \u043F\u0430\u043A\u0435\u0442\u0430
  if (data === "batch_settings") return showBatchSettingsMenu(chatId, msgId);
  if (data.startsWith("bset_im_")) { s.batchImgModel = data.replace("bset_im_", ""); saveState(chatId); return showBatchSettingsMenu(chatId, msgId); }
  if (data.startsWith("bset_vm_")) { s.batchVidModel = data.replace("bset_vm_", ""); saveState(chatId); return showBatchSettingsMenu(chatId, msgId); }
  if (data.startsWith("bset_ratio_")) { s.batchRatio = data.replace("bset_ratio_", "").replace("x", ":"); saveState(chatId); return showBatchSettingsMenu(chatId, msgId); }
  if (data.startsWith("bset_res_")) { s.batchResolution = data.replace("bset_res_", ""); saveState(chatId); return showBatchSettingsMenu(chatId, msgId); }
  if (data.startsWith("bset_dur_")) { s.batchGrokDuration = data.replace("bset_dur_", ""); saveState(chatId); return showBatchSettingsMenu(chatId, msgId); }
  if (data === "bset_reset") { s.batchImgModel = null; s.batchVidModel = null; s.batchRatio = null; s.batchResolution = null; s.batchGrokDuration = null; saveState(chatId); return showBatchSettingsMenu(chatId, msgId); }

  if (data === "bp_prev") { s.batchPromptIdx = Math.max(0, (s.batchPromptIdx || 0) - 1); return showBatchMenu(chatId, msgId); }
  if (data === "bp_next") { s.batchPromptIdx = Math.min(s.batchPrompts.length - 1, (s.batchPromptIdx || 0) + 1); return showBatchMenu(chatId, msgId); }
  if (data === "bp_delete") {
    const idx = s.batchPromptIdx || 0;
    s.batchPrompts.splice(idx, 1);
    s.batchPromptIdx = Math.max(0, idx - 1);
    return showBatchMenu(chatId, msgId);
  }

  // \u2500\u2500 \u041C\u043E\u0434\u0435\u043B\u0438
  if (data === "open_imgmodel") {
    const rows = Object.entries(IMAGE_MODELS).map(([k, v]) => [{ text: `${s.imgModel === k ? "\u2705 " : ""}${v.label} (${v.credits})`, callback_data: `set_im_${k}` }]);
    rows.push([{ text: "\u25C0\uFE0F \u041D\u0430\u0437\u0430\u0434", callback_data: "back_menu" }]);
    return edit("\u{1F3A8} *\u041C\u043E\u0434\u0435\u043B\u044C \u0438\u0437\u043E\u0431\u0440\u0430\u0436\u0435\u043D\u0438\u044F:*", { inline_keyboard: rows });
  }
  if (data.startsWith("set_img_")) { s.imgModel = data.replace("set_img_", ""); saveState(chatId); del(); return showMainMenu(chatId); }
  if (data.startsWith("set_im_")) { s.imgModel = data.replace("set_im_", ""); saveState(chatId); del(); return showMainMenu(chatId); }

  if (data === "open_vidmodel") {
    const rows = Object.entries(VIDEO_MODELS).map(([k, v]) => [{ text: `${s.vidModel === k ? "\u2705 " : ""}${v.label} (${v.credits})`, callback_data: `set_vm_${k}` }]);
    rows.push([{ text: "\u25C0\uFE0F \u041D\u0430\u0437\u0430\u0434", callback_data: "back_menu" }]);
    return edit("\u{1F3A5} *\u041C\u043E\u0434\u0435\u043B\u044C \u0432\u0438\u0434\u0435\u043E:*", { inline_keyboard: rows });
  }
  if (data.startsWith("set_vid_")) { s.vidModel = data.replace("set_vid_", ""); saveState(chatId); del(); return showMainMenu(chatId); }
  if (data.startsWith("set_vm_")) { s.vidModel = data.replace("set_vm_", ""); saveState(chatId); del(); return showMainMenu(chatId); }

  if (data === "open_ratio") {
    const rows = [];
    for (let i = 0; i < RATIOS.length; i += 3) rows.push(RATIOS.slice(i, i + 3).map(r => ({ text: s.ratio === r ? `\u2705 ${r}` : r, callback_data: `set_r_${r.replace(":", "x")}` })));
    rows.push([{ text: "\u25C0\uFE0F \u041D\u0430\u0437\u0430\u0434", callback_data: "back_menu" }]);
    return edit("\u{1F4D0} *\u0421\u043E\u043E\u0442\u043D\u043E\u0448\u0435\u043D\u0438\u0435 \u0441\u0442\u043E\u0440\u043E\u043D:*", { inline_keyboard: rows });
  }
  if (data.startsWith("set_ratio_")) { s.ratio = data.replace("set_ratio_", "").replace("x", ":"); saveState(chatId); del(); return showMainMenu(chatId); }
  if (data.startsWith("set_r_")) { s.ratio = data.replace("set_r_", "").replace("x", ":"); saveState(chatId); del(); return showMainMenu(chatId); }

  if (data === "open_count") { s.step = "waiting_count"; return edit(`\u{1F522} *\u041A\u043E\u043B\u0438\u0447\u0435\u0441\u0442\u0432\u043E* (\u0441\u0435\u0439\u0447\u0430\u0441: ${s.count})\n\n\u041D\u0430\u043F\u0438\u0448\u0438 \u043E\u0442 1 \u0434\u043E 500:`, cancelKb); }
  if (data.startsWith("set_count_")) { s.count = Number(data.replace("set_count_", "")); saveState(chatId); del(); return showMainMenu(chatId); }

  if (data === "open_seed") {
    return edit("\u{1F331} *Seed:*", { inline_keyboard: [
      [{ text: s.seed === "random" ? "\u2705 \u0421\u043B\u0443\u0447\u0430\u0439\u043D\u044B\u0439" : "\u0421\u043B\u0443\u0447\u0430\u0439\u043D\u044B\u0439", callback_data: "set_seed_random" },
       { text: s.seed === "fixed"  ? "\u2705 \u0424\u0438\u043A\u0441." : "\u0424\u0438\u043A\u0441\u0438\u0440\u043E\u0432\u0430\u043D\u043D\u044B\u0439", callback_data: "set_seed_fixed" }],
      [{ text: "\u25C0\uFE0F \u041D\u0430\u0437\u0430\u0434", callback_data: "back_menu" }],
    ]});
  }
  if (data === "set_seed_random") { s.seed = "random"; saveState(chatId); del(); return showMainMenu(chatId); }
  if (data === "set_seed_fixed")  { s.seed = "fixed";  saveState(chatId); del(); return showMainMenu(chatId); }

  if (data === "open_resolution") {
    return edit("\u{1F5A5} *\u0420\u0430\u0437\u0440\u0435\u0448\u0435\u043D\u0438\u0435 Grok Video:*", { inline_keyboard: [
      ["480p", "720p"].map(r => ({ text: (s.resolution || "720p") === r ? `\u2705 ${r}` : r, callback_data: `set_res_${r}` })),
      [{ text: "\u25C0\uFE0F \u041D\u0430\u0437\u0430\u0434", callback_data: "open_misc" }],
    ]});
  }
  if (data.startsWith("set_res_")) { s.resolution = data.replace("set_res_", ""); saveState(chatId); return showMiscMenu(chatId, msgId); }

  if (data === "open_grok_duration") return showGrokDurationMenu(chatId, msgId);
  if (data === "set_grok_dur_6s")  { s.grokDuration = "6s";  saveState(chatId); return showGrokDurationMenu(chatId, msgId); }
  if (data === "set_grok_dur_10s") { s.grokDuration = "10s"; saveState(chatId); return showGrokDurationMenu(chatId, msgId); }

  // \u2500\u2500 Enhance
  if (data === "open_enhance") return showEnhanceMenu(chatId, msgId);
  if (data.startsWith("set_enh_")) { s.enhanceMode = data.replace("set_enh_", ""); saveState(chatId); return showEnhanceMenu(chatId, msgId); }
  if (data === "enhance_always") { s.enhanceMode = "always"; saveState(chatId); return showEnhanceMenu(chatId, msgId); }
  if (data === "enhance_ask")    { s.enhanceMode = "ask";    saveState(chatId); return showEnhanceMenu(chatId, msgId); }
  if (data === "enhance_never")  { s.enhanceMode = "never";  saveState(chatId); return showEnhanceMenu(chatId, msgId); }

  if (data === "enhance_yes") {
    const rawPrompt = s.pendingPrompt;
    const isVideo = s.pendingIsVideo;
    const genKey = s.pendingGenKey;
    const genFn = pendingGenerators.get(genKey);
    if (s.pendingMsgId) await bot.deleteMessage(chatId, s.pendingMsgId).catch(() => {});
    s.pendingPrompt = null; s.pendingMsgId = null; s.pendingGenKey = null;
    if (!genFn || !rawPrompt) return showMainMenu(chatId);
    const waitMsg = await bot.sendMessage(chatId, "\u2728 \u0423\u043B\u0443\u0447\u0448\u0430\u044E \u043F\u0440\u043E\u043C\u043F\u0442...");
    let enhanced = null;
    try { enhanced = await v6EnhancePrompt(rawPrompt, isVideo); } catch(e) { console.log(`[enhance] ${e.message}`); }
    await bot.deleteMessage(chatId, waitMsg.message_id).catch(() => {});
    if (enhanced && enhanced !== rawPrompt) {
      await bot.sendMessage(chatId,
        `\u2728 *\u041F\u0440\u043E\u043C\u043F\u0442 \u0443\u043B\u0443\u0447\u0448\u0435\u043D:*\n_${enhanced.slice(0, 300)}${enhanced.length > 300 ? "..." : ""}_`,
        { parse_mode: "Markdown" });
      pendingGenerators.delete(genKey);
      return genFn(enhanced);
    }
    pendingGenerators.delete(genKey);
    return genFn(rawPrompt);
  }
  if (data === "enhance_no") {
    const rawPrompt = s.pendingPrompt;
    const genKey = s.pendingGenKey;
    const genFn = pendingGenerators.get(genKey);
    if (s.pendingMsgId) await bot.deleteMessage(chatId, s.pendingMsgId).catch(() => {});
    s.pendingPrompt = null; s.pendingMsgId = null; s.pendingGenKey = null;
    if (!genFn || !rawPrompt) return showMainMenu(chatId);
    pendingGenerators.delete(genKey);
    return genFn(rawPrompt);
  }

  // \u2500\u2500 \u041E\u0442\u043C\u0435\u043D\u0430 \u0432\u0441\u0435\u0445 \u0437\u0430\u0434\u0430\u0447
  if (data === "cancel_all_ops") {
    await bot.answerCallbackQuery(query.id, { text: "\u23F3 \u041E\u0442\u043C\u0435\u043D\u044F\u044E..." });

    if (videoScheduler[chatId]) {
      videoScheduler[chatId].stopped = true;
      await bot.sendMessage(chatId, "\u{1F6D1} \u041F\u043E\u0447\u0430\u0441\u043E\u0432\u043E\u0439 \u043F\u0430\u043A\u0435\u0442 \u043E\u0441\u0442\u0430\u043D\u043E\u0432\u043B\u0435\u043D.");
    }

    const s2 = getState(chatId);
    s2.step = null;
    if (s2.pendingGenKey) {
      pendingGenerators.delete(s2.pendingGenKey);
      s2.pendingGenKey = null;
    }
    s2.pendingPrompt = null;
    s2.pendingMsgId = null;

    try {
      const { data: res } = await axios.get(`${BASE_URL}/api/v6/operations/cancel-all`, {
        headers: v6Headers(), timeout: 15000,
      });
      const found = res.total_found ?? "?";
      const cancelled = res.total_cancelled ?? "?";
      const refunded = res.total_refunded ?? "?";
      await bot.sendMessage(chatId,
        `\u2705 *\u041E\u0442\u043C\u0435\u043D\u0430 \u0437\u0430\u0432\u0435\u0440\u0448\u0435\u043D\u0430*\n\u041D\u0430\u0439\u0434\u0435\u043D\u043E: ${found} | \u041E\u0442\u043C\u0435\u043D\u0435\u043D\u043E: ${cancelled} | \u0412\u043E\u0437\u0432\u0440\u0430\u0449\u0435\u043D\u043E: ${refunded}`,
        { parse_mode: "Markdown" });
    } catch(e) {
      await bot.sendMessage(chatId, `\u274C \u041E\u0448\u0438\u0431\u043A\u0430 \u043E\u0442\u043C\u0435\u043D\u044B \u0432 API: ${e.message.slice(0, 200)}`);
    }
    return showBalance(chatId, msgId);
  }

  // \u2500\u2500 Prompt gen
  if (data === "story2video") return showStoryPipelineMenu(chatId, msgId);
  if (data.startsWith("story_count_")) {
    const value = data.replace("story_count_", "");
    if (value === "custom") {
      s.step = "waiting_story_scenes";
      return edit("\u{1F522} \u0412\u0432\u0435\u0434\u0438 \u043A\u043E\u043B\u0438\u0447\u0435\u0441\u0442\u0432\u043E \u0441\u0446\u0435\u043D \u043E\u0442 1 \u0434\u043E 200:", { inline_keyboard: [[{ text: "\u274C \u041E\u0442\u043C\u0435\u043D\u0430", callback_data: "story2video" }]] });
    }
    const n = parseInt(value);
    if (Number.isInteger(n) && n >= 1 && n <= 200) {
      s.storyScenes = n;
      saveState(chatId);
    }
    return showStoryPipelineMenu(chatId, msgId);
  }
  if (data === "story_upload_file") {
    s.step = "waiting_story_file";
    return edit("\u{1F4C4} \u041E\u0442\u043F\u0440\u0430\u0432\u044C .txt \u0438\u043B\u0438 .docx \u0444\u0430\u0439\u043B. \u041F\u043E\u0441\u043B\u0435 \u0437\u0430\u0433\u0440\u0443\u0437\u043A\u0438 \u0431\u043E\u0442 \u0441\u0440\u0430\u0437\u0443 \u0437\u0430\u043F\u0443\u0441\u0442\u0438\u0442: \u0442\u0435\u043A\u0441\u0442 \u2192 \u043F\u0440\u043E\u043C\u043F\u0442\u044B \u2192 \u0438\u0437\u043E\u0431\u0440\u0430\u0436\u0435\u043D\u0438\u044F \u2192 \u0432\u0438\u0434\u0435\u043E.", { inline_keyboard: [[{ text: "\u274C \u041E\u0442\u043C\u0435\u043D\u0430", callback_data: "story2video" }]] });
  }

  if (data === "open_promptgen") return showPromptGenMenu(chatId, msgId);
  if (data === "pg_split_lines") { s.pgSplitMode = "lines"; saveState(chatId); return showPromptGenMenu(chatId, msgId); }
  if (data === "pg_split_sent")  { s.pgSplitMode = "sentences"; saveState(chatId); return showPromptGenMenu(chatId, msgId); }
  if (data === "pg_parallel") {
    return edit("\u26A1 *\u041F\u0430\u0440\u0430\u043B\u043B\u0435\u043B\u044C\u043D\u044B\u0445 \u0437\u0430\u043F\u0440\u043E\u0441\u043E\u0432:*", { inline_keyboard: [
      [1, 2, 3, 5].map(n => ({ text: s.pgParallel === n ? `\u2705 ${n}` : `${n}`, callback_data: `set_pgp_${n}` })),
      [7, 10, 15, 20].map(n => ({ text: s.pgParallel === n ? `\u2705 ${n}` : `${n}`, callback_data: `set_pgp_${n}` })),
      [{ text: "\u25C0\uFE0F \u041D\u0430\u0437\u0430\u0434", callback_data: "open_promptgen" }],
    ]});
  }
  if (data.startsWith("set_pgp_")) { s.pgParallel = parseInt(data.replace("set_pgp_", "")); saveState(chatId); return showPromptGenMenu(chatId, msgId); }
  if (data === "pg_provider") {
    return edit("\u{1F916} *LLM \u043F\u0440\u043E\u0432\u0430\u0439\u0434\u0435\u0440:*", { inline_keyboard: [
      [{ text: s.pgProvider === "fastgen"    ? "\u2705 FastGen"    : "FastGen",    callback_data: "set_pgprov_fastgen" }],
      [{ text: s.pgProvider === "openai"     ? "\u2705 OpenAI"     : "OpenAI",     callback_data: "set_pgprov_openai" }],
      [{ text: s.pgProvider === "gemini"     ? "\u2705 Gemini"     : "Gemini",     callback_data: "set_pgprov_gemini" }],
      [{ text: s.pgProvider === "openrouter" ? "\u2705 OpenRouter" : "OpenRouter", callback_data: "set_pgprov_openrouter" }],
      [{ text: "\u25C0\uFE0F \u041D\u0430\u0437\u0430\u0434", callback_data: "open_promptgen" }],
    ]});
  }
  if (data.startsWith("set_pgprov_")) { s.pgProvider = data.replace("set_pgprov_", ""); saveState(chatId); return showPromptGenMenu(chatId, msgId); }
  if (data === "pg_apikey")   { s.step = "waiting_pg_apikey";   return edit(`\u{1F511} *API \u043A\u043B\u044E\u0447 \u0434\u043B\u044F ${s.pgProvider}*\n\n\u041E\u0442\u043F\u0440\u0430\u0432\u044C \u043A\u043B\u044E\u0447:`, cancelKb); }
  if (data === "pg_template") {
    s.step = "waiting_pg_template";
    return edit("\u270F\uFE0F *\u0428\u0430\u0431\u043B\u043E\u043D \u043F\u0440\u043E\u043C\u043F\u0442\u0430*\n\n\u0418\u0441\u043F\u043E\u043B\u044C\u0437\u0443\u0439 `{TEXT}` \u043A\u0430\u043A \u043F\u043B\u0435\u0439\u0441\u0445\u043E\u043B\u0434\u0435\u0440.\n\n\u041E\u0442\u043F\u0440\u0430\u0432\u044C \u043D\u043E\u0432\u044B\u0439 \u0448\u0430\u0431\u043B\u043E\u043D:", { inline_keyboard: [
      [{ text: "\u{1F504} \u0421\u0431\u0440\u043E\u0441\u0438\u0442\u044C", callback_data: "pg_template_reset" }],
      [{ text: "\u274C \u041E\u0442\u043C\u0435\u043D\u0430", callback_data: "open_promptgen" }],
    ]});
  }
  if (data === "pg_template_reset") { s.pgTemplate = DEFAULT_STATE().pgTemplate; saveState(chatId); return showPromptGenMenu(chatId, msgId); }
  if (data === "pg_input_text") { s.step = "waiting_pg_story"; return edit("\u{1F4DD} \u041E\u0442\u043F\u0440\u0430\u0432\u044C \u0442\u0435\u043A\u0441\u0442 \u0438\u0441\u0442\u043E\u0440\u0438\u0438:", cancelKb); }
  if (data === "pg_input_file") { s.step = "waiting_pg_file";  return edit("\u{1F4C4} \u041E\u0442\u043F\u0440\u0430\u0432\u044C .txt \u0444\u0430\u0439\u043B:", cancelKb); }
  } catch (e) {
    const cbData = query?.data || "unknown";
    const chatIdSafe = query?.message?.chat?.id;
    console.error(`[callback_query] data=${cbData}`, e);
    try { await bot.answerCallbackQuery(query.id, { text: "\u041E\u0448\u0438\u0431\u043A\u0430 \u043A\u043D\u043E\u043F\u043A\u0438. \u041E\u0442\u043A\u0440\u043E\u0439 /menu", show_alert: false }); } catch {}
    if (chatIdSafe) {
      await bot.sendMessage(chatIdSafe, `\u274C \u041E\u0448\u0438\u0431\u043A\u0430 \u043A\u043D\u043E\u043F\u043A\u0438: ${String(e.message || e).slice(0, 300)}

\u041E\u0442\u043A\u0440\u043E\u0439 \u043C\u0435\u043D\u044E \u0437\u0430\u043D\u043E\u0432\u043E: /menu`).catch(() => {});
    }
  }

});

// \u2500\u2500\u2500 \u0424\u043E\u0442\u043E handler \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
bot.on("photo", async (msg) => {
  const chatId = msg.chat.id;
  const s = getState(chatId);
  const fileId = msg.photo[msg.photo.length - 1].file_id;

  if (s.step && s.step.startsWith("vp_wait_prompt_refs_")) {
    const rest = s.step.replace("vp_wait_prompt_refs_", "");
    const idx = rest.indexOf("_vpp_");
    if (idx < 0) {
      s.step = null;
      return bot.sendMessage(chatId, "\u274C Prompt \u043D\u0435 \u043D\u0430\u0439\u0434\u0435\u043D.");
    }
    const projectId = rest.slice(0, idx);
    const promptId = rest.slice(idx + 1);
    const project = videoProjects[projectId];
    const prompt = project ? findVideoProjectPrompt(project, promptId) : null;
    if (!project || String(project.chatId) !== String(chatId) || project.status === "deleted" || !prompt) {
      s.step = null;
      return bot.sendMessage(chatId, "\u274C Video Project prompt \u043D\u0435 \u043D\u0430\u0439\u0434\u0435\u043D.");
    }
    normalizeVideoProject(project);
    if (!Array.isArray(prompt.refs)) prompt.refs = [];
    const limit = getVideoProjectPromptRefLimit(project);
    if (prompt.refs.length >= limit) {
      return bot.sendMessage(chatId, `\u274C \u041C\u0430\u043A\u0441\u0438\u043C\u0443\u043C ${limit} reference images \u043D\u0430 \u043E\u0434\u0438\u043D prompt.`, {
        reply_markup: { inline_keyboard: [[{ text: "\u{1F9F7} Prompt refs", callback_data: `vp_promptref_${projectId}_${promptId}` }]] }
      });
    }
    try {
      const dataUri = await tgPhotoToDataUri(fileId);
      const label = getVideoProjectPhotoLabel(msg, `prompt ${(prompt.index ?? 0) + 1} ref ${prompt.refs.length + 1}`);
      prompt.refs.push(makeVideoProjectRef(dataUri, label, prompt.refs.length, `prompt_${(prompt.index ?? 0) + 1}_ref`));
      prompt.updatedAt = Date.now();
      project.updatedAt = Date.now();
      saveVideoProjects();
      return bot.sendMessage(chatId, `\u2705 Reference \u0434\u043B\u044F prompt \u0434\u043E\u0431\u0430\u0432\u043B\u0435\u043D: ${prompt.refs.length}/${limit}.
\u041F\u043E\u0434\u043F\u0438\u0441\u044C: *${md(label)}*`, {
        parse_mode: "Markdown",
        reply_markup: { inline_keyboard: [
          [{ text: "\u2705 \u0413\u043E\u0442\u043E\u0432\u043E", callback_data: `vp_promptref_${projectId}_${promptId}` }],
          [{ text: "\u{1F9F7} Prompt refs", callback_data: `vp_promptref_${projectId}_${promptId}` }],
        ]}
      });
    } catch(e) {
      return bot.sendMessage(chatId, `\u274C \u041E\u0448\u0438\u0431\u043A\u0430 \u0437\u0430\u0433\u0440\u0443\u0437\u043A\u0438 reference image: ${e.message}`);
    }
  }

  if (s.step && s.step.startsWith("vp_wait_refs_")) {
    const projectId = s.step.replace("vp_wait_refs_", "");
    const project = videoProjects[projectId];
    if (!project || String(project.chatId) !== String(chatId) || project.status === "deleted") {
      s.step = null;
      return bot.sendMessage(chatId, "\u274C Video Project \u043D\u0435 \u043D\u0430\u0439\u0434\u0435\u043D.");
    }
    normalizeVideoProject(project);
    if (project.defaultRefs.length >= VIDEO_PROJECT_MAX_REFS) {
      return bot.sendMessage(chatId, `\u274C \u041C\u0430\u043A\u0441\u0438\u043C\u0443\u043C ${VIDEO_PROJECT_MAX_REFS} reference images \u043D\u0430 \u043F\u0440\u043E\u0435\u043A\u0442.`, {
        reply_markup: { inline_keyboard: [[{ text: "\u{1F4C2} Project", callback_data: `vp_project_${projectId}` }]] }
      });
    }
    try {
      const dataUri = await tgPhotoToDataUri(fileId);
      const label = getVideoProjectPhotoLabel(msg, `project ref ${project.defaultRefs.length + 1}`);
      project.defaultRefs.push(makeVideoProjectRef(dataUri, label, project.defaultRefs.length, "project_ref"));
      project.updatedAt = Date.now();
      saveVideoProjects();
      return bot.sendMessage(chatId, `\u2705 Reference ${project.defaultRefs.length}/${VIDEO_PROJECT_MAX_REFS} \u0434\u043E\u0431\u0430\u0432\u043B\u0435\u043D.
\u041F\u043E\u0434\u043F\u0438\u0441\u044C: *${md(label)}*`, {
        parse_mode: "Markdown",
        reply_markup: { inline_keyboard: [
          [{ text: "\u2705 \u0413\u043E\u0442\u043E\u0432\u043E", callback_data: `vp_refs_done_${projectId}` }],
          [{ text: "\u{1F4C2} Project", callback_data: `vp_project_${projectId}` }],
        ]}
      });
    } catch(e) {
      return bot.sendMessage(chatId, `\u274C \u041E\u0448\u0438\u0431\u043A\u0430 \u0437\u0430\u0433\u0440\u0443\u0437\u043A\u0438 reference image: ${e.message}`);
    }
  }

  if (s.mode === "batch") {
    const bt = s.batchType || "image";
    if (bt === "video_image") {
      if (s.batchPhotos.length >= 500) return bot.sendMessage(chatId, "\u274C \u041C\u0430\u043A\u0441\u0438\u043C\u0443\u043C 500 \u0444\u043E\u0442\u043E \u0432 \u043F\u0430\u043A\u0435\u0442\u0435!");
      s.batchPhotos.push(fileId);
      if (msg.media_group_id) {
        if (mediaGroupTimers.has(msg.media_group_id)) clearTimeout(mediaGroupTimers.get(msg.media_group_id));
        const t = setTimeout(() => {
          mediaGroupTimers.delete(msg.media_group_id);
          bot.sendMessage(chatId, `\u2705 \u0424\u043E\u0442\u043E \u0434\u043E\u0431\u0430\u0432\u043B\u0435\u043D\u044B! \u0412\u0441\u0435\u0433\u043E: ${s.batchPhotos.length}`, {
            reply_markup: { inline_keyboard: [[{ text: "\u{1F4E6} \u041C\u0435\u043D\u044E \u043F\u0430\u043A\u0435\u0442\u0430", callback_data: "do_batch_menu" }]] }
          });
        }, 1500);
        mediaGroupTimers.set(msg.media_group_id, t);
        return;
      }
      return bot.sendMessage(chatId, `\u2705 \u0424\u043E\u0442\u043E ${s.batchPhotos.length}/500 \u0434\u043E\u0431\u0430\u0432\u043B\u0435\u043D\u043E.`, {
        reply_markup: { inline_keyboard: [[{ text: "\u{1F4E6} \u041C\u0435\u043D\u044E \u043F\u0430\u043A\u0435\u0442\u0430", callback_data: "do_batch_menu" }]] }
      });
    }
    return bot.sendMessage(chatId, `\u2139\uFE0F \u0424\u043E\u0442\u043E \u043D\u0435 \u043D\u0443\u0436\u043D\u044B \u0434\u043B\u044F \u0442\u0435\u043A\u0443\u0449\u0435\u0433\u043E \u0442\u0438\u043F\u0430 \u043F\u0430\u043A\u0435\u0442\u0430.`, {
      reply_markup: { inline_keyboard: [[{ text: "\u{1F4E6} \u041C\u0435\u043D\u044E \u043F\u0430\u043A\u0435\u0442\u0430", callback_data: "do_batch_menu" }]] }
    });
  }

  if (s.step === "waiting_keyframe_start") {
    s.keyframeStart = fileId; s.step = "waiting_keyframe_end";
    return bot.sendMessage(chatId, "\u2705 \u041F\u0435\u0440\u0432\u044B\u0439 \u043A\u0430\u0434\u0440! \u041E\u0442\u043F\u0440\u0430\u0432\u044C \u0432\u0442\u043E\u0440\u043E\u0439 \u0438\u043B\u0438 \u043F\u0440\u043E\u043F\u0443\u0441\u0442\u0438:", {
      reply_markup: { inline_keyboard: [
        [{ text: "\u23ED \u041F\u0440\u043E\u043F\u0443\u0441\u0442\u0438\u0442\u044C", callback_data: "kf_skip_end" }],
        [{ text: "\u274C \u041E\u0442\u043C\u0435\u043D\u0430", callback_data: "back_menu" }],
      ]}
    });
  }
  if (s.step === "waiting_keyframe_end") {
    s.keyframeEnd = fileId; s.step = "waiting_prompt";
    return bot.sendMessage(chatId, "\u2705 \u041E\u0431\u0430 \u043A\u0430\u0434\u0440\u0430! \u041D\u0430\u043F\u0438\u0448\u0438 \u043E\u043F\u0438\u0441\u0430\u043D\u0438\u0435:", {
      reply_markup: { inline_keyboard: [[{ text: "\u274C \u041E\u0442\u043C\u0435\u043D\u0430", callback_data: "back_menu" }]] }
    });
  }
  if (s.step === "waiting_ref_photos") {
    if (!s.pendingRefImages) s.pendingRefImages = [];
    if (s.pendingRefImages.length >= 10)
      return bot.sendMessage(chatId, "\u274C \u041C\u0430\u043A\u0441\u0438\u043C\u0443\u043C 10 \u0440\u0435\u0444\u0435\u0440\u0435\u043D\u0441\u043E\u0432!");
    try {
      const dataUri = await tgPhotoToDataUri(fileId);
      s.pendingRefImages.push(dataUri);
      return bot.sendMessage(chatId, `\u2705 \u0420\u0435\u0444\u0435\u0440\u0435\u043D\u0441 ${s.pendingRefImages.length}/10 \u0434\u043E\u0431\u0430\u0432\u043B\u0435\u043D!`, {
        reply_markup: { inline_keyboard: [
          [{ text: `\u2705 \u0413\u043E\u0442\u043E\u0432\u043E (${s.pendingRefImages.length} \u0444\u043E\u0442\u043E)`, callback_data: "ref_photos_done" }],
          [{ text: "\u274C \u041E\u0442\u043C\u0435\u043D\u0430", callback_data: "back_menu" }],
        ]}
      });
    } catch(e) {
      return bot.sendMessage(chatId, `\u274C \u041E\u0448\u0438\u0431\u043A\u0430 \u0437\u0430\u0433\u0440\u0443\u0437\u043A\u0438 \u0444\u043E\u0442\u043E: ${e.message}`);
    }
  }
  if (s.step === "waiting_vid_ref_photos") {
    if (!s.pendingRefImages) s.pendingRefImages = [];
    const maxRef = s.vidModel === "grok_vid" ? 7 : 3;
    if (s.pendingRefImages.length >= maxRef)
      return bot.sendMessage(chatId, `\u274C \u041C\u0430\u043A\u0441\u0438\u043C\u0443\u043C ${maxRef} \u0444\u043E\u0442\u043E!`);
    try {
      const dataUri = await tgPhotoToDataUri(fileId);
      s.pendingRefImages.push(dataUri);
      return bot.sendMessage(chatId, `\u2705 \u0424\u043E\u0442\u043E ${s.pendingRefImages.length}/${maxRef} \u0434\u043E\u0431\u0430\u0432\u043B\u0435\u043D\u043E!`, {
        reply_markup: { inline_keyboard: [
          [{ text: `\u2705 \u0413\u043E\u0442\u043E\u0432\u043E (${s.pendingRefImages.length} \u0444\u043E\u0442\u043E)`, callback_data: "vid_ref_photos_done" }],
          [{ text: "\u274C \u041E\u0442\u043C\u0435\u043D\u0430", callback_data: "back_menu" }],
        ]}
      });
    } catch(e) {
      return bot.sendMessage(chatId, `\u274C \u041E\u0448\u0438\u0431\u043A\u0430 \u0437\u0430\u0433\u0440\u0443\u0437\u043A\u0438 \u0444\u043E\u0442\u043E: ${e.message}`);
    }
  }
  // \u041E\u0442\u043F\u0440\u0430\u0432\u0438\u043B \u0444\u043E\u0442\u043E \u043F\u0440\u043E\u0441\u0442\u043E \u0442\u0430\u043A \u2014 \u0437\u0430\u043F\u0443\u0441\u043A\u0430\u0435\u043C \u0432\u0438\u0434\u0435\u043E \u0438\u0437 \u0444\u043E\u0442\u043E
  s.tab = "video_ref"; s.pendingRefImages = []; s.step = "waiting_prompt"; s.mode = "normal";
  const vm = VIDEO_MODELS[s.vidModel];
  try {
    const dataUri = await tgPhotoToDataUri(fileId);
    s.pendingRefImages = [dataUri];
    bot.sendMessage(chatId, `\u2705 \u0424\u043E\u0442\u043E \u0433\u043E\u0442\u043E\u0432\u043E!\n\n\u{1F3AC} *${vm.label}* (${vm.credits})\n\n\u041D\u0430\u043F\u0438\u0448\u0438 \u043E\u043F\u0438\u0441\u0430\u043D\u0438\u0435 \u0434\u043B\u044F \u0432\u0438\u0434\u0435\u043E:`, {
      reply_markup: { inline_keyboard: [
        [{ text: "\u{1F3A5} \u0421\u043C\u0435\u043D\u0438\u0442\u044C \u043C\u043E\u0434\u0435\u043B\u044C", callback_data: "open_vidmodel" }],
        [{ text: "\u274C \u041E\u0442\u043C\u0435\u043D\u0430", callback_data: "back_menu" }],
      ]}
    });
  } catch(e) {
    bot.sendMessage(chatId, `\u274C \u041E\u0448\u0438\u0431\u043A\u0430 \u0437\u0430\u0433\u0440\u0443\u0437\u043A\u0438 \u0444\u043E\u0442\u043E: ${e.message}`);
  }
});

// \u2500\u2500\u2500 \u0414\u043E\u043A\u0443\u043C\u0435\u043D\u0442\u044B \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
bot.on("document", async (msg) => {
  const chatId = msg.chat.id;
  const s = getState(chatId);
  const fileName = msg.document.file_name || "";
  const lowerName = fileName.toLowerCase();

  async function readTxt() {
    const buffer = await readTelegramDocumentBuffer(msg.document.file_id);
    return buffer.toString("utf-8");
  }

  if (s.step && s.step.startsWith("vp_wait_file_")) {
    const projectId = s.step.replace("vp_wait_file_", "");
    const project = videoProjects[projectId];
    if (!project || String(project.chatId) !== String(chatId) || project.status === "deleted") {
      s.step = null;
      return bot.sendMessage(chatId, "\u274C Video Project \u043D\u0435 \u043D\u0430\u0439\u0434\u0435\u043D.");
    }
    if (!lowerName.endsWith(".txt") && !lowerName.endsWith(".docx")) {
      return bot.sendMessage(chatId, "\u274C \u0414\u043B\u044F Video Projects \u043D\u0443\u0436\u0435\u043D .txt \u0438\u043B\u0438 .docx \u0444\u0430\u0439\u043B.");
    }
    try {
      const buffer = await readTelegramDocumentBuffer(msg.document.file_id);
      const prompts = await extractVideoProjectPrompts(buffer, fileName);
      const added = addPromptsToVideoProject(projectId, prompts);
      s.step = null;
      return bot.sendMessage(chatId, `\u2705 \u0418\u043C\u043F\u043E\u0440\u0442\u0438\u0440\u043E\u0432\u0430\u043D\u043E ${added} prompts \u0432 Video Project.`, {
        reply_markup: { inline_keyboard: [[{ text: "\u{1F4C2} \u041E\u0442\u043A\u0440\u044B\u0442\u044C \u043F\u0440\u043E\u0435\u043A\u0442", callback_data: `vp_project_${projectId}` }]] }
      });
    } catch(e) {
      return bot.sendMessage(chatId, `\u274C \u041E\u0448\u0438\u0431\u043A\u0430 \u0438\u043C\u043F\u043E\u0440\u0442\u0430: ${e.message}`);
    }
  }

  if (s.step === "waiting_story_file") {
    s.step = null;
    if (!lowerName.endsWith(".txt") && !lowerName.endsWith(".docx")) {
      return bot.sendMessage(chatId, "\u274C \u0414\u043B\u044F \u043A\u043E\u043D\u0432\u0435\u0439\u0435\u0440\u0430 \u043D\u0443\u0436\u0435\u043D .txt \u0438\u043B\u0438 .docx \u0444\u0430\u0439\u043B.");
    }
    try {
      const buffer = await readTelegramDocumentBuffer(msg.document.file_id);
      const text = await extractTextFromDocumentBuffer(buffer, fileName);
      return runStoryToVideoPipeline(chatId, text, fileName);
    } catch(e) {
      return bot.sendMessage(chatId, `\u274C \u041E\u0448\u0438\u0431\u043A\u0430 \u0444\u0430\u0439\u043B\u0430: ${e.message}`);
    }
  }

  if (!lowerName.endsWith(".txt")) return bot.sendMessage(chatId, "\u274C \u041D\u0443\u0436\u0435\u043D .txt \u0444\u0430\u0439\u043B!");

  if (s.step === "waiting_pg_file") {
    s.step = null;
    try { return runPromptGen(chatId, await readTxt()); }
    catch(e) { return bot.sendMessage(chatId, `\u274C \u041E\u0448\u0438\u0431\u043A\u0430 \u0444\u0430\u0439\u043B\u0430: ${e.message}`); }
  }
  if (s.step === "waiting_txt_file") {
    s.step = null;
    try {
      const text = await readTxt();
      const prompts = text.split("\n").map(p => p.trim()).filter(Boolean);
      const bt = s.batchType || "image";
      const MAX = bt === "image" ? 500 : 200;
      const toAdd = prompts.slice(0, MAX - s.batchPrompts.length);
      const skipped = prompts.length - toAdd.length;
      s.batchPrompts.push(...toAdd);
      s.batchPromptIdx = 0;
      let reply = `\u2705 \u0417\u0430\u0433\u0440\u0443\u0436\u0435\u043D\u043E ${toAdd.length} \u043F\u0440\u043E\u043C\u043F\u0442\u043E\u0432!`;
      if (skipped > 0) reply += `\n\u26A0\uFE0F \u041F\u0440\u043E\u043F\u0443\u0449\u0435\u043D\u043E ${skipped} (\u043B\u0438\u043C\u0438\u0442 ${MAX})`;
      bot.sendMessage(chatId, reply, { reply_markup: { inline_keyboard: [[{ text: "\u{1F4E6} \u041C\u0435\u043D\u044E \u043F\u0430\u043A\u0435\u0442\u0430", callback_data: "do_batch_menu" }]] } });
    } catch(e) { bot.sendMessage(chatId, `\u274C \u041E\u0448\u0438\u0431\u043A\u0430 \u0444\u0430\u0439\u043B\u0430: ${e.message}`); }
  }
});

// \u2500\u2500\u2500 \u0422\u0435\u043A\u0441\u0442 handler \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
bot.on("message", async (msg) => {
  const chatId = msg.chat.id;
  const s = getState(chatId);
  if (!msg.text || msg.text.startsWith("/")) return;

  if (msg.text === "\u{1F4CA} Project Status") {
    return showLatestVideoProjectStatus(chatId);
  }

  if (s.step && s.step.startsWith("vp_wait_project_ref_labels_")) {
    const projectId = s.step.replace("vp_wait_project_ref_labels_", "");
    const project = videoProjects[projectId];
    if (!project || String(project.chatId) !== String(chatId) || project.status === "deleted") {
      s.step = null;
      return bot.sendMessage(chatId, "\u274C Video Project \u043D\u0435 \u043D\u0430\u0439\u0434\u0435\u043D.");
    }
    normalizeVideoProject(project);
    project.defaultRefs = applyVideoProjectRefLabels(project.defaultRefs, parseVideoProjectRefLabels(msg.text), "project_ref");
    project.updatedAt = Date.now();
    s.step = null;
    saveVideoProjects();
    return bot.sendMessage(chatId, `\u2705 Project refs \u043F\u043E\u0434\u043F\u0438\u0441\u0430\u043D\u044B.\n\n${formatVideoProjectRefsList(project.defaultRefs, "project_ref")}`, {
      reply_markup: { inline_keyboard: [[{ text: "\u{1F4C2} \u041E\u0442\u043A\u0440\u044B\u0442\u044C \u043F\u0440\u043E\u0435\u043A\u0442", callback_data: `vp_project_${projectId}` }]] }
    });
  }

  if (s.step && s.step.startsWith("vp_wait_prompt_ref_labels_")) {
    const rest = s.step.replace("vp_wait_prompt_ref_labels_", "");
    const idx = rest.indexOf("_vpp_");
    if (idx < 0) {
      s.step = null;
      return bot.sendMessage(chatId, "\u274C Prompt \u043D\u0435 \u043D\u0430\u0439\u0434\u0435\u043D.");
    }
    const projectId = rest.slice(0, idx);
    const promptId = rest.slice(idx + 1);
    const project = videoProjects[projectId];
    const prompt = project ? findVideoProjectPrompt(project, promptId) : null;
    if (!project || String(project.chatId) !== String(chatId) || project.status === "deleted" || !prompt) {
      s.step = null;
      return bot.sendMessage(chatId, "\u274C Video Project prompt \u043D\u0435 \u043D\u0430\u0439\u0434\u0435\u043D.");
    }
    normalizeVideoProject(project);
    const promptNo = (prompt.index ?? 0) + 1;
    prompt.refs = applyVideoProjectRefLabels(prompt.refs, parseVideoProjectRefLabels(msg.text), `prompt_${promptNo}_ref`);
    prompt.updatedAt = Date.now();
    project.updatedAt = Date.now();
    s.step = null;
    saveVideoProjects();
    return bot.sendMessage(chatId, `\u2705 Prompt refs \u043F\u043E\u0434\u043F\u0438\u0441\u0430\u043D\u044B.\n\n${formatVideoProjectRefsList(prompt.refs, `prompt_${promptNo}_ref`)}`, {
      reply_markup: { inline_keyboard: [[{ text: "\u{1F9F7} Prompt refs", callback_data: `vp_promptref_${projectId}_${promptId}` }]] }
    });
  }

  if (s.step === "vp_wait_custom_ref_preset") {
    const preset = parseCustomRefPreset(msg.text);
    if (!preset) {
      return bot.sendMessage(chatId, "\u274C \u041D\u0435 \u0443\u0434\u0430\u043B\u043E\u0441\u044C \u0441\u043E\u0437\u0434\u0430\u0442\u044C preset. \u0424\u043E\u0440\u043C\u0430\u0442: `My Pack: hero, outfit, location`", { parse_mode: "Markdown" });
    }
    const list = getChatRefPresets(chatId);
    list.unshift(preset);
    if (list.length > 30) list.length = 30;
    videoRefPresets[String(chatId)] = list;
    saveVideoRefPresets();
    s.step = null;
    return bot.sendMessage(chatId, `\u2705 Custom preset \u0441\u043E\u0437\u0434\u0430\u043D: *${md(preset.name)}*\nLabels: ${md(preset.labels.join(", "))}`, {
      reply_markup: { inline_keyboard: [[{ text: "\u{1F3F7} Presets", callback_data: "vp_rpreset_back" }]] }
    });
  }

  if (s.step === "vp_wait_name") {
    const name = msg.text.trim();
    if (!name) return bot.sendMessage(chatId, "\u274C \u041D\u0430\u0437\u0432\u0430\u043D\u0438\u0435 \u043D\u0435 \u043C\u043E\u0436\u0435\u0442 \u0431\u044B\u0442\u044C \u043F\u0443\u0441\u0442\u044B\u043C.");
    s.videoProjectDraft = { ...(s.videoProjectDraft || {}), name };
    s.step = null;
    return showVideoProjectModelMenu(chatId);
  }

  if (s.step && s.step.startsWith("vp_wait_prompts_")) {
    const projectId = s.step.replace("vp_wait_prompts_", "");
    const project = videoProjects[projectId];
    if (!project || String(project.chatId) !== String(chatId) || project.status === "deleted") {
      s.step = null;
      return bot.sendMessage(chatId, "\u274C Video Project \u043D\u0435 \u043D\u0430\u0439\u0434\u0435\u043D.");
    }
    const prompts = msg.text.split("\n").map(p => p.trim()).filter(Boolean);
    const added = addPromptsToVideoProject(projectId, prompts);
    s.step = null;
    return bot.sendMessage(chatId, `\u2705 \u0414\u043E\u0431\u0430\u0432\u043B\u0435\u043D\u043E ${added} prompts \u0432 Video Project.`, {
      reply_markup: { inline_keyboard: [[{ text: "\u{1F4C2} \u041E\u0442\u043A\u0440\u044B\u0442\u044C \u043F\u0440\u043E\u0435\u043A\u0442", callback_data: `vp_project_${projectId}` }]] }
    });
  }

  if (s.step === "waiting_story_scenes") {
    const n = parseInt(msg.text);
    if (isNaN(n) || n < 1 || n > 200) return bot.sendMessage(chatId, "\u274C \u0412\u0432\u0435\u0434\u0438 \u0447\u0438\u0441\u043B\u043E \u043E\u0442 1 \u0434\u043E 200:");
    s.storyScenes = n;
    s.step = null;
    saveState(chatId);
    return showStoryPipelineMenu(chatId);
  }

  if (s.step === "waiting_count") {
    const n = parseInt(msg.text);
    if (isNaN(n) || n < 1 || n > 500) return bot.sendMessage(chatId, "\u274C \u0412\u0432\u0435\u0434\u0438 \u0447\u0438\u0441\u043B\u043E \u043E\u0442 1 \u0434\u043E 500:");
    s.count = n; s.step = null; saveState(chatId);
    return showMainMenu(chatId);
  }
  if (s.step === "waiting_hourly_limit") {
    const n = parseInt(msg.text);
    if (isNaN(n) || n < 1 || n > 500) return bot.sendMessage(chatId, "\u274C \u0412\u0432\u0435\u0434\u0438 \u0447\u0438\u0441\u043B\u043E \u043E\u0442 1 \u0434\u043E 500:");
    s.batchHourlyLimit = n; s.step = null; saveState(chatId);
    await bot.sendMessage(chatId, `\u2705 \u041B\u0438\u043C\u0438\u0442 \u0432\u0438\u0434\u0435\u043E/\u0447\u0430\u0441: *${n}*`, { parse_mode: "Markdown" });
    return showBatchMenu(chatId);
  }
  if (s.step === "waiting_batch_prompts") {
    s.step = null;
    const bt = s.batchType || "image";
    const MAX = bt === "image" ? 500 : 200;
    const prompts = msg.text.split("\n").map(p => p.trim()).filter(Boolean);
    const toAdd = prompts.slice(0, MAX - s.batchPrompts.length);
    const skipped = prompts.length - toAdd.length;
    s.batchPrompts.push(...toAdd);
    s.batchPromptIdx = Math.max(0, s.batchPrompts.length - toAdd.length);
    let reply = `\u2705 \u0414\u043E\u0431\u0430\u0432\u043B\u0435\u043D\u043E ${toAdd.length} \u043F\u0440\u043E\u043C\u043F\u0442\u043E\u0432!`;
    if (skipped > 0) reply += `\n\u26A0\uFE0F \u041F\u0440\u043E\u043F\u0443\u0449\u0435\u043D\u043E ${skipped} (\u043B\u0438\u043C\u0438\u0442 ${MAX})`;
    return bot.sendMessage(chatId, reply, { reply_markup: { inline_keyboard: [[{ text: "\u{1F4E6} \u041C\u0435\u043D\u044E \u043F\u0430\u043A\u0435\u0442\u0430", callback_data: "do_batch_menu" }]] } });
  }
  if (s.step === "waiting_pg_apikey") {
    s.pgApiKey = msg.text.trim(); s.step = null; saveState(chatId);
    await bot.sendMessage(chatId, "\u2705 API \u043A\u043B\u044E\u0447 \u0441\u043E\u0445\u0440\u0430\u043D\u0451\u043D!");
    return showPromptGenMenu(chatId);
  }
  if (s.step === "waiting_pg_template") {
    s.pgTemplate = msg.text; s.step = null; saveState(chatId);
    await bot.sendMessage(chatId, "\u2705 \u0428\u0430\u0431\u043B\u043E\u043D \u0441\u043E\u0445\u0440\u0430\u043D\u0451\u043D!");
    return showPromptGenMenu(chatId);
  }
  if (s.step === "waiting_pg_story") {
    s.step = null;
    return runPromptGen(chatId, msg.text);
  }
  if (s.step && s.step.startsWith("waiting_regen_prompt_")) {
    const idx = parseInt(s.step.replace("waiting_regen_prompt_", ""));
    s.step = null;
    const h = getHistory(chatId);
    const item = h[idx];
    if (!item) return bot.sendMessage(chatId, "\u274C \u0417\u0430\u043F\u0438\u0441\u044C \u043D\u0435 \u043D\u0430\u0439\u0434\u0435\u043D\u0430");
    return runRegenItem(chatId, { ...item, prompt: msg.text }, item.isImage);
  }

  if (s.step !== "waiting_prompt") return showMainMenu(chatId);

  const prompt = msg.text;
  s.step = null;

  if (s.mode === "keyframes") return runKeyframes(chatId, s, prompt);
  await runNormal(chatId, s, prompt);
});

// \u2500\u2500\u2500 /start /menu \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
bot.onText(/^\/(start|menu)(?:@\w+)?(?:\s|$)/, async (msg) => {
  const chatId = msg.chat.id;
  const s = getState(chatId);
  if (s.menuMsgId) {
    await bot.deleteMessage(chatId, s.menuMsgId).catch(() => {});
    s.menuMsgId = null;
  }
  showMainMenu(chatId);
});

bot.onText(/\/check (.+)/, async (msg, match) => {
  await checkGeneration(msg.chat.id, match[1].trim());
});

bot.onText(/\/project_status/, async (msg) => {
  await showLatestVideoProjectStatus(msg.chat.id);
});

bot.onText(/\/story2video/, async (msg) => {
  await showStoryPipelineMenu(msg.chat.id);
});

// \u2500\u2500\u2500 Startup / Railway recovery \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
restoreVideoProjectsAfterRestart();
setTimeout(() => processVideoProjects().catch(e => console.error(`[VideoProject] startup error: ${e.message}`)), 5000);
setInterval(() => processVideoProjects().catch(e => console.error(`[VideoProject] interval error: ${e.message}`)), VIDEO_PROJECT_PROCESS_MS);

async function startTelegramPolling() {
  try {
    // \u0412\u0430\u0436\u043D\u043E \u0434\u043B\u044F \u0441\u043B\u0443\u0447\u0430\u0435\u0432, \u043A\u043E\u0433\u0434\u0430 \u0440\u0430\u043D\u044C\u0448\u0435 \u0431\u043E\u0442 \u0437\u0430\u043F\u0443\u0441\u043A\u0430\u043B\u0441\u044F \u0447\u0435\u0440\u0435\u0437 webhook: polling \u043D\u0435 \u0431\u0443\u0434\u0435\u0442 \u043F\u043E\u043B\u0443\u0447\u0430\u0442\u044C \u0441\u043E\u043E\u0431\u0449\u0435\u043D\u0438\u044F, \u043F\u043E\u043A\u0430 webhook \u0432\u043A\u043B\u044E\u0447\u0451\u043D.
    await bot.deleteWebHook({ drop_pending_updates: false }).catch(e => {
      console.warn(`[startup] deleteWebhook skipped: ${e.message}`);
    });
    await bot.startPolling();
    console.log("\u{1F916} FastGen Bot v6 \u0437\u0430\u043F\u0443\u0449\u0435\u043D! Polling active.");
  } catch (e) {
    console.error(`[startup] Telegram polling failed: ${e.message}`);
    console.error("\u041F\u0440\u043E\u0432\u0435\u0440\u044C TELEGRAM_TOKEN \u0438 \u0447\u0442\u043E \u043D\u0435 \u0437\u0430\u043F\u0443\u0449\u0435\u043D\u0430 \u0432\u0442\u043E\u0440\u0430\u044F \u043A\u043E\u043F\u0438\u044F \u0431\u043E\u0442\u0430 \u0441 \u044D\u0442\u0438\u043C \u0436\u0435 \u0442\u043E\u043A\u0435\u043D\u043E\u043C.");
  }
}

process.once("SIGTERM", () => {
  saveJSON(STATE_FILE, persistedStates);
  saveJSON(HISTORY_FILE, persistedHistory);
  saveVideoProjects();
  saveVideoProjectHistory();
  bot.stopPolling().catch(() => {}).finally(() => process.exit(0));
});

process.once("SIGINT", () => {
  saveJSON(STATE_FILE, persistedStates);
  saveJSON(HISTORY_FILE, persistedHistory);
  saveVideoProjects();
  saveVideoProjectHistory();
  bot.stopPolling().catch(() => {}).finally(() => process.exit(0));
});

startTelegramPolling();
