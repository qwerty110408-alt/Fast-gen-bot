cat > /mnt/user-data/outputs/bot.js << 'ENDOFFILE'
const TelegramBot = require("node-telegram-bot-api");
const axios = require("axios");
const fs = require("fs");

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const FASTGEN_API_KEY = process.env.FASTGEN_API_KEY;
const BASE_URL = "https://googler.fast-gen.ai";
const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });

// ─── Персистентные настройки (сохраняются между /start) ──
const userSettings = {}; // только настройки — не сбрасываются
const userSession = {};  // текущий шаг/режим — сбрасывается только при явном /start
const history = {};
const pendingRegen = {}; // данные для перегенерации

const SETTINGS_FILE = "/tmp/user_settings.json";

function loadSettings() {
  try {
    if (fs.existsSync(SETTINGS_FILE)) {
      const data = JSON.parse(fs.readFileSync(SETTINGS_FILE, "utf-8"));
      Object.assign(userSettings, data);
    }
  } catch {}
}

function saveSettings() {
  try { fs.writeFileSync(SETTINGS_FILE, JSON.stringify(userSettings)); } catch {}
}

loadSettings();

const IMAGE_MODELS = {
  "imagen4_flow":  { label: "Imagen 4 - Flow",       ep: "/api/v4/flow/image/generate",   credits: "4 кред = 1 фото" },
  "nanopro_flow":  { label: "Nano Banana Pro - Flow", ep: "/api/v4/flow/image/generate",   credits: "4 кред = 1 фото", model: "nano-banana-pro" },
  "nanob2_flow":   { label: "Nano Banana 2 - Flow",   ep: "/api/v4/flow/image/generate",   credits: "4 кред = 1 фото", model: "nano-banana-2" },
  "grok_fast":     { label: "Grok (быстро)",          ep: "/api/v4/grok/image/generate",   credits: "1 кред = 6 фото", quality: "fast" },
  "grok_quality":  { label: "Grok (качество)",        ep: "/api/v4/grok/image/generate",   credits: "1 кред = 4 фото", quality: "quality" },
  "nanob2_flower": { label: "Nano Banana 2 - Flower", ep: "/api/v4/flower/image/generate", credits: "1 кред = 1 фото" },
  "chatgpt":       { label: "ChatGPT Images 2.0",     ep: "/api/v4/openai/image/generate", credits: "1 кред = 1 фото" },
};

const VIDEO_MODELS = {
  "veo31_fast":    { label: "Veo 3.1 Fast",    epT: "/api/v4/flow/video/from-text",   epI: "/api/v4/flow/video/from-image",   epK: "/api/v4/flow/video/from-keyframes", sub: "veo-3.1-fast",    credits: "1 кред = 1 видео" },
  "veo31_light":   { label: "Veo 3.1 Light",   epT: "/api/v4/flow/video/from-text",   epI: "/api/v4/flow/video/from-image",   epK: "/api/v4/flow/video/from-keyframes", sub: "veo-3.1-light",   credits: "1 кред = 1 видео" },
  "veo31_quality": { label: "Veo 3.1 Quality", epT: "/api/v4/flow/video/from-text",   epI: "/api/v4/flow/video/from-image",   epK: "/api/v4/flow/video/from-keyframes", sub: "veo-3.1-quality", credits: "10 кред = 1 видео ⚠️" },
  "grok_vid":      { label: "Grok Video",       epT: "/api/v4/grok/video/from-text",   epI: "/api/v4/grok/video/from-image",   credits: "1 кред = 1 видео", res: true },
  "veo31_flower":  { label: "Veo 3.1 Flower",  epT: "/api/v4/flower/video/from-text", epI: "/api/v4/flower/video/from-image", credits: "1 кред = 1 видео" },
};

const RATIOS = ["16:9","9:16","1:1","4:3","3:4","3:2","2:3"];

// ─── Настройки (персистентные) ────────────
function getSettings(chatId) {
  if (!userSettings[chatId]) {
    userSettings[chatId] = {
      imgModel: "imagen4_flow",
      vidModel: "veo31_fast",
      ratio: "16:9",
      count: 1,
      perPrompt: 1,
      seed: "random",
      resolution: "720p",
    };
    saveSettings();
  }
  return userSettings[chatId];
}

function updateSettings(chatId, patch) {
  const s = getSettings(chatId);
  Object.assign(s, patch);
  saveSettings();
}

// ─── Сессия (сбрасывается при смене шага) ─
function getSession(chatId) {
  if (!userSession[chatId]) {
    userSession[chatId] = {
      step: null, tab: "image", mode: "normal",
      batchPrompts: [], batchPhotos: [],
      batchPromptIdx: 0,
      keyframeStart: null, keyframeEnd: null,
      fileId: null,
      busy: false,  // флаг активной генерации
    };
  }
  return userSession[chatId];
}

function getHistory(chatId) {
  if (!history[chatId]) history[chatId] = [];
  return history[chatId];
}

function addHistory(chatId, entry) {
  const h = getHistory(chatId);
  h.unshift(entry);
  if (h.length > 100) h.pop();
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
  if (!media) return;
  const opts = { caption, parse_mode: "Markdown", ...(replyMarkup && { reply_markup: replyMarkup }) };
  if (media.base64) {
    let b64 = media.base64, ext = isImage ? "jpg" : "mp4";
    if (b64.includes(";base64,")) { const p = b64.split(";base64,"); b64 = p[1]; if (p[0].includes("png")) ext = "png"; }
    const tmp = `/tmp/fg_${Date.now()}_${Math.random().toString(36).slice(2)}.${ext}`;
    fs.writeFileSync(tmp, Buffer.from(b64, "base64"));
    try {
      if (isImage) await bot.sendPhoto(chatId, fs.createReadStream(tmp), opts);
      else await bot.sendVideo(chatId, fs.createReadStream(tmp), opts);
    } finally { try { fs.unlinkSync(tmp); } catch {} }
  } else if (media.url) {
    if (isImage) await bot.sendPhoto(chatId, media.url, opts);
    else await bot.sendVideo(chatId, media.url, opts);
  }
}

