const TelegramBot = require("node-telegram-bot-api");
const axios = require("axios");
const fs = require("fs");

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
  try { fs.writeFileSync(file, JSON.stringify(data, null, 2)); } catch(e) { console.error("saveJSON", e.message); }
}

const persistedStates = loadJSON(STATE_FILE, {});
const persistedHistory = loadJSON(HISTORY_FILE, {});

// ─── Очередь с ограничением параллельности ───
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

const imageQueue = createQueue(10); // 10 параллельных для фото
const videoQueue = createQueue(10); // 10 параллельных для видео

// ─── Storage Server — загрузка файла ─────
async function uploadToStorage(buffer, filename = "image.jpg") {
  try {
    const FormData = require("form-data");
    const form = new FormData();
    form.append("file", buffer, { filename, contentType: "image/jpeg" });
    const { data } = await axios.post(`${STORAGE_URL}/upload`, form, {
      headers: { ...form.getHeaders(), "X-API-Key": FASTGEN_API_KEY },
      timeout: 30000,
    });
    return data.file_hash ? `file:${data.file_hash}` : null;
  } catch(e) {
    console.log("[storage] upload failed:", e.message);
    return null;
  }
}

// ─── Получить реальный баланс с API ──────
async function fetchRealUsage() {
  try {
    const { data } = await axios.get(`${BASE_URL}/api/v5/usage`, {
      headers: { "X-API-Key": FASTGEN_API_KEY }, timeout: 10000,
    });
    return data;
  } catch(e) {
    console.log("[usage] fetch failed:", e.message);
    return null;
  }
}

// ─── Отмена всех операций ────────────────
async function cancelAllOperations() {
  try {
    const { data } = await axios.get(`${BASE_URL}/api/v4/operations/cancel-all`, {
      headers: { "X-API-Key": FASTGEN_API_KEY }, timeout: 15000,
    });
    return data;
  } catch(e) {
    console.log("[cancel-all] failed:", e.message);
    return null;
  }
}

// ─── Отмена конкретной операции ──────────
async function cancelOperation(opId) {
  try {
    const { data } = await axios.post(`${BASE_URL}/api/v4/operations/cancel`, {
      operation_ids: [opId],
    }, {
      headers: { "X-API-Key": FASTGEN_API_KEY, "Content-Type": "application/json" },
      timeout: 10000,
    });
    return data;
  } catch(e) {
    console.log("[cancel] failed:", e.message);
    return null;
  }
}

// ─── Улучшение промпта через FastGen LLM ─
// Умный системный промпт — адаптируется под тип контента
function buildEnhanceSystemPrompt(isVideo) {
  const mediaType = isVideo ? "video generation" : "image generation";
  return `You are an expert prompt engineer for AI ${mediaType} models (like Imagen, Veo, Grok, DALL-E).

Your task: take the user's raw prompt and rewrite it into a highly detailed, optimized prompt for ${mediaType}.

Rules:
- Detect the content type automatically: portrait, landscape, abstract, anime, realistic, cinematic, product, fantasy, sci-fi, etc.
- For portraits: add lighting details (soft rim light, golden hour), camera angle, skin details, expression, background blur
- For landscapes/nature: add atmosphere, time of day, weather, depth, color palette
- For cinematic/action: add camera movement${isVideo ? " (slow zoom, pan, dolly)" : ""}, color grade, film style
- For abstract/artistic: add style references, texture, mood, color theory
- For anime/illustration: add art style (Studio Ghibli, manga, etc.), line quality, color vibrancy
${isVideo ? "- For video: add motion description, camera movement, transition style, pacing" : ""}
- Always add: quality boosters (photorealistic, 8K, sharp focus, professional photography, award-winning)
- Keep the core idea intact — only expand and improve, never change the subject
- Output ONLY the improved prompt, nothing else, no explanations, no preamble`;
}

async function enhancePrompt(rawPrompt, isVideo = false) {
  const systemPrompt = buildEnhanceSystemPrompt(isVideo);
  try {
    const { data } = await axios.post(`${BASE_URL}/api/v5/prompts/generate`, {
      prompt: `${systemPrompt}\n\nUser prompt to improve: ${rawPrompt}`,
    }, {
      headers: { "X-API-Key": FASTGEN_API_KEY, "Content-Type": "application/json" },
      timeout: 30000,
    });
    // v5 может вернуть сразу текст или operation_id
    if (data.text) return data.text.trim();
    if (data.result?.text) return data.result.text.trim();
    // Если вернул operation_id — поллим
    const opId = data.operation_id || data.task_id || data.id;
    if (opId) {
      for (let i = 0; i < 15; i++) {
        await new Promise(r => setTimeout(r, 2000));
        const { data: op } = await axios.get(`${BASE_URL}/api/v4/operations/${opId}`, {
          headers: { "X-API-Key": FASTGEN_API_KEY }, timeout: 10000,
        });
        const st = op.status || op.state;
        if (["completed","success","done","finished"].includes(st)) {
          return (op.result?.text || op.text || String(op.result || "")).trim();
        }
        if (["failed","error","cancelled"].includes(st)) throw new Error("LLM failed");
      }
    }
    return null;
  } catch(e) {
    console.log("[enhance] failed:", e.message);
    return null;
  }
}

// ─── Почасовой планировщик видео ─────────
// chatId -> { tasks, statusMsgId, model, s }
const videoScheduler = {};

async function scheduleVideoChunk(chatId) {
  const job = videoScheduler[chatId];
  if (!job || job.tasks.length === 0) {
    delete videoScheduler[chatId];
    return;
  }
  const { tasks, model, s } = job;
  const hourlyLimit = job.hourlyLimit || 15;
  const chunk = tasks.splice(0, hourlyLimit); // берём до hourlyLimit задач
  const total = job.totalTasks;

  const { ratio: jobRatio, resolution: jobRes } = job.s;
  const statusText = () =>
    `⏰ *Почасовой пакет (видео)*\n` +
    `🤖 ${model.label} | 📐 ${jobRatio}\n` +
    `Всего: ${total} | Осталось: ${job.tasks.length}\n` +
    `✓${job.doneSoFar} ✗${job.errorsSoFar}\n` +
    `⚙️ Текущая пачка: ${chunk.length} задач (лимит/час: ${hourlyLimit})`;

  if (!job.statusMsgId) {
    const m = await bot.sendMessage(chatId, statusText(), { parse_mode: "Markdown" });
    job.statusMsgId = m.message_id;
  } else {
    await bot.editMessageText(statusText(), { chat_id: chatId, message_id: job.statusMsgId, parse_mode: "Markdown" }).catch(()=>{});
  }

  // Запускаем все задачи чанка через очередь (макс 10 параллельно) и ЖДЁМ все
  const chunkPromises = chunk.map(task =>
    videoQueue(async () => {
      try {
        await genOne(chatId, s, task.prompt, task.ep, model, task.isImg, 0, 0, task.idx, task.fileId);
        job.doneSoFar++;
      } catch {
        job.errorsSoFar++;
      }
      await bot.editMessageText(statusText(), { chat_id: chatId, message_id: job.statusMsgId, parse_mode: "Markdown" }).catch(()=>{});
    })
  );

  // Ждём пока ВСЕ задачи чанка завершатся
  await Promise.allSettled(chunkPromises);

  if (job.tasks.length > 0) {
    // Сколько ждать до следующего сброса лимита
    const msLeft = Math.max(60000, balanceState.resetAt - Date.now()); // минимум 1 мин чтобы не зациклиться
    const waitMs = msLeft + 3000; // +3 сек буфер
    const resetTime = new Date(Date.now() + waitMs).toLocaleTimeString("ru", { hour: "2-digit", minute: "2-digit" });
    await bot.sendMessage(chatId,
      `⏳ Пачка завершена: ✓${job.doneSoFar} ✗${job.errorsSoFar}\n` +
      `Осталось *${job.tasks.length}* задач.\n` +
      `🕐 Следующая пачка запустится в *${resetTime}* (сброс лимита).\n` +
      `Можно закрыть приложение — бот сам продолжит.`,
      { parse_mode: "Markdown" });
    setTimeout(() => scheduleVideoChunk(chatId), waitMs);
  } else {
    await bot.editMessageText(
      `✅ *Почасовой пакет завершён!*\n✓${job.doneSoFar} ✗${job.errorsSoFar}`,
      { chat_id: chatId, message_id: job.statusMsgId, parse_mode: "Markdown" }
    ).catch(()=>{});
    delete videoScheduler[chatId];
    showMainMenu(chatId);
  }
}

// ─── Локальный баланс (общий для всех) ───
const HOURLY_LIMITS = { images: 500, videos: 15, tokens: 200000 };

function nextHourReset() {
  const now = new Date();
  const next = new Date(now);
  next.setHours(now.getHours() + 1, 0, 0, 0); // начало следующего часа
  return next.getTime();
}

let balanceState = loadJSON(BALANCE_FILE, {
  images: 0, videos: 0, tokens: 0,
  resetAt: nextHourReset(),
});

// Если загрузили старый файл без правильного resetAt — пересчитаем
if (!balanceState.resetAt || balanceState.resetAt < Date.now()) {
  balanceState.resetAt = nextHourReset();
  saveJSON(BALANCE_FILE, balanceState);
}

function checkResetBalance() {
  if (Date.now() >= balanceState.resetAt) {
    balanceState = { images: 0, videos: 0, tokens: 0, resetAt: nextHourReset() };
    saveJSON(BALANCE_FILE, balanceState);
  }
}

function spendBalance(type, amount = 1) {
  checkResetBalance();
  balanceState[type] = (balanceState[type] || 0) + amount;
  saveJSON(BALANCE_FILE, balanceState);
}

async function formatBalance() {
  checkResetBalance();
  const b = balanceState;
  const imgLeft = Math.max(0, HOURLY_LIMITS.images - b.images);
  const vidLeft = Math.max(0, HOURLY_LIMITS.videos - b.videos);
  const tokLeft = Math.max(0, HOURLY_LIMITS.tokens - b.tokens);

  const msLeft = Math.max(0, b.resetAt - Date.now());
  const totalMin = Math.ceil(msLeft / 60000);
  const h = Math.floor(totalMin / 60), m = totalMin % 60;
  const resetStr = h > 0 ? `${h}ч ${m}м` : `${m}м`;
  const resetTime = new Date(b.resetAt).toLocaleTimeString("ru", { hour: "2-digit", minute: "2-digit" });

  function fmtTok(n) {
    if (n >= 1000000) return `${(n/1000000).toFixed(1).replace(".0","")}M`;
    if (n >= 1000) return `${Math.round(n/1000)}k`;
    return String(n);
  }

  // Пробуем получить реальные данные с API
  let realBlock = "";
  try {
    const usage = await fetchRealUsage();
    if (usage) {
      const lim = usage.account_limits || {};
      const cur = usage.current_usage || {};
      const threads = cur.active_threads || {};
      const hourly = cur.hourly_usage || {};
      realBlock =
        `\n📡 *Реальный баланс API:*\n` +
        `🖼 Лимит фото/час: *${lim.img_gen_per_hour_limit || "?"}*\n` +
        `🎬 Лимит видео/час: *${lim.video_gen_per_hour_limit || "?"}*\n` +
        `💬 Токенов/час: *${fmtTok(lim.prompt_tokens_per_hour_limit || 0)}*\n` +
        `⚡ Активных потоков: фото=${threads.image_threads || 0}, видео=${threads.video_threads || 0}\n`;
    }
  } catch(e) {}

  return (
    `📊 *Баланс и лимиты* (общий)\n\n` +
    `🖼 Изображения: *${imgLeft}/${HOURLY_LIMITS.images}*\n` +
    `🎬 Видео: *${vidLeft}/${HOURLY_LIMITS.videos}*\n` +
    `💬 Токены промптов: *${fmtTok(tokLeft)}/${fmtTok(HOURLY_LIMITS.tokens)}*\n` +
    `⏱ Сброс через: *${resetStr}* (в ${resetTime})\n` +
    realBlock +
    `\nСтоимость моделей:\n` +
    `🖼 Imagen/NanoPro/NanoBanana Flow: 4 кред\n` +
    `🖼 Grok быстро: 1 кред = 6 фото\n` +
    `🖼 Grok качество: 1 кред = 4 фото\n` +
    `🖼 NanaBanana Flower / ChatGPT / Remix: 1 кред\n` +
    `🎬 Veo 3.1 Fast/Light/Flower/Grok: 1 кред\n` +
    `🎬 Veo 3.1 Quality: 10 кред\n\n` +
    `Обновлено: ${new Date().toLocaleTimeString("ru")}`
  );
}

// ─── Модели ───────────────────────────────
const IMAGE_MODELS = {
  "imagen4_flow":  { label: "Imagen 4 - Flow",       ep: "/api/v4/flow/image/generate",   credits: "4 кред = 1 фото",   cost: 1 },
  "nanopro_flow":  { label: "Nano Banana Pro - Flow", ep: "/api/v4/flow/image/generate",   credits: "4 кред = 1 фото",   cost: 1, model: "nano-banana-pro" },
  "nanob2_flow":   { label: "Nano Banana 2 - Flow",   ep: "/api/v4/flow/image/generate",   credits: "4 кред = 1 фото",   cost: 1, model: "nano-banana-2" },
  "grok_fast":     { label: "Grok (быстро)",          ep: "/api/v4/grok/image/generate",   credits: "1 кред = 6 фото",   cost: 1, quality: "fast" },
  "grok_quality":  { label: "Grok (качество)",        ep: "/api/v4/grok/image/generate",   credits: "1 кред = 4 фото",   cost: 1, quality: "quality" },
  "nanob2_flower": { label: "Nano Banana 2 - Flower", ep: "/api/v4/flower/image/generate", credits: "1 кред = 1 фото",   cost: 1 },
  "chatgpt":       { label: "ChatGPT Images 2.0",     ep: "/api/v4/openai/image/generate", credits: "1 кред = 1 фото",   cost: 1 },
  "remix":         { label: "🎨 Remix (GoogleFX)",     ep: "/api/v4/flow/image/remix",      credits: "1 кред = 1 фото",   cost: 1, isRemix: true },
};

