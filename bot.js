const TelegramBot = require("node-telegram-bot-api");
const axios = require("axios");
const fs = require("fs");
const FormData = require("form-data");

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const FASTGEN_API_KEY = process.env.FASTGEN_API_KEY;
const BASE_URL = "https://googler.fast-gen.ai";
const STORAGE_URL = "https://storage.fast-gen.ai";

const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });

// ─── Персистентное состояние ──────────────
const STATE_FILE = "./user_states.json";
const BALANCE_FILE = "./balance_state.json";
const HISTORY_FILE = "./history_state.json";

function loadJSON(file, def) {
  try { return JSON.parse(fs.readFileSync(file, "utf-8")); } catch { return def; }
}
function saveJSON(file, data) {
  try { fs.writeFileSync(file, JSON.stringify(data, null, 2)); } catch(e) { console.error("saveJSON error:", e.message); }
}

const persistedStates = loadJSON(STATE_FILE, {});
const persistedHistory = loadJSON(HISTORY_FILE, {});

// ─── Очередь ──────────────────────────────
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

// ─── Storage upload ───────────────────────
async function uploadToStorage(buffer, filename = "image.jpg") {
  const form = new FormData();
  form.append("file", buffer, { filename, contentType: "image/jpeg" });
  const { data } = await axios.post(`${STORAGE_URL}/upload`, form, {
    headers: { ...form.getHeaders(), "X-API-Key": FASTGEN_API_KEY },
    timeout: 30000,
  });
  if (!data.file_hash) throw new Error("Storage upload: no file_hash returned");
  return `file:${data.file_hash}`;
}

// ─── Загрузить фото из Telegram → base64 data URI ──
async function tgPhotoToDataUri(fileId) {
  const f = await bot.getFile(fileId);
  const resp = await axios.get(`https://api.telegram.org/file/bot${TELEGRAM_TOKEN}/${f.file_path}`, { responseType: "arraybuffer" });
  const ext = f.file_path.split(".").pop().toLowerCase();
  const mime = ext === "png" ? "image/png" : ext === "webp" ? "image/webp" : "image/jpeg";
  return `data:${mime};base64,${Buffer.from(resp.data).toString("base64")}`;
}

// ─── Загрузить фото из Telegram → storage ref ──
async function tgPhotoToRef(fileId) {
  const f = await bot.getFile(fileId);
  const resp = await axios.get(`https://api.telegram.org/file/bot${TELEGRAM_TOKEN}/${f.file_path}`, { responseType: "arraybuffer" });
  const buf = Buffer.from(resp.data);
  return uploadToStorage(buf);
}

// ─── V5 API helpers ───────────────────────
function v5Headers() {
  return { "X-API-Key": FASTGEN_API_KEY, "Content-Type": "application/json" };
}

async function v5Create(body) {
  const { data } = await axios.post(`${BASE_URL}/api/v5/generations`, body, {
    headers: v5Headers(), timeout: 120000,
  });
  return data;
}

async function v5Poll(genId, maxAttempts = 180, interval = 10000) {
  for (let i = 0; i < maxAttempts; i++) {
    await new Promise(r => setTimeout(r, interval));
    let data;
    try {
      const resp = await axios.get(`${BASE_URL}/api/v5/generations/${genId}`, {
        headers: v5Headers(), timeout: 15000,
      });
      data = resp.data;
    } catch(e) {
      console.log(`[poll] network error attempt ${i}: ${e.message}`);
      continue;
    }
    const st = data.status;
    console.log(`[poll] id=${genId} attempt=${i} status=${st}`);
    if (st === "succeeded") return { results: data.results || [], usage: data.usage };
    if (st === "failed") {
      const reason = data.error || JSON.stringify(data).slice(0, 300);
      const refunded = data.usage?.refunded || false;
      throw new Error(`Generation failed: ${reason}|REFUNDED:${refunded}`);
    }
  }
  throw new Error("Generation timed out after polling|REFUNDED:false");
}

async function sendV5Media(chatId, media, caption, replyMarkup = null) {
  const isImage = media.mediaType === "image";
  const opts = { caption, parse_mode: "Markdown", ...(replyMarkup && { reply_markup: replyMarkup }) };

  if (media.type === "url") {
    if (isImage) await bot.sendPhoto(chatId, media.value, opts);
    else await bot.sendVideo(chatId, media.value, opts);
    return;
  }

  let b64 = media.value;
  let ext = isImage ? "jpg" : "mp4";
  if (b64.includes(";base64,")) {
    const parts = b64.split(";base64,");
    b64 = parts[1];
    if (parts[0].includes("png")) ext = "png";
  }
  const tmp = `/tmp/fg_${Date.now()}.${ext}`;
  fs.writeFileSync(tmp, Buffer.from(b64, "base64"));
  try {
    if (isImage) await bot.sendPhoto(chatId, fs.createReadStream(tmp), opts);
    else await bot.sendVideo(chatId, fs.createReadStream(tmp), opts);
  } finally {
    try { fs.unlinkSync(tmp); } catch {}
  }
}

// ─── Промпт через v5 ──────────────────────
async function v5EnhancePrompt(rawPrompt, isVideo = false) {
  const mediaType = isVideo ? "video generation" : "image generation";
  const systemPrompt = `You are an expert prompt engineer for AI ${mediaType} models (Imagen, Veo, Grok, DALL-E).
Take the user's raw prompt and rewrite it into a highly detailed, optimized prompt.
- Detect content type: portrait, landscape, abstract, anime, realistic, cinematic, etc.
- Add: lighting, camera angle, atmosphere, color palette, quality boosters (photorealistic, 8K, sharp focus)
${isVideo ? "- Add: motion description, camera movement, pacing" : ""}
- Keep the core idea intact — only expand and improve, never change the subject
Output ONLY the improved prompt, nothing else.

User prompt: ${rawPrompt}`;

  const { data } = await axios.post(`${BASE_URL}/api/v5/prompts/generate`, {
    user_prompt: systemPrompt,
  }, { headers: v5Headers(), timeout: 30000 });

  return data.generated_text?.trim() || null;
}

// ─── Баланс ───────────────────────────────
const HOURLY_LIMITS = { images: 500, videos: 15, tokens: 200000 };

function nextHourResetUTC() {
  const now = new Date();
  // Сброс в начале каждого часа по UTC (00:00, 01:00, 02:00, ...)
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
  const resetStr = h > 0 ? `${h}ч ${m}м` : `${m}м`;
  const resetTime = new Date(b.resetAt).toLocaleTimeString("ru", { hour: "2-digit", minute: "2-digit", timeZone: "UTC" });

  let realBlock = "";
  try {
    const { data } = await axios.get(`${BASE_URL}/api/v5/usage`, {
      headers: v5Headers(), timeout: 10000,
    });
    const lim = data.account_limits || {};
    const threads = data.current_usage?.active_threads || {};
    realBlock =
      `\n📡 *API (реальный):*\n` +
      `🖼 Лимит фото/час: *${lim.img_gen_per_hour_limit ?? "?"}*\n` +
      `🎬 Лимит видео/час: *${lim.video_gen_per_hour_limit ?? "?"}*\n` +
      `⚡ Активных потоков: фото=${threads.image_threads || 0}, видео=${threads.video_threads || 0}\n`;
  } catch(e) {
    realBlock = `\n📡 API: не удалось получить (${e.message})\n`;
  }

  return (
    `📊 *Баланс*\n\n` +
    `🖼 Изображений осталось: *${imgLeft}/${HOURLY_LIMITS.images}*\n` +
    `🎬 Видео осталось: *${vidLeft}/${HOURLY_LIMITS.videos}*\n` +
    `⏱ Сброс через: *${resetStr}* (в ${resetTime} UTC)\n` +
    realBlock +
    `\n*Стоимость моделей:*\n` +
    `🖼 Imagen 4 / NanoPro / NanoBanana 2 (Flow): 4 кред\n` +
    `🖼 NanaBanana 2 (Flower) / ChatGPT / Grok: 1 кред\n` +
    `🎬 Veo 3.1 Fast/Light/Ultra-Light/Flower/Grok 6s: 1 кред\n` +
    `🎬 Grok Video 10s: 3 кред\n` +
    `🎬 Omni Flash 4-8s: 1 кред | 10s: 2 кред\n` +
    `🎬 Veo 3.1 Quality: 10 кред ⚠️\n` +
    `\nОбновлено: ${new Date().toLocaleTimeString("ru")}`
  );
}

// ─── Модели ───────────────────────────────
const IMAGE_MODELS = {
  "imagen4":    { label: "Imagen 4",           operation: "imagen_4_image_generate",         credits: "4 кред/фото" },
  "nanopro":    { label: "NanoBanana Pro",      operation: "nano_banana_pro_image_generate",  credits: "4 кред/фото" },
  "nanob2":     { label: "NanoBanana 2 Flow",   operation: "nano_banana_2_image_generate",    credits: "4 кред/фото" },
  "flower":     { label: "NanaBanana 2 Flower", operation: "flower_image_generate",           credits: "1 кред/фото" },
  "grok_fast":  { label: "Grok (быстро)",       operation: "grok_image_generate",             credits: "1 кред→6 фото", quality: "speed" },
  "grok_qual":  { label: "Grok (качество)",     operation: "grok_image_generate",             credits: "1 кред→4 фото", quality: "quality" },
  "chatgpt":    { label: "ChatGPT Images",      operation: "openai_image_generate",           credits: "1 кред/фото" },
};

const GROK_DURATIONS = {
  "6s":  { label: "6 сек (1 кред)",  duration: "6s",  credits: "1 кред/видео" },
  "10s": { label: "10 сек (3 кред)", duration: "10s", credits: "3 кред/видео" },
};

function getGrokVideoCredits(duration) {
  return duration === "10s" ? 3 : 1;
}

const VIDEO_MODELS = {
  "veo_fast":   { label: "Veo 3.1 Fast",        opText: "flow_video_from_text",         opImg: "flow_video_from_ingredients",         opKf: "flow_video_from_keyframes",         credits: "1 кред/видео" },
  "veo_light":  { label: "Veo 3.1 Light",       opText: "flow_video_light_from_text",   opImg: "flow_video_light_from_ingredients",   opKf: "flow_video_light_from_keyframes",   credits: "1 кред/видео" },
  "veo_ultra":  { label: "Veo 3.1 Ultra-Light", opText: "flow_video_ultra_light_from_text", opImg: "flow_video_ultra_light_from_ingredients", opKf: "flow_video_ultra_light_from_keyframes", credits: "1 кред/видео" },
  "veo_qual":   { label: "Veo 3.1 Quality",     opText: "flow_video_quality_from_text", opImg: null,                                  opKf: "flow_video_quality_from_keyframes", credits: "10 кред/видео ⚠️" },
  "flower_vid": { label: "Veo 3.1 Flower",      opText: "flower_video_from_text",       opImg: "flower_video_from_image",             opKf: null,                                credits: "1 кред/видео" },
  "grok_vid":   { label: "Grok Video",          opText: "grok_video_from_text",         opImg: "grok_video_from_image",               opKf: null,                                credits: "1/3 кред/видео", hasResolution: true, hasDuration: true },
  "omni_4s":    { label: "Omni Flash 4s",       opText: "flow_video_omni_flash_from_text_4s",  opImg: "flow_video_omni_flash_from_ingredients_4s",  opKf: null, credits: "1 кред/видео" },
  "omni_6s":    { label: "Omni Flash 6s",       opText: "flow_video_omni_flash_from_text_6s",  opImg: "flow_video_omni_flash_from_ingredients_6s",  opKf: null, credits: "1 кред/видео" },
  "omni_8s":    { label: "Omni Flash 8s",       opText: "flow_video_omni_flash_from_text_8s",  opImg: "flow_video_omni_flash_from_ingredients_8s",  opKf: null, credits: "1 кред/видео" },
  "omni_10s":   { label: "Omni Flash 10s",      opText: "flow_video_omni_flash_from_text_10s", opImg: "flow_video_omni_flash_from_ingredients_10s", opKf: null, credits: "2 кред/видео" },
};