// ─── Поллинг ──────────────────────────────
async function pollResult(opId, max = 36, interval = 10000) {
  for (let i = 0; i < max; i++) {
    await new Promise(r => setTimeout(r, interval));
    try {
      const { data } = await axios.get(`${BASE_URL}/api/v4/operations/${opId}`, {
        headers: { "X-API-Key": FASTGEN_API_KEY }, timeout: 10000
      });
      const st = data.status || data.state;
      if (["completed","success","done","finished"].includes(st)) return { media: extractMedia(data), rawData: data };
      if (["failed","error","cancelled"].includes(st)) {
        const reason = data.error || data.error_message || data.message || data.detail || st;
        throw new Error(reason);
      }
    } catch(e) { if (!e.message.includes("timeout")) throw e; }
  }
  return null;
}

// ─── Баланс ───────────────────────────────
async function getUsageData() {
  try {
    const { data } = await axios.get(`${BASE_URL}/api/v5/usage`, {
      headers: { "X-API-Key": FASTGEN_API_KEY }, timeout: 10000
    });
    return data;
  } catch { return null; }
}

function formatBalance(usage) {
  if (!usage) return "❌ Не удалось получить баланс";
  const imgUsed = usage.images_used ?? "?", imgTotal = usage.images_limit ?? "?";
  const vidUsed = usage.videos_used ?? "?", vidTotal = usage.videos_limit ?? "?";
  const streams = usage.active_threads ?? "?", maxStreams = usage.max_threads ?? "?";
  const resetIn = usage.reset_in_minutes != null ? `${Math.floor(usage.reset_in_minutes)}м` : "?";
  const resetAt = usage.reset_at ? new Date(usage.reset_at).toLocaleTimeString("ru") : "?";
  return `📊 *Баланс и лимиты*\n\n🖼 Изображения: *${imgUsed}/${imgTotal}* за час\n🎬 Видео: *${vidUsed}/${vidTotal}* за час\n🔄 Потоки: *${streams}/${maxStreams}* активно\n⏱ Сброс через: *${resetIn}* (в ${resetAt})\n\n*Стоимость:*\n🖼 Imagen/NanoPro/NanoBanana Flow: 4 кред\n🖼 Grok быстро: 1 кред = 6 фото\n🖼 Grok качество: 1 кред = 4 фото\n🖼 NanoBanana Flower / ChatGPT: 1 кред\n🎬 Veo Fast/Light/Flower/Grok: 1 кред\n🎬 Veo 3.1 Quality: *10 кред* ⚠️\n\n_Обновлено: ${new Date().toLocaleTimeString("ru")}_`;
}

async function showBalance(chatId, msgId = null) {
  const usage = await getUsageData();
  const text = formatBalance(usage);
  const kb = { inline_keyboard: [[{ text: "🔄 Обновить", callback_data: "refresh_balance" }],[{ text: "◀️ Назад", callback_data: "back_menu" }]] };
  if (msgId) await bot.editMessageText(text, { chat_id: chatId, message_id: msgId, parse_mode: "Markdown", reply_markup: kb }).catch(()=>{});
  else await bot.sendMessage(chatId, text, { parse_mode: "Markdown", reply_markup: kb });
}

async function liveBalanceUpdate(chatId, msgId, intervalMs = 15000, totalMs = 300000) {
  const end = Date.now() + totalMs;
  while (Date.now() < end) {
    await new Promise(r => setTimeout(r, intervalMs));
    const usage = await getUsageData();
    if (!usage) continue;
    await bot.editMessageText(formatBalance(usage), {
      chat_id: chatId, message_id: msgId, parse_mode: "Markdown",
      reply_markup: { inline_keyboard: [[{ text: "🔄 Обновить", callback_data: "refresh_balance" }],[{ text: "◀️ Меню", callback_data: "back_menu" }]] }
    }).catch(()=>{});
  }
}

// ─── История ──────────────────────────────
function showHistoryMenu(chatId, msgId = null) {
  const h = getHistory(chatId);
  if (h.length === 0) {
    const text = "📭 История пуста.";
    const kb = { inline_keyboard: [[{ text: "◀️ Назад", callback_data: "back_menu" }]] };
    if (msgId) bot.editMessageText(text, { chat_id: chatId, message_id: msgId, reply_markup: kb }).catch(()=>{});
    else bot.sendMessage(chatId, text, { reply_markup: kb });
    return;
  }
  const rows = h.slice(0, 15).map((item, i) => [{
    text: `${item.index || i+1} | ${item.model.slice(0,12)} | ${item.prompt.slice(0,18)}`,
    callback_data: `hist_${i}`
  }]);
  rows.push([{ text: "◀️ Назад", callback_data: "back_menu" }]);
  const opts = { parse_mode: "Markdown", reply_markup: { inline_keyboard: rows } };
  if (msgId) bot.editMessageText("📋 *История:*", { chat_id: chatId, message_id: msgId, ...opts }).catch(()=>{});
  else bot.sendMessage(chatId, "📋 *История:*", opts);
}

// ─── Главное меню ─────────────────────────
function showMainMenu(chatId) {
  const s = getSettings(chatId);
  const sess = getSession(chatId);
  // Не спамим если уже идёт генерация
  if (sess.busy) return bot.sendMessage(chatId, "⏳ Идёт генерация, подожди...");
  const im = IMAGE_MODELS[s.imgModel];
  const vm = VIDEO_MODELS[s.vidModel];
  bot.sendMessage(chatId,
    `🤖 *FastGen Bot*\n\n🖼 Фото: *${im.label}*\n└ ${im.credits}\n🎬 Видео: *${vm.label}*\n└ ${vm.credits}\n📐 ${s.ratio} | 🔢 ${s.count} шт. | 🌱 ${s.seed==="fixed"?"Фикс.":"Случ."}`,
    { parse_mode: "Markdown", reply_markup: { inline_keyboard: [
      [{ text: "🖼️ Изображение", callback_data: "do_image" }, { text: "🎬 Видео из текста", callback_data: "do_vtext" }],
      [{ text: "📸 Видео из фото", callback_data: "do_vimage" }, { text: "🎞 Ключ. кадры", callback_data: "do_keyframes" }],
      [{ text: "📦 Пакетный режим", callback_data: "do_batch" }],
      [{ text: "🎨 Модель фото", callback_data: "open_imgmodel" }, { text: "🎥 Модель видео", callback_data: "open_vidmodel" }],
      [{ text: "📐 Соотношение", callback_data: "open_ratio" }, { text: "🔢 Количество", callback_data: "open_count" }],
      [{ text: "🌱 Seed", callback_data: "open_seed" }, { text: "📊 Баланс", callback_data: "show_balance" }],
      [{ text: "📋 История", callback_data: "show_history" }],
    ]}}
  );
}

