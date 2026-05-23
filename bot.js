const TelegramBot = require("node-telegram-bot-api");
const axios = require("axios");
const fs = require("fs");

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const FASTGEN_API_KEY = process.env.FASTGEN_API_KEY;
const BASE_URL = "https://googler.fast-gen.ai";
const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });

const userState = {};
const history = {};

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
  "grok_vid":      { label: "Grok Video",       epT: "/api/v4/grok/video/from-text",   epI: "/api/v4/grok/video/from-image",   credits: "1 кред = 1 видео", res: true, defaultRes: "720p" },
  "veo31_flower":  { label: "Veo 3.1 Flower",  epT: "/api/v4/flower/video/from-text", epI: "/api/v4/flower/video/from-image", credits: "1 кред = 1 видео" },
};

const RATIOS = ["16:9","9:16","1:1","4:3","3:4","3:2","2:3"];
// Количество вводится вручную (до 500)

function getState(chatId) {
  if (!userState[chatId]) userState[chatId] = {
    step: null, tab: "image",
    imgModel: "imagen4_flow", vidModel: "veo31_fast",
    ratio: "16:9", count: 1, perPrompt: 1,
    seed: "random", resolution: "720p", mode: "normal",
    batchPrompts: [], batchPhotos: [],
    batchPromptIdx: 0, // текущий индекс просмотра промпта
    keyframeStart: null, keyframeEnd: null,
    fileId: null,
    balanceMsgId: null,
    menuMsgId: null, // ID последнего меню для замены
  };
  return userState[chatId];
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
      if (["failed","error","cancelled"].includes(st)) throw new Error(`Статус: ${st}`);
    } catch(e) { if (e.message.startsWith("Статус")) throw e; }
  }
  return null;
}

// ─── Баланс ───────────────────────────────
async function getUsageData() {
  // Try different known endpoints
  const endpoints = [
    "/api/v5/usage",
    "/api/v4/usage",
    "/api/v5/user/usage",
    "/api/v5/limits",
    "/api/v4/limits",
  ];
  for (const ep of endpoints) {
    try {
      const { data } = await axios.get(`${BASE_URL}${ep}`, {
        headers: { "X-API-Key": FASTGEN_API_KEY }, timeout: 10000
      });
      console.log(`[balance OK] endpoint=${ep}`);
      console.log(`[balance win]`, JSON.stringify(data.usagewindow || data.usage_window || "none").slice(0, 300));
      console.log(`[balance cur]`, JSON.stringify(data.currentusage?.hourlyusage || "none").slice(0, 300));
      return data;
    } catch(e) {
      console.log(`[balance FAIL] endpoint=${ep} status=${e.response?.status} msg=${e.message}`);
    }
  }
  return null;
}