const VIDEO_MODELS = {
  "veo31_fast":    { label: "Veo 3.1 Fast",    epT: "/api/v4/flow/video/from-text",   epI: "/api/v4/flow/video/from-ingredients",   epK: "/api/v4/flow/video/from-keyframes", sub: "veo-3.1-fast",    credits: "1 кред = 1 видео",   cost: 1 },
  "veo31_light":   { label: "Veo 3.1 Light",   epT: "/api/v4/flow/video/from-text",   epI: "/api/v4/flow/video/from-ingredients",   epK: "/api/v4/flow/video/from-keyframes", sub: "veo-3.1-light",   credits: "1 кред = 1 видео",   cost: 1 },
  "veo31_quality": { label: "Veo 3.1 Quality", epT: "/api/v4/flow/video/from-text",   epI: "/api/v4/flow/video/from-ingredients",   epK: "/api/v4/flow/video/from-keyframes", sub: "veo-3.1-quality", credits: "10 кред = 1 видео ⚠️", cost: 10 },
  "grok_vid":      { label: "Grok Video",       epT: "/api/v4/grok/video/from-text",   epI: "/api/v4/grok/video/from-image",         credits: "1 кред = 1 видео",   cost: 1, res: true, defaultRes: "720p" },
  "veo31_flower":  { label: "Veo 3.1 Flower",  epT: "/api/v4/flower/video/from-text", epI: "/api/v4/flower/video/from-image",       credits: "1 кред = 1 видео",   cost: 1 },
};

const RATIOS = ["16:9","9:16","1:1","4:3","3:4","3:2","2:3"];

// ─── Состояние пользователей ──────────────
const DEFAULT_STATE = () => ({
  step: null, tab: "image",
  imgModel: "imagen4_flow", vidModel: "veo31_fast",
  ratio: "16:9", count: 1, perPrompt: 1,
  seed: "random", resolution: "720p", mode: "normal",
  batchPrompts: [], batchPhotos: [],
  batchPromptIdx: 0,
  batchType: "image",
  batchImgModel: null, batchVidModel: null,
  batchRatio: null, batchResolution: null,
  batchHourlyLimit: 15,
  keyframeStart: null, keyframeEnd: null,
  fileId: null,
  pendingRefImages: [],
  balanceMsgId: null,
  menuMsgId: null,
  pgSplitMode: "lines",
  pgParallel: 5,
  pgProvider: "fastgen",
  pgApiKey: null,
  pgTemplate: `I'll send you a paragraph from a story, and you'll generate a detailed image prompt for image generation.\nKeep total response length under 1000 symbols.\n\n**Follow these steps:**\n1. Prompt: Create a vivid 1-line prompt, specifying:\n- Visual focus (characters, objects, scenery).\n- Atmosphere (e.g., "gloomy," "whimsical").\n- Style (e.g., "photorealistic," "oil painting").\n- Lighting (e.g., "soft morning light").\n- Color palette.\n- Camera angle (e.g., "wide shot," "close-up").\n2. Negative: list what to avoid.\n\nText: {TEXT}`,
  // Улучшение промпта
  enhanceMode: "ask", // "always" | "never" | "ask"
  // Remix
  remixImages: [], // [{fileId, category}]
  remixStep: null,
});

const userState = {};
const history = {};

function getState(chatId) {
  const key = String(chatId);
  if (!userState[key]) {
    // Восстанавливаем из файла, сохраняя дефолты для новых полей
    const saved = persistedStates[key] || {};
    userState[key] = Object.assign(DEFAULT_STATE(), saved);
    // Сбрасываем эфемерные поля
    userState[key].step = null;
    userState[key].menuMsgId = null;
    userState[key].balanceMsgId = null;
  }
  return userState[key];
}

function saveState(chatId) {
  const key = String(chatId);
  const s = userState[key];
  if (!s) return;
  // Сохраняем только настройки (не эфемерные поля)
  persistedStates[key] = {
    tab: s.tab, imgModel: s.imgModel, vidModel: s.vidModel,
    ratio: s.ratio, count: s.count, perPrompt: s.perPrompt,
    seed: s.seed, resolution: s.resolution, batchType: s.batchType,
    batchImgModel: s.batchImgModel, batchVidModel: s.batchVidModel,
    batchRatio: s.batchRatio, batchResolution: s.batchResolution,
    batchHourlyLimit: s.batchHourlyLimit,
    pgSplitMode: s.pgSplitMode, pgParallel: s.pgParallel,
    pgProvider: s.pgProvider, pgApiKey: s.pgApiKey, pgTemplate: s.pgTemplate,
    enhanceMode: s.enhanceMode,
  };
  saveJSON(STATE_FILE, persistedStates);
}

function getHistory(chatId) {
  const key = String(chatId);
  if (!history[key]) {
    history[key] = persistedHistory[key] || [];
  }
  return history[key];
}

function addHistory(chatId, entry) {
  const key = String(chatId);
  const h = getHistory(chatId);
  // Add timestamp
  entry.ts = Date.now();
  h.unshift(entry);
  if (h.length > 50) h.pop();
  persistedHistory[key] = h;
  saveJSON(HISTORY_FILE, persistedHistory);
}

// ─── Медиа ────────────────────────────────
function extractMedia(data) {
  if (Array.isArray(data.result) && data.result.length > 0) return { base64: data.result[0], type: data.media_type || "video" };
  if (typeof data.result === "string" && data.result.startsWith("data:")) return { base64: data.result, type: data.media_type || "video" };
  const url = data.video_url || data.image_url || data.url || data.output || data.result?.url;
  if (url) return { url, type: data.media_type || "video" };
  return null;
}

async function sendMedia(chatId, media, isImage, caption, replyMarkup = null) {
  if (media.base64) {
    let b64 = media.base64, ext = isImage ? "jpg" : "mp4";
    if (b64.includes(";base64,")) { const p = b64.split(";base64,"); b64 = p[1]; if (p[0].includes("png")) ext="png"; }
    const tmp = `/tmp/fg_${Date.now()}.${ext}`;
    fs.writeFileSync(tmp, Buffer.from(b64, "base64"));
    try {
      const opts = { caption, parse_mode: "Markdown", ...(replyMarkup && { reply_markup: replyMarkup }) };
      if (isImage) await bot.sendPhoto(chatId, fs.createReadStream(tmp), opts);
      else await bot.sendVideo(chatId, fs.createReadStream(tmp), opts);
    } finally { try { fs.unlinkSync(tmp); } catch {} }
  } else if (media.url) {
    const opts = { caption, parse_mode: "Markdown", ...(replyMarkup && { reply_markup: replyMarkup }) };
    if (isImage) await bot.sendPhoto(chatId, media.url, opts);
    else await bot.sendVideo(chatId, media.url, opts);
  }
}

// ─── Поллинг ──────────────────────────────
async function pollResult(opId, max=90, interval=10000) {
  for (let i=0; i<max; i++) {
    await new Promise(r => setTimeout(r, interval));
    try {
      const { data } = await axios.get(`${BASE_URL}/api/v4/operations/${opId}`, {
        headers: { "X-API-Key": FASTGEN_API_KEY }, timeout: 10000
      });
      const st = data.status || data.state;
      console.log(`[poll] opId=${opId} i=${i} status=${st} keys=${Object.keys(data).join(",")}`);
      if (["completed","success","done","finished"].includes(st)) return extractMedia(data);
      if (["failed","error","cancelled"].includes(st)) {
        const reason = data.error || data.message || data.detail || JSON.stringify(data).slice(0,300);
        console.log(`[poll] FAILED opId=${opId} reason=${reason}`);
        throw new Error(`Статус: ${st}${reason !== st ? ` — ${reason}` : ""}`);
      }
    } catch(e) {
      if (e.message && e.message.startsWith("Статус")) throw e;
      // network error — log and retry next iteration
      console.log(`[poll] retry after error: ${e.message}`);
    }
  }
  return null;
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
    const ok = await bot.editMessageText(text, { chat_id: chatId, message_id: targetId, parse_mode: "Markdown", reply_markup: kb }).catch(()=>null);
    if (ok) return;
  }
  if (s.menuMsgId) { await bot.deleteMessage(chatId, s.menuMsgId).catch(()=>{}); }
  const m = await bot.sendMessage(chatId, text, { parse_mode: "Markdown", reply_markup: kb });
  s.menuMsgId = m.message_id;
}

// ─── История ──────────────────────────────
function showHistoryMenu(chatId, msgId = null, page = 0) {
  const h = getHistory(chatId);
  if (h.length === 0) {
    const text = "📭 История пуста.";
    if (msgId) bot.editMessageText(text, { chat_id: chatId, message_id: msgId, reply_markup: { inline_keyboard: [[{ text: "◀️ Назад", callback_data: "open_misc" }]] } }).catch(()=>{});
    else bot.sendMessage(chatId, text, { reply_markup: { inline_keyboard: [[{ text: "◀️ Назад", callback_data: "open_misc" }]] } });
    return;
  }
  const PAGE_SIZE = 8;
  const totalPages = Math.ceil(h.length / PAGE_SIZE);
  const slice = h.slice(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE);

  const rows = slice.map((item, i) => {
    const realIdx = page * PAGE_SIZE + i;
    const typeIcon = item.isImage ? "🖼" : "🎬";
    const timeStr = item.ts ? new Date(item.ts).toLocaleTimeString("ru", { hour:"2-digit", minute:"2-digit" }) : "";
    const label = `${typeIcon} ${timeStr} | ${item.model.slice(0,12)} | ${item.prompt.slice(0,18)}`;
    return [{ text: label, callback_data: `hist_${realIdx}` }];
  });

  const navRow = [];
  if (page > 0) navRow.push({ text: "◀️", callback_data: `hist_page_${page - 1}` });
  navRow.push({ text: `${page + 1}/${totalPages}`, callback_data: "noop" });
  if (page < totalPages - 1) navRow.push({ text: "▶️", callback_data: `hist_page_${page + 1}` });

  rows.push(navRow);
  rows.push([{ text: "🗑 Очистить историю", callback_data: "hist_clear" }, { text: "◀️ Назад", callback_data: "open_misc" }]);

  const opts = { parse_mode: "Markdown", reply_markup: { inline_keyboard: rows } };
  const text = `📋 *История запросов* (${h.length}):\n_Тап на запись — детали и перегенерация_`;
  if (msgId) bot.editMessageText(text, { chat_id: chatId, message_id: msgId, ...opts }).catch(()=>{});
  else bot.sendMessage(chatId, text, opts);
}

// ─── Главное меню ─────────────────────────
async function showMainMenu(chatId) {
  const s = getState(chatId);
  const im = IMAGE_MODELS[s.imgModel];
  const vm = VIDEO_MODELS[s.vidModel];
  const enhanceLabel = { always: "✨ Всегда", never: "⏭ Никогда", ask: "❓ Спрашивать" }[s.enhanceMode || "ask"];
  const text =
    `🤖 *FastGen Bot*\n\n` +
    `🖼 Фото: *${im.label}*\n└ ${im.credits}\n` +
    `🎬 Видео: *${vm.label}*\n└ ${vm.credits}\n` +
    `📐 ${s.ratio} | 🔢 ${s.count} шт. | 🌱 ${s.seed==="fixed"?"Фикс.":"Случ."}\n` +
    `✨ Улучшение промпта: *${enhanceLabel}*`;
  const kb = { inline_keyboard: [
    [{ text: "🖼️ Изображение", callback_data: "do_image" }, { text: "🖼️📸 Фото из рефов", callback_data: "do_image_ref" }],
    [{ text: "🎬 Видео из текста", callback_data: "do_vtext" }, { text: "📸 Видео из фото", callback_data: "do_vimage" }],
    [{ text: "📦 Пакетный режим", callback_data: "do_batch" }],
    [{ text: "🎨 Модель фото", callback_data: "open_imgmodel" }, { text: "🎥 Модель видео", callback_data: "open_vidmodel" }],
    [{ text: "📐 Соотношение", callback_data: "open_ratio" }, { text: "🔢 Количество", callback_data: "open_count" }],
    [{ text: "📊 Баланс", callback_data: "show_balance" }, { text: "⚙️ Прочее", callback_data: "open_misc" }],
  ]};

  if (s.menuMsgId) {
    try {
      await bot.editMessageText(text, { chat_id: chatId, message_id: s.menuMsgId, parse_mode: "Markdown", reply_markup: kb });
      return;
    } catch(e) {
      await bot.deleteMessage(chatId, s.menuMsgId).catch(()=>{});
      s.menuMsgId = null;
    }
  }
  const m = await bot.sendMessage(chatId, text, { parse_mode: "Markdown", reply_markup: kb });
  s.menuMsgId = m.message_id;
}