// ─── Меню перегенерации ───────────────────
function showRegenMenu(chatId, msgId, regenKey) {
  const data = pendingRegen[regenKey];
  if (!data) return bot.sendMessage(chatId, "❌ Данные для перегенерации устарели. Сгенерируй заново.");
  const s = getSettings(chatId);

  const text =
    `🔄 *Перегенерация*\n\n` +
    `📝 Промпт:\n_${data.prompt.slice(0, 200)}_\n\n` +
    `🎨 Модель: *${data.isImage ? IMAGE_MODELS[data.imgModel]?.label || data.imgModel : VIDEO_MODELS[data.vidModel]?.label || data.vidModel}*\n` +
    `📐 Соотношение: *${data.ratio}*\n\n` +
    `Измени что нужно и нажми *Генерировать*:`;

  bot.editMessageText(text, {
    chat_id: chatId, message_id: msgId, parse_mode: "Markdown",
    reply_markup: { inline_keyboard: [
      [{ text: "✏️ Изменить промпт", callback_data: `rg_prompt_${regenKey}` }],
      [{ text: "🎨 Модель фото", callback_data: `rg_imgmodel_${regenKey}` }, { text: "🎥 Модель видео", callback_data: `rg_vidmodel_${regenKey}` }],
      [{ text: "📐 Соотношение", callback_data: `rg_ratio_${regenKey}` }],
      [{ text: "🚀 Генерировать!", callback_data: `rg_run_${regenKey}` }],
      [{ text: "❌ Отмена", callback_data: "back_menu" }],
    ]}
  }).catch(()=>{});
}

// ─── Пакетное меню ────────────────────────
function showBatchMenu(chatId, msgId = null) {
  const sess = getSession(chatId);
  const s = getSettings(chatId);
  const prompts = sess.batchPrompts;
  const photos = sess.batchPhotos;
  const idx = Math.min(sess.batchPromptIdx || 0, Math.max(prompts.length - 1, 0));
  const isVideo = sess.tab !== "image";
  const maxP = isVideo ? 15 : 500;
  const currentPrompt = prompts.length > 0 ? prompts[idx] : null;

  const text =
    `📦 *Пакетный режим* (${isVideo?"Видео":"Фото"})\n\n` +
    `📝 Промптов: *${prompts.length}/${maxP}*\n` +
    `📸 Фото: *${photos.length}*\n` +
    `🔢 На 1: *${s.perPrompt}* вар. | Задач: *${(prompts.length + photos.length) * s.perPrompt}*\n\n` +
    (currentPrompt ? `*Промпт ${idx+1}/${prompts.length}:*\n_${currentPrompt.slice(0,200)}_` : "_Промптов нет_");

  const navRow = prompts.length > 0 ? [
    { text: "◀️", callback_data: "bp_prev" },
    { text: `${idx+1}/${prompts.length}`, callback_data: "noop" },
    { text: "▶️", callback_data: "bp_next" },
    { text: "🗑", callback_data: "bp_delete" },
  ] : [];

  const kb = { inline_keyboard: [
    ...(navRow.length ? [navRow] : []),
    [{ text: "✏️ Добавить промпты", callback_data: "batch_add_text" }, { text: "📄 Из .txt", callback_data: "batch_from_file" }],
    [{ text: `📸 Фото (${photos.length})`, callback_data: "batch_photos_menu" }],
    [{ text: `🔢 На 1: ${s.perPrompt}`, callback_data: "batch_per_prompt" }, { text: `${isVideo?"🎬 Видео":"🖼 Фото"} →`, callback_data: "batch_toggle_mode" }],
    [{ text: "🚀 Генерировать!", callback_data: "batch_run" }],
    [{ text: "🗑 Очистить", callback_data: "batch_clear" }, { text: "❌ Отмена", callback_data: "back_menu" }],
  ]};

  if (msgId) bot.editMessageText(text, { chat_id: chatId, message_id: msgId, parse_mode: "Markdown", reply_markup: kb }).catch(()=>{});
  else bot.sendMessage(chatId, text, { parse_mode: "Markdown", reply_markup: kb });
}

function showBatchPhotosMenu(chatId, msgId) {
  const sess = getSession(chatId);
  const rows = sess.batchPhotos.map((_, i) => [{ text: `🗑 Удалить фото ${i+1}`, callback_data: `del_photo_${i}` }]);
  rows.push([{ text: "◀️ Назад к пакету", callback_data: "do_batch" }]);
  bot.editMessageText(`📸 *Фото: ${sess.batchPhotos.length}*\n\nОтправь фото в чат чтобы добавить:`,
    { chat_id: chatId, message_id: msgId, parse_mode: "Markdown", reply_markup: { inline_keyboard: rows } }
  ).catch(()=>{});
}

// ─── /start /menu ─────────────────────────
bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;
  // НЕ сбрасываем userSettings — только сессию
  userSession[chatId] = null;
  showMainMenu(chatId);
});
bot.onText(/\/menu/, (msg) => showMainMenu(msg.chat.id));
bot.onText(/\/balance/, (msg) => showBalance(msg.chat.id));
bot.onText(/\/history/, (msg) => showHistoryMenu(msg.chat.id));
bot.onText(/\/check (.+)/, async (msg, m) => checkOperation(msg.chat.id, m[1].trim()));

