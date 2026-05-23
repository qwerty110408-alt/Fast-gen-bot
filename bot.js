const TelegramBot = require("node-telegram-bot-api");
const axios = require("axios");
const fs = require("fs");

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const FASTGEN_API_KEY = process.env.FASTGEN_API_KEY;
const BASE_URL = "https://googler.fast-gen.ai";
const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });

// ─── Персистентное состояние ──────────────
const STATE_FILE = "./user_states.json";
const BALANCE_FILE = "./balance_state.json";

function loadJSON(file, def) {
  try { return JSON.parse(fs.readFileSync(file, "utf-8")); } catch { return def; }
}
function saveJSON(file, data) {
  try { fs.writeFileSync(file, JSON.stringify(data, null, 2)); } catch(e) { console.error("saveJSON", e.message); }
}

const persistedStates = loadJSON(STATE_FILE, {});

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

function formatBalance() {
  checkResetBalance();
  const b = balanceState;
  const imgLeft = Math.max(0, HOURLY_LIMITS.images - b.images);
  const vidLeft = Math.max(0, HOURLY_LIMITS.videos - b.videos);
  const tokLeft = Math.max(0, HOURLY_LIMITS.tokens - b.tokens);

  // Время до сброса
  const msLeft = Math.max(0, b.resetAt - Date.now());
  const totalMin = Math.ceil(msLeft / 60000);
  const h = Math.floor(totalMin / 60), m = totalMin % 60;
  const resetStr = h > 0 ? `${h}ч ${m}м` : `${m}м`;
  // Время сброса
  const resetTime = new Date(b.resetAt).toLocaleTimeString("ru", { hour: "2-digit", minute: "2-digit" });

  function fmtTok(n) {
    if (n >= 1000000) return `${(n/1000000).toFixed(1).replace(".0","")}M`;
    if (n >= 1000) return `${Math.round(n/1000)}k`;
    return String(n);
  }

  return (
    `📊 *Баланс и лимиты* (общий)\n\n` +
    `🖼 Изображения: *${imgLeft}/${HOURLY_LIMITS.images}*\n` +
    `🎬 Видео: *${vidLeft}/${HOURLY_LIMITS.videos}*\n` +
    `💬 Токены промптов: *${fmtTok(tokLeft)}/${fmtTok(HOURLY_LIMITS.tokens)}*\n` +
    `⏱ Сброс через: *${resetStr}* (в ${resetTime})\n\n` +
    `Стоимость моделей:\n` +
    `🖼 Imagen/NanoPro/NanoBanana Flow: 4 кред\n` +
    `🖼 Grok быстро: 1 кред = 6 фото\n` +
    `🖼 Grok качество: 1 кред = 4 фото\n` +
    `🖼 NanoBanana Flower / ChatGPT: 1 кред\n` +
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
    seed: s.seed, resolution: s.resolution,
    pgSplitMode: s.pgSplitMode, pgParallel: s.pgParallel,
    pgProvider: s.pgProvider, pgApiKey: s.pgApiKey, pgTemplate: s.pgTemplate,
  };
  saveJSON(STATE_FILE, persistedStates);
}

function getHistory(chatId) {
  if (!history[chatId]) history[chatId] = [];
  return history[chatId];
}