// ─── Меню «Прочее» ────────────────────────
function showMiscMenu(chatId, msgId = null) {
  const s = getState(chatId);
  const enhanceLabel = { always: "✨ Всегда", never: "⏭ Никогда", ask: "❓ Спрашивать" }[s.enhanceMode || "ask"];
  const seedLabel = s.seed === "fixed" ? "🌱 Seed: Фикс." : "🌱 Seed: Случ.";
  const text = `⚙️ *Прочее*`;
  const kb = { inline_keyboard: [
    [{ text: "🎞 Ключ. кадры", callback_data: "do_keyframes" }, { text: "🎨 Remix", callback_data: "do_remix" }],
    [{ text: seedLabel, callback_data: "open_seed" }],
    ...(s.vidModel === "grok_vid" ? [[{ text: `🖥 Разрешение Grok: ${s.resolution || "720p"}`, callback_data: "open_resolution" }]] : []),
    [{ text: `✨ Промпт: ${enhanceLabel}`, callback_data: "open_enhance" }],
    [{ text: "🧠 Генерация промптов", callback_data: "open_promptgen" }],
    [{ text: "📋 История запросов", callback_data: "show_history" }],
    [{ text: "◀️ Назад", callback_data: "back_menu" }],
  ]};
  if (msgId) bot.editMessageText(text, { chat_id: chatId, message_id: msgId, parse_mode: "Markdown", reply_markup: kb }).catch(()=>{});
  else bot.sendMessage(chatId, text, { parse_mode: "Markdown", reply_markup: kb });
}


// ─── Хелперы для пакетных настроек ───────
// Возвращает эффективные настройки пакета (собственные или из главного меню)
function batchEffective(s) {
  const bt = s.batchType || "image";
  const isImage = bt === "image";
  const imgModelKey = s.batchImgModel || s.imgModel;
  const vidModelKey = s.batchVidModel || s.vidModel;
  const model = isImage ? IMAGE_MODELS[imgModelKey] : VIDEO_MODELS[vidModelKey];
  const ratio = s.batchRatio || s.ratio;
  const resolution = s.batchResolution || s.resolution || "720p";
  return { bt, isImage, imgModelKey, vidModelKey, model, ratio, resolution };
}

// Меню настроек пакета (модель, соотношение, разрешение)
function showBatchSettingsMenu(chatId, msgId = null) {
  const s = getState(chatId);
  const { bt, isImage, imgModelKey, vidModelKey, model, ratio, resolution } = batchEffective(s);
  const isGrok = vidModelKey === "grok_vid";

  const ownImgModel = s.batchImgModel != null;
  const ownVidModel = s.batchVidModel != null;
  const ownRatio    = s.batchRatio != null;
  const ownRes      = s.batchResolution != null;

  const text =
    `⚙️ *Настройки пакета*\n\n` +
    `${isImage ? "🖼" : "🎬"} Модель: *${model.label}*${!isImage && !ownVidModel || isImage && !ownImgModel ? " _(из главного меню)_" : " _(своя)_"}\n` +
    `📐 Соотношение: *${ratio}*${!ownRatio ? " _(из главного меню)_" : " _(своё)_"}\n` +
    (!isImage && isGrok ? `🖥 Разрешение: *${resolution}*${!ownRes ? " _(из главного меню)_" : " _(своё)_"}\n` : "") +
    `\nИзменения применяются только к пакетному режиму.`;

  const modelRows = isImage
    ? Object.entries(IMAGE_MODELS).map(([k,v]) => [{
        text: `${imgModelKey===k?"✅ ":""}${v.label}`,
        callback_data: `bset_im_${k}`
      }])
    : Object.entries(VIDEO_MODELS).map(([k,v]) => [{
        text: `${vidModelKey===k?"✅ ":""}${v.label}`,
        callback_data: `bset_vm_${k}`
      }]);

  const ratioRows = [RATIOS.map(r => ({
    text: `${ratio===r?"✅ ":""}${r}`,
    callback_data: `bset_ratio_${r.replace(":","x")}`
  }))];

  const resRow = (!isImage && isGrok) ? [
    ["720p","1080p"].map(r => ({ text: `${resolution===r?"✅ ":""}${r}`, callback_data: `bset_res_${r}` }))
  ] : [];

  const resetRow = [
    { text: "🔄 Сбросить (= главное меню)", callback_data: "bset_reset" }
  ];

  const kb = { inline_keyboard: [
    ...modelRows,
    ...ratioRows,
    ...resRow,
    [resetRow[0]],
    [{ text: "◀️ Назад", callback_data: "do_batch_menu" }],
  ]};

  if (msgId) bot.editMessageText(text, { chat_id: chatId, message_id: msgId, parse_mode: "Markdown", reply_markup: kb }).catch(()=>{});
  else bot.sendMessage(chatId, text, { parse_mode: "Markdown", reply_markup: kb });
}

// ─── Выбор типа пакетного режима ─────────
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

  const text =
    `📦 *Пакетный режим — выбор типа*\n\n` +
    `Текущий тип: *${typeLabels[bt]}*\n\n` +
    `Выбери что генерировать:`;

  const kb = { inline_keyboard: [
    [{ text: bt==="image"      ? `✅ 🖼 Фото из текста`        : `🖼 Фото из текста`,        callback_data: "batch_type_image" }],
    [{ text: bt==="video_text" ? `✅ 🎬 Видео из текста`       : `🎬 Видео из текста`,       callback_data: "batch_type_video_text" }],
    [{ text: bt==="video_image"? `✅ 📸 Видео из фото+текста`  : `📸 Видео из фото+текста`,  callback_data: "batch_type_video_image" }],
    [{ text: "▶️ Продолжить →", callback_data: "do_batch_menu" }],
    [{ text: "❌ Отмена", callback_data: "back_menu" }],
  ]};

  if (msgId) bot.editMessageText(text, { chat_id: chatId, message_id: msgId, parse_mode: "Markdown", reply_markup: kb }).catch(()=>{});
  else bot.sendMessage(chatId, text, { parse_mode: "Markdown", reply_markup: kb });
}

// ─── Пакетное меню ────────────────────────
function showBatchMenu(chatId, msgId = null) {
  const s = getState(chatId);
  const prompts = s.batchPrompts;
  const photos = s.batchPhotos;
  const idx = s.batchPromptIdx || 0;
  const { bt, isImage, model, ratio, resolution, vidModelKey } = batchEffective(s);
  const isVideoImage = bt === "video_image";
  const isGrokVid = vidModelKey === "grok_vid";
  const MAX_PROMPTS = isImage ? 500 : 200;
  const currentPrompt = prompts.length > 0 ? prompts[idx] : null;

  const typeIcon = isImage ? "🖼" : isVideoImage ? "📸" : "🎬";
  const typeLabel = isImage ? "Фото из текста" : isVideoImage ? "Видео из фото+текста" : "Видео из текста";

  const ownModel = isImage ? s.batchImgModel != null : s.batchVidModel != null;
  const ownRatio = s.batchRatio != null;
  const ownRes   = s.batchResolution != null;

  let totalTasks = 0;
  if (isVideoImage) totalTasks = photos.length * s.perPrompt + prompts.length * s.perPrompt;
  else totalTasks = prompts.length * s.perPrompt;

  const text =
    `📦 *Пакетный режим*\n\n` +
    `${typeIcon} Тип: *${typeLabel}*\n` +
    `🤖 Модель: *${model.label}*${ownModel ? " ✏️" : ""}\n` +
    `📐 Соотношение: *${ratio}*${ownRatio ? " ✏️" : ""}\n` +
    (!isImage && isGrokVid ? `🖥 Разрешение: *${resolution}*${ownRes ? " ✏️" : ""}\n` : "") +
    `📝 Промптов: *${prompts.length}/${MAX_PROMPTS}*\n` +
    (isVideoImage ? `📸 Фото: *${photos.length}*\n` : "") +
    `🔢 На 1 промпт/фото: *${s.perPrompt}* вар.\n` +
    (!isImage ? `⏱ Лимит видео/час: *${s.batchHourlyLimit || 15}*\n` : "") +
    `Всего задач: *${totalTasks}*\n\n` +
    (currentPrompt ? `*Промпт ${idx+1}/${prompts.length}:*\n${currentPrompt}` : "_Промптов нет_");

  const navRow = prompts.length > 0 ? [
    { text: "◀️", callback_data: "bp_prev" },
    { text: `${idx+1}/${prompts.length}`, callback_data: "noop" },
    { text: "▶️", callback_data: "bp_next" },
    { text: "🗑 Удалить", callback_data: "bp_delete" },
  ] : [];

  const kb = { inline_keyboard: [
    [{ text: `${typeIcon} Сменить тип`, callback_data: "batch_change_type" }, { text: "⚙️ Настройки пакета", callback_data: "batch_settings" }],
    ...(navRow.length ? [navRow] : []),
    [{ text: "✏️ Добавить промпты", callback_data: "batch_add_text" }, { text: "📄 Из файла .txt", callback_data: "batch_from_file" }],
    ...(isVideoImage ? [[{ text: "📸 Фото управление", callback_data: "batch_photos_menu" }]] : []),
    [{ text: `🔢 На 1 промпт: ${s.perPrompt}`, callback_data: "batch_per_prompt" }],
    ...(!isImage ? [[{ text: `⏱ Лимит видео/час: ${s.batchHourlyLimit || 15}`, callback_data: "batch_hourly_limit" }]] : []),
    [{ text: "🚀 Генерировать!", callback_data: "batch_run" }],
    [{ text: "🗑 Очистить всё", callback_data: "batch_clear" }, { text: "❌ Отмена", callback_data: "back_menu" }],
  ]};

  if (msgId) bot.editMessageText(text, { chat_id: chatId, message_id: msgId, parse_mode: "Markdown", reply_markup: kb }).catch(()=>{});
  else bot.sendMessage(chatId, text, { parse_mode: "Markdown", reply_markup: kb });
}

function showBatchPhotosMenu(chatId, msgId) {
  const s = getState(chatId);
  const photos = s.batchPhotos;
  const text = `📸 *Фото в пакете: ${photos.length}*\n\nДобавь фото отправив их в чат.\nДля удаления нажми кнопку:`;
  const rows = photos.map((_, i) => [{ text: `🗑 Удалить фото ${i+1}`, callback_data: `del_photo_${i}` }]);
  rows.push([{ text: "◀️ Назад", callback_data: "do_batch_menu" }]);
  bot.editMessageText(text, { chat_id: chatId, message_id: msgId, parse_mode: "Markdown", reply_markup: { inline_keyboard: rows } }).catch(()=>{});
}

// ─── Remix меню ───────────────────────────
function showRemixMenu(chatId, msgId = null) {
  const s = getState(chatId);
  const imgs = s.remixImages || [];
  const categoryEmoji = { MEDIA_CATEGORY_SUBJECT: "👤", MEDIA_CATEGORY_SCENE: "🌄", MEDIA_CATEGORY_STYLE: "🎨" };
  const catList = imgs.map((img, i) =>
    `${i+1}. ${categoryEmoji[img.category] || "📷"} ${img.category.replace("MEDIA_CATEGORY_","")}`
  ).join("\n") || "_Нет фото_";

  const text =
    `🎨 *Remix Image*\n\n` +
    `Добавь 1-3 фото и укажи роль каждого:\n` +
    `👤 SUBJECT — кто/что (персонаж, объект)\n` +
    `🌄 SCENE — фон, место, обстановка\n` +
    `🎨 STYLE — арт-стиль, атмосфера\n\n` +
    `*Добавлено:* ${imgs.length}/3\n${catList}`;

  const addRows = imgs.length < 3 ? [
    [{ text: "➕ Добавить фото", callback_data: "remix_add_photo" }],
  ] : [];
  const deleteRows = imgs.map((_, i) => [{ text: `🗑 Удалить фото ${i+1}`, callback_data: `remix_del_${i}` }]);
  const goRow = imgs.length >= 1 ? [{ text: "✏️ Ввести промпт →", callback_data: "remix_go" }] : [];

  const kb = { inline_keyboard: [
    ...addRows,
    ...deleteRows,
    ...(goRow.length ? [goRow] : []),
    [{ text: "◀️ Назад", callback_data: "back_menu" }],
  ]};

  if (msgId) bot.editMessageText(text, { chat_id: chatId, message_id: msgId, parse_mode: "Markdown", reply_markup: kb }).catch(()=>{});
  else bot.sendMessage(chatId, text, { parse_mode: "Markdown", reply_markup: kb });
}

// ─── Меню настройки улучшения промпта ────
function showEnhanceMenu(chatId, msgId = null) {
  const s = getState(chatId);
  const mode = s.enhanceMode || "ask";
  const text =
    `✨ *Улучшение промпта*\n\n` +
    `FastGen LLM автоматически улучшает твой промпт перед генерацией — добавляет детали освещения, стиля, камеры, атмосферы.\n\n` +
    `*Режим:*`;
  const kb = { inline_keyboard: [
    [{ text: mode==="always" ? "✅ Всегда улучшать" : "Всегда улучшать", callback_data: "enhance_always" }],
    [{ text: mode==="ask"    ? "✅ Спрашивать каждый раз" : "Спрашивать каждый раз", callback_data: "enhance_ask" }],
    [{ text: mode==="never"  ? "✅ Никогда (оригинальный)" : "Никогда (оригинальный)", callback_data: "enhance_never" }],
    [{ text: "◀️ Назад", callback_data: "back_menu" }],
  ]};
  if (msgId) bot.editMessageText(text, { chat_id: chatId, message_id: msgId, parse_mode: "Markdown", reply_markup: kb }).catch(()=>{});
  else bot.sendMessage(chatId, text, { parse_mode: "Markdown", reply_markup: kb });
}