// ─── Callbacks ────────────────────────────
bot.on("callback_query", async (query) => {
  const chatId = query.message.chat.id;
  const msgId = query.message.message_id;
  const data = query.data;
  const s = getSettings(chatId);
  const sess = getSession(chatId);
  bot.answerCallbackQuery(query.id);

  const del = () => bot.deleteMessage(chatId, msgId).catch(()=>{});
  const edit = (text, kb) => bot.editMessageText(text, { chat_id: chatId, message_id: msgId, parse_mode: "Markdown", reply_markup: kb });
  const cancelKb = { inline_keyboard: [[{ text: "❌ Отмена", callback_data: "back_menu" }]] };

  if (data === "back_menu") { del(); return showMainMenu(chatId); }
  if (data === "noop") return;

  // ── Баланс
  if (data === "show_balance") { del(); return showBalance(chatId); }
  if (data === "refresh_balance") return showBalance(chatId, msgId);

  // ── История
  if (data === "show_history") return showHistoryMenu(chatId, msgId);
  if (data.startsWith("hist_")) {
    const idx = parseInt(data.replace("hist_",""));
    const h = getHistory(chatId);
    const item = h[idx];
    if (!item) return;
    const regenKey = `h_${chatId}_${idx}_${Date.now()}`;
    pendingRegen[regenKey] = {
      prompt: item.prompt, endpoint: item.endpoint, body: item.body,
      isImage: item.isImage, idx: item.index,
      imgModel: item.imgModel || s.imgModel, vidModel: item.vidModel || s.vidModel,
      ratio: item.ratio || s.ratio,
    };
    return edit(
      `📋 *${item.index || idx+1}*\n\nМодель: ${item.model}\n📝 _${item.prompt}_\n${item.opId ? `\nID: \`${item.opId}\`` : ""}`,
      { inline_keyboard: [
        [{ text: "🔄 Перегенерировать", callback_data: `open_regen_${regenKey}` }],
        [{ text: "◀️ К истории", callback_data: "show_history" }],
      ]}
    );
  }

  // ── Открыть меню перегенерации
  if (data.startsWith("open_regen_")) {
    const regenKey = data.replace("open_regen_","");
    return showRegenMenu(chatId, msgId, regenKey);
  }

  // ── Изменить промпт в перегенерации
  if (data.startsWith("rg_prompt_")) {
    const regenKey = data.replace("rg_prompt_","");
    sess.step = `regen_prompt_${regenKey}`;
    return edit("✏️ Напиши новый промпт:", { inline_keyboard: [[{ text: "❌ Отмена", callback_data: `open_regen_${regenKey}` }]] });
  }

  // ── Выбор модели фото в перегенерации
  if (data.startsWith("rg_imgmodel_")) {
    const regenKey = data.replace("rg_imgmodel_","");
    const rows = Object.entries(IMAGE_MODELS).map(([k,v]) => [{
      text: `${pendingRegen[regenKey]?.imgModel===k?"✅ ":""}${v.label}`, callback_data: `rg_setim_${regenKey}_${k}`
    }]);
    rows.push([{ text: "◀️ Назад", callback_data: `open_regen_${regenKey}` }]);
    return edit("🎨 Модель изображения:", { inline_keyboard: rows });
  }
  if (data.startsWith("rg_setim_")) {
    const parts = data.replace("rg_setim_","").split("_");
    const k = parts.pop();
    const regenKey = parts.join("_");
    if (pendingRegen[regenKey]) pendingRegen[regenKey].imgModel = k;
    return showRegenMenu(chatId, msgId, regenKey);
  }

  // ── Выбор модели видео в перегенерации
  if (data.startsWith("rg_vidmodel_")) {
    const regenKey = data.replace("rg_vidmodel_","");
    const rows = Object.entries(VIDEO_MODELS).map(([k,v]) => [{
      text: `${pendingRegen[regenKey]?.vidModel===k?"✅ ":""}${v.label}`, callback_data: `rg_setvm_${regenKey}_${k}`
    }]);
    rows.push([{ text: "◀️ Назад", callback_data: `open_regen_${regenKey}` }]);
    return edit("🎥 Модель видео:", { inline_keyboard: rows });
  }
  if (data.startsWith("rg_setvm_")) {
    const parts = data.replace("rg_setvm_","").split("_");
    const k = parts.pop();
    const regenKey = parts.join("_");
    if (pendingRegen[regenKey]) pendingRegen[regenKey].vidModel = k;
    return showRegenMenu(chatId, msgId, regenKey);
  }

  // ── Выбор соотношения в перегенерации
  if (data.startsWith("rg_ratio_")) {
    const regenKey = data.replace("rg_ratio_","");
    const rows = [];
    for (let i=0; i<RATIOS.length; i+=3) rows.push(RATIOS.slice(i,i+3).map(r => ({
      text: pendingRegen[regenKey]?.ratio===r?`✅ ${r}`:r, callback_data: `rg_setr_${regenKey}_${r.replace(":","x")}`
    })));
    rows.push([{ text: "◀️ Назад", callback_data: `open_regen_${regenKey}` }]);
    return edit("📐 Соотношение:", { inline_keyboard: rows });
  }
  if (data.startsWith("rg_setr_")) {
    const parts = data.replace("rg_setr_","").split("_");
    const r = parts.pop().replace("x",":");
    const regenKey = parts.join("_");
    if (pendingRegen[regenKey]) pendingRegen[regenKey].ratio = r;
    return showRegenMenu(chatId, msgId, regenKey);
  }

  // ── Запустить перегенерацию
  if (data.startsWith("rg_run_")) {
    const regenKey = data.replace("rg_run_","");
    const rg = pendingRegen[regenKey];
    if (!rg) return edit("❌ Данные устарели", { inline_keyboard: [] });
    del();
    return runRegen(chatId, rg);
  }

  // ── Повтор при ошибке
  if (data.startsWith("retry_")) {
    const regenKey = data.replace("retry_","");
    return showRegenMenu(chatId, msgId, regenKey);
  }

  // ── Режимы
  if (data === "do_image") { sess.step="waiting_prompt"; sess.tab="image"; sess.mode="normal"; return edit(`🖼️ *Изображение*\n${IMAGE_MODELS[s.imgModel].label}\n\nНапиши промпт:`, cancelKb); }
  if (data === "do_vtext") { sess.step="waiting_prompt"; sess.tab="video_text"; sess.mode="normal"; return edit(`🎬 *Видео из текста*\n${VIDEO_MODELS[s.vidModel].label}\n\nОпиши видео:`, cancelKb); }
  if (data === "do_vimage") { sess.step="waiting_photo"; sess.tab="video_image"; sess.mode="normal"; return edit("📸 *Видео из фото*\n\nОтправь фото:", cancelKb); }
  if (data === "do_keyframes") {
    sess.step="waiting_keyframe_start"; sess.tab="video_text"; sess.mode="keyframes"; sess.keyframeStart=null; sess.keyframeEnd=null;
    return edit("🎞 *Ключевые кадры*\n\nОтправь *первое* фото:", cancelKb);
  }
  if (data === "kf_skip_end") { sess.step="waiting_prompt"; return edit("✅ Только начальный кадр.\n\nНапиши описание:", cancelKb); }

  // ── Пакетный режим
  if (data === "do_batch") { sess.mode="batch"; return showBatchMenu(chatId, msgId); }
  if (data === "batch_toggle_mode") { sess.tab = sess.tab==="image" ? "video_text" : "image"; return showBatchMenu(chatId, msgId); }
  if (data === "batch_add_text") { sess.step="waiting_batch_prompts"; return edit("✏️ Промпты (каждый с новой строки):", cancelKb); }
  if (data === "batch_from_file") { sess.step="waiting_txt_file"; return edit("📄 Отправь .txt файл:", cancelKb); }
  if (data === "batch_photos_menu") return showBatchPhotosMenu(chatId, msgId);
  if (data.startsWith("del_photo_")) { sess.batchPhotos.splice(parseInt(data.replace("del_photo_","")), 1); return showBatchPhotosMenu(chatId, msgId); }
  if (data === "batch_per_prompt") { sess.step="waiting_per_prompt"; return edit(`🔢 Сколько на 1 промпт/фото? (1-10)\nТекущее: ${s.perPrompt}`, cancelKb); }
  if (data === "batch_clear") { sess.batchPrompts=[]; sess.batchPhotos=[]; sess.batchPromptIdx=0; return showBatchMenu(chatId, msgId); }
  if (data === "batch_run") { del(); return runBatch(chatId); }
  if (data === "bp_prev") { sess.batchPromptIdx = Math.max(0, (sess.batchPromptIdx||0)-1); return showBatchMenu(chatId, msgId); }
  if (data === "bp_next") { sess.batchPromptIdx = Math.min(sess.batchPrompts.length-1, (sess.batchPromptIdx||0)+1); return showBatchMenu(chatId, msgId); }
  if (data === "bp_delete") {
    const idx = sess.batchPromptIdx||0;
    sess.batchPrompts.splice(idx, 1);
    sess.batchPromptIdx = Math.max(0, idx-1);
    return showBatchMenu(chatId, msgId);
  }

  // ── Настройки (сохраняются персистентно)
  if (data === "open_imgmodel") {
    const rows = Object.entries(IMAGE_MODELS).map(([k,v]) => [{ text:`${s.imgModel===k?"✅ ":""}${v.label} (${v.credits})`, callback_data:`set_im_${k}` }]);
    rows.push([{ text:"◀️ Назад", callback_data:"back_menu" }]);
    return edit("🎨 *Модель изображения:*", { inline_keyboard: rows });
  }
  if (data.startsWith("set_im_")) { updateSettings(chatId, { imgModel: data.replace("set_im_","") }); del(); return showMainMenu(chatId); }

  if (data === "open_vidmodel") {
    const rows = Object.entries(VIDEO_MODELS).map(([k,v]) => [{ text:`${s.vidModel===k?"✅ ":""}${v.label} (${v.credits})`, callback_data:`set_vm_${k}` }]);
    rows.push([{ text:"◀️ Назад", callback_data:"back_menu" }]);
    return edit("🎥 *Модель видео:*", { inline_keyboard: rows });
  }
  if (data.startsWith("set_vm_")) { updateSettings(chatId, { vidModel: data.replace("set_vm_","") }); del(); return showMainMenu(chatId); }

  if (data === "open_ratio") {
    const rows = [];
    for (let i=0; i<RATIOS.length; i+=3) rows.push(RATIOS.slice(i,i+3).map(r => ({ text:s.ratio===r?`✅ ${r}`:r, callback_data:`set_r_${r.replace(":","x")}` })));
    rows.push([{ text:"◀️ Назад", callback_data:"back_menu" }]);
    return edit("📐 *Соотношение:*", { inline_keyboard: rows });
  }
  if (data.startsWith("set_r_")) { updateSettings(chatId, { ratio: data.replace("set_r_","").replace("x",":") }); del(); return showMainMenu(chatId); }

  if (data === "open_count") {
    sess.step = "waiting_count";
    return edit(
      `🔢 *Количество*\n\nТекущее: *${s.count}*\n\nНапиши число (1-500) или выбери:`,
      { inline_keyboard: [
        [1,2,3,5].map(n => ({ text:`${s.count===n?"✅ ":""}${n}`, callback_data:`set_c_${n}` })),
        [10,20,50,100].map(n => ({ text:`${s.count===n?"✅ ":""}${n}`, callback_data:`set_c_${n}` })),
        [{ text:"❌ Отмена", callback_data:"back_menu" }],
      ]}
    );
  }
  if (data.startsWith("set_c_")) { updateSettings(chatId, { count: parseInt(data.replace("set_c_","")) }); sess.step=null; del(); return showMainMenu(chatId); }

  if (data === "open_seed") {
    return edit("🌱 *Seed:*", { inline_keyboard: [
      [{ text:s.seed==="random"?"✅ Случайный":"Случайный", callback_data:"set_seed_random" },{ text:s.seed==="fixed"?"✅ Фиксированный":"Фиксированный", callback_data:"set_seed_fixed" }],
      [{ text:"◀️ Назад", callback_data:"back_menu" }],
    ]});
  }
  if (data === "set_seed_random") { updateSettings(chatId, { seed: "random" }); del(); return showMainMenu(chatId); }
  if (data === "set_seed_fixed") { updateSettings(chatId, { seed: "fixed" }); del(); return showMainMenu(chatId); }
});

// ─── Фото ─────────────────────────────────
bot.on("photo", async (msg) => {
  const chatId = msg.chat.id;
  const sess = getSession(chatId);
  const fileId = msg.photo[msg.photo.length-1].file_id;

  if (sess.mode === "batch") {
    sess.batchPhotos.push(fileId);
    return bot.sendMessage(chatId, `✅ Фото ${sess.batchPhotos.length} добавлено!`, {
      reply_markup: { inline_keyboard: [[{ text:"📦 Меню пакета", callback_data:"do_batch" }],[{ text:"🚀 Генерировать!", callback_data:"batch_run" }]] }
    });
  }
  if (sess.step === "waiting_keyframe_start") {
    sess.keyframeStart = fileId; sess.step = "waiting_keyframe_end";
    return bot.sendMessage(chatId, "✅ Первый кадр! Отправь второй или пропусти:", {
      reply_markup: { inline_keyboard: [[{ text:"⏭ Пропустить", callback_data:"kf_skip_end" }],[{ text:"❌ Отмена", callback_data:"back_menu" }]] }
    });
  }
  if (sess.step === "waiting_keyframe_end") {
    sess.keyframeEnd = fileId; sess.step = "waiting_prompt";
    return bot.sendMessage(chatId, "✅ Оба кадра! Напиши описание:", {
      reply_markup: { inline_keyboard: [[{ text:"❌ Отмена", callback_data:"back_menu" }]] }
    });
  }
  if (sess.step === "waiting_photo") {
    sess.fileId = fileId; sess.step = "waiting_prompt";
    return bot.sendMessage(chatId, "✅ Фото! Напиши описание:", {
      reply_markup: { inline_keyboard: [[{ text:"❌ Отмена", callback_data:"back_menu" }]] }
    });
  }
  sess.fileId = fileId; sess.tab = "video_image"; sess.step = "waiting_prompt"; sess.mode = "normal";
  bot.sendMessage(chatId, "✅ Фото! Напиши описание:", {
    reply_markup: { inline_keyboard: [[{ text:"❌ Отмена", callback_data:"back_menu" }]] }
  });
});

// ─── Документ ─────────────────────────────
bot.on("document", async (msg) => {
  const chatId = msg.chat.id;
  const sess = getSession(chatId);
  const s = getSettings(chatId);
  if (sess.step !== "waiting_txt_file") return;
  if (!msg.document.file_name.endsWith(".txt")) return bot.sendMessage(chatId, "❌ Нужен .txt файл!");
  sess.step = null;
  const isVideo = sess.tab !== "image";
  const maxP = isVideo ? 15 : 500;
  try {
    const f = await bot.getFile(msg.document.file_id);
    const resp = await axios.get(`https://api.telegram.org/file/bot${TELEGRAM_TOKEN}/${f.file_path}`, { responseType:"arraybuffer" });
    const text = Buffer.from(resp.data).toString("utf-8");
    const prompts = text.split("\n").map(p => p.trim()).filter(Boolean).slice(0, maxP - sess.batchPrompts.length);
    sess.batchPrompts.push(...prompts);
    sess.batchPromptIdx = 0;
    bot.sendMessage(chatId, `✅ Загружено ${prompts.length} промптов!`, {
      reply_markup: { inline_keyboard: [[{ text:"📦 Меню пакета", callback_data:"do_batch" }]] }
    });
  } catch(e) { bot.sendMessage(chatId, `❌ Ошибка: ${e.message}`); }
});