function addHistory(chatId, entry) {
  const h = getHistory(chatId);
  h.unshift(entry);
  if (h.length > 50) h.pop();
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
async function pollResult(opId, max=36, interval=10000) {
  for (let i=0; i<max; i++) {
    await new Promise(r => setTimeout(r, interval));
    try {
      const { data } = await axios.get(`${BASE_URL}/api/v4/operations/${opId}`, {
        headers: { "X-API-Key": FASTGEN_API_KEY }, timeout: 10000
      });
      const st = data.status || data.state;
      if (["completed","success","done","finished"].includes(st)) return extractMedia(data);
      if (["failed","error","cancelled"].includes(st)) {
        const reason = data.error || data.message || data.detail || st;
        throw new Error(`Статус: ${st}${reason !== st ? ` — ${reason}` : ""}`);
      }
    } catch(e) { if (e.message.startsWith("Статус")) throw e; }
  }
  return null;
}

// ─── Баланс UI ────────────────────────────
async function showBalance(chatId, msgId = null) {
  const text = formatBalance();
  const kb = { inline_keyboard: [
    [{ text: "🔄 Обновить", callback_data: "refresh_balance" }],
    [{ text: "◀️ Назад", callback_data: "close_balance" }],
  ]};
  if (msgId) {
    await bot.editMessageText(text, { chat_id: chatId, message_id: msgId, parse_mode: "Markdown", reply_markup: kb }).catch(()=>{});
  } else {
    const m = await bot.sendMessage(chatId, text, { parse_mode: "Markdown", reply_markup: kb });
    getState(chatId).balanceMsgId = m.message_id;
  }
}

// ─── История ──────────────────────────────
function showHistoryMenu(chatId, msgId = null) {
  const h = getHistory(chatId);
  if (h.length === 0) {
    const text = "📭 История пуста.";
    if (msgId) bot.editMessageText(text, { chat_id: chatId, message_id: msgId }).catch(()=>{});
    else bot.sendMessage(chatId, text);
    return;
  }
  const rows = h.slice(0,10).map((item,i) => [{
    text: `${item.index || i+1} | ${item.model.slice(0,15)} | ${item.prompt.slice(0,20)}`,
    callback_data: `hist_${i}`
  }]);
  rows.push([{ text: "◀️ Назад", callback_data: "back_menu" }]);
  const opts = { parse_mode: "Markdown", reply_markup: { inline_keyboard: rows } };
  if (msgId) bot.editMessageText("📋 *История:*", { chat_id: chatId, message_id: msgId, ...opts }).catch(()=>{});
  else bot.sendMessage(chatId, "📋 *История:*", opts);
}

// ─── Главное меню ─────────────────────────
async function showMainMenu(chatId) {
  const s = getState(chatId);
  const im = IMAGE_MODELS[s.imgModel];
  const vm = VIDEO_MODELS[s.vidModel];
  const text =
    `🤖 *FastGen Bot*\n\n` +
    `🖼 Фото: *${im.label}*\n└ ${im.credits}\n` +
    `🎬 Видео: *${vm.label}*\n└ ${vm.credits}\n` +
    `📐 ${s.ratio} | 🔢 ${s.count} шт. | 🌱 ${s.seed==="fixed"?"Фикс.":"Случ."}`;
  const kb = { inline_keyboard: [
    [{ text: "🖼️ Изображение", callback_data: "do_image" }, { text: "🖼️📸 Фото из рефов", callback_data: "do_image_ref" }],
    [{ text: "🎬 Видео из текста", callback_data: "do_vtext" }, { text: "📸 Видео из фото", callback_data: "do_vimage" }],
    [{ text: "🎞 Ключ. кадры", callback_data: "do_keyframes" }],
    [{ text: "📦 Пакетный режим", callback_data: "do_batch" }],
    [{ text: "🎨 Модель фото", callback_data: "open_imgmodel" }, { text: "🎥 Модель видео", callback_data: "open_vidmodel" }],
    [{ text: "📐 Соотношение", callback_data: "open_ratio" }, { text: "🔢 Количество", callback_data: "open_count" }],
    [{ text: "🌱 Seed", callback_data: "open_seed" }, { text: "📊 Баланс", callback_data: "show_balance" }],
    ...(s.vidModel === "grok_vid" ? [[{ text: `🖥 Разрешение Grok: ${s.resolution || "720p"}`, callback_data: "open_resolution" }]] : []),
    [{ text: "🧠 Генерация промптов", callback_data: "open_promptgen" }],
    [{ text: "📋 История", callback_data: "show_history" }],
  ]};

  if (s.menuMsgId) {
    try {
      await bot.editMessageText(text, { chat_id: chatId, message_id: s.menuMsgId, parse_mode: "Markdown", reply_markup: kb });
      return;
    } catch {}
  }
  const m = await bot.sendMessage(chatId, text, { parse_mode: "Markdown", reply_markup: kb });
  s.menuMsgId = m.message_id;
}

// ─── Пакетное меню ────────────────────────
function showBatchMenu(chatId, msgId = null) {
  const s = getState(chatId);
  const prompts = s.batchPrompts;
  const photos = s.batchPhotos;
  const idx = s.batchPromptIdx || 0;
  const isImage = s.tab === "image";
  const MAX_PROMPTS = isImage ? 500 : 15;
  const currentPrompt = prompts.length > 0 ? prompts[idx] : null;

  const text =
    `📦 *Пакетный режим*\n\n` +
    `📝 Промптов: *${prompts.length}/${MAX_PROMPTS}*\n` +
    `📸 Фото: *${photos.length}*\n` +
    `🔢 На 1 промпт/фото: *${s.perPrompt}* вар.\n` +
    `Всего задач: *${(prompts.length + photos.length) * s.perPrompt}*\n\n` +
    (currentPrompt ? `*Промпт ${idx+1}/${prompts.length}:*\n${currentPrompt}` : "_Промптов нет_");

  const navRow = prompts.length > 0 ? [
    { text: "◀️", callback_data: "bp_prev" },
    { text: `${idx+1}/${prompts.length}`, callback_data: "noop" },
    { text: "▶️", callback_data: "bp_next" },
    { text: "🗑 Удалить", callback_data: "bp_delete" },
  ] : [];

  const kb = { inline_keyboard: [
    ...(navRow.length ? [navRow] : []),
    [{ text: "✏️ Добавить промпты", callback_data: "batch_add_text" }, { text: "📄 Из файла .txt", callback_data: "batch_from_file" }],
    [{ text: "📸 Фото управление", callback_data: "batch_photos_menu" }],
    [{ text: `🔢 На 1 промпт: ${s.perPrompt}`, callback_data: "batch_per_prompt" }],
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
  rows.push([{ text: "◀️ Назад", callback_data: "do_batch" }]);
  bot.editMessageText(text, { chat_id: chatId, message_id: msgId, parse_mode: "Markdown", reply_markup: { inline_keyboard: rows } }).catch(()=>{});
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

  const MAX = s.tab === "image" ? 500 : 15;
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

// ─── /start /menu ─────────────────────────
bot.onText(/\/start|\/menu/, (msg) => {
  const chatId = msg.chat.id;
  getState(chatId); // инициализация
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
  if (data === "close_balance") { return bot.deleteMessage(chatId, msgId).catch(()=>{}); }
  if (data === "show_balance")   { return showBalance(chatId); }
  if (data === "refresh_balance") { return showBalance(chatId, msgId); }
  if (data === "show_history")   { del(); return showHistoryMenu(chatId); }

  // ── История
  if (data.startsWith("hist_")) {
    const idx = parseInt(data.replace("hist_",""));
    const h = getHistory(chatId);
    const item = h[idx];
    if (!item) return;
    return edit(
      `📋 *Запись ${idx+1}*\n\n🤖 ${item.model}\n📝 _${item.prompt}_\n\n🔑 ID: \`${item.opId}\``,
      { inline_keyboard: [
        [{ text: "🔄 Перегенерировать", callback_data: `show_regen_${idx}` }],
        [{ text: "◀️ Назад", callback_data: "show_history" }],
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
  if (data === "do_batch") { s.mode="batch"; return showBatchMenu(chatId, msgId); }
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
  if (data === "batch_clear") { s.batchPrompts=[]; s.batchPhotos=[]; s.batchPromptIdx=0; return showBatchMenu(chatId, msgId); }
  if (data === "batch_run") { del(); return runBatch(chatId); }

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
});

// ─── Фото ─────────────────────────────────
bot.on("photo", async (msg) => {
  const chatId = msg.chat.id;
  const s = getState(chatId);
  const fileId = msg.photo[msg.photo.length-1].file_id;

  if (s.mode === "batch") {
    s.batchPhotos.push(fileId);
    return bot.sendMessage(chatId, `✅ Фото добавлено! Всего: ${s.batchPhotos.length} фото, ${s.batchPrompts.length} промптов`, {
      reply_markup: { inline_keyboard: [[{ text:"📦 Открыть меню пакета", callback_data:"do_batch" }],[{ text:"🚀 Генерировать!", callback_data:"batch_run" }]] }
    });
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
      const isImage = s.tab === "image";
      const MAX = isImage ? 500 : 15;
      const toAdd = prompts.slice(0, MAX - s.batchPrompts.length);
      const skipped = prompts.length - toAdd.length;
      s.batchPrompts.push(...toAdd);
      s.batchPromptIdx = 0;
      let reply = `✅ Загружено ${toAdd.length} промптов из файла!`;
      if (skipped > 0) reply += `\n⚠️ Пропущено ${skipped}`;
      bot.sendMessage(chatId, reply, { reply_markup: { inline_keyboard: [[{ text:"📦 Открыть пакет", callback_data:"do_batch" }]] } });
    } catch(e) { bot.sendMessage(chatId, `❌ Ошибка файла: ${e.message}`); }
  }
});

// ─── Текст ────────────────────────────────
bot.on("message", async (msg) => {
  const chatId = msg.chat.id;
  const s = getState(chatId);
  if (!msg.text || msg.text.startsWith("/")) return;

  if (s.step === "waiting_count") {
    const n = parseInt(msg.text);
    if (isNaN(n) || n < 1 || n > 500) return bot.sendMessage(chatId, "❌ Введи число от 1 до 500:");
    s.count = n; s.step = null; saveState(chatId);
    await bot.sendMessage(chatId, `✅ Количество: *${n}*`, { parse_mode: "Markdown" });
    return showMainMenu(chatId);
  }
  if (s.step === "waiting_batch_prompts") {
    s.step = null;
    const isImage = s.tab === "image";
    const MAX = isImage ? 500 : 15;
    const prompts = msg.text.split("\n").map(p => p.trim()).filter(Boolean);
    const toAdd = prompts.slice(0, MAX - s.batchPrompts.length);
    const skipped = prompts.length - toAdd.length;
    s.batchPrompts.push(...toAdd);
    s.batchPromptIdx = Math.max(0, s.batchPrompts.length - toAdd.length);
    let reply = `✅ Добавлено ${toAdd.length} промптов!`;
    if (skipped > 0) reply += `\n⚠️ Пропущено ${skipped}`;
    return bot.sendMessage(chatId, reply, { reply_markup: { inline_keyboard: [[{ text:"📦 Меню пакета", callback_data:"do_batch" }]] } });
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

  if (s.step !== "waiting_prompt") return bot.sendMessage(chatId, "Нажми /menu чтобы начать.");

  const prompt = msg.text;
  s.step = null;
  if (s.mode === "keyframes") return runKeyframes(chatId, s, prompt);
  await runNormal(chatId, s, prompt);
});

// ─── Обычная генерация ────────────────────
async function runNormal(chatId, s, prompt) {
  const isImage = s.tab === "image" || s.tab === "image_ref";
  let model, endpoint;
  if (s.tab === "image" || s.tab === "image_ref") { model = IMAGE_MODELS[s.imgModel]; endpoint = model.ep; }
  else if (s.tab === "video_text") { model = VIDEO_MODELS[s.vidModel]; endpoint = model.epT; }
  else if (s.tab === "video_ref") { model = VIDEO_MODELS[s.vidModel]; endpoint = model.epI; }
  else { model = VIDEO_MODELS[s.vidModel]; endpoint = model.epI; }

  const count = s.count;
  const statusMsg = await bot.sendMessage(chatId, `⏳ Запускаю ${count} задач...\n🎨 ${model.label}\n💳 ${model.credits}`);
  const tasks = Array.from({length:count}, (_,i) => genOne(chatId, s, prompt, endpoint, model, isImage, i+1, count));
  await bot.editMessageText(`⏳ ${count} задач запущено...`, { chat_id: chatId, message_id: statusMsg.message_id });
  const results = await Promise.allSettled(tasks);
  const ok = results.filter(r=>r.status==="fulfilled").length;
  await bot.editMessageText(`✅ Готово! ✓${ok}${count-ok>0?` ✗${count-ok}`:""}`, { chat_id: chatId, message_id: statusMsg.message_id }).catch(()=>{});
  showMainMenu(chatId);
}

// ─── Ключевые кадры ───────────────────────
async function runKeyframes(chatId, s, prompt) {
  const model = VIDEO_MODELS[s.vidModel];
  const statusMsg = await bot.sendMessage(chatId, `⏳ Ключевые кадры...\n🎥 ${model.label}`);
  try {
    const body = { prompt, aspect_ratio: s.ratio, ...(model.sub && { model: model.sub }) };
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
      await sendMedia(chatId, result, false, `🎞 Ключ. кадры\n📝 _${prompt.slice(0,100)}_`);
    }
  } catch(e) {
    await bot.editMessageText(`❌ ${e.message}`, { chat_id: chatId, message_id: statusMsg.message_id });
  }
  showMainMenu(chatId);
}

// ─── Пакетная генерация ───────────────────
async function runBatch(chatId) {
  const s = getState(chatId);
  const isImage = s.tab === "image";
  const model = isImage ? IMAGE_MODELS[s.imgModel] : VIDEO_MODELS[s.vidModel];
  const prompts = [...s.batchPrompts];
  const photos = [...s.batchPhotos];
  const perPrompt = s.perPrompt || 1;

  if (prompts.length === 0 && photos.length === 0) return bot.sendMessage(chatId, "❌ Нет промптов или фото!");

  const tasks = [];
  for (let pi=0; pi<prompts.length; pi++)
    for (let vi=0; vi<perPrompt; vi++)
      tasks.push({ prompt: prompts[pi], idx: `${pi+1}.${vi+1}`, ep: isImage ? model.ep : model.epT, isImg: isImage, fileId: null });
  for (let fi=0; fi<photos.length; fi++)
    for (let vi=0; vi<perPrompt; vi++)
      tasks.push({ prompt: "animate", idx: `${prompts.length+fi+1}.${vi+1}`, ep: VIDEO_MODELS[s.vidModel].epI, isImg: false, fileId: photos[fi] });

  const total = tasks.length;
  let done = 0, errors = 0;
  const statusMsg = await bot.sendMessage(chatId, `📦 *Пакетный режим*\nЗадач: ${total} | ${model.label}\n💳 ${model.credits}`, { parse_mode: "Markdown" });

  for (let i=0; i<tasks.length; i+=5) {
    const batch = tasks.slice(i, i+5);
    await Promise.allSettled(batch.map(async (task) => {
      try {
        await genOne(chatId, s, task.prompt, task.ep, model, task.isImg, 0, 0, task.idx, task.fileId);
        done++;
      } catch { errors++; }
      await bot.editMessageText(
        `📦 Пакет: ✓${done}/${total}${errors>0?` ✗${errors}`:""}`,
        { chat_id: chatId, message_id: statusMsg.message_id }
      ).catch(()=>{});
    }));
  }

  await bot.editMessageText(`✅ Пакет готов! ✓${done}${errors>0?` ✗${errors}`:""}`, { chat_id: chatId, message_id: statusMsg.message_id }).catch(()=>{});
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
    if (fid && (s.tab==="video_image" || overrideFileId)) {
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
      timeout: 60000,
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
    console.log(`[genOne error] status=${e.response?.status} endpoint=${endpoint} errData=${JSON.stringify(e.response?.data).slice(0,500)} bodyKeys=${Object.keys(body).join(",")}`);
    await bot.sendMessage(chatId, `❌ ${errStatus}${label?`[${label}] `:""}${errStr}`, {
      reply_markup: { inline_keyboard: [[{ text:"🔄 Повторить", callback_data:`show_regen_0` }]] }
    });
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