// ─── Перегенерация ────────────────────────
function showRegenMenu(chatId, histIdx) {
  const h = getHistory(chatId);
  const item = h[histIdx];
  if (!item) return bot.sendMessage(chatId, "❌ Запись не найдена");

  const isImage = item.isImage;
  const s = getState(chatId);

  const text =
    `🔄 *Перегенерировать*\n\n` +
    `📝 Промпт:\n_${item.prompt.slice(0,200)}_\n\n` +
    `🤖 Модель: *${item.model}*\n` +
    `📐 Соотношение: *${item.ratio || s.ratio}*`;

  const modelRows = isImage
    ? Object.entries(IMAGE_MODELS).map(([k,v]) => [{ text: v.label, callback_data: `regen_run_${histIdx}_im_${k}` }])
    : Object.entries(VIDEO_MODELS).map(([k,v]) => [{ text: v.label, callback_data: `regen_run_${histIdx}_vm_${k}` }]);

  const kb = { inline_keyboard: [
    [{ text: "✏️ Изменить промпт", callback_data: `regen_edit_${histIdx}` }],
    ...modelRows,
    [{ text: "🔄 Та же модель", callback_data: `regen_same_${histIdx}` }],
    [{ text: "❌ Отмена", callback_data: "back_menu" }],
  ]};

  bot.sendMessage(chatId, text, { parse_mode: "Markdown", reply_markup: kb });
}

// ─── Генерация промптов ───────────────────
function showPromptGenMenu(chatId, msgId = null) {
  const s = getState(chatId);
  const providerLabel = { fastgen: "FastGen", openai: "OpenAI", gemini: "Gemini", openrouter: "OpenRouter" }[s.pgProvider] || s.pgProvider;
  const text =
    `🧠 *Генерация промптов*\n\n` +
    `Загрузи текст истории → ИИ разобьёт на части и сгенерирует промпт для каждой.\n\n` +
    `✂️ Разбивка: *${s.pgSplitMode === "lines" ? "По строкам" : "По предложениям"}*\n` +
    `⚡ Параллельных запросов: *${s.pgParallel}*\n` +
    `🤖 LLM провайдер: *${providerLabel}*\n` +
    (s.pgProvider !== "fastgen" ? `🔑 API ключ: *${s.pgApiKey ? "✅ задан" : "❌ не задан"}*\n` : "");

  const kb = { inline_keyboard: [
    [{ text: `${s.pgSplitMode === "lines" ? "✅ " : ""}Строки`, callback_data: "pg_split_lines" },
     { text: `${s.pgSplitMode === "sentences" ? "✅ " : ""}Предложения`, callback_data: "pg_split_sent" }],
    [{ text: `⚡ Параллельно: ${s.pgParallel}`, callback_data: "pg_parallel" }],
    [{ text: "✏️ Шаблон промпта", callback_data: "pg_template" }],
    [{ text: "🤖 LLM провайдер", callback_data: "pg_provider" }],
    ...(s.pgProvider !== "fastgen" ? [[{ text: "🔑 Задать API ключ", callback_data: "pg_apikey" }]] : []),
    [{ text: "📝 Ввести текст истории", callback_data: "pg_input_text" }],
    [{ text: "📄 Загрузить .txt файл", callback_data: "pg_input_file" }],
    [{ text: "◀️ Назад", callback_data: "back_menu" }],
  ]};

  if (msgId) bot.editMessageText(text, { chat_id: chatId, message_id: msgId, parse_mode: "Markdown", reply_markup: kb }).catch(()=>{});
  else bot.sendMessage(chatId, text, { parse_mode: "Markdown", reply_markup: kb });
}