// ─── Текст ────────────────────────────────
bot.on("message", async (msg) => {
  const chatId = msg.chat.id;
  const sess = getSession(chatId);
  const s = getSettings(chatId);
  if (!msg.text || msg.text.startsWith("/")) return;

  // Новый промпт для перегенерации
  if (sess.step && sess.step.startsWith("regen_prompt_")) {
    const regenKey = sess.step.replace("regen_prompt_","");
    sess.step = null;
    if (pendingRegen[regenKey]) {
      pendingRegen[regenKey].prompt = msg.text;
      pendingRegen[regenKey].body = { ...pendingRegen[regenKey].body, prompt: msg.text };
    }
    return bot.sendMessage(chatId, `✅ Промпт обновлён!`, {
      reply_markup: { inline_keyboard: [[{ text:"🔄 Открыть меню перегенерации", callback_data:`open_regen_${regenKey}` }]] }
    });
  }

  if (sess.step === "waiting_count") {
    const n = parseInt(msg.text.trim());
    if (isNaN(n) || n < 1 || n > 500) return bot.sendMessage(chatId, "❌ Введи число от 1 до 500");
    updateSettings(chatId, { count: n });
    sess.step = null;
    await bot.sendMessage(chatId, `✅ Количество: *${n}*`, { parse_mode: "Markdown" });
    return showMainMenu(chatId);
  }

  if (sess.step === "waiting_per_prompt") {
    const n = parseInt(msg.text.trim());
    if (isNaN(n) || n < 1 || n > 10) return bot.sendMessage(chatId, "❌ Введи число от 1 до 10");
    updateSettings(chatId, { perPrompt: n });
    sess.step = null;
    return bot.sendMessage(chatId, `✅ На 1 промпт: *${n}*`, {
      parse_mode: "Markdown",
      reply_markup: { inline_keyboard: [[{ text:"📦 Меню пакета", callback_data:"do_batch" }]] }
    });
  }

  if (sess.step === "waiting_batch_prompts") {
    sess.step = null;
    const isVideo = sess.tab !== "image";
    const maxP = isVideo ? 15 : 500;
    const prompts = msg.text.split("\n").map(p => p.trim()).filter(Boolean);
    const available = maxP - sess.batchPrompts.length;
    const toAdd = prompts.slice(0, available);
    sess.batchPrompts.push(...toAdd);
    sess.batchPromptIdx = Math.max(0, sess.batchPrompts.length - toAdd.length);
    return bot.sendMessage(chatId,
      `✅ Добавлено ${toAdd.length}!${toAdd.length < prompts.length ? ` ⚠️ Обрезано (лимит ${maxP})` : ""}`,
      { reply_markup: { inline_keyboard: [[{ text:"📦 Меню пакета", callback_data:"do_batch" }]] }}
    );
  }

  if (sess.step !== "waiting_prompt") return;

  const prompt = msg.text;
  sess.step = null;

  if (sess.mode === "keyframes") return runKeyframes(chatId, prompt);
  await runNormal(chatId, prompt);
});