const RATIOS = ["16:9", "9:16", "1:1", "4:3", "3:4", "3:2", "2:3"];

// ─── Состояние пользователей ──────────────
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
  pgSplitMode: "lines",
  pgParallel: 5,
  pgProvider: "fastgen",
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

// ─── Pending generators ────────────────────
const pendingGenerators = new Map();

// ─── Хранилище задач с ошибками для перегенерации ──
const failedTasks = new Map();

function storeFailedTask(chatId, errKey, taskData) {
  failedTasks.set(`${chatId}_${errKey}`, taskData);
  setTimeout(() => failedTasks.delete(`${chatId}_${errKey}`), 24 * 60 * 60 * 1000);
}

function getFailedTask(chatId, errKey) {
  return failedTasks.get(`${chatId}_${errKey}`);
}

// ─── Получение реального состояния лимитов из API ──
async function getRealVideoUsage() {
  try {
    const { data } = await axios.get(`${BASE_URL}/api/v5/usage`, {
      headers: v5Headers(), timeout: 10000,
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

// ─── Баланс UI ────────────────────────────
async function showBalance(chatId, msgId = null) {
  const s = getState(chatId);
  const text = await formatBalance();
  const kb = { inline_keyboard: [
    [{ text: "🔄 Обновить", callback_data: "refresh_balance" }],
    [{ text: "🔴 Отменить все задачи", callback_data: "cancel_all_ops" }],
    [{ text: "◀️ Назад", callback_data: "close_balance" }],
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

// ─── История UI ───────────────────────────
function showHistoryMenu(chatId, msgId = null, page = 0) {
  const h = getHistory(chatId);
  if (h.length === 0) {
    const text = "📭 История пуста.";
    const kb = { inline_keyboard: [[{ text: "◀️ Назад", callback_data: "open_misc" }]] };
    if (msgId) bot.editMessageText(text, { chat_id: chatId, message_id: msgId, reply_markup: kb }).catch(() => {});
    else bot.sendMessage(chatId, text, { reply_markup: kb });
    return;
  }
  const PAGE = 8;
  const totalPages = Math.ceil(h.length / PAGE);
  const slice = h.slice(page * PAGE, page * PAGE + PAGE);
  const rows = slice.map((item, i) => {
    const idx = page * PAGE + i;
    const icon = item.isImage ? "🖼" : "🎬";
    const time = item.ts ? new Date(item.ts).toLocaleTimeString("ru", { hour: "2-digit", minute: "2-digit" }) : "";
    return [{ text: `${icon} ${time} | ${item.model.slice(0, 14)} | ${item.prompt.slice(0, 18)}`, callback_data: `hist_${idx}` }];
  });
  const nav = [];
  if (page > 0) nav.push({ text: "◀️", callback_data: `hist_page_${page - 1}` });
  nav.push({ text: `${page + 1}/${totalPages}`, callback_data: "noop" });
  if (page < totalPages - 1) nav.push({ text: "▶️", callback_data: `hist_page_${page + 1}` });
  rows.push(nav);
  rows.push([{ text: "🗑 Очистить", callback_data: "hist_clear" }, { text: "◀️ Назад", callback_data: "open_misc" }]);
  const text = `📋 *История* (${h.length}):`;
  const opts = { parse_mode: "Markdown", reply_markup: { inline_keyboard: rows } };
  if (msgId) bot.editMessageText(text, { chat_id: chatId, message_id: msgId, ...opts }).catch(() => {});
  else bot.sendMessage(chatId, text, opts);
}

// ─── Главное меню ─────────────────────────
async function showMainMenu(chatId) {
  const s = getState(chatId);
  const im = IMAGE_MODELS[s.imgModel];
  const vm = VIDEO_MODELS[s.vidModel];
  const enhLabel = { always: "✨ Всегда", never: "⏭ Никогда", ask: "❓ Спрашивать" }[s.enhanceMode];
  const grokDurLabel = s.vidModel === "grok_vid" ? ` | ⏱ ${s.grokDuration || "6s"}` : "";
  const text =
    `🤖 *FastGen Bot v5*\n\n` +
    `🖼 Фото: *${im.label}* — ${im.credits}\n` +
    `🎬 Видео: *${vm.label}* — ${vm.credits}\n` +
    `📐 ${s.ratio} | 🔢 ${s.count} шт. | 🌱 ${s.seed === "fixed" ? "Фикс. seed" : "Случ. seed"}${grokDurLabel}\n` +
    `✨ Промпт: *${enhLabel}*`;
  const kb = { inline_keyboard: [
    [{ text: "🖼 Изображение", callback_data: "do_image" }, { text: "🖼📸 Из референсов", callback_data: "do_image_ref" }],
    [{ text: "🎬 Видео из текста", callback_data: "do_vtext" }, { text: "📸 Видео из фото", callback_data: "do_vimage" }],
    [{ text: "📦 Пакетный режим", callback_data: "do_batch" }],
    [{ text: "🎨 Модель фото", callback_data: "open_imgmodel" }, { text: "🎥 Модель видео", callback_data: "open_vidmodel" }],
    [{ text: "📐 Соотношение", callback_data: "open_ratio" }, { text: "🔢 Количество", callback_data: "open_count" }],
    [{ text: "📊 Баланс", callback_data: "show_balance" }, { text: "⚙️ Прочее", callback_data: "open_misc" }],
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

// ─── Меню Прочее ──────────────────────────
function showMiscMenu(chatId, msgId = null) {
  const s = getState(chatId);
  const enhLabel = { always: "✨ Всегда", never: "⏭ Никогда", ask: "❓ Спрашивать" }[s.enhanceMode];
  const seedLabel = s.seed === "fixed" ? "🌱 Seed: Фикс." : "🌱 Seed: Случ.";
  const text = `⚙️ *Прочее*`;
  const kb = { inline_keyboard: [
    [{ text: "🎞 Ключ. кадры", callback_data: "do_keyframes" }],
    [{ text: seedLabel, callback_data: "open_seed" }],
    ...(VIDEO_MODELS[s.vidModel]?.hasResolution ? [[{ text: `🖥 Разрешение Grok: ${s.resolution}`, callback_data: "open_resolution" }]] : []),
    ...(VIDEO_MODELS[s.vidModel]?.hasDuration ? [[{ text: `⏱ Длительность Grok: ${s.grokDuration || "6s"}`, callback_data: "open_grok_duration" }]] : []),
    [{ text: `✨ Промпт: ${enhLabel}`, callback_data: "open_enhance" }],
    [{ text: "🧠 Генерация промптов", callback_data: "open_promptgen" }],
    [{ text: "📋 История", callback_data: "show_history" }],
    [{ text: "◀️ Назад", callback_data: "back_menu" }],
  ]};
  if (msgId) bot.editMessageText(text, { chat_id: chatId, message_id: msgId, parse_mode: "Markdown", reply_markup: kb }).catch(() => {});
  else bot.sendMessage(chatId, text, { parse_mode: "Markdown", reply_markup: kb });
}

// ─── Меню длительности Grok ──────
function showGrokDurationMenu(chatId, msgId = null) {
  const s = getState(chatId);
  const cur = s.grokDuration || "6s";
  const text = `⏱ *Длительность Grok Video*\n\n6 сек = 1 кред\n10 сек = 3 кред`;
  const kb = { inline_keyboard: [
    [{ text: cur === "6s" ? "✅ 6 сек (1 кред)" : "6 сек (1 кред)", callback_data: "set_grok_dur_6s" },
     { text: cur === "10s" ? "✅ 10 сек (3 кред)" : "10 сек (3 кред)", callback_data: "set_grok_dur_10s" }],
    [{ text: "◀️ Назад", callback_data: "open_misc" }],
  ]};
  if (msgId) bot.editMessageText(text, { chat_id: chatId, message_id: msgId, parse_mode: "Markdown", reply_markup: kb }).catch(() => {});
  else bot.sendMessage(chatId, text, { parse_mode: "Markdown", reply_markup: kb });
}

// ─── Пакетный режим — утилиты ─────────────
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
    `⚙️ *Настройки пакета*\n\n` +
    `Модель: *${model.label}*\n` +
    `Соотношение: *${ratio}*\n` +
    (!isImage && isGrok ? `Разрешение: *${resolution}*\nДлительность: *${grokDuration}*\n` : "");

  const modelRows = isImage
    ? Object.entries(IMAGE_MODELS).map(([k, v]) => [{ text: `${imgModelKey === k ? "✅ " : ""}${v.label}`, callback_data: `bset_im_${k}` }])
    : Object.entries(VIDEO_MODELS).map(([k, v]) => [{ text: `${vidModelKey === k ? "✅ " : ""}${v.label}`, callback_data: `bset_vm_${k}` }]);

  const ratioRows = [RATIOS.map(r => ({ text: `${ratio === r ? "✅ " : ""}${r}`, callback_data: `bset_ratio_${r.replace(":", "x")}` }))];
  const resRow = !isImage && isGrok ? [[["480p", "720p"].map(r => ({ text: `${resolution === r ? "✅ " : ""}${r}`, callback_data: `bset_res_${r}` }))]] : [];
  const durRow = !isImage && isGrok ? [[["6s", "10s"].map(d => ({ text: `${grokDuration === d ? "✅ " : ""}${d === "6s" ? "6с(1кр)" : "10с(3кр)"}`, callback_data: `bset_dur_${d}` }))]] : [];

  const kb = { inline_keyboard: [
    ...modelRows,
    ...ratioRows,
    ...(resRow.length ? resRow[0].map(r => [r]) : []),
    ...(durRow.length ? durRow[0].map(d => [d]) : []),
    [{ text: "🔄 Сбросить (= главное меню)", callback_data: "bset_reset" }],
    [{ text: "◀️ Назад", callback_data: "do_batch_menu" }],
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
    "image":       `🖼 Фото из текста (${im.label})`,
    "video_text":  `🎬 Видео из текста (${vm.label})`,
    "video_image": `📸 Видео из фото+текста (${vm.label})`,
  };
  const text = `📦 *Пакетный режим — тип*\n\nВыбери что генерировать:\nТекущий: *${typeLabels[bt]}*`;
  const kb = { inline_keyboard: [
    [{ text: bt === "image"      ? "✅ 🖼 Фото из текста"       : "🖼 Фото из текста",       callback_data: "batch_type_image" }],
    [{ text: bt === "video_text" ? "✅ 🎬 Видео из текста"      : "🎬 Видео из текста",      callback_data: "batch_type_video_text" }],
    [{ text: bt === "video_image"? "✅ 📸 Видео из фото+текста" : "📸 Видео из фото+текста", callback_data: "batch_type_video_image" }],
    [{ text: "▶️ Продолжить →", callback_data: "do_batch_menu" }],
    [{ text: "❌ Отмена", callback_data: "back_menu" }],
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

  const typeIcon = isImage ? "🖼" : isVideoImage ? "📸" : "🎬";

  const text =
    `📦 *Пакетный режим*\n\n` +
    `${typeIcon} Тип: *${isImage ? "Фото" : isVideoImage ? "Видео из фото" : "Видео из текста"}*\n` +
    `🤖 Модель: *${model.label}*\n` +
    `📐 ${ratio}${!isImage && isGrokVid ? ` | 🖥 ${resolution} | ⏱ ${grokDuration}` : ""}\n` +
    `📝 Промптов: *${prompts.length}/${MAX}*\n` +
    (isVideoImage ? `📸 Фото: *${photos.length}*\n` : "") +
    `🔢 На 1 промпт: *${s.perPrompt}*\n` +
    (!isImage ? `⏱ Лимит видео/час: *${s.batchHourlyLimit}*\n` : "") +
    `Всего задач: *${totalTasks}*\n\n` +
    (prompts.length > 0 ? `*Промпт ${idx + 1}/${prompts.length}:*\n${prompts[idx]}` : "_Промптов нет_");

  const navRow = prompts.length > 0 ? [
    { text: "◀️", callback_data: "bp_prev" },
    { text: `${idx + 1}/${prompts.length}`, callback_data: "noop" },
    { text: "▶️", callback_data: "bp_next" },
    { text: "🗑 Удалить", callback_data: "bp_delete" },
  ] : [];

  const kb = { inline_keyboard: [
    [{ text: `${typeIcon} Сменить тип`, callback_data: "batch_change_type" }, { text: "⚙️ Настройки", callback_data: "batch_settings" }],
    ...(navRow.length ? [navRow] : []),
    [{ text: "✏️ Добавить промпты", callback_data: "batch_add_text" }, { text: "📄 Из .txt файла", callback_data: "batch_from_file" }],
    ...(isVideoImage ? [[{ text: "📸 Фото", callback_data: "batch_photos_menu" }]] : []),
    [{ text: `🔢 На 1 промпт: ${s.perPrompt}`, callback_data: "batch_per_prompt" }],
    ...(!isImage ? [[{ text: `⏱ Лимит видео/час: ${s.batchHourlyLimit}`, callback_data: "batch_hourly_limit" }]] : []),
    [{ text: "🚀 Генерировать!", callback_data: "batch_run" }],
    [{ text: "🗑 Очистить всё", callback_data: "batch_clear" }, { text: "❌ Отмена", callback_data: "back_menu" }],
  ]};
  if (msgId) bot.editMessageText(text, { chat_id: chatId, message_id: msgId, parse_mode: "Markdown", reply_markup: kb }).catch(() => {});
  else bot.sendMessage(chatId, text, { parse_mode: "Markdown", reply_markup: kb });
}

function showBatchPhotosMenu(chatId, msgId) {
  const s = getState(chatId);
  const photos = s.batchPhotos;
  const text = `📸 *Фото в пакете: ${photos.length}*\n\nОтправь фото в чат чтобы добавить.`;
  const rows = photos.map((_, i) => [{ text: `🗑 Удалить фото ${i + 1}`, callback_data: `del_photo_${i}` }]);
  rows.push([{ text: "◀️ Назад", callback_data: "do_batch_menu" }]);
  bot.editMessageText(text, { chat_id: chatId, message_id: msgId, parse_mode: "Markdown", reply_markup: { inline_keyboard: rows } }).catch(() => {});
}

// ─── Enhance меню ─────────────────────────
function showEnhanceMenu(chatId, msgId = null) {
  const s = getState(chatId);
  const mode = s.enhanceMode;
  const text = `✨ *Улучшение промпта*\n\nFastGen LLM улучшает промпт перед генерацией.\n\n*Режим:*`;
  const kb = { inline_keyboard: [
    [{ text: mode === "always" ? "✅ Всегда" : "Всегда", callback_data: "enhance_always" }],
    [{ text: mode === "ask"    ? "✅ Спрашивать" : "Спрашивать", callback_data: "enhance_ask" }],
    [{ text: mode === "never"  ? "✅ Никогда" : "Никогда", callback_data: "enhance_never" }],
    [{ text: "◀️ Назад", callback_data: "back_menu" }],
  ]};
  if (msgId) bot.editMessageText(text, { chat_id: chatId, message_id: msgId, parse_mode: "Markdown", reply_markup: kb }).catch(() => {});
  else bot.sendMessage(chatId, text, { parse_mode: "Markdown", reply_markup: kb });
}

// ─── Prompt gen меню ──────────────────────
function showPromptGenMenu(chatId, msgId = null) {
  const s = getState(chatId);
  const provLabel = { fastgen: "FastGen", openai: "OpenAI", gemini: "Gemini", openrouter: "OpenRouter" }[s.pgProvider] || s.pgProvider;
  const text =
    `🧠 *Генерация промптов*\n\n` +
    `Загрузи текст → ИИ разобьёт и сгенерирует промпт для каждой части.\n\n` +
    `✂️ Разбивка: *${s.pgSplitMode === "lines" ? "По строкам" : "По предложениям"}*\n` +
    `⚡ Параллельно: *${s.pgParallel}*\n` +
    `🤖 LLM: *${provLabel}*\n` +
    (s.pgProvider !== "fastgen" ? `🔑 API ключ: *${s.pgApiKey ? "✅ задан" : "❌ нет"}*\n` : "");
  const kb = { inline_keyboard: [
    [{ text: `${s.pgSplitMode === "lines" ? "✅ " : ""}Строки`, callback_data: "pg_split_lines" },
     { text: `${s.pgSplitMode === "sentences" ? "✅ " : ""}Предложения`, callback_data: "pg_split_sent" }],
    [{ text: `⚡ Параллельно: ${s.pgParallel}`, callback_data: "pg_parallel" }],
    [{ text: "✏️ Шаблон промпта", callback_data: "pg_template" }],
    [{ text: "🤖 LLM провайдер", callback_data: "pg_provider" }],
    ...(s.pgProvider !== "fastgen" ? [[{ text: "🔑 API ключ", callback_data: "pg_apikey" }]] : []),
    [{ text: "📝 Ввести текст", callback_data: "pg_input_text" }],
    [{ text: "📄 Загрузить .txt", callback_data: "pg_input_file" }],
    [{ text: "◀️ Назад", callback_data: "back_menu" }],
  ]};
  if (msgId) bot.editMessageText(text, { chat_id: chatId, message_id: msgId, parse_mode: "Markdown", reply_markup: kb }).catch(() => {});
  else bot.sendMessage(chatId, text, { parse_mode: "Markdown", reply_markup: kb });
}

// ─── Перегенерация ────────────────────────
function showRegenMenu(chatId, histIdx) {
  const h = getHistory(chatId);
  const item = h[histIdx];
  if (!item) return bot.sendMessage(chatId, "❌ Запись не найдена");
  const isImage = item.isImage;
  const text =
    `🔄 *Перегенерировать*\n\n` +
    `📝 _${item.prompt.slice(0, 200)}_\n` +
    `🤖 *${item.model}*`;
  const modelRows = isImage
    ? Object.entries(IMAGE_MODELS).map(([k, v]) => [{ text: v.label, callback_data: `regen_run_${histIdx}_im_${k}` }])
    : Object.entries(VIDEO_MODELS).map(([k, v]) => [{ text: v.label, callback_data: `regen_run_${histIdx}_vm_${k}` }]);
  const kb = { inline_keyboard: [
    [{ text: "✏️ Изменить промпт", callback_data: `regen_edit_${histIdx}` }],
    ...modelRows,
    [{ text: "🔄 Та же модель", callback_data: `regen_same_${histIdx}` }],
    [{ text: "❌ Отмена", callback_data: "back_menu" }],
  ]};
  bot.sendMessage(chatId, text, { parse_mode: "Markdown", reply_markup: kb });
}

// ─── callLLM ─────────────────────────────
async function callLLM(provider, apiKey, template, userText) {
  const prompt = template.replace("{TEXT}", userText);
  if (provider === "fastgen") {
    const { data } = await axios.post(`${BASE_URL}/api/v5/prompts/generate`, {
      user_prompt: prompt,
    }, { headers: v5Headers(), timeout: 30000 });
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
  throw new Error(`Неизвестный провайдер: ${provider}`);
}

function splitText(text, mode) {
  if (mode === "sentences") return text.match(/[^.!?\n]+[.!?\n]*/g)?.map(s => s.trim()).filter(Boolean) || [text];
  return text.split("\n").map(s => s.trim()).filter(Boolean);
}

async function runPromptGen(chatId, storyText) {
  const s = getState(chatId);
  const parts = splitText(storyText, s.pgSplitMode);
  if (parts.length === 0) return bot.sendMessage(chatId, "❌ Текст пустой.");
  const statusMsg = await bot.sendMessage(chatId,
    `🧠 *Генерация промптов*\nЧастей: ${parts.length} | Параллельно: ${s.pgParallel}\n⏳ Запускаю...`,
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
      `🧠 Генерация: ✓${done}/${parts.length}${errors > 0 ? ` ✗${errors}` : ""}`,
      { chat_id: chatId, message_id: statusMsg.message_id }
    ).catch(() => {});
  }
  if (results.length === 0) {
    await bot.editMessageText("❌ Не удалось сгенерировать промпты.", { chat_id: chatId, message_id: statusMsg.message_id });
    return showMainMenu(chatId);
  }
  const bt = s.batchType || "image";
  const MAX = bt === "image" ? 500 : 200;
  const available = MAX - s.batchPrompts.length;
  const toAdd = results.slice(0, available);
  s.batchPrompts.push(...toAdd);
  s.batchPromptIdx = 0;
  await bot.editMessageText(
    `✅ Сгенерировано ${toAdd.length} промптов!${errors > 0 ? `\n⚠️ Ошибок: ${errors}` : ""}\nДобавлены в пакет.`,
    { chat_id: chatId, message_id: statusMsg.message_id }
  ).catch(() => {});
  showBatchMenu(chatId);
}

// ─── Почасовой планировщик видео ─────────
const videoScheduler = {};

async function scheduleVideoChunk(chatId) {
  const job = videoScheduler[chatId];
  if (!job || job.stopped) {
    delete videoScheduler[chatId];
    return;
  }
  if (job.tasks.length === 0) {
    await bot.editMessageText(
      `✅ *Почасовой пакет завершён!*\n✓${job.doneSoFar} ✗${job.errorsSoFar}`,
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
        `⏳ Лимит API исчерпан (использовано ${usedAlready}/${apiLimit}).\n` +
        `🕐 Следующая пачка в *${resetTime}* UTC.\nМожно закрыть приложение — бот продолжит.`,
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
        `⏳ Локальный лимит исчерпан.\n🕐 Следующая пачка в *${resetTime}* UTC.\nМожно закрыть приложение — бот продолжит.`,
        { parse_mode: "Markdown" });
      setTimeout(() => scheduleVideoChunk(chatId), waitMs);
      return;
    }
    allowedThisChunk = remaining;
  }

  const chunk = job.tasks.splice(0, allowedThisChunk);

  const statusText = () =>
    `⏰ *Почасовой пакет (видео)*\n` +
    `🤖 ${model.label}\n` +
    `Всего: ${total} | Осталось: ${job.tasks.length}\n` +
    `✓${job.doneSoFar} ✗${job.errorsSoFar}\n` +
    `Текущая пачка: ${chunk.length} задач (лимит/час: ${hourlyLimit})`;

  if (!job.statusMsgId) {
    const m = await bot.sendMessage(chatId, statusText(), { parse_mode: "Markdown" });
    job.statusMsgId = m.message_id;
  } else {
    await bot.editMessageText(statusText(), { chat_id: chatId, message_id: job.statusMsgId, parse_mode: "Markdown" }).catch(() => {});
  }

  for (const task of chunk) {
    if (job.stopped) break;

    // Проверяем: до следующего часа UTC осталось меньше 5 минут?
    const timeUntilNextHour = getTimeUntilNextHourUTC();
    if (timeUntilNextHour < 5 * 60 * 1000) {
      // Не перегенерируем — сохраняем задачу
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
        `⚠️ Осталось <5 минут до конца часа. Задача ${task.idx} отложена для ручной перегенерации.`,
        { parse_mode: "Markdown",
          reply_markup: { inline_keyboard: [[{ text: "🔄 Перегенерировать эту задачу", callback_data: `retry_err_${errKey}` }]] }
        });
      job.errorsSoFar++;
      continue;
    }

    try {
      await genOne(chatId, batchS, task.prompt, task.operation, model, false, 0, 0, task.idx, task.imageRef, true);
      job.doneSoFar++;
    } catch {
      job.errorsSoFar++;
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
      `⏳ Пачка завершена: ✓${job.doneSoFar} ✗${job.errorsSoFar}\n` +
      `Осталось *${job.tasks.length}* задач.\n` +
      `🕐 Следующая пачка в *${resetTime}* UTC (сброс лимита).\n` +
      `Можно закрыть приложение — бот продолжит.`,
      { parse_mode: "Markdown" });
    setTimeout(() => scheduleVideoChunk(chatId), waitMs);
  } else {
    await bot.editMessageText(
      `✅ *Почасовой пакет завершён!*\n✓${job.doneSoFar} ✗${job.errorsSoFar}`,
      { chat_id: chatId, message_id: job.statusMsgId, parse_mode: "Markdown" }
    ).catch(() => {});
    delete videoScheduler[chatId];
    showMainMenu(chatId);
  }
}

// ─── Генерация одной задачи (v5) с автоперегенерацией до 5 раз ──────────
async function genOne(chatId, s, prompt, operation, model, isImage, index, total, batchIdx = null, imageRef = null, isScheduled = false) {
  const label = batchIdx || (total > 1 ? `${index}/${total}` : "");
  const errKey = `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const MAX_RETRIES = 5;

  const body = {
    operation,
    prompt,
    aspect_ratio: s.ratio,
    ...(s.seed === "fixed" && { seed: 42 }),
    ...(model.quality && { quality: model.quality }),
    ...(model.hasResolution && { resolution: s.resolution || "720p" }),
    ...(model.hasDuration && s.grokDuration && { duration: s.grokDuration }),
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
    seed: s.seed,
  };

  let lastError = null;
  let lastRefunded = false;

  for (let retry = 0; retry < MAX_RETRIES; retry++) {
    let genId;
    try {
      const created = await v5Create(body);
      genId = created.id;
      if (!genId) throw new Error(`v5Create returned no id: ${JSON.stringify(created).slice(0, 200)}`);
    } catch(e) {
      const detail = e.response?.data?.detail || e.response?.data?.message || e.response?.data?.error || e.message;
      const status = e.response?.status ? `[HTTP ${e.response.status}] ` : "";
      const errStr = typeof detail === "object" ? JSON.stringify(detail) : String(detail);
      console.error(`[genOne] create failed (retry ${retry + 1}/${MAX_RETRIES}): ${status}${errStr}`);

      lastError = new Error(`${status}${errStr}`);
      lastRefunded = false;

      // Если до следующего часа UTC осталось меньше 5 минут — прекращаем перегенерацию
      if (isScheduled && getTimeUntilNextHourUTC() < 5 * 60 * 1000) {
        storeFailedTask(chatId, errKey, taskData);
        await bot.sendMessage(chatId,
          `⚠️ До конца часа <5 мин. Перегенерация остановлена после ${retry} попыток.\n` +
          `❌ *Ошибка создания задачи*${label ? ` [${label}]` : ""}\n` +
          `🤖 ${model.label}\n${status}${errStr.slice(0, 400)}`,
          {
            parse_mode: "Markdown",
            reply_markup: { inline_keyboard: [[{ text: "🔄 Перегенерировать эту задачу", callback_data: `retry_err_${errKey}` }]] }
          });
        throw lastError;
      }

      // Иначе продолжаем retry
      continue;
    }

    addHistory(chatId, { model: model.label, prompt, genId, operation, isImage, ratio: s.ratio });

    let results;
    try {
      const pollResult = await v5Poll(genId);
      results = pollResult.results;
      const usage = pollResult.usage;

      // Успех! Тратим баланс (только если refunded=false или нет данных)
      if (!usage || usage.refunded !== true) {
        if (isImage) spendBalance("images", 1);
        else {
          const vidCost = model.hasDuration ? getGrokVideoCredits(s.grokDuration || "6s") : 1;
          spendBalance("videos", vidCost);
        }
      }

      const idxStr = batchIdx ? `*${batchIdx}* ` : "";
      const caption = `${idxStr}${model.label}\n📝 _${prompt.slice(0, 100)}_`;
      const regenKb = { inline_keyboard: [[{ text: "🔄 Перегенерировать", callback_data: "show_regen_0" }]] };

      try {
        for (const item of results) {
          let media;
          if (item.data) media = { type: "data_uri", value: item.data, mediaType: item.type };
          else if (item.download_path) {
            const url = `${STORAGE_URL}${item.download_path.startsWith("/") ? "" : "/"}${item.download_path}`;
            media = { type: "url", value: url, mediaType: item.type || (isImage ? "image" : "video") };
          }
          if (media) await sendV5Media(chatId, media, caption, regenKb);
        }
      } catch(e) {
        console.error(`[genOne] sendMedia failed genId=${genId}: ${e.message}`);
        await bot.sendMessage(chatId,
          `⚠️ Генерация завершена, но отправка файла не удалась\n${e.message.slice(0, 300)}`,
          { parse_mode: "Markdown" }
        );
      }

      return; // Успешное завершение
    } catch(e) {
      console.error(`[genOne] poll failed genId=${genId} (retry ${retry + 1}/${MAX_RETRIES}): ${e.message}`);

      // Парсим refunded из ошибки
      const errMsg = e.message || "";
      const refundedMatch = errMsg.match(/REFUNDED:(true|false)/);
      lastRefunded = refundedMatch ? refundedMatch[1] === "true" : false;
      lastError = new Error(errMsg.replace(/\|REFUNDED:(true|false)/, ""));

      // Если до следующего часа UTC осталось меньше 5 минут — прекращаем перегенерацию
      if (isScheduled && getTimeUntilNextHourUTC() < 5 * 60 * 1000) {
        storeFailedTask(chatId, errKey, taskData);
        await bot.sendMessage(chatId,
          `⚠️ До конца часа <5 мин. Перегенерация остановлена после ${retry + 1} попыток.\n` +
          `❌ *Ошибка генерации*${label ? ` [${label}]` : ""}\n🤖 ${model.label}\n${lastError.message.slice(0, 400)}\n` +
          `💳 Кредиты: ${lastRefunded ? "✅ возвращены" : "❌ потрачены"}`,
          {
            parse_mode: "Markdown",
            reply_markup: { inline_keyboard: [[{ text: "🔄 Перегенерировать эту задачу", callback_data: `retry_err_${errKey}` }]] }
          });
        throw lastError;
      }

      // Иначе продолжаем retry
      continue;
    }
  }

  // Все 5 попыток исчерпаны
  storeFailedTask(chatId, errKey, taskData);
  await bot.sendMessage(chatId,
    `❌ *Ошибка после ${MAX_RETRIES} попыток перегенерации*${label ? ` [${label}]` : ""}\n` +
    `🤖 ${model.label}\n` +
    `${lastError?.message?.slice(0, 400) || "Неизвестная ошибка"}\n` +
    `💳 Кредиты: ${lastRefunded ? "✅ возвращены" : "❌ потрачены"}`,
    {
      parse_mode: "Markdown",
      reply_markup: { inline_keyboard: [[{ text: "🔄 Перегенерировать эту задачу", callback_data: `retry_err_${errKey}` }]] }
    });
  throw lastError || new Error("Max retries exceeded");
}

// ─── Перегенерация задачи с ошибкой ──
async function retryFailedTask(chatId, errKey) {
  const task = getFailedTask(chatId, errKey);
  if (!task) {
    return bot.sendMessage(chatId, "❌ Задача не найдена (возможно устарела, прошло >24ч).");
  }

  const { prompt, operation, model, isImage, ratio, resolution, grokDuration, imageRef, seed } = task;

  const fakeS = {
    ratio,
    resolution: resolution || "720p",
    grokDuration: grokDuration || "6s",
    seed: seed || "random",
    pendingRefImages: [],
  };

  const statusMsg = await bot.sendMessage(chatId,
    `🔄 *Перегенерирую задачу...*\n🤖 ${model.label}\n📝 _${prompt.slice(0, 80)}_`,
    { parse_mode: "Markdown" }
  );

  try {
    await genOne(chatId, fakeS, prompt, operation, model, isImage, 0, 0, null, imageRef, false);
    await bot.editMessageText("✅ Перегенерировано!", { chat_id: chatId, message_id: statusMsg.message_id }).catch(() => {});
    failedTasks.delete(`${chatId}_${errKey}`);
  } catch(e) {
    await bot.editMessageText(
      `❌ Снова ошибка: ${e.message.slice(0, 200)}`,
      { chat_id: chatId, message_id: statusMsg.message_id }
    ).catch(() => {});
  }
}

// ─── handlePromptAndGenerate ──────────────
async function handlePromptAndGenerate(chatId, s, rawPrompt, generatorFn) {
  const mode = s.enhanceMode || "ask";
  const isVideo = s.tab === "video_text" || s.tab === "video_ref";

  if (mode === "never") return generatorFn(rawPrompt);

  if (mode === "always") {
    const waitMsg = await bot.sendMessage(chatId, "✨ Улучшаю промпт...");
    let enhanced = null;
    try {
      enhanced = await v5EnhancePrompt(rawPrompt, isVideo);
    } catch(e) {
      console.log(`[enhance] failed: ${e.message}`);
    }
    await bot.deleteMessage(chatId, waitMsg.message_id).catch(() => {});
    if (enhanced && enhanced !== rawPrompt) {
      await bot.sendMessage(chatId,
        `✨ *Промпт улучшен:*\n_${enhanced.slice(0, 300)}${enhanced.length > 300 ? "..." : ""}_`,
        { parse_mode: "Markdown" }
      );
      return generatorFn(enhanced);
    }
    return generatorFn(rawPrompt);
  }

  // ask
  const previewMsg = await bot.sendMessage(chatId,
    `✨ *Улучшить промпт?*\n\n📝 _${rawPrompt.slice(0, 200)}${rawPrompt.length > 200 ? "..." : ""}_`,
    { parse_mode: "Markdown", reply_markup: { inline_keyboard: [
      [{ text: "✨ Улучшить", callback_data: "enhance_yes" }, { text: "⏭ Оригинал", callback_data: "enhance_no" }],
    ]}}
  );
  s.pendingPrompt = rawPrompt;
  s.pendingIsVideo = isVideo;
  s.pendingMsgId = previewMsg.message_id;
  s.pendingGenKey = `gen_${Date.now()}`;
  pendingGenerators.set(s.pendingGenKey, generatorFn);
}

// ─── runNormal ────────────────────────────
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
      return bot.sendMessage(chatId, `❌ Модель *${model.label}* не поддерживает видео из фото.`, { parse_mode: "Markdown" });
    }
  } else {
    model = VIDEO_MODELS[s.vidModel];
    operation = model.opImg || model.opText;
  }

  const doGenerate = async (finalPrompt) => {
    const count = s.count;
    const queue = isImage ? imageQueue : videoQueue;
    let done = 0, errors = 0;
    const statusMsg = await bot.sendMessage(chatId,
      `⏳ *${count} задач в очереди*\n🎨 ${model.label}\n💳 ${model.credits}\n(макс. 10 параллельно)`,
      { parse_mode: "Markdown" });

    const tasks = Array.from({ length: count }, (_, i) =>
      queue(() => genOne(chatId, s, finalPrompt, operation, model, isImage, i + 1, count))
        .then(() => done++)
        .catch(() => errors++)
        .finally(() => {
          bot.editMessageText(
            `⏳ Прогресс: ✓${done}/${count}${errors > 0 ? ` ✗${errors}` : ""}\n🎨 ${model.label}`,
            { chat_id: chatId, message_id: statusMsg.message_id, parse_mode: "Markdown" }
          ).catch(() => {});
        })
    );
    await Promise.allSettled(tasks);
    await bot.editMessageText(
      `✅ Готово! ✓${done}${errors > 0 ? ` ✗${errors}` : ""}`,
      { chat_id: chatId, message_id: statusMsg.message_id }
    ).catch(() => {});
    showMainMenu(chatId);
  };

  await handlePromptAndGenerate(chatId, s, prompt, doGenerate);
}

// ─── runKeyframes ─────────────────────────
async function runKeyframes(chatId, s, prompt) {
  const doGenerate = async (finalPrompt) => {
    const model = VIDEO_MODELS[s.vidModel];
    if (!model.opKf) {
      return bot.sendMessage(chatId, `❌ Модель *${model.label}* не поддерживает ключевые кадры.`, { parse_mode: "Markdown" });
    }
    const statusMsg = await bot.sendMessage(chatId, `⏳ Ключевые кадры...\n🎥 ${model.label}`);
    try {
      const inputs = [];
      if (s.keyframeStart) inputs.push(await tgPhotoToDataUri(s.keyframeStart));
      if (s.keyframeEnd) inputs.push(await tgPhotoToDataUri(s.keyframeEnd));

      const body = {
        operation: model.opKf,
        prompt: finalPrompt,
        aspect_ratio: s.ratio,
        inputs,
        keyframes: true,
        ...(s.seed === "fixed" && { seed: 42 }),
      };
      const created = await v5Create(body);
      const pollResult = await v5Poll(created.id);

      // Проверяем refunded
      if (!pollResult.usage || pollResult.usage.refunded !== true) {
        spendBalance("videos", 1);
      }

      await bot.editMessageText("✅ Готово!", { chat_id: chatId, message_id: statusMsg.message_id });
      for (const item of pollResult.results) {
        if (item.data || item.download_path) {
          const url = item.data ? null : `${STORAGE_URL}${item.download_path.startsWith("/") ? "" : "/"}${item.download_path}`;
          const media = item.data
            ? { type: "data_uri", value: item.data, mediaType: "video" }
            : { type: "url", value: url, mediaType: "video" };
          await sendV5Media(chatId, media, `🎞 Ключ. кадры\n📝 _${finalPrompt.slice(0, 100)}_`);
        }
      }
    } catch(e) {
      const errMsg = e.message?.replace(/\|REFUNDED:(true|false)/, "") || "Неизвестная ошибка";
      await bot.editMessageText(`❌ ${errMsg.slice(0, 300)}`, { chat_id: chatId, message_id: statusMsg.message_id });
    }
    showMainMenu(chatId);
  };
  await handlePromptAndGenerate(chatId, s, prompt, doGenerate);
}

// ─── runBatch ─────────────────────────────
async function runBatch(chatId) {
  const s = getState(chatId);
  const { bt, isImage, model, ratio, resolution, grokDuration, vidModelKey } = batchEffective(s);
  const isVideoImage = bt === "video_image";
  const batchS = { ...s, ratio, resolution, grokDuration };
  const prompts = [...s.batchPrompts];
  const photos = [...s.batchPhotos];
  const perPrompt = s.perPrompt || 1;

  if (prompts.length === 0 && photos.length === 0) return bot.sendMessage(chatId, "❌ Нет промптов или фото!");
  if (isVideoImage && photos.length === 0) return bot.sendMessage(chatId, "❌ Добавь фото для режима «Видео из фото»!");

  let photoRefs = [];
  if (isVideoImage && photos.length > 0) {
    const uploadMsg = await bot.sendMessage(chatId, `⏳ Подготавливаю ${photos.length} фото...`);
    try {
      for (let i = 0; i < photos.length; i += 5) {
        const chunk = photos.slice(i, i + 5);
        const results = await Promise.allSettled(chunk.map(fid => tgPhotoToDataUri(fid)));
        for (const r of results) {
          if (r.status === "fulfilled") photoRefs.push(r.value);
          else throw new Error(`Ошибка загрузки фото ${photoRefs.length + 1}: ${r.reason?.message || r.reason}`);
        }
        await bot.editMessageText(`⏳ Подготовлено ${photoRefs.length}/${photos.length} фото...`, {
          chat_id: chatId, message_id: uploadMsg.message_id
        }).catch(() => {});
      }
      await bot.editMessageText(`✅ Фото готовы (${photoRefs.length})`, { chat_id: chatId, message_id: uploadMsg.message_id });
    } catch(e) {
      await bot.editMessageText(`❌ Ошибка загрузки фото: ${e.message}`, { chat_id: chatId, message_id: uploadMsg.message_id });
      return;
    }
  }

  const tasks = [];
  if (isVideoImage) {
    for (let fi = 0; fi < photos.length; fi++) {
      const prompt = prompts[fi] || prompts[0] || "animate";
      const op = model.opImg || model.opText;
      for (let vi = 0; vi < perPrompt; vi++)
        tasks.push({ prompt, idx: `ф${fi + 1}.${vi + 1}`, operation: op, imageRef: photoRefs[fi], model });
    }
    for (let pi = photos.length; pi < prompts.length; pi++)
      for (let vi = 0; vi < perPrompt; vi++)
        tasks.push({ prompt: prompts[pi], idx: `т${pi + 1}.${vi + 1}`, operation: model.opText, imageRef: null, model });
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
      `⏰ *Почасовой видео-пакет запущен!*\n` +
      `Всего задач: *${total}*\nЛимит/час: *${hourlyLimit}*\n` +
      `Пачек: *${Math.ceil(total / hourlyLimit)}*\n\n` +
      `Первая пачка стартует сейчас.`,
      { parse_mode: "Markdown" });
    s.batchPrompts = []; s.batchPhotos = []; s.batchPromptIdx = 0;
    scheduleVideoChunk(chatId);
    return;
  }

  let done = 0, errors = 0;
  const statusMsg = await bot.sendMessage(chatId,
    `📦 *Пакетный режим*\nЗадач: ${total} | 🤖 ${model.label}\n💳 ${model.credits}`,
    { parse_mode: "Markdown" });

  // 10 параллельных потоков, результаты отправляются строго по порядку
  const CONCURRENCY = 10;
  // Каждая задача: генерируем параллельно, отправляем по цепочке
  // sendChain — промис предыдущей отправки, ждём его перед отправкой текущей
  let sendChain = Promise.resolve();

  async function genOneOrdered(task) {
    const taskModel = task.model || model;
    const errKey = `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const MAX_RETRIES = 5;
    const label = task.idx;
    const body = {
      operation: task.operation,
      prompt: task.prompt,
      aspect_ratio: batchS.ratio,
      ...(batchS.seed === "fixed" && { seed: 42 }),
      ...(taskModel.quality && { quality: taskModel.quality }),
      ...(taskModel.hasResolution && { resolution: batchS.resolution || "720p" }),
      ...(taskModel.hasDuration && batchS.grokDuration && { duration: batchS.grokDuration }),
    };
    if (task.imageRef) body.inputs = [task.imageRef];
    else if (batchS.pendingRefImages && batchS.pendingRefImages.length > 0) body.inputs = batchS.pendingRefImages;

    const taskData = {
      prompt: task.prompt, operation: task.operation, model: taskModel,
      isImage, ratio: batchS.ratio, resolution: batchS.resolution || "720p",
      grokDuration: batchS.grokDuration || "6s", imageRef: task.imageRef || null, seed: batchS.seed,
    };

    let lastError = null, lastRefunded = false;

    for (let retry = 0; retry < MAX_RETRIES; retry++) {
      let genId;
      try {
        const created = await v5Create(body);
        genId = created.id;
        if (!genId) throw new Error(`v5Create returned no id: ${JSON.stringify(created).slice(0, 200)}`);
      } catch(e) {
        const detail = e.response?.data?.detail || e.response?.data?.message || e.response?.data?.error || e.message;
        const status = e.response?.status ? `[HTTP ${e.response.status}] ` : "";
        const errStr = typeof detail === "object" ? JSON.stringify(detail) : String(detail);
        console.error(`[runBatch] create failed [${label}] retry ${retry + 1}/${MAX_RETRIES}: ${status}${errStr}`);
        lastError = new Error(`${status}${errStr}`);
        lastRefunded = false;
        continue;
      }

      addHistory(chatId, { model: taskModel.label, prompt: task.prompt, genId, operation: task.operation, isImage, ratio: batchS.ratio });

      try {
        const pollResult = await v5Poll(genId);
        const usage = pollResult.usage;
        if (!usage || usage.refunded !== true) {
          if (isImage) spendBalance("images", 1);
          else {
            const vidCost = taskModel.hasDuration ? getGrokVideoCredits(batchS.grokDuration || "6s") : 1;
            spendBalance("videos", vidCost);
          }
        }
        // Ждём своей очереди на отправку
        const myResults = pollResult.results;
        sendChain = sendChain.then(async () => {
          const idxStr = `*${label}* `;
          const caption = `${idxStr}${taskModel.label}\n📝 _${task.prompt.slice(0, 100)}_`;
          const regenKb = { inline_keyboard: [[{ text: "🔄 Перегенерировать", callback_data: "show_regen_0" }]] };
          try {
            for (const item of myResults) {
              let media;
              if (item.data) media = { type: "data_uri", value: item.data, mediaType: item.type };
              else if (item.download_path) {
                const url = `${STORAGE_URL}${item.download_path.startsWith("/") ? "" : "/"}${item.download_path}`;
                media = { type: "url", value: url, mediaType: item.type || (isImage ? "image" : "video") };
              }
              if (media) await sendV5Media(chatId, media, caption, regenKb);
            }
          } catch(e) {
            console.error(`[runBatch] sendMedia failed [${label}]: ${e.message}`);
            await bot.sendMessage(chatId, `⚠️ [${label}] Генерация завершена, но отправка не удалась\n${e.message.slice(0, 300)}`).catch(() => {});
          }
        });
        return; // успех
      } catch(e) {
        const errMsg = e.message || "";
        const refundedMatch = errMsg.match(/REFUNDED:(true|false)/);
        lastRefunded = refundedMatch ? refundedMatch[1] === "true" : false;
        lastError = new Error(errMsg.replace(/\|REFUNDED:(true|false)/, ""));
        console.error(`[runBatch] poll failed [${label}] retry ${retry + 1}/${MAX_RETRIES}: ${lastError.message}`);
        continue;
      }
    }

    // Все 5 попыток исчерпаны — ставим ошибку в очередь отправки в нужном порядке
    storeFailedTask(chatId, errKey, taskData);
    sendChain = sendChain.then(async () => {
      await bot.sendMessage(chatId,
        `❌ *Ошибка после ${MAX_RETRIES} попыток* [${label}]\n` +
        `🤖 ${taskModel.label}\n` +
        `${lastError?.message?.slice(0, 400) || "Неизвестная ошибка"}\n` +
        `💳 Кредиты: ${lastRefunded ? "✅ возвращены" : "❌ потрачены"}`,
        {
          parse_mode: "Markdown",
          reply_markup: { inline_keyboard: [[{ text: "🔄 Перегенерировать эту задачу", callback_data: `retry_err_${errKey}` }]] }
        }
      ).catch(() => {});
    });
    throw lastError || new Error("Max retries exceeded");
  }

  // Запускаем через семафор (10 потоков)
  const sem = createQueue(CONCURRENCY);
  const allTasks = tasks.map(task =>
    sem(() => genOneOrdered(task))
      .then(() => done++)
      .catch(() => errors++)
      .finally(() => {
        bot.editMessageText(
          `📦 Пакет: ✓${done}/${total}${errors > 0 ? ` ✗${errors}` : ""}`,
          { chat_id: chatId, message_id: statusMsg.message_id, parse_mode: "Markdown" }
        ).catch(() => {});
      })
  );
  await Promise.allSettled(allTasks);
  await sendChain; // ждём последней отправки
  await bot.editMessageText(
    `✅ Пакет готов! ✓${done}${errors > 0 ? ` ✗${errors}` : ""}`,
    { chat_id: chatId, message_id: statusMsg.message_id }
  ).catch(() => {});
  s.batchPrompts = []; s.batchPhotos = []; s.batchPromptIdx = 0;
  showMainMenu(chatId);
}

// ─── runRegenItem ─────────────────────────
async function runRegenItem(chatId, item, isImage, modelOverride = null) {
  const modelMap = isImage ? IMAGE_MODELS : VIDEO_MODELS;
  const model = modelOverride || Object.values(modelMap).find(m => m.label === item.model) || Object.values(modelMap)[0];
  const operation = isImage ? model.operation : model.opText;
  const s = getState(chatId);
  const statusMsg = await bot.sendMessage(chatId, `⏳ Перегенерирую...\n🎨 ${model.label}`);
  try {
    const body = { operation, prompt: item.prompt, aspect_ratio: item.ratio || s.ratio, ...(s.seed === "fixed" && { seed: 42 }) };
    const created = await v5Create(body);
    const pollResult = await v5Poll(created.id);

    // Проверяем refunded
    if (!pollResult.usage || pollResult.usage.refunded !== true) {
      if (isImage) spendBalance("images", 1); else spendBalance("videos", 1);
    }

    addHistory(chatId, { model: model.label, prompt: item.prompt, genId: created.id, operation, isImage, ratio: item.ratio || s.ratio });
    await bot.editMessageText("✅ Перегенерировано!", { chat_id: chatId, message_id: statusMsg.message_id });
    for (const res of pollResult.results) {
      if (res.data || res.download_path) {
        const url = res.data ? null : `${STORAGE_URL}${res.download_path.startsWith("/") ? "" : "/"}${res.download_path}`;
        const media = res.data ? { type: "data_uri", value: res.data, mediaType: res.type } : { type: "url", value: url, mediaType: res.type };
        await sendV5Media(chatId, media, `🔄 ${model.label}\n📝 _${item.prompt.slice(0, 100)}_`,
          { inline_keyboard: [[{ text: "🔄 Перегенерировать", callback_data: "show_regen_0" }]] });
      }
    }
  } catch(e) {
    const detail = e.response?.data?.detail || e.message?.replace(/\|REFUNDED:(true|false)/, "") || e.message;
    await bot.editMessageText(`❌ ${String(detail).slice(0, 300)}`, { chat_id: chatId, message_id: statusMsg.message_id });
  }
  showMainMenu(chatId);
}

// ─── /check ───────────────────────────────
async function checkGeneration(chatId, genId) {
  const msg = await bot.sendMessage(chatId, `🔍 Проверяю \`${genId}\`...`, { parse_mode: "Markdown" });
  try {
    const { data } = await axios.get(`${BASE_URL}/api/v5/generations/${genId}`, {
      headers: v5Headers(), timeout: 15000,
    });
    const st = data.status;
    await bot.editMessageText(`Статус: *${st}*`, { chat_id: chatId, message_id: msg.message_id, parse_mode: "Markdown" });
    if (st === "succeeded" && data.results?.length > 0) {
      for (const item of data.results) {
        if (item.data || item.download_path) {
          const url = item.data ? null : `${STORAGE_URL}${item.download_path.startsWith("/") ? "" : "/"}${item.download_path}`;
          const media = item.data ? { type: "data_uri", value: item.data, mediaType: item.type } : { type: "url", value: url, mediaType: item.type };
          await sendV5Media(chatId, media, "✅ Результат");
        }
      }
    }
  } catch(e) {
    await bot.editMessageText(`❌ ${e.message.slice(0, 300)}`, { chat_id: chatId, message_id: msg.message_id });
  }
}

// ─── Callback handler ─────────────────────
const mediaGroupTimers = new Map();
const mediaGroupBuffers = new Map(); // буфер для media group: media_group_id -> [{ fileId, messageId }]

bot.on("callback_query", async (query) => {
  const chatId = query.message.chat.id;
  const msgId  = query.message.message_id;
  const data   = query.data;
  const s      = getState(chatId);

  bot.answerCallbackQuery(query.id).catch(() => {});

  function edit(text, kb) {
    return bot.editMessageText(text, { chat_id: chatId, message_id: msgId, parse_mode: "Markdown", reply_markup: kb }).catch(() => {});
  }
  function del() { return bot.deleteMessage(chatId, msgId).catch(() => {}); }
  const cancelKb = { inline_keyboard: [[{ text: "❌ Отмена", callback_data: "back_menu" }]] };

  if (data === "noop") return;
  if (data === "back_menu" || data === "cancel") { s.step = null; del(); return showMainMenu(chatId); }
  if (data === "close_balance") { s.menuMsgId = msgId; return showMainMenu(chatId); }
  if (data === "show_balance")  { s.menuMsgId = msgId; return showBalance(chatId, msgId); }
  if (data === "refresh_balance") return showBalance(chatId, msgId);
  if (data === "open_misc")     { s.menuMsgId = msgId; return showMiscMenu(chatId, msgId); }
  if (data === "show_history")  { s.menuMsgId = msgId; return showHistoryMenu(chatId, msgId, 0); }

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
    const time = item.ts ? new Date(item.ts).toLocaleString("ru") : "—";
    const icon = item.isImage ? "🖼" : "🎬";
    return edit(
      `📋 *Запись ${idx + 1}*\n\n${icon} *${item.model}*\n🕐 ${time}\n📝 _${item.prompt}_\n\n🔑 ID: \`${item.genId}\``,
      { inline_keyboard: [
        [{ text: "🔄 Перегенерировать", callback_data: `show_regen_${idx}` }],
        [{ text: "◀️ Назад к истории", callback_data: "show_history" }],
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
      return bot.sendMessage(chatId, "✏️ Отправь новый промпт:", cancelKb);
    }
  }

  // ── Режимы генерации
  if (data === "do_image") {
    s.step = "waiting_prompt"; s.tab = "image"; s.mode = "normal";
    return edit(`🖼 *Изображение*\n${IMAGE_MODELS[s.imgModel].label}\n\nНапиши промпт:`, cancelKb);
  }
  if (data === "do_image_ref") {
    s.pendingRefImages = []; s.tab = "image_ref"; s.mode = "normal"; s.step = "waiting_ref_photos";
    return edit("🖼📸 *Изображение из референсов*\n\nОтправь до 10 фото, затем нажми кнопку:", {
      inline_keyboard: [
        [{ text: "✅ Референсы готовы, ввести промпт", callback_data: "ref_photos_done" }],
        [{ text: "❌ Отмена", callback_data: "back_menu" }],
      ]
    });
  }
  if (data === "ref_photos_done") {
    if (!s.pendingRefImages || s.pendingRefImages.length === 0)
      return bot.sendMessage(chatId, "❌ Сначала отправь хотя бы 1 фото!");
    s.step = "waiting_prompt";
    return bot.sendMessage(chatId, `✅ Референсов: ${s.pendingRefImages.length}\n\nНапиши промпт:`, {
      reply_markup: { inline_keyboard: [[{ text: "❌ Отмена", callback_data: "back_menu" }]] }
    });
  }
  if (data === "do_vtext") {
    s.step = "waiting_prompt"; s.tab = "video_text"; s.mode = "normal";
    return edit(`🎬 *Видео из текста*\n${VIDEO_MODELS[s.vidModel].label}\n\nОпиши видео:`, cancelKb);
  }
  if (data === "do_vimage") {
    const maxRef = s.vidModel === "grok_vid" ? 7 : 3;
    s.pendingRefImages = []; s.tab = "video_ref"; s.mode = "normal"; s.step = "waiting_vid_ref_photos";
    return edit(`📸 *Видео из фото*\n${VIDEO_MODELS[s.vidModel].label}\n\nОтправь до ${maxRef} фото:`, {
      inline_keyboard: [
        [{ text: "✅ Готово, ввести промпт", callback_data: "vid_ref_photos_done" }],
        [{ text: "❌ Отмена", callback_data: "back_menu" }],
      ]
    });
  }
  if (data === "vid_ref_photos_done") {
    if (!s.pendingRefImages || s.pendingRefImages.length === 0)
      return bot.sendMessage(chatId, "❌ Сначала отправь хотя бы 1 фото!");
    s.step = "waiting_prompt";
    return bot.sendMessage(chatId, `✅ Фото: ${s.pendingRefImages.length}\n\nНапиши описание видео:`, {
      reply_markup: { inline_keyboard: [[{ text: "❌ Отмена", callback_data: "back_menu" }]] }
    });
  }
  if (data === "do_keyframes") {
    s.step = "waiting_keyframe_start"; s.tab = "video_text"; s.mode = "keyframes";
    s.keyframeStart = null; s.keyframeEnd = null;
    return edit("🎞 *Ключевые кадры*\n\nОтправь *первое* фото (начало):", cancelKb);
  }
  if (data === "kf_skip_end") { s.step = "waiting_prompt"; return edit("✅ Только начальный кадр.\n\nНапиши описание:", cancelKb); }

  // ── Пакетный режим
  if (data === "do_batch") { s.mode = "batch"; return showBatchTypeMenu(chatId, msgId); }
  if (data === "do_batch_menu") { s.mode = "batch"; return showBatchMenu(chatId, msgId); }
  if (data === "batch_change_type") return showBatchTypeMenu(chatId, msgId);
  if (data === "batch_type_image")       { s.batchType = "image";       saveState(chatId); return showBatchTypeMenu(chatId, msgId); }
  if (data === "batch_type_video_text")  { s.batchType = "video_text";  saveState(chatId); return showBatchTypeMenu(chatId, msgId); }
  if (data === "batch_type_video_image") { s.batchType = "video_image"; saveState(chatId); return showBatchTypeMenu(chatId, msgId); }
  if (data === "batch_add_text")  { s.step = "waiting_batch_prompts"; return edit("✏️ Напиши промпты, каждый с новой строки:", cancelKb); }
  if (data === "batch_from_file") { s.step = "waiting_txt_file"; return edit("📄 Отправь .txt файл с промптами:", cancelKb); }
  if (data === "batch_photos_menu") return showBatchPhotosMenu(chatId, msgId);
  if (data.startsWith("del_photo_")) { s.batchPhotos.splice(parseInt(data.replace("del_photo_", "")), 1); return showBatchPhotosMenu(chatId, msgId); }
  if (data === "batch_per_prompt") {
    return edit("🔢 Сколько на 1 промпт/фото?", { inline_keyboard: [
      [[1, 2, 3, 4, 5].map(n => ({ text: s.perPrompt === n ? `✅ ${n}` : `${n}`, callback_data: `set_pp_${n}` }))],
      [{ text: "◀️ Назад", callback_data: "do_batch_menu" }],
    ]});
  }
  if (data.startsWith("set_pp_")) { s.perPrompt = parseInt(data.replace("set_pp_", "")); return showBatchMenu(chatId, msgId); }
  if (data === "batch_hourly_limit") {
    const cur = s.batchHourlyLimit || 15;
    return edit(`⏱ *Лимит видео/час*\nСейчас: *${cur}*`, { inline_keyboard: [
      [[5, 10, 15, 20].map(n => ({ text: cur === n ? `✅ ${n}` : `${n}`, callback_data: `set_hl_${n}` }))],
      [[25, 30, 40, 50].map(n => ({ text: cur === n ? `✅ ${n}` : `${n}`, callback_data: `set_hl_${n}` }))],
      [{ text: "✏️ Своё число", callback_data: "set_hl_custom" }],
      [{ text: "◀️ Назад", callback_data: "do_batch_menu" }],
    ]});
  }
  if (data.startsWith("set_hl_")) {
    const val = data.replace("set_hl_", "");
    if (val === "custom") { s.step = "waiting_hourly_limit"; return edit("⏱ Введи число (1–500):", { inline_keyboard: [[{ text: "❌ Отмена", callback_data: "do_batch_menu" }]] }); }
    s.batchHourlyLimit = parseInt(val); saveState(chatId); return showBatchMenu(chatId, msgId);
  }
  if (data === "batch_clear") { s.batchPrompts = []; s.batchPhotos = []; s.batchPromptIdx = 0; return showBatchMenu(chatId, msgId); }
  if (data === "batch_run") { del(); return runBatch(chatId); }

  // ── Настройки пакета
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

  // ── Модели
  if (data === "open_imgmodel") {
    const rows = Object.entries(IMAGE_MODELS).map(([k, v]) => [{ text: `${s.imgModel === k ? "✅ " : ""}${v.label} (${v.credits})`, callback_data: `set_im_${k}` }]);
    rows.push([{ text: "◀️ Назад", callback_data: "back_menu" }]);
    return edit("🎨 *Модель изображения:*", { inline_keyboard: rows });
  }
  if (data.startsWith("set_im_")) { s.imgModel = data.replace("set_im_", ""); saveState(chatId); del(); return showMainMenu(chatId); }

  if (data === "open_vidmodel") {
    const rows = Object.entries(VIDEO_MODELS).map(([k, v]) => [{ text: `${s.vidModel === k ? "✅ " : ""}${v.label} (${v.credits})`, callback_data: `set_vm_${k}` }]);
    rows.push([{ text: "◀️ Назад", callback_data: "back_menu" }]);
    return edit("🎥 *Модель видео:*", { inline_keyboard: rows });
  }
  if (data.startsWith("set_vm_")) { s.vidModel = data.replace("set_vm_", ""); saveState(chatId); del(); return showMainMenu(chatId); }

  if (data === "open_ratio") {
    const rows = [];
    for (let i = 0; i < RATIOS.length; i += 3) rows.push(RATIOS.slice(i, i + 3).map(r => ({ text: s.ratio === r ? `✅ ${r}` : r, callback_data: `set_r_${r.replace(":", "x")}` })));
    rows.push([{ text: "◀️ Назад", callback_data: "back_menu" }]);
    return edit("📐 *Соотношение сторон:*", { inline_keyboard: rows });
  }
  if (data.startsWith("set_r_")) { s.ratio = data.replace("set_r_", "").replace("x", ":"); saveState(chatId); del(); return showMainMenu(chatId); }

  if (data === "open_count") { s.step = "waiting_count"; return edit(`🔢 *Количество* (сейчас: ${s.count})\n\nНапиши от 1 до 500:`, cancelKb); }

  if (data === "open_seed") {
    return edit("🌱 *Seed:*", { inline_keyboard: [
      [{ text: s.seed === "random" ? "✅ Случайный" : "Случайный", callback_data: "set_seed_random" },
       { text: s.seed === "fixed"  ? "✅ Фикс." : "Фиксированный", callback_data: "set_seed_fixed" }],
      [{ text: "◀️ Назад", callback_data: "back_menu" }],
    ]});
  }
  if (data === "set_seed_random") { s.seed = "random"; saveState(chatId); del(); return showMainMenu(chatId); }
  if (data === "set_seed_fixed")  { s.seed = "fixed";  saveState(chatId); del(); return showMainMenu(chatId); }

  if (data === "open_resolution") {
    return edit("🖥 *Разрешение Grok Video:*", { inline_keyboard: [
      [["480p", "720p"].map(r => ({ text: (s.resolution || "720p") === r ? `✅ ${r}` : r, callback_data: `set_res_${r}` }))],
      [{ text: "◀️ Назад", callback_data: "open_misc" }],
    ]});
  }
  if (data.startsWith("set_res_")) { s.resolution = data.replace("set_res_", ""); saveState(chatId); return showMiscMenu(chatId, msgId); }

  if (data === "open_grok_duration") return showGrokDurationMenu(chatId, msgId);
  if (data === "set_grok_dur_6s")  { s.grokDuration = "6s";  saveState(chatId); return showGrokDurationMenu(chatId, msgId); }
  if (data === "set_grok_dur_10s") { s.grokDuration = "10s"; saveState(chatId); return showGrokDurationMenu(chatId, msgId); }

  // ── Enhance
  if (data === "open_enhance") return showEnhanceMenu(chatId, msgId);
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
    const waitMsg = await bot.sendMessage(chatId, "✨ Улучшаю промпт...");
    let enhanced = null;
    try { enhanced = await v5EnhancePrompt(rawPrompt, isVideo); } catch(e) { console.log(`[enhance] ${e.message}`); }
    await bot.deleteMessage(chatId, waitMsg.message_id).catch(() => {});
    if (enhanced && enhanced !== rawPrompt) {
      await bot.sendMessage(chatId,
        `✨ *Промпт улучшен:*\n_${enhanced.slice(0, 300)}${enhanced.length > 300 ? "..." : ""}_`,
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

  // ── Отмена всех задач
  if (data === "cancel_all_ops") {
    await bot.answerCallbackQuery(query.id, { text: "⏳ Отменяю..." });

    if (videoScheduler[chatId]) {
      videoScheduler[chatId].stopped = true;
      await bot.sendMessage(chatId, "🛑 Почасовой пакет остановлен.");
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
      const { data: res } = await axios.get(`${BASE_URL}/api/v5/operations/cancel-all`, {
        headers: v5Headers(), timeout: 15000,
      });
      const found = res.total_found ?? "?";
      const cancelled = res.total_cancelled ?? "?";
      const refunded = res.total_refunded ?? "?";
      await bot.sendMessage(chatId,
        `✅ *Отмена завершена*\nНайдено: ${found} | Отменено: ${cancelled} | Возвращено: ${refunded}`,
        { parse_mode: "Markdown" });
    } catch(e) {
      await bot.sendMessage(chatId, `❌ Ошибка отмены в API: ${e.message.slice(0, 200)}`);
    }
    return showBalance(chatId, msgId);
  }

  // ── Prompt gen
  if (data === "open_promptgen") return showPromptGenMenu(chatId, msgId);
  if (data === "pg_split_lines") { s.pgSplitMode = "lines"; saveState(chatId); return showPromptGenMenu(chatId, msgId); }
  if (data === "pg_split_sent")  { s.pgSplitMode = "sentences"; saveState(chatId); return showPromptGenMenu(chatId, msgId); }
  if (data === "pg_parallel") {
    return edit("⚡ *Параллельных запросов:*", { inline_keyboard: [
      [[1, 2, 3, 5].map(n => ({ text: s.pgParallel === n ? `✅ ${n}` : `${n}`, callback_data: `set_pgp_${n}` }))],
      [[7, 10, 15, 20].map(n => ({ text: s.pgParallel === n ? `✅ ${n}` : `${n}`, callback_data: `set_pgp_${n}` }))],
      [{ text: "◀️ Назад", callback_data: "open_promptgen" }],
    ]});
  }
  if (data.startsWith("set_pgp_")) { s.pgParallel = parseInt(data.replace("set_pgp_", "")); saveState(chatId); return showPromptGenMenu(chatId, msgId); }
  if (data === "pg_provider") {
    return edit("🤖 *LLM провайдер:*", { inline_keyboard: [
      [{ text: s.pgProvider === "fastgen"    ? "✅ FastGen"    : "FastGen",    callback_data: "set_pgprov_fastgen" }],
      [{ text: s.pgProvider === "openai"     ? "✅ OpenAI"     : "OpenAI",     callback_data: "set_pgprov_openai" }],
      [{ text: s.pgProvider === "gemini"     ? "✅ Gemini"     : "Gemini",     callback_data: "set_pgprov_gemini" }],
      [{ text: s.pgProvider === "openrouter" ? "✅ OpenRouter" : "OpenRouter", callback_data: "set_pgprov_openrouter" }],
      [{ text: "◀️ Назад", callback_data: "open_promptgen" }],
    ]});
  }
  if (data.startsWith("set_pgprov_")) { s.pgProvider = data.replace("set_pgprov_", ""); saveState(chatId); return showPromptGenMenu(chatId, msgId); }
  if (data === "pg_apikey")   { s.step = "waiting_pg_apikey";   return edit(`🔑 *API ключ для ${s.pgProvider}*\n\nОтправь ключ:`, cancelKb); }
  if (data === "pg_template") {
    s.step = "waiting_pg_template";
    return edit("✏️ *Шаблон промпта*\n\nИспользуй `{TEXT}` как плейсхолдер.\n\nОтправь новый шаблон:", { inline_keyboard: [
      [{ text: "🔄 Сбросить", callback_data: "pg_template_reset" }],
      [{ text: "❌ Отмена", callback_data: "open_promptgen" }],
    ]});
  }
  if (data === "pg_template_reset") { s.pgTemplate = DEFAULT_STATE().pgTemplate; saveState(chatId); return showPromptGenMenu(chatId, msgId); }
  if (data === "pg_input_text") { s.step = "waiting_pg_story"; return edit("📝 Отправь текст истории:", cancelKb); }
  if (data === "pg_input_file") { s.step = "waiting_pg_file";  return edit("📄 Отправь .txt файл:", cancelKb); }
});

// ─── Фото handler ─────────────────────────
bot.on("photo", async (msg) => {
  const chatId = msg.chat.id;
  const s = getState(chatId);
  const fileId = msg.photo[msg.photo.length - 1].file_id;

  if (s.mode === "batch") {
    const bt = s.batchType || "image";
    if (bt === "video_image") {
      if (s.batchPhotos.length >= 500) return bot.sendMessage(chatId, "❌ Максимум 500 фото в пакете!");
      if (msg.media_group_id) {
        // Media group — накапливаем фото в буфер
        if (!mediaGroupBuffers.has(msg.media_group_id)) {
          mediaGroupBuffers.set(msg.media_group_id, []);
        }
        mediaGroupBuffers.get(msg.media_group_id).push({ fileId, messageId: msg.message_id });

        if (mediaGroupTimers.has(msg.media_group_id)) clearTimeout(mediaGroupTimers.get(msg.media_group_id));
        const t = setTimeout(() => {
          // Сортируем по message_id для сохранения порядка отправки
          const buffer = mediaGroupBuffers.get(msg.media_group_id) || [];
          buffer.sort((a, b) => a.messageId - b.messageId);
          const count = buffer.length;
          const currentTotal = s.batchPhotos.length;
          if (currentTotal + count > 500) {
            const allowed = 500 - currentTotal;
            for (let i = 0; i < allowed; i++) s.batchPhotos.push(buffer[i].fileId);
            bot.sendMessage(chatId, `✅ Добавлено ${allowed}/${count} фото (лимит 500). Всего: ${s.batchPhotos.length}`, {
              reply_markup: { inline_keyboard: [[{ text: "📦 Меню пакета", callback_data: "do_batch_menu" }]] }
            });
          } else {
            for (const item of buffer) s.batchPhotos.push(item.fileId);
            bot.sendMessage(chatId, `✅ Фото добавлены! Всего: ${s.batchPhotos.length}`, {
              reply_markup: { inline_keyboard: [[{ text: "📦 Меню пакета", callback_data: "do_batch_menu" }]] }
            });
          }
          mediaGroupTimers.delete(msg.media_group_id);
          mediaGroupBuffers.delete(msg.media_group_id);
        }, 1500);
        mediaGroupTimers.set(msg.media_group_id, t);
        return;
      } else {
        // Одиночное фото
        s.batchPhotos.push(fileId);
      }
      return bot.sendMessage(chatId, `✅ Фото ${s.batchPhotos.length}/500 добавлено.`, {
        reply_markup: { inline_keyboard: [[{ text: "📦 Меню пакета", callback_data: "do_batch_menu" }]] }
      });
    }
    return bot.sendMessage(chatId, `ℹ️ Фото не нужны для текущего типа пакета.`, {
      reply_markup: { inline_keyboard: [[{ text: "📦 Меню пакета", callback_data: "do_batch_menu" }]] }
    });
  }

  if (s.step === "waiting_keyframe_start") {
    s.keyframeStart = fileId; s.step = "waiting_keyframe_end";
    return bot.sendMessage(chatId, "✅ Первый кадр! Отправь второй или пропусти:", {
      reply_markup: { inline_keyboard: [
        [{ text: "⏭ Пропустить", callback_data: "kf_skip_end" }],
        [{ text: "❌ Отмена", callback_data: "back_menu" }],
      ]}
    });
  }
  if (s.step === "waiting_keyframe_end") {
    s.keyframeEnd = fileId; s.step = "waiting_prompt";
    return bot.sendMessage(chatId, "✅ Оба кадра! Напиши описание:", {
      reply_markup: { inline_keyboard: [[{ text: "❌ Отмена", callback_data: "back_menu" }]] }
    });
  }
  if (s.step === "waiting_ref_photos") {
    if (!s.pendingRefImages) s.pendingRefImages = [];
    if (s.pendingRefImages.length >= 10)
      return bot.sendMessage(chatId, "❌ Максимум 10 референсов!");
    try {
      const dataUri = await tgPhotoToDataUri(fileId);
      s.pendingRefImages.push(dataUri);
      return bot.sendMessage(chatId, `✅ Референс ${s.pendingRefImages.length}/10 добавлен!`, {
        reply_markup: { inline_keyboard: [
          [{ text: `✅ Готово (${s.pendingRefImages.length} фото)`, callback_data: "ref_photos_done" }],
          [{ text: "❌ Отмена", callback_data: "back_menu" }],
        ]}
      });
    } catch(e) {
      return bot.sendMessage(chatId, `❌ Ошибка загрузки фото: ${e.message}`);
    }
  }
  if (s.step === "waiting_vid_ref_photos") {
    if (!s.pendingRefImages) s.pendingRefImages = [];
    const maxRef = s.vidModel === "grok_vid" ? 7 : 3;
    if (s.pendingRefImages.length >= maxRef)
      return bot.sendMessage(chatId, `❌ Максимум ${maxRef} фото!`);
    try {
      const dataUri = await tgPhotoToDataUri(fileId);
      s.pendingRefImages.push(dataUri);
      return bot.sendMessage(chatId, `✅ Фото ${s.pendingRefImages.length}/${maxRef} добавлено!`, {
        reply_markup: { inline_keyboard: [
          [{ text: `✅ Готово (${s.pendingRefImages.length} фото)`, callback_data: "vid_ref_photos_done" }],
          [{ text: "❌ Отмена", callback_data: "back_menu" }],
        ]}
      });
    } catch(e) {
      return bot.sendMessage(chatId, `❌ Ошибка загрузки фото: ${e.message}`);
    }
  }
  // Отправил фото просто так — запускаем видео из фото
  s.tab = "video_ref"; s.pendingRefImages = []; s.step = "waiting_prompt"; s.mode = "normal";
  const vm = VIDEO_MODELS[s.vidModel];
  try {
    const dataUri = await tgPhotoToDataUri(fileId);
    s.pendingRefImages = [dataUri];
    bot.sendMessage(chatId, `✅ Фото готово!\n\n🎬 *${vm.label}* (${vm.credits})\n\nНапиши описание для видео:`, {
      parse_mode: "Markdown",
      reply_markup: { inline_keyboard: [
        [{ text: "🎥 Сменить модель", callback_data: "open_vidmodel" }],
        [{ text: "❌ Отмена", callback_data: "back_menu" }],
      ]}
    });
  } catch(e) {
    bot.sendMessage(chatId, `❌ Ошибка загрузки фото: ${e.message}`);
  }
});

// ─── Документы ────────────────────────────
bot.on("document", async (msg) => {
  const chatId = msg.chat.id;
  const s = getState(chatId);
  if (!msg.document.file_name.endsWith(".txt")) return bot.sendMessage(chatId, "❌ Нужен .txt файл!");

  async function readTxt() {
    const f = await bot.getFile(msg.document.file_id);
    const resp = await axios.get(`https://api.telegram.org/file/bot${TELEGRAM_TOKEN}/${f.file_path}`, { responseType: "arraybuffer" });
    return Buffer.from(resp.data).toString("utf-8");
  }

  if (s.step === "waiting_pg_file") {
    s.step = null;
    try { return runPromptGen(chatId, await readTxt()); }
    catch(e) { return bot.sendMessage(chatId, `❌ Ошибка файла: ${e.message}`); }
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
      let reply = `✅ Загружено ${toAdd.length} промптов!`;
      if (skipped > 0) reply += `\n⚠️ Пропущено ${skipped} (лимит ${MAX})`;
      bot.sendMessage(chatId, reply, { reply_markup: { inline_keyboard: [[{ text: "📦 Меню пакета", callback_data: "do_batch_menu" }]] } });
    } catch(e) { bot.sendMessage(chatId, `❌ Ошибка файла: ${e.message}`); }
  }
});

// ─── Текст handler ────────────────────────
bot.on("message", async (msg) => {
  const chatId = msg.chat.id;
  const s = getState(chatId);
  if (!msg.text || msg.text.startsWith("/")) return;

  if (s.step === "waiting_count") {
    const n = parseInt(msg.text);
    if (isNaN(n) || n < 1 || n > 500) return bot.sendMessage(chatId, "❌ Введи число от 1 до 500:");
    s.count = n; s.step = null; saveState(chatId);
    return showMainMenu(chatId);
  }
  if (s.step === "waiting_hourly_limit") {
    const n = parseInt(msg.text);
    if (isNaN(n) || n < 1 || n > 500) return bot.sendMessage(chatId, "❌ Введи число от 1 до 500:");
    s.batchHourlyLimit = n; s.step = null; saveState(chatId);
    await bot.sendMessage(chatId, `✅ Лимит видео/час: *${n}*`, { parse_mode: "Markdown" });
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
    let reply = `✅ Добавлено ${toAdd.length} промптов!`;
    if (skipped > 0) reply += `\n⚠️ Пропущено ${skipped} (лимит ${MAX})`;
    return bot.sendMessage(chatId, reply, { reply_markup: { inline_keyboard: [[{ text: "📦 Меню пакета", callback_data: "do_batch_menu" }]] } });
  }
  if (s.step === "waiting_pg_apikey") {
    s.pgApiKey = msg.text.trim(); s.step = null; saveState(chatId);
    await bot.sendMessage(chatId, "✅ API ключ сохранён!");
    return showPromptGenMenu(chatId);
  }
  if (s.step === "waiting_pg_template") {
    s.pgTemplate = msg.text; s.step = null; saveState(chatId);
    await bot.sendMessage(chatId, "✅ Шаблон сохранён!");
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
    if (!item) return bot.sendMessage(chatId, "❌ Запись не найдена");
    return runRegenItem(chatId, { ...item, prompt: msg.text }, item.isImage);
  }

  if (s.step !== "waiting_prompt") return showMainMenu(chatId);

  const prompt = msg.text;
  s.step = null;

  if (s.mode === "keyframes") return runKeyframes(chatId, s, prompt);
  await runNormal(chatId, s, prompt);
});

// ─── /start /menu ─────────────────────────
bot.onText(/\/start|\/menu/, async (msg) => {
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

console.log("🤖 FastGen Bot v5 запущен!");