function formatBalance(usage) {
  if (!usage) return "❌ Не удалось получить баланс";

  const cur    = usage.currentusage  || usage.current_usage || usage;
  const lim    = usage.accountlimits || usage.account_limits || usage;
  const win    = usage.usagewindow   || usage.usage_window  || {};
  const hourly = cur.hourlyusage     || cur.hourly_usage    || cur;

  // Exact field names confirmed from debug:
  // hourly: image_generation, video_generation, prompt_generation, flow_ultra_generation
  // lim: img_gen_per_hour_limit, video_gen_per_hour_limit,
  //      img_generation_threads_allowed, video_generation_threads_allowed,
  //      prompt_tokens_per_hour_limit, flow_ultra_hour_limit, flow_ultra_threads_allowed

  const imgUsed  = hourly.image_generation  ?? "?";
  const imgTotal = lim.img_gen_per_hour_limit ?? "?";
  const vidUsed  = hourly.video_generation  ?? "?";
  const vidTotal = lim.video_gen_per_hour_limit ?? "?";
  const tokUsed  = hourly.prompt_generation ?? null;
  const tokTotal = lim.prompt_tokens_per_hour_limit ?? null;
  const threads    = cur.activethreads ?? cur.active_threads ?? null;
  const imgThreads = lim.img_generation_threads_allowed   ?? null;
  const vidThreads = lim.video_generation_threads_allowed ?? null;

  // Reset time
  const resetMin   = win.reset_in_minutes ?? win.reset_in ?? usage.reset_in_minutes ?? null;
  const resetAtRaw = win.reset_at ?? win.resets_at ?? usage.reset_at ?? null;
  let resetStr = "?";
  if (resetMin != null) {
    resetStr = `${Math.floor(resetMin)}м`;
    if (resetAtRaw) { try { resetStr += ` (в ${new Date(resetAtRaw).toLocaleTimeString("ru")})`; } catch {} }
  } else if (resetAtRaw) {
    try { resetStr = new Date(resetAtRaw).toLocaleTimeString("ru"); } catch {}
  }

  const tokLine    = tokUsed  != null ? `💬 Токены: ${tokUsed}/${tokTotal ?? "?"}\n` : "";
  const threadLine = threads  != null
    ? `🔄 Потоки: 🖼 ${threads}/${imgThreads ?? "?"} | 🎬 ${threads}/${vidThreads ?? "?"}\n`
    : (imgThreads != null ? `🔄 Потоки: 🖼 ?/${imgThreads} | 🎬 ?/${vidThreads ?? "?"}\n` : "");

  return (
    `📊 Баланс и лимиты\n\n` +
    `🖼 Изображения: ${imgUsed}/${imgTotal}\n` +
    `🎬 Видео: ${vidUsed}/${vidTotal}\n` +
    tokLine + threadLine +
    `⏱ Сброс через: ${resetStr}\n\n` +
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

async function showBalance(chatId, msgId = null) {
  try {
    const usage = await getUsageData();
    const text = formatBalance(usage);
    const kb = { inline_keyboard: [
      [{ text: "🔄 Обновить", callback_data: "refresh_balance" }],
      [{ text: "◀️ Назад", callback_data: "close_balance" }],
    ]};
    if (msgId) {
      await bot.editMessageText(text, { chat_id: chatId, message_id: msgId, reply_markup: kb }).catch(()=>{});
    } else {
      const m = await bot.sendMessage(chatId, text, { reply_markup: kb });
      getState(chatId).balanceMsgId = m.message_id;
    }
  } catch(e) {
    console.error("[showBalance error]", e.message);
    const errText = `❌ Ошибка баланса: ${e.message}`;
    if (msgId) {
      await bot.editMessageText(errText, { chat_id: chatId, message_id: msgId }).catch(()=>{});
    } else {
      await bot.sendMessage(chatId, errText);
    }
  }
}

// Живое обновление баланса во время генерации
async function liveBalanceUpdate(chatId, msgId, intervalMs = 15000, durationMs = 300000) {
  const end = Date.now() + durationMs;
  while (Date.now() < end) {
    await new Promise(r => setTimeout(r, intervalMs));
    const usage = await getUsageData();
    if (!usage) continue;
    try {
      await bot.editMessageText(formatBalance(usage), {
        chat_id: chatId, message_id: msgId, parse_mode: "Markdown",
        reply_markup: { inline_keyboard: [[{ text: "🔄 Обновить", callback_data: "refresh_balance" }],[{ text: "◀️ Назад", callback_data: "close_balance" }]] }
      });
    } catch {}
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
    [{ text: "🖼️ Изображение", callback_data: "do_image" }, { text: "🎬 Видео из текста", callback_data: "do_vtext" }],
    [{ text: "📸 Видео из фото", callback_data: "do_vimage" }, { text: "🎞 Ключ. кадры", callback_data: "do_keyframes" }],
    [{ text: "📦 Пакетный режим", callback_data: "do_batch" }],
    [{ text: "🎨 Модель фото", callback_data: "open_imgmodel" }, { text: "🎥 Модель видео", callback_data: "open_vidmodel" }],
    [{ text: "📐 Соотношение", callback_data: "open_ratio" }, { text: "🔢 Количество", callback_data: "open_count" }],
    [{ text: "🌱 Seed", callback_data: "open_seed" }, { text: "📊 Баланс", callback_data: "show_balance" }],
    ...(s.vidModel === "grok_vid" ? [[{ text: `🖥 Разрешение Grok: ${s.resolution || "720p"}`, callback_data: "open_resolution" }]] : []),
    [{ text: "📋 История", callback_data: "show_history" }],
  ]};

  // Try to edit existing menu message
  if (s.menuMsgId) {
    try {
      await bot.editMessageText(text, { chat_id: chatId, message_id: s.menuMsgId, parse_mode: "Markdown", reply_markup: kb });
      return;
    } catch(e) {
      // Message too old or deleted — send new one
    }
  }
  const m = await bot.sendMessage(chatId, text, { parse_mode: "Markdown", reply_markup: kb });
  s.menuMsgId = m.message_id;
}

// ─── Промпт-навигатор для пакетного режима ─
function showBatchMenu(chatId, msgId = null) {
  const s = getState(chatId);
  const prompts = s.batchPrompts;
  const photos = s.batchPhotos;
  const idx = s.batchPromptIdx || 0;
  const hasPrompts = prompts.length > 0;
  const currentPrompt = hasPrompts ? prompts[idx] : null;

  const isImage = s.tab === "image";
  const MAX_PROMPTS = isImage ? 500 : 15;

  const text =
    `📦 *Пакетный режим*\n\n` +
    `📝 Промптов: *${prompts.length}/${MAX_PROMPTS}*\n` +
    `📸 Фото: *${photos.length}*\n` +
    `🔢 На 1 промпт/фото: *${s.perPrompt}* вар.\n` +
    `Всего задач: *${(prompts.length + photos.length) * s.perPrompt}*\n\n` +
    (currentPrompt ? `*Промпт ${idx+1}/${prompts.length}:*\n${currentPrompt}` : "_Промптов нет_");

  const navRow = hasPrompts ? [
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

// ─── /start /menu ─────────────────────────
bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;
  const s = getState(chatId);
  // Try delete old menu
  if (s.menuMsgId) {
    await bot.deleteMessage(chatId, s.menuMsgId).catch(()=>{});
    s.menuMsgId = null;
  }
  // Try delete the /start command message
  await bot.deleteMessage(chatId, msg.message_id).catch(()=>{});
  userState[chatId] = null;
  showMainMenu(chatId);
});
bot.onText(/\/menu/, async (msg) => {
  const chatId = msg.chat.id;
  await bot.deleteMessage(chatId, msg.message_id).catch(()=>{});
  showMainMenu(chatId);
});
bot.onText(/\/balance/, (msg) => showBalance(msg.chat.id));
bot.onText(/\/history/, (msg) => showHistoryMenu(msg.chat.id));
bot.onText(/\/check (.+)/, async (msg, m) => checkOperation(msg.chat.id, m[1].trim()));

// ─── Callbacks ────────────────────────────
bot.on("callback_query", async (query) => {
  const chatId = query.message.chat.id;
  const msgId = query.message.message_id;
  const data = query.data;
  const s = getState(chatId);
  bot.answerCallbackQuery(query.id);

  const del = () => bot.deleteMessage(chatId, msgId).catch(()=>{});
  const edit = (text, kb) => bot.editMessageText(text, { chat_id: chatId, message_id: msgId, parse_mode: "Markdown", reply_markup: kb });
  const cancelKb = { inline_keyboard: [[{ text: "❌ Отмена", callback_data: "back_menu" }]] };

  if (data === "back_menu") {
    // If this message IS the main menu — just refresh it
    const s2 = getState(chatId);
    if (s2.menuMsgId === msgId) {
      return showMainMenu(chatId);
    }
    // Otherwise delete this sub-menu and restore main menu
    del();
    return showMainMenu(chatId);
  }
  if (data === "noop") return;

  // ── Баланс
  if (data === "close_balance") { return del(); }
  if (data === "show_balance") { return await showBalance(chatId); }
  if (data === "refresh_balance") { return await showBalance(chatId, msgId); }

  // ── История
  if (data === "show_history") { return showHistoryMenu(chatId, msgId); }
  if (data.startsWith("hist_")) {
    const idx = parseInt(data.replace("hist_",""));
    const h = getHistory(chatId);
    const item = h[idx];
    if (!item) return;
    return edit(
      `📋 *${item.index || idx+1}*\n\nМодель: ${item.model}\n📝 ${item.prompt}\n${item.opId ? `ID: \`${item.opId}\`` : ""}`,
      { inline_keyboard: [
        item.opId ? [{ text: "🔄 Перегенерировать", callback_data: `regen_${idx}` }] : [],
        [{ text: "◀️ К истории", callback_data: "show_history" }],
      ].filter(r=>r.length) }
    );
  }
  if (data.startsWith("regen_")) {
    const histIdx = parseInt(data.replace("regen_",""));
    const h = getHistory(chatId);
    const item = h[histIdx];
    if (!item) return;
    await edit("⏳ Перегенерация...", { inline_keyboard: [] });
    try {
      const { data: apiData } = await axios.post(`${BASE_URL}${item.endpoint}`, item.body, {
        headers: { "X-API-Key": FASTGEN_API_KEY, "Content-Type": "application/json" }, timeout: 60000
      });
      const opId = apiData.operation_id || apiData.task_id || apiData.id;
      const result = await pollResult(opId);
      if (result) {
        await bot.editMessageText(`✅ Перегенерировано: *${item.index}*`, { chat_id: chatId, message_id: msgId, parse_mode: "Markdown" });
        await sendMedia(chatId, result, item.isImage, `🔄 *${item.index}* (перегенерация)\n📝 _${item.prompt.slice(0,100)}_`);
      }
    } catch(e) {
      await bot.editMessageText(`❌ Ошибка: ${e.message}`, { chat_id: chatId, message_id: msgId });
    }
    return;
  }

  // ── Режимы
  if (data === "do_image") { s.step="waiting_prompt"; s.tab="image"; s.mode="normal"; return edit(`🖼️ *Изображение*\n${IMAGE_MODELS[s.imgModel].label}\n\nНапиши промпт:`, cancelKb); }
  if (data === "do_vtext") { s.step="waiting_prompt"; s.tab="video_text"; s.mode="normal"; return edit(`🎬 *Видео из текста*\n${VIDEO_MODELS[s.vidModel].label}\n\nОпиши видео:`, cancelKb); }
  if (data === "do_vimage") { s.step="waiting_photo"; s.tab="video_image"; s.mode="normal"; return edit("📸 *Видео из фото*\n\nОтправь фото:", cancelKb); }
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

  // ── Навигация по промптам
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
  if (data.startsWith("set_im_")) { s.imgModel=data.replace("set_im_",""); del(); return showMainMenu(chatId); }

  if (data === "open_vidmodel") {
    const rows = Object.entries(VIDEO_MODELS).map(([k,v]) => [{ text:`${s.vidModel===k?"✅ ":""}${v.label} (${v.credits})`, callback_data:`set_vm_${k}` }]);
    rows.push([{ text:"◀️ Назад", callback_data:"back_menu" }]);
    return edit("🎥 *Модель видео:*", { inline_keyboard: rows });
  }
  if (data.startsWith("set_vm_")) { s.vidModel=data.replace("set_vm_",""); del(); return showMainMenu(chatId); }

  // ── Соотношение
  if (data === "open_ratio") {
    const rows = [];
    for (let i=0; i<RATIOS.length; i+=3) rows.push(RATIOS.slice(i,i+3).map(r => ({ text:s.ratio===r?`✅ ${r}`:r, callback_data:`set_r_${r.replace(":","x")}` })));
    rows.push([{ text:"◀️ Назад", callback_data:"back_menu" }]);
    return edit("📐 *Соотношение сторон:*", { inline_keyboard: rows });
  }
  if (data.startsWith("set_r_")) { s.ratio=data.replace("set_r_","").replace("x",":"); del(); return showMainMenu(chatId); }

  // ── Количество (ввод текстом до 500)
  if (data === "open_count") {
    s.step = "waiting_count";
    return edit(
      `🔢 *Количество за раз*\n\nСейчас: *${s.count}*\n\nНапиши число от 1 до 500:`,
      { inline_keyboard: [[{ text: "❌ Отмена", callback_data: "cancel_count" }]] }
    );
  }
  if (data === "cancel_count") { s.step = null; del(); return showMainMenu(chatId); }
  if (data.startsWith("set_c_")) { s.count=parseInt(data.replace("set_c_","")); del(); return showMainMenu(chatId); }

  // ── Seed
  if (data === "open_seed") {
    return edit("🌱 *Seed:*", { inline_keyboard: [
      [{ text:s.seed==="random"?"✅ Случайный":"Случайный", callback_data:"set_seed_random" }, { text:s.seed==="fixed"?"✅ Фиксированный":"Фиксированный", callback_data:"set_seed_fixed" }],
      [{ text:"◀️ Назад", callback_data:"back_menu" }],
    ]});
  }
  if (data === "set_seed_random") { s.seed="random"; del(); return showMainMenu(chatId); }
  if (data === "set_seed_fixed") { s.seed="fixed"; del(); return showMainMenu(chatId); }

  // ── Разрешение (для Grok Video)
  if (data === "open_resolution") {
    const RESOLUTIONS = ["480p","720p","1080p"];
    return edit("🖥 *Разрешение Grok Video:*", { inline_keyboard: [
      RESOLUTIONS.map(r => ({ text: (s.resolution||"720p")===r?`✅ ${r}`:r, callback_data:`set_res_${r}` })),
      [{ text:"◀️ Назад", callback_data:"back_menu" }],
    ]});
  }
  if (data.startsWith("set_res_")) { s.resolution=data.replace("set_res_",""); del(); return showMainMenu(chatId); }
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
  if (s.step === "waiting_photo") {
    s.fileId = fileId; s.step = "waiting_prompt";
    return bot.sendMessage(chatId, "✅ Фото получено! Напиши описание:", {
      reply_markup: { inline_keyboard: [[{ text:"❌ Отмена", callback_data:"back_menu" }]] }
    });
  }
  // No active step — set state for video-from-photo
  s.fileId = fileId; s.tab = "video_image"; s.step = "waiting_prompt"; s.mode = "normal";
  const vm = VIDEO_MODELS[s.vidModel];
  bot.sendMessage(chatId, `✅ Фото получено!

🎬 *${vm.label}* (${vm.credits})

Напиши описание для видео:`, {
    parse_mode: "Markdown",
    reply_markup: { inline_keyboard: [
      [{ text: "🎥 Сменить модель видео", callback_data: "open_vidmodel" }],
      [{ text: "❌ Отмена", callback_data: "back_menu" }],
    ]}
  });
});

// ─── Документ (.txt файл) ─────────────────
bot.on("document", async (msg) => {
  const chatId = msg.chat.id;
  const s = getState(chatId);
  if (s.step !== "waiting_txt_file") return;
  if (!msg.document.file_name.endsWith(".txt")) return bot.sendMessage(chatId, "❌ Нужен .txt файл!");
  s.step = null;

  try {
    const f = await bot.getFile(msg.document.file_id);
    const resp = await axios.get(`https://api.telegram.org/file/bot${TELEGRAM_TOKEN}/${f.file_path}`, { responseType: "arraybuffer" });
    const text = Buffer.from(resp.data).toString("utf-8");
    const prompts = text.split("\n").map(p => p.trim()).filter(Boolean);
    const isImage = s.tab === "image";
    const MAX_PROMPTS = isImage ? 500 : 15;
    const available = MAX_PROMPTS - s.batchPrompts.length;
    const toAdd = prompts.slice(0, available);
    const skipped = prompts.length - toAdd.length;
    s.batchPrompts.push(...toAdd);
    s.batchPromptIdx = 0;
    let reply = `✅ Загружено ${toAdd.length} промптов из файла!`;
    if (skipped > 0) reply += `\n⚠️ Пропущено ${skipped} — лимит ${MAX_PROMPTS} для ${isImage ? "фото" : "видео"}`;
    bot.sendMessage(chatId, reply, {
      reply_markup: { inline_keyboard: [[{ text:"📦 Открыть меню пакета", callback_data:"do_batch" }]] }
    });
  } catch(e) {
    bot.sendMessage(chatId, `❌ Ошибка чтения файла: ${e.message}`);
  }
});

// ─── Текстовые сообщения ──────────────────
bot.on("message", async (msg) => {
  const chatId = msg.chat.id;
  const s = getState(chatId);
  if (!msg.text || msg.text.startsWith("/")) return;

  if (s.step === "waiting_count") {
    const n = parseInt(msg.text);
    if (isNaN(n) || n < 1 || n > 500) {
      return bot.sendMessage(chatId, "❌ Введи число от 1 до 500:", {
        reply_markup: { inline_keyboard: [[{ text: "❌ Отмена", callback_data: "cancel_count" }]] }
      });
    }
    s.count = n;
    s.step = null;
    await bot.sendMessage(chatId, `✅ Количество: *${n}*`, { parse_mode: "Markdown" });
    return showMainMenu(chatId);
  }

  if (s.step === "waiting_batch_prompts") {
    s.step = null;
    const isImage = s.tab === "image";
    const MAX_PROMPTS = isImage ? 500 : 15;
    const prompts = msg.text.split("\n").map(p => p.trim()).filter(Boolean);
    const available = MAX_PROMPTS - s.batchPrompts.length;
    const toAdd = prompts.slice(0, available);
    const skipped = prompts.length - toAdd.length;
    s.batchPrompts.push(...toAdd);
    s.batchPromptIdx = Math.max(0, s.batchPrompts.length - toAdd.length);
    let reply = `✅ Добавлено ${toAdd.length} промптов!`;
    if (skipped > 0) reply += `\n⚠️ Пропущено ${skipped} — лимит ${MAX_PROMPTS} для ${isImage ? "фото" : "видео"}`;
    return bot.sendMessage(chatId, reply, {
      reply_markup: { inline_keyboard: [[{ text:"📦 Меню пакета", callback_data:"do_batch" }]] }
    });
  }

  if (s.step !== "waiting_prompt") return bot.sendMessage(chatId, "Нажми /menu чтобы начать.");

  const prompt = msg.text;
  s.step = null;

  if (s.mode === "keyframes") return runKeyframes(chatId, s, prompt);
  await runNormal(chatId, s, prompt);
});

// ─── Обычная генерация ────────────────────
async function runNormal(chatId, s, prompt) {
  const isImage = s.tab === "image";
  let model, endpoint;
  if (isImage) { model = IMAGE_MODELS[s.imgModel]; endpoint = model.ep; }
  else if (s.tab === "video_text") { model = VIDEO_MODELS[s.vidModel]; endpoint = model.epT; }
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
  for (let pi=0; pi<prompts.length; pi++) {
    for (let vi=0; vi<perPrompt; vi++) {
      tasks.push({ prompt: prompts[pi], idx: `${pi+1}.${vi+1}`, ep: isImage ? model.ep : model.epT, isImg: isImage, fileId: null });
    }
  }
  for (let fi=0; fi<photos.length; fi++) {
    for (let vi=0; vi<perPrompt; vi++) {
      tasks.push({ prompt: "animate", idx: `${prompts.length+fi+1}.${vi+1}`, ep: VIDEO_MODELS[s.vidModel].epI, isImg: false, fileId: photos[fi] });
    }
  }

  const total = tasks.length;
  let done = 0, errors = 0;
  const statusMsg = await bot.sendMessage(chatId,
    `📦 *Пакетный режим*\nЗадач: ${total} | Модель: ${model.label}\n💳 ${model.credits}`,
    { parse_mode: "Markdown" }
  );

  // Живое обновление баланса параллельно
  const balanceMsg = await bot.sendMessage(chatId, "📊 _Обновляю баланс..._", { parse_mode: "Markdown" });
  liveBalanceUpdate(chatId, balanceMsg.message_id, 15000, total * 60000).catch(()=>{});

  for (let i=0; i<tasks.length; i+=5) {
    const batch = tasks.slice(i, i+5);
    await Promise.allSettled(batch.map(async (task) => {
      try {
        await genOne(chatId, s, task.prompt, task.ep, model, task.isImg, 0, 0, task.idx, task.fileId);
        done++;
      } catch { errors++; }
      await bot.editMessageText(
        `📦 Пакет: ✓${done}/${total}${errors>0?` | ✗${errors}`:""}`,
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

    const { data } = await axios.post(`${BASE_URL}${endpoint}`, body, {
      headers: { "X-API-Key": FASTGEN_API_KEY, "Content-Type": "application/json", Accept: "application/json" },
      timeout: 60000,
    });

    const opId = data.operation_id || data.task_id || data.id;
    if (!opId) throw new Error("Нет ID задачи");

    addHistory(chatId, { index: batchIdx||label, model: model.label, prompt, opId, endpoint, body, isImage });

    const result = await pollResult(opId);
    const idxStr = batchIdx ? `*${batchIdx}* ` : "";
    const caption = `${idxStr}${model.label}\n📝 _${prompt.slice(0,100)}_`;

    if (result) {
      const regenKb = { inline_keyboard: [[{ text:"🔄 Перегенерировать", callback_data:`regen_0` }]] };
      await sendMedia(chatId, result, isImage, caption, regenKb);
    } else {
      await bot.sendMessage(chatId, `⏰ ${idxStr}не успело.\nID: \`${opId}\`\n/check ${opId}`, {
        parse_mode: "Markdown",
        reply_markup: { inline_keyboard: [[{ text:"🔄 Повторить", callback_data:`regen_0` }]] }
      });
    }
  } catch(e) {
    const errMsg = e.response?.data?.detail || e.response?.data?.message || e.message;
    await bot.sendMessage(chatId, `❌ ${label?`[${label}] `:""}${errMsg}`, {
      reply_markup: { inline_keyboard: [[{ text:"🔄 Повторить запрос", callback_data:"back_menu" }]] }
    });
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
    await bot.editMessageText(`Статус: *${st}*`, { chat_id: chatId, message_id: msg.message_id, parse_mode:"Markdown" });
    if (["completed","success","done","finished"].includes(st)) {
      const media = extractMedia(data);
      if (media) await sendMedia(chatId, media, data.media_type==="image", "✅ Результат");
    }
  } catch(e) {
    await bot.editMessageText(`❌ ${e.message}`, { chat_id: chatId, message_id: msg.message_id });
  }
}

console.log("🤖 Бот запущен!");