// ─── Обычная генерация ────────────────────
async function runNormal(chatId, prompt) {
  const s = getSettings(chatId);
  const sess = getSession(chatId);
  const isImage = sess.tab === "image";
  let model, endpoint;
  if (isImage) { model = IMAGE_MODELS[s.imgModel]; endpoint = model.ep; }
  else if (sess.tab === "video_text") { model = VIDEO_MODELS[s.vidModel]; endpoint = model.epT; }
  else { model = VIDEO_MODELS[s.vidModel]; endpoint = model.epI; }

  sess.busy = true;
  const count = s.count;
  const statusMsg = await bot.sendMessage(chatId, `⏳ Запускаю ${count} задач...\n🎨 ${model.label}`);
  const tasks = Array.from({length:count}, (_,i) => genOne(chatId, prompt, endpoint, model, isImage, i+1, count));
  await bot.editMessageText(`⏳ ${count} задач запущено...`, { chat_id: chatId, message_id: statusMsg.message_id });
  const results = await Promise.allSettled(tasks);
  const ok = results.filter(r=>r.status==="fulfilled").length;
  sess.busy = false;
  await bot.editMessageText(`✅ Готово! ✓${ok}${count-ok>0?` ✗${count-ok}`:""}`, { chat_id: chatId, message_id: statusMsg.message_id }).catch(()=>{});
  showMainMenu(chatId);
}