async function callLLM(provider, apiKey, systemPrompt, userText) {
  if (provider === "fastgen") {
    const { data } = await axios.post(`${BASE_URL}/api/v5/prompts/generate`, {
      prompt: systemPrompt.replace("{TEXT}", userText),
    }, { headers: { "X-API-Key": FASTGEN_API_KEY, "Content-Type": "application/json" }, timeout: 30000 });
    if (data.operation_id || data.task_id || data.id) {
      const opId = data.operation_id || data.task_id || data.id;
      for (let i = 0; i < 20; i++) {
        await new Promise(r => setTimeout(r, 3000));
        const { data: op } = await axios.get(`${BASE_URL}/api/v4/operations/${opId}`, {
          headers: { "X-API-Key": FASTGEN_API_KEY }, timeout: 10000
        });
        const st = op.status || op.state;
        if (["completed","success","done","finished"].includes(st)) return op.result?.text || op.text || String(op.result || "");
        if (["failed","error","cancelled"].includes(st)) throw new Error(`LLM: ${st}`);
      }
      throw new Error("LLM timeout");
    }
    return data.text || data.result?.text || String(data.result || "");
  }
  if (provider === "openai") {
    const { data } = await axios.post("https://api.openai.com/v1/chat/completions", {
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: systemPrompt.replace("{TEXT}", userText) }],
      max_tokens: 1000,
    }, { headers: { "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json" }, timeout: 30000 });
    return data.choices?.[0]?.message?.content || "";
  }
  if (provider === "gemini") {
    const { data } = await axios.post(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`,
      { contents: [{ parts: [{ text: systemPrompt.replace("{TEXT}", userText) }] }] },
      { headers: { "Content-Type": "application/json" }, timeout: 30000 }
    );
    return data.candidates?.[0]?.content?.parts?.[0]?.text || "";
  }
  if (provider === "openrouter") {
    const { data } = await axios.post("https://openrouter.ai/api/v1/chat/completions", {
      model: "google/gemini-2.0-flash-001",
      messages: [{ role: "user", content: systemPrompt.replace("{TEXT}", userText) }],
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
    `🧠 *Генерация промптов*\n\nЧастей: ${parts.length} | Параллельно: ${s.pgParallel}\n⏳ Запускаю...`,
    { parse_mode: "Markdown" }
  );

  const results = [];
  let done = 0, errors = 0;

  for (let i = 0; i < parts.length; i += s.pgParallel) {
    const batch = parts.slice(i, i + s.pgParallel);
    const batchResults = await Promise.allSettled(batch.map(part => callLLM(s.pgProvider, s.pgApiKey, s.pgTemplate, part)));
    for (const r of batchResults) {
      if (r.status === "fulfilled" && r.value) { results.push(r.value.trim()); done++; }
      else errors++;
    }
    await bot.editMessageText(
      `🧠 Генерация: ✓${done}/${parts.length}${errors > 0 ? ` ✗${errors}` : ""}`,
      { chat_id: chatId, message_id: statusMsg.message_id }
    ).catch(()=>{});
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
  s.mode = "batch";

  await bot.editMessageText(
    `✅ Сгенерировано ${toAdd.length} промптов!${errors > 0 ? `\n⚠️ Ошибок: ${errors}` : ""}\nДобавлены в пакетный режим.`,
    { chat_id: chatId, message_id: statusMsg.message_id }
  ).catch(()=>{});

  showBatchMenu(chatId);
}

// ─── Reply Keyboard ──────────────────────
const REPLY_KEYBOARD = {
  keyboard: [
    [{ text: '🖼️ Изображение' }, { text: '🖼️📸 Фото из рефов' }],
    [{ text: '🎬 Видео из текста' }, { text: '📸 Видео из фото' }],
    [{ text: '🎨 Модель фото' }, { text: '🎥 Модель видео' }],
    [{ text: '📊 Баланс' }],
  ],
  resize_keyboard: true,
  persistent: true,
};

// ─── /start /menu ─────────────────────────
bot.onText(/\/start|\/menu/, async (msg) => {
  const chatId = msg.chat.id;
  const s = getState(chatId);
  if (s.menuMsgId) {
    await bot.deleteMessage(chatId, s.menuMsgId).catch(()=>{});
    s.menuMsgId = null;
  }
  await bot.sendMessage(chatId, '⌨️ Клавиатура активирована!', { reply_markup: REPLY_KEYBOARD });
  showMainMenu(chatId);
});

bot.onText(/\/check (.+)/, async (msg, match) => {
  await checkOperation(msg.chat.id, match[1].trim());
});

// ─── Callback ─────────────────────────────
bot.on("callback_query", async (query) => {
  const chatId = query.message.chat.id;
  const msgId  = query.message.message_id;
  const data   = query.data;
  const s      = getState(chatId);

  bot.answerCallbackQuery(query.id).catch(()=>{});

  function edit(text, kb) {
    return bot.editMessageText(text, { chat_id: chatId, message_id: msgId, parse_mode: "Markdown", reply_markup: kb }).catch(()=>{});
  }
  function del() {
    return bot.deleteMessage(chatId, msgId).catch(()=>{});
  }
  const cancelKb = { inline_keyboard: [[{ text: "❌ Отмена", callback_data: "back_menu" }]] };

  if (data === "noop") return;
  if (data === "back_menu" || data === "cancel") { s.step = null; del(); return showMainMenu(chatId); }
  if (data === "close_balance") { s.menuMsgId = msgId; return showMainMenu(chatId); }
  if (data === "show_balance")   { s.menuMsgId = msgId; return showBalance(chatId, msgId); }
  if (data === "refresh_balance") { return showBalance(chatId, msgId); }
  if (data === "open_misc")      { s.menuMsgId = msgId; return showMiscMenu(chatId, msgId); }
  if (data === "show_history")   { s.menuMsgId = msgId; return showHistoryMenu(chatId, msgId, 0); }
  if (data.startsWith("hist_page_")) {
    const pg = parseInt(data.replace("hist_page_",""));
    return showHistoryMenu(chatId, msgId, pg);
  }
  if (data === "hist_clear") {
    const key = String(chatId);
    history[key] = [];
    persistedHistory[key] = [];
    saveJSON(HISTORY_FILE, persistedHistory);
    return showHistoryMenu(chatId, msgId, 0);
  }

  // ── История
  if (data.startsWith("hist_")) {
    const idx = parseInt(data.replace("hist_",""));
    const h = getHistory(chatId);
    const item = h[idx];
    if (!item) return;
    const timeStr = item.ts ? new Date(item.ts).toLocaleString("ru") : "—";
    const typeIcon = item.isImage ? "🖼" : "🎬";
    return edit(
      `📋 *Запись ${idx+1}*\n\n` +
      `${typeIcon} *${item.model}*\n` +
      `🕐 ${timeStr}\n` +
      `📝 _${item.prompt}_\n\n` +
      `🔑 ID: \`${item.opId}\``,
      { inline_keyboard: [
        [{ text: "🔄 Перегенерировать", callback_data: `show_regen_${idx}` }],
        [{ text: "◀️ Назад к истории", callback_data: "show_history" }],
      ]}
    );
  }

  // ── Перегенерация — показать меню (новым сообщением, не трогая результат)
  if (data.startsWith("show_regen_")) {
    const idx = parseInt(data.replace("show_regen_",""));
    return showRegenMenu(chatId, idx);
  }

  // ── Перегенерация с фото (кнопка под результатом)
  if (data.startsWith("regen_")) {
    const parts = data.split("_");
    if (parts.length === 2) {
      const h = getHistory(chatId);
      if (h.length === 0) return bot.sendMessage(chatId, "❌ История пуста");
      return showRegenMenu(chatId, 0);
    }
    // regen_same_<idx>
    if (parts[1] === "same") {
      const idx = parseInt(parts[2]);
      const h = getHistory(chatId);
      const item = h[idx];
      if (!item) return;
      return runRegenItem(chatId, item, item.endpoint, item.isImage);
    }
    // regen_run_<idx>_im_<model> или regen_run_<idx>_vm_<model>
    if (parts[1] === "run") {
      const idx = parseInt(parts[2]);
      const type = parts[3]; // "im" or "vm"
      const modelKey = parts.slice(4).join("_");
      const h = getHistory(chatId);
      const item = h[idx];
      if (!item) return;
      const isImage = type === "im";
      const model = isImage ? IMAGE_MODELS[modelKey] : VIDEO_MODELS[modelKey];
      if (!model) return;
      const endpoint = isImage ? model.ep : model.epT;
      return runRegenItem(chatId, item, endpoint, isImage, model);
    }
    // regen_edit_<idx>
    if (parts[1] === "edit") {
      const idx = parseInt(parts[2]);
      s.step = `waiting_regen_prompt_${idx}`;
      return bot.sendMessage(chatId, "✏️ Отправь новый промпт:", cancelKb);
    }
  }

  // ── Режимы
  if (data === "do_image") { s.step="waiting_prompt"; s.tab="image"; s.mode="normal"; return edit(`🖼️ *Изображение*\n${IMAGE_MODELS[s.imgModel].label}\n\nНапиши промпт:`, cancelKb); }

  if (data === "do_image_ref") {
    s.pendingRefImages = []; s.tab="image_ref"; s.mode="normal"; s.step="waiting_ref_photos";
    return edit("🖼️📸 *Изображение из референсов*\n\nОтправь до 10 фото по одному.\nКогда добавишь все — нажми кнопку:", {
      inline_keyboard: [
        [{ text: "✅ Референсы готовы, ввести промпт", callback_data: "ref_photos_done" }],
        [{ text: "❌ Отмена", callback_data: "back_menu" }],
      ]
    });
  }
  if (data === "ref_photos_done") {
    if (!s.pendingRefImages || s.pendingRefImages.length === 0)
      return bot.sendMessage(chatId, "❌ Сначала отправь хотя бы 1 фото!", { reply_markup: { inline_keyboard: [[{ text: "◀️ Назад", callback_data: "do_image_ref" }]] } });
    s.step = "waiting_prompt";
    return bot.sendMessage(chatId, `✅ Референсов: ${s.pendingRefImages.length}\n\nТеперь напиши промпт:`, {
      reply_markup: { inline_keyboard: [[{ text: "❌ Отмена", callback_data: "back_menu" }]] }
    });
  }

  if (data === "do_vtext") { s.step="waiting_prompt"; s.tab="video_text"; s.mode="normal"; return edit(`🎬 *Видео из текста*\n${VIDEO_MODELS[s.vidModel].label}\n\nОпиши видео:`, cancelKb); }

  if (data === "do_vimage") {
    const maxVidRef = s.vidModel === "grok_vid" ? 7 : 3;
    s.pendingRefImages = []; s.tab="video_ref"; s.mode="normal"; s.step="waiting_vid_ref_photos";
    return edit(`📸 *Видео из фото*\n${VIDEO_MODELS[s.vidModel].label}\n\nОтправь до ${maxVidRef} фото:\n(Grok — до 7, Veo/остальные — до 3)`, {
      inline_keyboard: [
        [{ text: "✅ Фото готовы, ввести промпт", callback_data: "vid_ref_photos_done" }],
        [{ text: "❌ Отмена", callback_data: "back_menu" }],
      ]
    });
  }
  if (data === "vid_ref_photos_done") {
    if (!s.pendingRefImages || s.pendingRefImages.length === 0)
      return bot.sendMessage(chatId, "❌ Сначала отправь хотя бы 1 фото!", { reply_markup: { inline_keyboard: [[{ text: "◀️ Назад", callback_data: "do_vimage" }]] } });
    s.step = "waiting_prompt";
    return bot.sendMessage(chatId, `✅ Фото: ${s.pendingRefImages.length}\n\nТеперь напиши описание видео:`, {
      reply_markup: { inline_keyboard: [[{ text: "❌ Отмена", callback_data: "back_menu" }]] }
    });
  }
  if (data === "do_keyframes") {
    s.step="waiting_keyframe_start"; s.tab="video_text"; s.mode="keyframes"; s.keyframeStart=null; s.keyframeEnd=null;
    return edit("🎞 *Ключевые кадры*\n\nОтправь *первое* фото (начало):", cancelKb);
  }
  if (data === "kf_skip_end") { s.step="waiting_prompt"; return edit("✅ Только начальный кадр.\n\nНапиши описание:", cancelKb); }

  // ── Пакетный режим
  if (data === "do_batch") { s.mode="batch"; return showBatchTypeMenu(chatId, msgId); }
  if (data === "do_batch_menu") { s.mode="batch"; return showBatchMenu(chatId, msgId); }
  if (data === "batch_change_type") { return showBatchTypeMenu(chatId, msgId); }
  if (data === "batch_type_image")       { s.batchType="image";       s.tab="image";      saveState(chatId); return showBatchTypeMenu(chatId, msgId); }
  if (data === "batch_type_video_text")  { s.batchType="video_text";  s.tab="video_text"; saveState(chatId); return showBatchTypeMenu(chatId, msgId); }
  if (data === "batch_type_video_image") { s.batchType="video_image"; s.tab="video_image";saveState(chatId); return showBatchTypeMenu(chatId, msgId); }
  if (data === "batch_add_text") { s.step="waiting_batch_prompts"; return edit("✏️ Напиши промпты, каждый с новой строки:", cancelKb); }
  if (data === "batch_from_file") { s.step="waiting_txt_file"; return edit("📄 Отправь .txt файл с промптами (каждый с новой строки):", cancelKb); }
  if (data === "batch_photos_menu") return showBatchPhotosMenu(chatId, msgId);
  if (data.startsWith("del_photo_")) {
    const pi = parseInt(data.replace("del_photo_",""));
    s.batchPhotos.splice(pi, 1);
    return showBatchPhotosMenu(chatId, msgId);
  }
  if (data === "batch_per_prompt") {
    return edit("🔢 Сколько генераций на 1 промпт/фото?", { inline_keyboard: [
      [1,2,3,4,5].map(n => ({ text: s.perPrompt===n?`✅ ${n}`:`${n}`, callback_data:`set_pp_${n}` })),
      [{ text: "◀️ Назад", callback_data: "do_batch" }],
    ]});
  }
  if (data.startsWith("set_pp_")) { s.perPrompt=parseInt(data.replace("set_pp_","")); return showBatchMenu(chatId, msgId); }

  if (data === "batch_hourly_limit") {
    const cur = s.batchHourlyLimit || 15;
    return edit(
      `⏱ *Лимит видео в час*\n\nСейчас: *${cur}*\n\nСколько видео генерировать за один час?\n(Потом бот автоматически ждёт сброса лимита)`,
      { inline_keyboard: [
        [5, 10, 15, 20].map(n => ({ text: cur===n?`✅ ${n}`:`${n}`, callback_data:`set_hl_${n}` })),
        [25, 30, 40, 50].map(n => ({ text: cur===n?`✅ ${n}`:`${n}`, callback_data:`set_hl_${n}` })),
        [{ text: "✏️ Ввести своё число", callback_data: "set_hl_custom" }],
        [{ text: "◀️ Назад", callback_data: "do_batch_menu" }],
      ]}
    );
  }
  if (data.startsWith("set_hl_")) {
    const val = data.replace("set_hl_","");
    if (val === "custom") {
      s.step = "waiting_hourly_limit";
      return edit("⏱ Введи число видео в час (1–500):", { inline_keyboard: [[{ text: "❌ Отмена", callback_data: "do_batch_menu" }]] });
    }
    s.batchHourlyLimit = parseInt(val);
    saveState(chatId);
    return showBatchMenu(chatId, msgId);
  }
  if (data === "batch_clear") { s.batchPrompts=[]; s.batchPhotos=[]; s.batchPromptIdx=0; return showBatchMenu(chatId, msgId); }
  if (data === "batch_run") { del(); return runBatch(chatId); }

  // ── Настройки пакета
  if (data === "batch_settings") { return showBatchSettingsMenu(chatId, msgId); }
  if (data.startsWith("bset_im_")) {
    s.batchImgModel = data.replace("bset_im_","");
    saveState(chatId); return showBatchSettingsMenu(chatId, msgId);
  }
  if (data.startsWith("bset_vm_")) {
    s.batchVidModel = data.replace("bset_vm_","");
    saveState(chatId); return showBatchSettingsMenu(chatId, msgId);
  }
  if (data.startsWith("bset_ratio_")) {
    s.batchRatio = data.replace("bset_ratio_","").replace("x",":");
    saveState(chatId); return showBatchSettingsMenu(chatId, msgId);
  }
  if (data.startsWith("bset_res_")) {
    s.batchResolution = data.replace("bset_res_","");
    saveState(chatId); return showBatchSettingsMenu(chatId, msgId);
  }
  if (data === "bset_reset") {
    s.batchImgModel=null; s.batchVidModel=null; s.batchRatio=null; s.batchResolution=null;
    saveState(chatId); return showBatchSettingsMenu(chatId, msgId);
  }

  if (data === "bp_prev") { s.batchPromptIdx = Math.max(0, (s.batchPromptIdx||0)-1); return showBatchMenu(chatId, msgId); }
  if (data === "bp_next") { s.batchPromptIdx = Math.min(s.batchPrompts.length-1, (s.batchPromptIdx||0)+1); return showBatchMenu(chatId, msgId); }
  if (data === "bp_delete") {
    const idx = s.batchPromptIdx || 0;
    s.batchPrompts.splice(idx, 1);
    s.batchPromptIdx = Math.max(0, idx-1);
    return showBatchMenu(chatId, msgId);
  }

  // ── Модели
  if (data === "open_imgmodel") {
    const rows = Object.entries(IMAGE_MODELS).map(([k,v]) => [{ text:`${s.imgModel===k?"✅ ":""}${v.label} (${v.credits})`, callback_data:`set_im_${k}` }]);
    rows.push([{ text:"◀️ Назад", callback_data:"back_menu" }]);
    return edit("🎨 *Модель изображения:*", { inline_keyboard: rows });
  }
  if (data.startsWith("set_im_")) { s.imgModel=data.replace("set_im_",""); saveState(chatId); del(); return showMainMenu(chatId); }

  if (data === "open_vidmodel") {
    const rows = Object.entries(VIDEO_MODELS).map(([k,v]) => [{ text:`${s.vidModel===k?"✅ ":""}${v.label} (${v.credits})`, callback_data:`set_vm_${k}` }]);
    rows.push([{ text:"◀️ Назад", callback_data:"back_menu" }]);
    return edit("🎥 *Модель видео:*", { inline_keyboard: rows });
  }
  if (data.startsWith("set_vm_")) { s.vidModel=data.replace("set_vm_",""); saveState(chatId); del(); return showMainMenu(chatId); }

  if (data === "open_ratio") {
    const rows = [];
    for (let i=0; i<RATIOS.length; i+=3) rows.push(RATIOS.slice(i,i+3).map(r => ({ text:s.ratio===r?`✅ ${r}`:r, callback_data:`set_r_${r.replace(":","x")}` })));
    rows.push([{ text:"◀️ Назад", callback_data:"back_menu" }]);
    return edit("📐 *Соотношение сторон:*", { inline_keyboard: rows });
  }
  if (data.startsWith("set_r_")) { s.ratio=data.replace("set_r_","").replace("x",":"); saveState(chatId); del(); return showMainMenu(chatId); }

  if (data === "open_count") {
    s.step = "waiting_count";
    return edit(`🔢 *Количество за раз*\n\nСейчас: *${s.count}*\n\nНапиши число от 1 до 500:`, { inline_keyboard: [[{ text: "❌ Отмена", callback_data: "cancel_count" }]] });
  }
  if (data === "cancel_count") { s.step = null; del(); return showMainMenu(chatId); }

  if (data === "open_seed") {
    return edit("🌱 *Seed:*", { inline_keyboard: [
      [{ text:s.seed==="random"?"✅ Случайный":"Случайный", callback_data:"set_seed_random" }, { text:s.seed==="fixed"?"✅ Фиксированный":"Фиксированный", callback_data:"set_seed_fixed" }],
      [{ text:"◀️ Назад", callback_data:"back_menu" }],
    ]});
  }
  if (data === "set_seed_random") { s.seed="random"; saveState(chatId); del(); return showMainMenu(chatId); }
  if (data === "set_seed_fixed")  { s.seed="fixed";  saveState(chatId); del(); return showMainMenu(chatId); }

  // ── Генерация промптов
  if (data === "open_promptgen") { return showPromptGenMenu(chatId, msgId); }
  if (data === "pg_split_lines") { s.pgSplitMode = "lines"; saveState(chatId); return showPromptGenMenu(chatId, msgId); }
  if (data === "pg_split_sent")  { s.pgSplitMode = "sentences"; saveState(chatId); return showPromptGenMenu(chatId, msgId); }
  if (data === "pg_parallel") {
    return edit("⚡ *Параллельных запросов:*", { inline_keyboard: [
      [1,2,3,5].map(n => ({ text: s.pgParallel===n?`✅ ${n}`:`${n}`, callback_data:`set_pgp_${n}` })),
      [7,10,15,20].map(n => ({ text: s.pgParallel===n?`✅ ${n}`:`${n}`, callback_data:`set_pgp_${n}` })),
      [{ text: "◀️ Назад", callback_data: "open_promptgen" }],
    ]});
  }
  if (data.startsWith("set_pgp_")) { s.pgParallel = parseInt(data.replace("set_pgp_","")); saveState(chatId); return showPromptGenMenu(chatId, msgId); }
  if (data === "pg_provider") {
    return edit("🤖 *LLM провайдер:*", { inline_keyboard: [
      [{ text: s.pgProvider==="fastgen"?"✅ FastGen":"FastGen", callback_data:"set_pgprov_fastgen" }],
      [{ text: s.pgProvider==="openai"?"✅ OpenAI":"OpenAI", callback_data:"set_pgprov_openai" }],
      [{ text: s.pgProvider==="gemini"?"✅ Gemini":"Gemini", callback_data:"set_pgprov_gemini" }],
      [{ text: s.pgProvider==="openrouter"?"✅ OpenRouter":"OpenRouter", callback_data:"set_pgprov_openrouter" }],
      [{ text: "◀️ Назад", callback_data: "open_promptgen" }],
    ]});
  }
  if (data.startsWith("set_pgprov_")) { s.pgProvider = data.replace("set_pgprov_",""); saveState(chatId); return showPromptGenMenu(chatId, msgId); }
  if (data === "pg_apikey") { s.step = "waiting_pg_apikey"; return edit(`🔑 *API ключ для ${s.pgProvider}*\n\nОтправь ключ в чат:`, cancelKb); }
  if (data === "pg_template") {
    s.step = "waiting_pg_template";
    return edit(`✏️ *Шаблон промпта*\n\nИспользуй \`{TEXT}\` как плейсхолдер.\n\nОтправь новый шаблон:`, { inline_keyboard: [
      [{ text: "🔄 Сбросить", callback_data: "pg_template_reset" }],
      [{ text: "❌ Отмена", callback_data: "open_promptgen" }],
    ]});
  }
  if (data === "pg_template_reset") {
    s.pgTemplate = DEFAULT_STATE().pgTemplate;
    saveState(chatId);
    return showPromptGenMenu(chatId, msgId);
  }
  if (data === "pg_input_text") { s.step = "waiting_pg_story"; return edit("📝 Отправь текст истории:", cancelKb); }
  if (data === "pg_input_file") { s.step = "waiting_pg_file";  return edit("📄 Отправь .txt файл:", cancelKb); }

  // ── Разрешение
  if (data === "open_resolution") {
    return edit("🖥 *Разрешение Grok Video:*", { inline_keyboard: [
      ["480p","720p","1080p"].map(r => ({ text: (s.resolution||"720p")===r?`✅ ${r}`:r, callback_data:`set_res_${r}` })),
      [{ text:"◀️ Назад", callback_data:"back_menu" }],
    ]});
  }
  if (data.startsWith("set_res_")) { s.resolution=data.replace("set_res_",""); saveState(chatId); del(); return showMainMenu(chatId); }

  // ── Улучшение промпта — настройки
  if (data === "open_enhance") { return showEnhanceMenu(chatId, msgId); }
  if (data === "enhance_always") { s.enhanceMode="always"; saveState(chatId); return showEnhanceMenu(chatId, msgId); }
  if (data === "enhance_ask")    { s.enhanceMode="ask";    saveState(chatId); return showEnhanceMenu(chatId, msgId); }
  if (data === "enhance_never")  { s.enhanceMode="never";  saveState(chatId); return showEnhanceMenu(chatId, msgId); }

  // ── Улучшение промпта — ответ пользователя (yes/no)
  if (data === "enhance_yes") {
    const rawPrompt = s.pendingPrompt;
    const isVideo = s.pendingIsVideo;
    const genKey = s.pendingGenKey;
    const genFn = pendingGenerators.get(genKey);
    if (s.pendingMsgId) await bot.deleteMessage(chatId, s.pendingMsgId).catch(()=>{});
    s.pendingPrompt = null; s.pendingMsgId = null; s.pendingGenKey = null;
    if (!genFn || !rawPrompt) return showMainMenu(chatId);
    const waitMsg = await bot.sendMessage(chatId, "✨ Улучшаю промпт...");
    const enhanced = await enhancePrompt(rawPrompt, isVideo);
    await bot.deleteMessage(chatId, waitMsg.message_id).catch(()=>{});
    if (enhanced && enhanced !== rawPrompt) {
      await bot.sendMessage(chatId,
        `✨ *Промпт улучшен:*\n_${enhanced.slice(0,300)}${enhanced.length>300?"...":""}_`,
        { parse_mode: "Markdown" }
      );
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
    if (s.pendingMsgId) await bot.deleteMessage(chatId, s.pendingMsgId).catch(()=>{});
    s.pendingPrompt = null; s.pendingMsgId = null; s.pendingGenKey = null;
    if (!genFn || !rawPrompt) return showMainMenu(chatId);
    pendingGenerators.delete(genKey);
    return genFn(rawPrompt);
  }

  // ── Отмена всех операций
  if (data === "cancel_all_ops") {
    await bot.answerCallbackQuery(query.id, { text: "⏳ Отменяю..." });
    const result = await cancelAllOperations();
    const txt = result
      ? `✅ Все операции отменены!\n${JSON.stringify(result).slice(0,100)}`
      : "❌ Не удалось отменить операции";
    await bot.sendMessage(chatId, txt);
    return showBalance(chatId, msgId);
  }

  // ── Remix
  if (data === "do_remix") {
    s.remixImages = []; s.tab = "image"; s.mode = "normal";
    return showRemixMenu(chatId, msgId);
  }
  if (data === "remix_add_photo") {
    s.step = "waiting_remix_photo";
    return edit("📸 Отправь фото для Remix:", { inline_keyboard: [[{ text:"❌ Отмена", callback_data:"do_remix" }]] });
  }
  if (data === "remix_go") {
    s.step = "waiting_remix_prompt";
    return edit("✏️ Напиши промпт для Remix:", { inline_keyboard: [[{ text:"❌ Отмена", callback_data:"do_remix" }]] });
  }
  if (data.startsWith("remix_del_")) {
    const ri = parseInt(data.replace("remix_del_",""));
    if (s.remixImages) s.remixImages.splice(ri, 1);
    return showRemixMenu(chatId, msgId);
  }
  if (data.startsWith("remix_cat_")) {
    // remix_cat_0_MEDIA_CATEGORY_SUBJECT
    const parts = data.split("_");
    const photoIdx = parseInt(parts[2]);
    const category = parts.slice(3).join("_");
    if (!s.remixImages) s.remixImages = [];
    // Этот fileId уже сохранён в s.pendingRemixFileId
    s.remixImages.push({ fileId: s.pendingRemixFileId, category });
    s.pendingRemixFileId = null;
    return showRemixMenu(chatId, msgId);
  }
});