// ─── Ключевые кадры ───────────────────────
async function runKeyframes(chatId, prompt) {
  const s = getSettings(chatId);
  const sess = getSession(chatId);
  const model = VIDEO_MODELS[s.vidModel];
  sess.busy = true;
  const statusMsg = await bot.sendMessage(chatId, `⏳ Ключевые кадры...\n🎥 ${model.label}`);
  try {
    const body = { prompt, aspect_ratio: s.ratio, ...(model.sub && { model: model.sub }) };
    if (sess.keyframeStart) {
      const f = await bot.getFile(sess.keyframeStart);
      const r = await axios.get(`https://api.telegram.org/file/bot${TELEGRAM_TOKEN}/${f.file_path}`, { responseType:"arraybuffer" });
      body.start_image = `data:image/jpeg;base64,${Buffer.from(r.data).toString("base64")}`;
    }
    if (sess.keyframeEnd) {
      const f = await bot.getFile(sess.keyframeEnd);
      const r = await axios.get(`https://api.telegram.org/file/bot${TELEGRAM_TOKEN}/${f.file_path}`, { responseType:"arraybuffer" });
      body.end_image = `data:image/jpeg;base64,${Buffer.from(r.data).toString("base64")}`;
    }
    const { data } = await axios.post(`${BASE_URL}${model.epK || model.epT}`, body, {
      headers: { "X-API-Key": FASTGEN_API_KEY, "Content-Type": "application/json" }, timeout: 60000
    });
    const opId = data.operation_id || data.task_id || data.id;
    if (!opId) throw new Error("Нет ID");
    const res = await pollResult(opId);
    if (res?.media) {
      await bot.editMessageText("✅ Готово!", { chat_id: chatId, message_id: statusMsg.message_id });
      await sendMedia(chatId, res.media, false, `🎞 Ключ. кадры\n📝 _${prompt.slice(0,100)}_`);
    }
  } catch(e) {
    await bot.editMessageText(`❌ ${e.message}`, { chat_id: chatId, message_id: statusMsg.message_id });
  }
  sess.busy = false;
  showMainMenu(chatId);
}

// ─── Перегенерация ────────────────────────
async function runRegen(chatId, rg) {
  const s = getSettings(chatId);
  const model = rg.isImage ? IMAGE_MODELS[rg.imgModel] : VIDEO_MODELS[rg.vidModel];
  const endpoint = rg.isImage ? model?.ep : model?.epT;
  if (!model || !endpoint) return bot.sendMessage(chatId, "❌ Ошибка: модель не найдена");

  const body = { ...rg.body, aspect_ratio: rg.ratio, prompt: rg.prompt };
  const statusMsg = await bot.sendMessage(chatId, `🔄 Перегенерация...\n${model.label}`);
  try {
    const { data } = await axios.post(`${BASE_URL}${endpoint}`, body, {
      headers: { "X-API-Key": FASTGEN_API_KEY, "Content-Type": "application/json" }, timeout: 60000
    });
    const opId = data.operation_id || data.task_id || data.id;
    if (!opId) throw new Error("Нет ID");
    const res = await pollResult(opId);
    if (res?.media) {
      await bot.editMessageText(`✅ Перегенерировано!`, { chat_id: chatId, message_id: statusMsg.message_id });
      // Создаём новый regenKey для повторной перегенерации
      const newKey = `rg_${chatId}_${Date.now()}`;
      pendingRegen[newKey] = { ...rg, imgModel: rg.imgModel, vidModel: rg.vidModel };
      await sendMedia(chatId, res.media, rg.isImage, `🔄 ${model.label}\n📝 _${rg.prompt.slice(0,100)}_`, {
        inline_keyboard: [[{ text: "🔄 Перегенерировать ещё раз", callback_data: `open_regen_${newKey}` }]]
      });
    }
  } catch(e) {
    const newKey = `rg_err_${chatId}_${Date.now()}`;
    pendingRegen[newKey] = { ...rg };
    await bot.editMessageText(`❌ Ошибка: ${e.message}`, {
      chat_id: chatId, message_id: statusMsg.message_id,
      reply_markup: { inline_keyboard: [[{ text: "🔄 Попробовать снова", callback_data: `open_regen_${newKey}` }]] }
    });
  }
}