// ─── Фото ─────────────────────────────────
// Дедупликация media_group — показываем итог один раз после задержки
const mediaGroupTimers = new Map();

bot.on("photo", async (msg) => {
  const chatId = msg.chat.id;
  const s = getState(chatId);
  const fileId = msg.photo[msg.photo.length-1].file_id;

  if (s.mode === "batch") {
    const bt = s.batchType || "image";
    if (bt === "video_image") {
      if (s.batchPhotos.length >= 500)
        return bot.sendMessage(chatId, `❌ Максимум 500 фото в пакете!`);
      s.batchPhotos.push(fileId);
      // Если это альбом — дебаунсим сообщение
      if (msg.media_group_id) {
        if (mediaGroupTimers.has(msg.media_group_id)) clearTimeout(mediaGroupTimers.get(msg.media_group_id));
        const t = setTimeout(() => {
          mediaGroupTimers.delete(msg.media_group_id);
          bot.sendMessage(chatId, `✅ Фото добавлены! Всего: ${s.batchPhotos.length}/500 фото, ${s.batchPrompts.length} промптов`, {
            reply_markup: { inline_keyboard: [[{ text:"📦 Открыть меню пакета", callback_data:"do_batch_menu" }],[{ text:"🚀 Генерировать!", callback_data:"batch_run" }]] }
          });
        }, 1500);
        mediaGroupTimers.set(msg.media_group_id, t);
        return;
      }
      return bot.sendMessage(chatId, `✅ Фото добавлено! Всего: ${s.batchPhotos.length}/500 фото, ${s.batchPrompts.length} промптов`, {
        reply_markup: { inline_keyboard: [[{ text:"📦 Открыть меню пакета", callback_data:"do_batch_menu" }],[{ text:"🚀 Генерировать!", callback_data:"batch_run" }]] }
      });
    } else {
      return bot.sendMessage(chatId, `ℹ️ Сейчас выбран режим «${bt === "image" ? "Фото из текста" : "Видео из текста"}». Фото не нужны.\nДля режима «Видео из фото» смени тип в пакетном меню.`, {
        reply_markup: { inline_keyboard: [[{ text:"📦 Открыть меню пакета", callback_data:"do_batch_menu" }]] }
      });
    }
  }
  if (s.step === "waiting_keyframe_start") {
    s.keyframeStart = fileId; s.step = "waiting_keyframe_end";
    return bot.sendMessage(chatId, "✅ Первый кадр! Отправь второе фото или пропусти:", {
      reply_markup: { inline_keyboard: [[{ text:"⏭ Пропустить", callback_data:"kf_skip_end" }],[{ text:"❌ Отмена", callback_data:"back_menu" }]] }
    });
  }
  if (s.step === "waiting_keyframe_end") {
    s.keyframeEnd = fileId; s.step = "waiting_prompt";
    return bot.sendMessage(chatId, "✅ Оба кадра! Напиши описание:", {
      reply_markup: { inline_keyboard: [[{ text:"❌ Отмена", callback_data:"back_menu" }]] }
    });
  }
  if (s.step === "waiting_remix_photo") {
    s.pendingRemixFileId = fileId;
    s.step = null;
    const idx = (s.remixImages || []).length;
    const kb = { inline_keyboard: [
      [{ text: "👤 Субъект (кто/что)", callback_data: `remix_cat_${idx}_MEDIA_CATEGORY_SUBJECT` }],
      [{ text: "🌄 Сцена (фон/место)", callback_data: `remix_cat_${idx}_MEDIA_CATEGORY_SCENE` }],
      [{ text: "🎨 Стиль", callback_data: `remix_cat_${idx}_MEDIA_CATEGORY_STYLE` }],
      [{ text: "❌ Отмена", callback_data: "do_remix" }],
    ]};
    return bot.sendMessage(chatId, "🎨 Выбери роль этого фото:", { reply_markup: kb });
  }
  if (s.step === "waiting_ref_photos") {
    if (!s.pendingRefImages) s.pendingRefImages = [];
    if (s.pendingRefImages.length >= 10)
      return bot.sendMessage(chatId, "❌ Максимум 10 референсов!", { reply_markup: { inline_keyboard: [[{ text: "✅ Готово, ввести промпт", callback_data: "ref_photos_done" }]] } });
    s.pendingRefImages.push(fileId);
    const cnt = s.pendingRefImages.length;
    return bot.sendMessage(chatId, `✅ Референс ${cnt}/10 добавлен!`, {
      reply_markup: { inline_keyboard: [
        [{ text: `✅ Готово (${cnt} фото), ввести промпт`, callback_data: "ref_photos_done" }],
        [{ text: "❌ Отмена", callback_data: "back_menu" }],
      ]}
    });
  }
  if (s.step === "waiting_vid_ref_photos") {
    if (!s.pendingRefImages) s.pendingRefImages = [];
    const maxVidRef = s.vidModel === "grok_vid" ? 7 : 3;
    if (s.pendingRefImages.length >= maxVidRef)
      return bot.sendMessage(chatId, `❌ Максимум ${maxVidRef} фото!`, { reply_markup: { inline_keyboard: [[{ text: "✅ Готово, ввести промпт", callback_data: "vid_ref_photos_done" }]] } });
    s.pendingRefImages.push(fileId);
    const cnt2 = s.pendingRefImages.length;
    return bot.sendMessage(chatId, `✅ Фото ${cnt2}/${maxVidRef} добавлено!`, {
      reply_markup: { inline_keyboard: [
        [{ text: `✅ Готово (${cnt2} фото), ввести промпт`, callback_data: "vid_ref_photos_done" }],
        [{ text: "❌ Отмена", callback_data: "back_menu" }],
      ]}
    });
  }
  if (s.step === "waiting_photo") {
    s.fileId = fileId; s.step = "waiting_prompt";
    return bot.sendMessage(chatId, "✅ Фото получено! Напиши описание:", {
      reply_markup: { inline_keyboard: [[{ text:"❌ Отмена", callback_data:"back_menu" }]] }
    });
  }
  s.fileId = fileId; s.tab = "video_image"; s.step = "waiting_prompt"; s.mode = "normal";
  const vm = VIDEO_MODELS[s.vidModel];
  bot.sendMessage(chatId, `✅ Фото получено!\n\n🎬 *${vm.label}* (${vm.credits})\n\nНапиши описание для видео:`, {
    parse_mode: "Markdown",
    reply_markup: { inline_keyboard: [
      [{ text: "🎥 Сменить модель видео", callback_data: "open_vidmodel" }],
      [{ text: "❌ Отмена", callback_data: "back_menu" }],
    ]}
  });
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
      const isImage = bt === "image";
      const MAX = isImage ? 500 : 200; // видео: 200, почасовой режим разобьёт по 15
      const toAdd = prompts.slice(0, MAX - s.batchPrompts.length);
      const skipped = prompts.length - toAdd.length;
      s.batchPrompts.push(...toAdd);
      s.batchPromptIdx = 0;
      let reply = `✅ Загружено ${toAdd.length} промптов из файла!`;
      if (skipped > 0) reply += `\n⚠️ Пропущено ${skipped} (лимит ${MAX})`;
      bot.sendMessage(chatId, reply, { reply_markup: { inline_keyboard: [[{ text:"📦 Открыть пакет", callback_data:"do_batch_menu" }]] } });
    } catch(e) { bot.sendMessage(chatId, `❌ Ошибка файла: ${e.message}`); }
  }
});