// ─── Пакетная генерация ───────────────────
async function runBatch(chatId) {
  const s = getSettings(chatId);
  const sess = getSession(chatId);
  const isImage = sess.tab === "image";
  const model = isImage ? IMAGE_MODELS[s.imgModel] : VIDEO_MODELS[s.vidModel];
  const prompts = [...sess.batchPrompts];
  const photos = [...sess.batchPhotos];
  const perPrompt = s.perPrompt || 1;

  if (prompts.length === 0 && photos.length === 0) return bot.sendMessage(chatId, "❌ Нет промптов или фото!");

  sess.busy = true;
  const tasks = [];
  for (let pi=0; pi<prompts.length; pi++) for (let vi=0; vi<perPrompt; vi++)
    tasks.push({ prompt: prompts[pi], idx: `${pi+1}.${vi+1}`, ep: isImage ? model.ep : model.epT, isImg: isImage, fileId: null });
  for (let fi=0; fi<photos.length; fi++) for (let vi=0; vi<perPrompt; vi++)
    tasks.push({ prompt: "animate", idx: `${prompts.length+fi+1}.${vi+1}`, ep: VIDEO_MODELS[s.vidModel].epI, isImg: false, fileId: photos[fi] });

  const total = tasks.length;
  let done = 0, errors = 0;
  const statusMsg = await bot.sendMessage(chatId, `📦 *Пакет: ${total} задач*\n${model.label}`, { parse_mode: "Markdown" });
  const balMsg = await bot.sendMessage(chatId, "📊 _Загружаю баланс..._", { parse_mode: "Markdown" });
  liveBalanceUpdate(chatId, balMsg.message_id, 15000, Math.max(total*30000, 120000)).catch(()=>{});

  for (let i=0; i<tasks.length; i+=5) {
    await Promise.allSettled(tasks.slice(i,i+5).map(async (task) => {
      try { await genOne(chatId, task.prompt, task.ep, model, task.isImg, 0, 0, task.idx, task.fileId); done++; }
      catch { errors++; }
      bot.editMessageText(`📦 ✓${done}/${total}${errors>0?` | ✗${errors}`:""}`, { chat_id: chatId, message_id: statusMsg.message_id }).catch(()=>{});
    }));
  }

  sess.batchPrompts=[]; sess.batchPhotos=[]; sess.batchPromptIdx=0; sess.busy=false;
  await bot.editMessageText(`✅ Пакет готов! ✓${done}${errors>0?` ✗${errors}`:""}`, { chat_id: chatId, message_id: statusMsg.message_id }).catch(()=>{});
  showMainMenu(chatId);
}

// ─── Одна задача ──────────────────────────
async function genOne(chatId, prompt, endpoint, model, isImage, index, total, batchIdx=null, overrideFileId=null) {
  const s = getSettings(chatId);
  const sess = getSession(chatId);
  const label = batchIdx || (total>1 ? `${index}/${total}` : "");

  const body = {
    prompt, aspect_ratio: s.ratio,
    ...(model.sub && { model: model.sub }),
    ...(model.model && { model: model.model }),
    ...(model.quality && { quality: model.quality }),
    ...(model.res && { resolution: s.resolution }),
    ...(s.seed === "fixed" && { seed: 42 }),
  };

  try {
    const fid = overrideFileId || sess.fileId;
    if (fid && (sess.tab==="video_image" || overrideFileId)) {
      const f = await bot.getFile(fid);
      const r = await axios.get(`https://api.telegram.org/file/bot${TELEGRAM_TOKEN}/${f.file_path}`, { responseType:"arraybuffer" });
      body.image = `data:image/jpeg;base64,${Buffer.from(r.data).toString("base64")}`;
    }

    const { data } = await axios.post(`${BASE_URL}${endpoint}`, body, {
      headers: { "X-API-Key": FASTGEN_API_KEY, "Content-Type": "application/json", Accept: "application/json" },
      timeout: 60000,
    });

    const opId = data.operation_id || data.task_id || data.id;
    if (!opId) throw new Error("Нет ID задачи от API");

    addHistory(chatId, {
      index: batchIdx||label||"1", model: model.label, prompt, opId,
      endpoint, body, isImage,
      imgModel: s.imgModel, vidModel: s.vidModel, ratio: s.ratio,
    });

    const res = await pollResult(opId);
    const idxStr = batchIdx ? `*${batchIdx}* ` : "";
    const caption = `${idxStr}${model.label}\n📝 _${prompt.slice(0,100)}_`;

    // Создаём ключ для перегенерации
    const regenKey = `gen_${chatId}_${Date.now()}_${Math.random().toString(36).slice(2,5)}`;
    pendingRegen[regenKey] = {
      prompt, endpoint, body, isImage,
      imgModel: s.imgModel, vidModel: s.vidModel, ratio: s.ratio, idx: batchIdx||label,
    };
    const regenKb = { inline_keyboard: [[{ text: `🔄 Перегенерировать${batchIdx?` ${batchIdx}`:""}`, callback_data: `open_regen_${regenKey}` }]] };

    if (res?.media) {
      await sendMedia(chatId, res.media, isImage, caption, regenKb);
    } else {
      await bot.sendMessage(chatId, `⏰ ${idxStr}не успело.\nID: \`${opId}\`\n/check ${opId}`, {
        parse_mode: "Markdown", reply_markup: regenKb
      });
    }
  } catch(e) {
    const apiErr = e.response?.data?.detail || e.response?.data?.message || e.response?.data?.error;
    const errMsg = apiErr || e.message;
    const httpCode = e.response?.status;

    const regenKey = `err_${chatId}_${Date.now()}`;
    pendingRegen[regenKey] = { prompt, endpoint, body, isImage, imgModel: s.imgModel, vidModel: s.vidModel, ratio: s.ratio, idx: batchIdx||label };

    await bot.sendMessage(chatId,
      `❌ ${batchIdx?`[${batchIdx}] `:""}${httpCode?`[${httpCode}] `:""}${errMsg}`,
      { reply_markup: { inline_keyboard: [[{ text:`🔄 Перегенерировать`, callback_data:`open_regen_${regenKey}` }]] } }
    );
    throw e;
  }
}

// ─── /check ───────────────────────────────
async function checkOperation(chatId, opId) {
  const msg = await bot.sendMessage(chatId, `🔍 Проверяю \`${opId}\`...`, { parse_mode:"Markdown" });
  try {
    const { data } = await axios.get(`${BASE_URL}/api/v4/operations/${opId}`, {
      headers: { "X-API-Key": FASTGEN_API_KEY }, timeout: 15000
    });
    const st = data.status || data.state;
    const errDetail = data.error || data.error_message || "";
    await bot.editMessageText(`Статус: *${st}*${errDetail?`\nОшибка: ${errDetail}`:""}`, { chat_id: chatId, message_id: msg.message_id, parse_mode:"Markdown" });
    if (["completed","success","done","finished"].includes(st)) {
      const media = extractMedia(data);
      if (media) await sendMedia(chatId, media, data.media_type==="image", "✅ Результат");
    }
  } catch(e) {
    await bot.editMessageText(`❌ ${e.message}`, { chat_id: chatId, message_id: msg.message_id });
  }
}