// ─── Текст ────────────────────────────────
bot.on("message", async (msg) => {
  const chatId = msg.chat.id;
  const s = getState(chatId);
  if (!msg.text || msg.text.startsWith("/")) return;

  // ── Reply Keyboard кнопки
  const replyMap = {
    "🖼️ Изображение":     "do_image",
    "🖼️📸 Фото из рефов": "do_image_ref",
    "🎬 Видео из текста": "do_vtext",
    "📸 Видео из фото":   "do_vimage",
    "🎨 Модель фото":     "open_imgmodel",
    "🎥 Модель видео":    "open_vidmodel",
    "📊 Баланс":          "show_balance",
  };
  if (replyMap[msg.text]) {
    s.step = null;
    const action = replyMap[msg.text];
    if (s.menuMsgId) { await bot.deleteMessage(chatId, s.menuMsgId).catch(()=>{}); s.menuMsgId = null; }
    if (action === "show_balance") return showBalance(chatId);
    if (action === "open_imgmodel") {
      const rows = Object.entries(IMAGE_MODELS).map(([k,v]) => [{ text:`${s.imgModel===k?"✅ ":""}${v.label} (${v.credits})`, callback_data:`set_im_${k}` }]);
      rows.push([{ text:"◀️ Назад", callback_data:"back_menu" }]);
      const m = await bot.sendMessage(chatId, "🎨 *Модель изображения:*", { parse_mode:"Markdown", reply_markup: { inline_keyboard: rows } });
      s.menuMsgId = m.message_id; return;
    }
    if (action === "open_vidmodel") {
      const rows = Object.entries(VIDEO_MODELS).map(([k,v]) => [{ text:`${s.vidModel===k?"✅ ":""}${v.label} (${v.credits})`, callback_data:`set_vm_${k}` }]);
      rows.push([{ text:"◀️ Назад", callback_data:"back_menu" }]);
      const m = await bot.sendMessage(chatId, "🎥 *Модель видео:*", { parse_mode:"Markdown", reply_markup: { inline_keyboard: rows } });
      s.menuMsgId = m.message_id; return;
    }
    if (action === "do_image") {
      s.step="waiting_prompt"; s.tab="image"; s.mode="normal";
      const m = await bot.sendMessage(chatId, `🖼️ *Изображение*\n${IMAGE_MODELS[s.imgModel].label}\n\nНапиши промпт:`, { parse_mode:"Markdown", reply_markup: { inline_keyboard: [[{ text:"❌ Отмена", callback_data:"back_menu" }]] } });
      s.menuMsgId = m.message_id; return;
    }
    if (action === "do_image_ref") {
      s.pendingRefImages=[]; s.tab="image_ref"; s.mode="normal"; s.step="waiting_ref_photos";
      const m = await bot.sendMessage(chatId, "🖼️📸 *Фото из референсов*\n\nОтправь до 10 фото, затем нажми кнопку:", { parse_mode:"Markdown", reply_markup: { inline_keyboard: [
        [{ text:"✅ Готово, ввести промпт", callback_data:"ref_photos_done" }],
        [{ text:"❌ Отмена", callback_data:"back_menu" }],
      ]}});
      s.menuMsgId = m.message_id; return;
    }
    if (action === "do_vtext") {
      s.step="waiting_prompt"; s.tab="video_text"; s.mode="normal";
      const m = await bot.sendMessage(chatId, `🎬 *Видео из текста*\n${VIDEO_MODELS[s.vidModel].label}\n\nОпиши видео:`, { parse_mode:"Markdown", reply_markup: { inline_keyboard: [[{ text:"❌ Отмена", callback_data:"back_menu" }]] } });
      s.menuMsgId = m.message_id; return;
    }
    if (action === "do_vimage") {
      const maxVidRef = s.vidModel === "grok_vid" ? 7 : 3;
      s.pendingRefImages=[]; s.tab="video_ref"; s.mode="normal"; s.step="waiting_vid_ref_photos";
      const m = await bot.sendMessage(chatId, `📸 *Видео из фото*\n${VIDEO_MODELS[s.vidModel].label}\n\nОтправь до ${maxVidRef} фото:`, { parse_mode:"Markdown", reply_markup: { inline_keyboard: [
        [{ text:"✅ Фото готовы, ввести промпт", callback_data:"vid_ref_photos_done" }],
        [{ text:"❌ Отмена", callback_data:"back_menu" }],
      ]}});
      s.menuMsgId = m.message_id; return;
    }
    return;
  }

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
    await bot.sendMessage(chatId, `✅ Лимит видео/час установлен: *${n}*`, { parse_mode: "Markdown" });
    return showBatchMenu(chatId);
  }
  if (s.step === "waiting_batch_prompts") {
    s.step = null;
    const bt = s.batchType || "image";
    const isImage = bt === "image";
    const MAX = isImage ? 500 : 200; // видео: 200 промптов, почасовой режим сам разобьёт по 15
    const prompts = msg.text.split("\n").map(p => p.trim()).filter(Boolean);
    const toAdd = prompts.slice(0, MAX - s.batchPrompts.length);
    const skipped = prompts.length - toAdd.length;
    s.batchPrompts.push(...toAdd);
    s.batchPromptIdx = Math.max(0, s.batchPrompts.length - toAdd.length);
    let reply = `✅ Добавлено ${toAdd.length} промптов!`;
    if (skipped > 0) reply += `\n⚠️ Пропущено ${skipped} (лимит ${MAX})`;
    return bot.sendMessage(chatId, reply, { reply_markup: { inline_keyboard: [[{ text:"📦 Меню пакета", callback_data:"do_batch_menu" }]] } });
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

  // Перегенерация с новым промптом
  if (s.step && s.step.startsWith("waiting_regen_prompt_")) {
    const idx = parseInt(s.step.replace("waiting_regen_prompt_",""));
    s.step = null;
    const h = getHistory(chatId);
    const item = h[idx];
    if (!item) return bot.sendMessage(chatId, "❌ Запись не найдена");
    const newItem = { ...item, prompt: msg.text };
    return runRegenItem(chatId, newItem, newItem.endpoint, newItem.isImage);
  }

  if (s.step === "waiting_remix_prompt") {
    s.step = null;
    const prompt = msg.text;
    return handlePromptAndGenerate(chatId, s, prompt, (finalPrompt) => runRemix(chatId, s, finalPrompt));
  }

  if (s.step !== "waiting_prompt") return showMainMenu(chatId);

  const prompt = msg.text;
  s.step = null;
  if (s.mode === "keyframes") return runKeyframes(chatId, s, prompt);
  await runNormal(chatId, s, prompt);
});

// ─── Обычная генерация ────────────────────
// Обработчик промпта с улучшением
async function handlePromptAndGenerate(chatId, s, rawPrompt, generatorFn) {
  const mode = s.enhanceMode || "ask";
  const isVideo = s.tab === "video_text" || s.tab === "video_ref";

  if (mode === "never") {
    return generatorFn(rawPrompt);
  }
  if (mode === "always") {
    const waitMsg = await bot.sendMessage(chatId, "✨ Улучшаю промпт...", {});
    const enhanced = await enhancePrompt(rawPrompt, isVideo);
    await bot.deleteMessage(chatId, waitMsg.message_id).catch(()=>{});
    if (enhanced && enhanced !== rawPrompt) {
      await bot.sendMessage(chatId,
        `✨ *Промпт улучшен:*\n_${enhanced.slice(0, 300)}${enhanced.length > 300 ? "..." : ""}_`,
        { parse_mode: "Markdown" }
      );
      return generatorFn(enhanced);
    }
    return generatorFn(rawPrompt);
  }
  // mode === "ask"
  const previewMsg = await bot.sendMessage(chatId,
    `✨ *Улучшить промпт?*\n\n📝 _${rawPrompt.slice(0, 200)}${rawPrompt.length > 200 ? "..." : ""}_`,
    {
      parse_mode: "Markdown",
      reply_markup: { inline_keyboard: [
        [{ text: "✨ Улучшить", callback_data: "enhance_yes" }, { text: "⏭ Оригинал", callback_data: "enhance_no" }],
      ]}
    }
  );
  // Сохраняем промпт и коллбэк в состояние
  s.pendingPrompt = rawPrompt;
  s.pendingIsVideo = isVideo;
  s.pendingMsgId = previewMsg.message_id;
  s.pendingGenKey = `gen_${Date.now()}`;
  // Сохраняем функцию-генератор в Map
  pendingGenerators.set(s.pendingGenKey, generatorFn);
}

// Map для хранения pending генераторов (не сериализуется)
const pendingGenerators = new Map();
async function runNormal(chatId, s, prompt) {
  const isImage = s.tab === "image" || s.tab === "image_ref";
  let model, endpoint;
  if (s.tab === "image" || s.tab === "image_ref") { model = IMAGE_MODELS[s.imgModel]; endpoint = model.ep; }
  else if (s.tab === "video_text") { model = VIDEO_MODELS[s.vidModel]; endpoint = model.epT; }
  else if (s.tab === "video_ref") { model = VIDEO_MODELS[s.vidModel]; endpoint = model.epI; }
  else { model = VIDEO_MODELS[s.vidModel]; endpoint = model.epI; }

  const doGenerate = async (finalPrompt) => {
    const count = s.count;
    const queue = isImage ? imageQueue : videoQueue;
    let done = 0, errors = 0;
    const errorLog = [];
    const statusMsg = await bot.sendMessage(chatId,
      `⏳ *${count} задач в очереди*\n🎨 ${model.label}\n💳 ${model.credits}\n(макс. 10 параллельно)`,
      { parse_mode: "Markdown" });

    const tasks = Array.from({length:count}, (_,i) =>
      queue(() => genOne(chatId, s, finalPrompt, endpoint, model, isImage, i+1, count))
        .then(() => { done++; })
        .catch((e) => {
          errors++;
          const errDetail = e.response?.data?.detail || e.response?.data?.message || e.message;
          const errStatus = e.response?.status ? `[${e.response.status}] ` : "";
          errorLog.push({ idx: i+1, err: `${errStatus}${String(errDetail).slice(0,200)}` });
        })
        .finally(() => {
          bot.editMessageText(
            `⏳ Прогресс: ✓${done}/${count}${errors>0?` ✗${errors}`:""}\n🎨 ${model.label}`,
            { chat_id: chatId, message_id: statusMsg.message_id, parse_mode: "Markdown" }
          ).catch(()=>{});
        })
    );

    await Promise.allSettled(tasks);
    let finalText2 = `✅ Готово! ✓${done}${errors>0?` ✗${errors}`:""}`;
    if (errorLog.length > 0) {
      finalText2 += `\n\n⚠️ *Ошибки:*`;
      for (const er of errorLog.slice(0, 8)) finalText2 += `\n• [${er.idx}] \`${er.err}\``;
      if (errorLog.length > 8) finalText2 += `\n...и ещё ${errorLog.length - 8}`;
    }
    await bot.editMessageText(finalText2, { chat_id: chatId, message_id: statusMsg.message_id, parse_mode: "Markdown" }).catch(()=>{});
    showMainMenu(chatId);
  };

  await handlePromptAndGenerate(chatId, s, prompt, doGenerate);
}

// ─── Ключевые кадры ───────────────────────
async function runKeyframes(chatId, s, prompt) {
  const doGenerate = async (finalPrompt) => {
    const model = VIDEO_MODELS[s.vidModel];
    const statusMsg = await bot.sendMessage(chatId, `⏳ Ключевые кадры...\n🎥 ${model.label}`);
    try {
      const body = { prompt: finalPrompt, aspect_ratio: s.ratio, ...(model.sub && { model: model.sub }) };
      if (s.keyframeStart) {
        const f = await bot.getFile(s.keyframeStart);
        const r = await axios.get(`https://api.telegram.org/file/bot${TELEGRAM_TOKEN}/${f.file_path}`, { responseType:"arraybuffer" });
        body.start_image = `data:image/jpeg;base64,${Buffer.from(r.data).toString("base64")}`;
      }
      if (s.keyframeEnd) {
        const f = await bot.getFile(s.keyframeEnd);
        const r = await axios.get(`https://api.telegram.org/file/bot${TELEGRAM_TOKEN}/${f.file_path}`, { responseType:"arraybuffer" });
        body.end_image = `data:image/jpeg;base64,${Buffer.from(r.data).toString("base64")}`;
      }
      const { data } = await axios.post(`${BASE_URL}${model.epK || model.epT}`, body, {
        headers: { "X-API-Key": FASTGEN_API_KEY, "Content-Type": "application/json" }, timeout: 60000
      });
      const opId = data.operation_id || data.task_id || data.id;
      if (!opId) throw new Error("Нет ID");
      const result = await pollResult(opId);
      if (result) {
        await bot.editMessageText("✅ Готово!", { chat_id: chatId, message_id: statusMsg.message_id });
        await sendMedia(chatId, result, false, `🎞 Ключ. кадры\n📝 _${finalPrompt.slice(0,100)}_`);
      }
    } catch(e) {
      await bot.editMessageText(`❌ ${e.message}`, { chat_id: chatId, message_id: statusMsg.message_id });
    }
    showMainMenu(chatId);
  };
  await handlePromptAndGenerate(chatId, s, prompt, doGenerate);
}

// ─── Remix генерация ──────────────────────
async function runRemix(chatId, s, prompt) {
  const imgs = s.remixImages || [];
  if (imgs.length === 0) return bot.sendMessage(chatId, "❌ Добавь хотя бы одно фото для Remix!");
  const statusMsg = await bot.sendMessage(chatId, `⏳ *Remix генерация...*\n📸 Фото: ${imgs.length}`, { parse_mode: "Markdown" });
  try {
    const referenceImages = [];
    for (const img of imgs) {
      const f = await bot.getFile(img.fileId);
      const r = await axios.get(`https://api.telegram.org/file/bot${TELEGRAM_TOKEN}/${f.file_path}`, { responseType: "arraybuffer" });
      const buf = Buffer.from(r.data);
      const fileRef = await uploadToStorage(buf);
      referenceImages.push({
        image: fileRef || `data:image/jpeg;base64,${buf.toString("base64")}`,
        category: img.category,
      });
    }
    const body = {
      prompt,
      reference_images: referenceImages,
      aspect_ratio: s.ratio,
      ...(s.seed === "fixed" && { seed: 42 }),
    };
    const { data } = await axios.post(`${BASE_URL}/api/v4/flow/image/remix`, body, {
      headers: { "X-API-Key": FASTGEN_API_KEY, "Content-Type": "application/json" },
      timeout: 120000,
    });
    const opId = data.operation_id || data.task_id || data.id;
    if (!opId) throw new Error("Нет ID задачи");
    addHistory(chatId, { index: "remix", model: "Remix (GoogleFX)", prompt, opId, endpoint: "/api/v4/flow/image/remix", body, isImage: true, ratio: s.ratio });
    const result = await pollResult(opId);
    spendBalance("images", 1);
    await bot.editMessageText("✅ Remix готов!", { chat_id: chatId, message_id: statusMsg.message_id }).catch(()=>{});
    if (result) {
      const regenKb = { inline_keyboard: [[{ text: "🔄 Перегенерировать", callback_data: "show_regen_0" }]] };
      await sendMedia(chatId, result, true, `🎨 Remix\n📝 _${prompt.slice(0, 100)}_`, regenKb);
    }
  } catch(e) {
    const errStr = e.response?.data?.detail || e.message;
    await bot.editMessageText(`❌ Remix ошибка: ${String(errStr).slice(0,200)}`, { chat_id: chatId, message_id: statusMsg.message_id }).catch(()=>{});
  }
  s.remixImages = [];
  showMainMenu(chatId);
}

// ─── Пакетная генерация ───────────────────
async function runBatch(chatId) {
  const s = getState(chatId);
  // Берём эффективные настройки пакета (свои или из главного меню)
  const { bt, isImage, model, ratio, resolution } = batchEffective(s);
  const isVideoImage = bt === "video_image";
  // Создаём временную копию состояния с настройками пакета для genOne
  const batchS = { ...s, ratio, resolution };
  const prompts = [...s.batchPrompts];
  const photos = [...s.batchPhotos];
  const perPrompt = s.perPrompt || 1;

  if (prompts.length === 0 && photos.length === 0) return bot.sendMessage(chatId, "❌ Нет промптов или фото!");
  if (isVideoImage && photos.length === 0) return bot.sendMessage(chatId, "❌ Для режима «Видео из фото» нужно добавить фото!");

  const tasks = [];

  if (isVideoImage) {
    // Видео из фото: каждое фото + (промпт или "animate") × perPrompt
    for (let fi = 0; fi < photos.length; fi++) {
      const prompt = prompts[fi] || prompts[0] || "animate";
      for (let vi = 0; vi < perPrompt; vi++)
        tasks.push({ prompt, idx: `ф${fi+1}.${vi+1}`, ep: model.epI || model.epT, isImg: false, fileId: photos[fi] });
    }
    // Если промптов больше чем фото — добавим видео из текста для остатка промптов
    for (let pi = photos.length; pi < prompts.length; pi++)
      for (let vi = 0; vi < perPrompt; vi++)
        tasks.push({ prompt: prompts[pi], idx: `т${pi+1}.${vi+1}`, ep: model.epT, isImg: false, fileId: null });
  } else {
    // Фото из текста или видео из текста
    for (let pi = 0; pi < prompts.length; pi++)
      for (let vi = 0; vi < perPrompt; vi++)
        tasks.push({ prompt: prompts[pi], idx: `${pi+1}.${vi+1}`, ep: isImage ? model.ep : model.epT, isImg: isImage, fileId: null });
  }

  const total = tasks.length;
  const hourlyLimit = s.batchHourlyLimit || 15;

  if (!isImage && total > hourlyLimit) {
    // ── Почасовой режим для видео (пачки по hourlyLimit)
    videoScheduler[chatId] = {
      tasks: [...tasks],
      totalTasks: total,
      doneSoFar: 0,
      errorsSoFar: 0,
      statusMsgId: null,
      hourlyLimit,
      model, s: batchS,
    };
    await bot.sendMessage(chatId,
      `⏰ *Почасовой видео-пакет запущен!*\n` +
      `Всего задач: *${total}*\n` +
      `Лимит в час: *${hourlyLimit}*\n` +
      `Пачек: *${Math.ceil(total/hourlyLimit)}*\n` +
      `Параллельно: *10 потоков*\n\n` +
      `Первая пачка стартует сейчас. Следующие — после сброса лимита каждый час.`,
      { parse_mode: "Markdown" });
    s.batchPrompts=[]; s.batchPhotos=[]; s.batchPromptIdx=0;
    scheduleVideoChunk(chatId);
    return;
  }

  // ── Обычный пакет (фото или видео ≤15)
  const queue = isImage ? imageQueue : videoQueue;
  let done = 0, errors = 0;
  const errorLog = []; // собираем детали ошибок
  const typeLabel = isImage ? "🖼 Фото" : isVideoImage ? "📸 Видео из фото" : "🎬 Видео";
  const statusMsg = await bot.sendMessage(chatId,
    `📦 *Пакетный режим*\n${typeLabel} | Задач: ${total}\n🤖 ${model.label} | 📐 ${ratio}\n💳 ${model.credits}\n(макс. 10 параллельно)`,
    { parse_mode: "Markdown" });

  const allTasks = tasks.map((task) => {
    return queue(() => genOne(chatId, batchS, task.prompt, task.ep, model, task.isImg, 0, 0, task.idx, task.fileId))
      .then(() => { done++; })
      .catch((e) => {
        errors++;
        const errDetail = e.response?.data?.detail || e.response?.data?.message || e.response?.data?.error || e.message;
        const errStatus = e.response?.status ? `[${e.response.status}] ` : "";
        errorLog.push({ idx: task.idx, prompt: task.prompt, err: `${errStatus}${String(errDetail).slice(0,200)}` });
      })
      .finally(() => {
        bot.editMessageText(
          `📦 Пакет: ✓${done}/${total}${errors>0?` ✗${errors}`:""}`,
          { chat_id: chatId, message_id: statusMsg.message_id }
        ).catch(()=>{});
      });
  });

  await Promise.allSettled(allTasks);

  let finalText = `✅ Пакет готов! ✓${done}${errors>0?` ✗${errors}`:""}`;
  if (errorLog.length > 0) {
    finalText += `\n\n⚠️ *Ошибки:*`;
    for (const er of errorLog.slice(0, 10)) {
      finalText += `\n• [${er.idx}] \`${er.err}\``;
    }
    if (errorLog.length > 10) finalText += `\n...и ещё ${errorLog.length - 10}`;
  }
  await bot.editMessageText(finalText, { chat_id: chatId, message_id: statusMsg.message_id, parse_mode: "Markdown" }).catch(()=>{});
  s.batchPrompts=[]; s.batchPhotos=[]; s.batchPromptIdx=0;
  showMainMenu(chatId);
}

// ─── Одна задача ──────────────────────────
async function genOne(chatId, s, prompt, endpoint, model, isImage, index, total, batchIdx=null, overrideFileId=null) {
  const label = batchIdx || (total>1 ? `${index}/${total}` : "");
  try {
    const body = {
      prompt, aspect_ratio: s.ratio,
      ...(model.sub && { model: model.sub }),
      ...(model.model && { model: model.model }),
      ...(model.quality && { quality: model.quality }),
      ...(model.res && { resolution: s.resolution || model.defaultRes || "720p" }),
      ...(s.seed === "fixed" && { seed: 42 }),
    };
    const fid = overrideFileId || s.fileId;
    if (fid) {
      const f = await bot.getFile(fid);
      const r = await axios.get(`https://api.telegram.org/file/bot${TELEGRAM_TOKEN}/${f.file_path}`, { responseType:"arraybuffer" });
      body.image = `data:image/jpeg;base64,${Buffer.from(r.data).toString("base64")}`;
    }
    // Референсные изображения
    const pendingRefs = s.pendingRefImages || [];
    if (pendingRefs.length > 0 && (s.tab === "image_ref" || s.tab === "video_ref")) {
      const refImages = [];
      for (const rid of pendingRefs) {
        try {
          const rf = await bot.getFile(rid);
          const rr = await axios.get(`https://api.telegram.org/file/bot${TELEGRAM_TOKEN}/${rf.file_path}`, { responseType:"arraybuffer" });
          refImages.push(`data:image/jpeg;base64,${Buffer.from(rr.data).toString("base64")}`);
        } catch(e) { console.log("[ref] skip failed ref:", e.message); }
      }
      if (refImages.length > 0) {
        if (s.tab === "image_ref") body.reference_images = refImages;
        else if (s.tab === "video_ref") body.images = refImages;
        console.log(`[refs] sending ${refImages.length} refs, tab=${s.tab}, field=${s.tab==="image_ref"?"reference_images":"images"}`);
      }
    }

    console.log(`[genOne] endpoint=${endpoint} tab=${s.tab} bodyKeys=${Object.keys(body).join(",")}`);
    const { data } = await axios.post(`${BASE_URL}${endpoint}`, body, {
      headers: { "X-API-Key": FASTGEN_API_KEY, "Content-Type": "application/json", Accept: "application/json" },
      timeout: 120000,
    });
    console.log(`[genOne] response keys=${Object.keys(data).join(",")}`);

    const opId = data.operation_id || data.task_id || data.id;
    if (!opId) throw new Error("Нет ID задачи");

    const histEntry = { index: batchIdx||label, model: model.label, prompt, opId, endpoint, body, isImage, ratio: s.ratio };
    addHistory(chatId, histEntry);
    const histIdx = 0; // только что добавили в начало

    const result = await pollResult(opId);

    // Списываем баланс
    if (isImage) spendBalance("images", 1);
    else spendBalance("videos", 1);

    const idxStr = batchIdx ? `*${batchIdx}* ` : "";
    const caption = `${idxStr}${model.label}\n📝 _${prompt.slice(0,100)}_`;
    const regenKb = { inline_keyboard: [[{ text:"🔄 Перегенерировать", callback_data:`show_regen_${histIdx}` }]] };

    if (result) {
      await sendMedia(chatId, result, isImage, caption, regenKb);
    } else {
      await bot.sendMessage(chatId, `⏰ ${idxStr}не успело.\nID: \`${opId}\``, {
        parse_mode: "Markdown", reply_markup: regenKb
      });
    }
  } catch(e) {
    const errDetail = e.response?.data?.detail || e.response?.data?.message || e.response?.data?.error;
    const errStatus = e.response?.status ? `[${e.response.status}] ` : "";
    const errStr = errDetail ? (typeof errDetail === "object" ? JSON.stringify(errDetail) : String(errDetail)) : e.message;

    // Детальный лог в консоль
    const logMsg = [
      `[genOne ERROR]`,
      `label=${label || "-"}`,
      `status=${e.response?.status || "none"}`,
      `endpoint=${endpoint}`,
      `model=${model.label}`,
      `prompt="${prompt.slice(0,80)}"`,
      `bodyKeys=${Object.keys(body).join(",")}`,
      `err="${errStr}"`,
      `rawData=${JSON.stringify(e.response?.data || {}).slice(0,400)}`,
    ].join(" | ");
    console.error(logMsg);

    // Сохраняем в историю для перегенерации даже при ошибке
    addHistory(chatId, { index: label||"err", model: model.label, prompt, opId: "error", endpoint, body, isImage, ratio: s.ratio });
    const errHistIdx = 0;

    await bot.sendMessage(chatId,
      `❌ *Ошибка генерации*${label ? ` [${label}]` : ""}\n` +
      `🤖 ${model.label}\n` +
      `${errStatus ? `Код: \`${errStatus.trim()}\`\n` : ""}` +
      `Причина: \`${errStr.slice(0,300)}\``,
      {
        parse_mode: "Markdown",
        reply_markup: { inline_keyboard: [[{ text:"🔄 Перегенерировать", callback_data:`show_regen_${errHistIdx}` }]] }
      }
    );
    throw e;
  }
}

// ─── Перегенерация ────────────────────────
async function runRegenItem(chatId, item, endpoint, isImage, modelOverride = null) {
  const s = getState(chatId);
  const modelMap = isImage ? IMAGE_MODELS : VIDEO_MODELS;
  const model = modelOverride || Object.values(modelMap).find(m => m.label === item.model) || Object.values(modelMap)[0];
  const ep = endpoint || (isImage ? model.ep : model.epT);

  const statusMsg = await bot.sendMessage(chatId, `⏳ Перегенерирую...\n🎨 ${model.label}`);
  try {
    const body = { ...item.body };
    const { data } = await axios.post(`${BASE_URL}${ep}`, body, {
      headers: { "X-API-Key": FASTGEN_API_KEY, "Content-Type": "application/json" }, timeout: 60000
    });
    const opId = data.operation_id || data.task_id || data.id;
    if (!opId) throw new Error("Нет ID");

    addHistory(chatId, { ...item, model: model.label, opId, endpoint: ep });

    const result = await pollResult(opId);

    if (isImage) spendBalance("images", 1);
    else spendBalance("videos", 1);

    await bot.editMessageText("✅ Перегенерировано!", { chat_id: chatId, message_id: statusMsg.message_id });
    if (result) {
      const regenKb = { inline_keyboard: [[{ text:"🔄 Перегенерировать", callback_data:`show_regen_0` }]] };
      await sendMedia(chatId, result, isImage, `🔄 ${model.label}\n📝 _${item.prompt.slice(0,100)}_`, regenKb);
    }
  } catch(e) {
    const errDetail = e.response?.data?.detail || e.response?.data?.message || e.message;
    await bot.editMessageText(`❌ ${errDetail}`, { chat_id: chatId, message_id: statusMsg.message_id });
  }
  showMainMenu(chatId);
}

// ─── /check ───────────────────────────────
async function checkOperation(chatId, opId) {
  const msg = await bot.sendMessage(chatId, `🔍 Проверяю \`${opId}\`...`, { parse_mode:"Markdown" });
  try {
    const { data } = await axios.get(`${BASE_URL}/api/v4/operations/${opId}`, {
      headers: { "X-API-Key": FASTGEN_API_KEY }, timeout: 15000
    });
    const st = data.status || data.state;
    const reason = data.error || data.message || data.detail || "";
    const statusText = `Статус: *${st}*${reason ? `\n${reason}` : ""}`;
    await bot.editMessageText(statusText, { chat_id: chatId, message_id: msg.message_id, parse_mode:"Markdown" });
    if (["completed","success","done","finished"].includes(st)) {
      const media = extractMedia(data);
      if (media) await sendMedia(chatId, media, data.media_type==="image", "✅ Результат");
    }
  } catch(e) {
    await bot.editMessageText(`❌ ${e.message}`, { chat_id: chatId, message_id: msg.message_id });
  }
}

console.log("🤖 Бот запущен!");
