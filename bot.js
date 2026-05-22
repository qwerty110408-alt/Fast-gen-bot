const TelegramBot = require("node-telegram-bot-api");
const axios = require("axios");
const fs = require("fs");

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const FASTGEN_API_KEY = process.env.FASTGEN_API_KEY;
const BASE_URL = "https://googler.fast-gen.ai";
const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });

// ─── Хранилище ────────────────────────────
const userState = {};   // настройки и шаги
const history = {};     // история генераций

// ─── Модели ───────────────────────────────
const IMAGE_MODELS = {
  "imagen4_flow":  { label: "Imagen 4 - Flow",        ep: "/api/v4/flow/image/generate",   credits: "4 кред = 1 фото" },
  "nanopro_flow":  { label: "Nano Banana Pro - Flow",  ep: "/api/v4/flow/image/generate",   credits: "4 кред = 1 фото", model: "nano-banana-pro" },
  "nanob2_flow":   { label: "Nano Banana 2 - Flow",    ep: "/api/v4/flow/image/generate",   credits: "4 кред = 1 фото", model: "nano-banana-2" },
  "grok_fast":     { label: "Grok (быстро)",           ep: "/api/v4/grok/image/generate",   credits: "1 кред = 6 фото", quality: "fast" },
  "grok_quality":  { label: "Grok (качество)",         ep: "/api/v4/grok/image/generate",   credits: "1 кред = 4 фото", quality: "quality" },
  "nanob2_flower": { label: "Nano Banana 2 - Flower",  ep: "/api/v4/flower/image/generate", credits: "1 кред = 1 фото" },
  "chatgpt":       { label: "ChatGPT Images 2.0",      ep: "/api/v4/openai/image/generate", credits: "1 кред = 1 фото" },
};

const VIDEO_MODELS = {
  "veo31_fast":    { label: "Veo 3.1 Fast",     epT: "/api/v4/flow/video/from-text",   epI: "/api/v4/flow/video/from-image",   epK: "/api/v4/flow/video/from-keyframes", sub: "veo-3.1-fast",    credits: "1 кред = 1 видео" },
  "veo31_light":   { label: "Veo 3.1 Light",    epT: "/api/v4/flow/video/from-text",   epI: "/api/v4/flow/video/from-image",   epK: "/api/v4/flow/video/from-keyframes", sub: "veo-3.1-light",   credits: "1 кред = 1 видео" },
  "veo31_quality": { label: "Veo 3.1 Quality",  epT: "/api/v4/flow/video/from-text",   epI: "/api/v4/flow/video/from-image",   epK: "/api/v4/flow/video/from-keyframes", sub: "veo-3.1-quality", credits: "10 кред = 1 видео" },
  "grok_vid":      { label: "Grok Video",        epT: "/api/v4/grok/video/from-text",   epI: "/api/v4/grok/video/from-image",   credits: "1 кред = 1 видео", res: true },
  "veo31_flower":  { label: "Veo 3.1 Flower",   epT: "/api/v4/flower/video/from-text", epI: "/api/v4/flower/video/from-image", credits: "1 кред = 1 видео" },
};

const RATIOS = ["16:9","9:16","1:1","4:3","3:4","3:2","2:3"];
const COUNTS = [1,2,3,4,5,6,8,10];

function getState(chatId) {
  if (!userState[chatId]) userState[chatId] = {
    step: null, tab: "image",
    imgModel: "imagen4_flow", vidModel: "veo31_fast",
    ratio: "16:9", count: 1, perPrompt: 1,
    seed: "random", resolution: "720p",
    mode: "normal",       // normal | batch | keyframes
    batchPrompts: [],     // массив промптов для пакетного режима
    batchPhotos: [],      // массив fileId фото
    keyframeStart: null, keyframeEnd: null,
    fileId: null,
    currentBatchIdx: 0,
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

// ─── Медиа из ответа ──────────────────────
function extractMedia(data) {
  if (Array.isArray(data.result) && data.result.length > 0) return { base64: data.result[0], type: data.media_type || "video" };
  if (typeof data.result === "string" && data.result.startsWith("data:")) return { base64: data.result, type: data.media_type || "video" };
  const url = data.video_url || data.image_url || data.url || data.output || data.result?.url;
  if (url) return { url, type: data.media_type || "video" };
  return null;
}

async function sendMedia(chatId, media, isImage, caption) {
  if (media.base64) {
    let b64 = media.base64, ext = isImage ? "jpg" : "mp4";
    if (b64.includes(";base64,")) { const p = b64.split(";base64,"); b64 = p[1]; if (p[0].includes("png")) ext="png"; }
    const tmp = `/tmp/fg_${Date.now()}.${ext}`;
    fs.writeFileSync(tmp, Buffer.from(b64, "base64"));
    try {
      if (isImage) await bot.sendPhoto(chatId, fs.createReadStream(tmp), { caption, parse_mode: "Markdown" });
      else await bot.sendVideo(chatId, fs.createReadStream(tmp), { caption, parse_mode: "Markdown" });
    } finally { try { fs.unlinkSync(tmp); } catch {} }
  } else if (media.url) {
    if (isImage) await bot.sendPhoto(chatId, media.url, { caption, parse_mode: "Markdown" });
    else await bot.sendVideo(chatId, media.url, { caption, parse_mode: "Markdown" });
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
      console.log(`Poll[${i+1}] ${opId}: ${st}`);
      if (["completed","success","done","finished"].includes(st)) return extractMedia(data);
      if (["failed","error","cancelled"].includes(st)) throw new Error(`Статус: ${st}`);
    } catch(e) { if (e.message.startsWith("Статус")) throw e; }
  }
  return null;
}

// ─── Баланс кредитов ─────────────────────
async function getCredits() {
  try {
    const { data } = await axios.get(`${BASE_URL}/api/v4/`, {
      headers: { "X-API-Key": FASTGEN_API_KEY }, timeout: 10000
    });
    return data;
  } catch(e) { return null; }
}

async function getUsage() {
  try {
    const { data } = await axios.get(`${BASE_URL}/api/v5/usage`, {
      headers: { "X-API-Key": FASTGEN_API_KEY }, timeout: 10000
    });
    return data;
  } catch(e) { return null; }
}

// ─── /start /menu ─────────────────────────
bot.onText(/\/start/, (msg) => { userState[msg.chat.id]=null; showMainMenu(msg.chat.id); });
bot.onText(/\/menu/, (msg) => showMainMenu(msg.chat.id));
bot.onText(/\/balance/, async (msg) => showBalance(msg.chat.id));
bot.onText(/\/history/, (msg) => showHistory(msg.chat.id));
bot.onText(/\/check (.+)/, async (msg, m) => checkOperation(msg.chat.id, m[1].trim()));

// ─── Показать баланс ──────────────────────
async function showBalance(chatId) {
  const msg = await bot.sendMessage(chatId, "⏳ Получаю баланс...");
  const usage = await getUsage();
  if (usage) {
    const imgUsed = usage.images_used ?? "?";
    const imgTotal = usage.images_limit ?? "?";
    const vidUsed = usage.videos_used ?? "?";
    const vidTotal = usage.videos_limit ?? "?";
    const streams = usage.active_threads ?? "?";
    const maxStreams = usage.max_threads ?? "?";
    const resetIn = usage.reset_in_minutes ? `${Math.floor(usage.reset_in_minutes)}м` : "?";
    const resetAt = usage.reset_at ? new Date(usage.reset_at).toLocaleTimeString("ru") : "?";
    const text =
      `📊 *Баланс и лимиты*\n\n` +
      `🖼 Изображения: *${imgUsed}/${imgTotal}* за час\n` +
      `🎬 Видео: *${vidUsed}/${vidTotal}* за час\n` +
      `🔄 Потоки: *${streams}/${maxStreams}* активно\n\n` +
      `⏱ Сброс через: *${resetIn}* (в ${resetAt})\n\n` +
      `*Стоимость моделей:*\n` +
      `🖼 Imagen/NanoPro/NanoBanana Flow: 4 кред\n` +
      `🖼 Grok быстро: 1 кред = 6 фото\n` +
      `🖼 Grok качество: 1 кред = 4 фото\n` +
      `🖼 NanoBanana Flower / ChatGPT: 1 кред\n` +
      `🎬 Veo 3.1 Fast/Light/Flower: 1 кред\n` +
      `🎬 Veo 3.1 Quality: *10 кред* ⚠️\n` +
      `🎬 Grok Video: 1 кред`;
    await bot.editMessageText(text, { chat_id: chatId, message_id: msg.message_id, parse_mode: "Markdown" });
  } else {
    await bot.editMessageText("❌ Не удалось получить баланс", { chat_id: chatId, message_id: msg.message_id });
  }
}

// ─── История ──────────────────────────────
async function showHistory(chatId) {
  const h = getHistory(chatId);
  if (h.length === 0) return bot.sendMessage(chatId, "📭 История пуста.");

  const rows = h.slice(0, 10).map((item, i) => [{
    text: `${item.index} | ${item.model} | ${item.prompt.slice(0, 20)}...`,
    callback_data: `hist_${i}`
  }]);
  rows.push([{ text: "◀️ Назад", callback_data: "back_menu" }]);
  bot.sendMessage(chatId, "📋 *История генераций:*", {
    parse_mode: "Markdown",
    reply_markup: { inline_keyboard: rows }
  });
}

// ─── Главное меню ─────────────────────────
function showMainMenu(chatId) {
  const s = getState(chatId);
  const im = IMAGE_MODELS[s.imgModel];
  const vm = VIDEO_MODELS[s.vidModel];
  bot.sendMessage(chatId,
    `🤖 *FastGen Bot*\n\n` +
    `🖼 Фото: *${im.label}* (${im.credits})\n` +
    `🎬 Видео: *${vm.label}* (${vm.credits})\n` +
    `📐 Соотношение: *${s.ratio}* | 🔢 Кол-во: *${s.count}*\n` +
    `📦 Режим: *${s.mode === "batch" ? "Пакетный" : s.mode === "keyframes" ? "Ключ. кадры" : "Обычный"}*`,
    {
      parse_mode: "Markdown",
      reply_markup: { inline_keyboard: [
        [{ text: "🖼️ Изображение", callback_data: "do_image" }, { text: "🎬 Видео из текста", callback_data: "do_vtext" }],
        [{ text: "📸 Видео из фото", callback_data: "do_vimage" }, { text: "🎞 Ключ. кадры", callback_data: "do_keyframes" }],
        [{ text: "📦 Пакетный режим", callback_data: "do_batch" }],
        [{ text: "🎨 Модель фото", callback_data: "open_imgmodel" }, { text: "🎥 Модель видео", callback_data: "open_vidmodel" }],
        [{ text: "📐 Соотношение", callback_data: "open_ratio" }, { text: "🔢 Кол-во", callback_data: "open_count" }],
        [{ text: "📊 Баланс", callback_data: "show_balance" }, { text: "📋 История", callback_data: "show_history" }],
      ]}
    }
  );
}

// ─── Callbacks ────────────────────────────
bot.on("callback_query", async (query) => {
  const chatId = query.message.chat.id;
  const msgId = query.message.message_id;
  const data = query.data;
  const s = getState(chatId);
  bot.answerCallbackQuery(query.id);

  const del = () => bot.deleteMessage(chatId, msgId).catch(() => {});
  const edit = (text, kb) => bot.editMessageText(text, { chat_id: chatId, message_id: msgId, parse_mode: "Markdown", reply_markup: kb });
  const cancelKb = { inline_keyboard: [[{ text: "❌ Отмена", callback_data: "back_menu" }]] };

  if (data === "back_menu") { del(); return showMainMenu(chatId); }
  if (data === "noop") return;

  // ── Баланс и история
  if (data === "show_balance") { del(); return showBalance(chatId); }
  if (data === "show_history") { del(); return showHistory(chatId); }

  // ── История — просмотр элемента
  if (data.startsWith("hist_")) {
    const idx = parseInt(data.replace("hist_", ""));
    const h = getHistory(chatId);
    const item = h[idx];
    if (!item) return;
    const text = `📋 *${item.index}*\n\n` +
      `Модель: ${item.model}\n📝 ${item.prompt}\n` +
      `${item.opId ? `ID: \`${item.opId}\`` : ""}`;
    return edit(text, { inline_keyboard: [
      item.opId ? [{ text: "🔄 Перегенерировать", callback_data: `regen_${item.opId}_${idx}` }] : [],
      [{ text: "◀️ Назад", callback_data: "show_history" }],
    ].filter(r => r.length > 0) });
  }

  // ── Перегенерация
  if (data.startsWith("regen_")) {
    const parts = data.split("_");
    const opId = parts[1];
    const histIdx = parseInt(parts[2]);
    const h = getHistory(chatId);
    const item = h[histIdx];
    if (!item) return;

    await edit("⏳ Повторная генерация...", { inline_keyboard: [] });
    try {
      // Повторяем тот же запрос
      const { data: apiData } = await axios.post(`${BASE_URL}${item.endpoint}`, item.body, {
        headers: { "X-API-Key": FASTGEN_API_KEY, "Content-Type": "application/json" },
        timeout: 60000,
      });
      const newOpId = apiData.operation_id || apiData.task_id || apiData.id;
      const result = await pollResult(newOpId);
      if (result) {
        await bot.editMessageText(`✅ Перегенерировано: *${item.index}*`, { chat_id: chatId, message_id: msgId, parse_mode: "Markdown" });
        await sendMedia(chatId, result, item.isImage, `🔄 *${item.index}* (перегенерация)\n📝 _${item.prompt.slice(0,100)}_`);
      }
    } catch(e) {
      await bot.editMessageText(`❌ Ошибка перегенерации: ${e.message}`, { chat_id: chatId, message_id: msgId });
    }
    return;
  }

  // ── Режимы генерации
  if (data === "do_image") {
    s.step = "waiting_prompt"; s.tab = "image"; s.mode = "normal";
    return edit(`🖼️ *Изображение*\nМодель: ${IMAGE_MODELS[s.imgModel].label}\n\nНапиши промпт:`, cancelKb);
  }
  if (data === "do_vtext") {
    s.step = "waiting_prompt"; s.tab = "video_text"; s.mode = "normal";
    return edit(`🎬 *Видео из текста*\nМодель: ${VIDEO_MODELS[s.vidModel].label}\n\nОпиши видео:`, cancelKb);
  }
  if (data === "do_vimage") {
    s.step = "waiting_photo"; s.tab = "video_image"; s.mode = "normal";
    return edit("📸 *Видео из фото*\n\nОтправь фото:", cancelKb);
  }
  if (data === "do_keyframes") {
    s.step = "waiting_keyframe_start"; s.tab = "video_text"; s.mode = "keyframes";
    s.keyframeStart = null; s.keyframeEnd = null;
    return edit("🎞 *Ключевые кадры*\n\nОтправь *первое* фото (начало видео):", cancelKb);
  }

  // ── Пакетный режим
  if (data === "do_batch") {
    s.mode = "batch"; s.batchPrompts = []; s.batchPhotos = [];
    return edit(
      `📦 *Пакетный режим*\n\n` +
      `Отправь несколько фото и/или напиши промпты (каждый с новой строки).\n\n` +
      `Сейчас: 0 фото, 0 промптов\n\n` +
      `Когда готов — нажми *Генерировать*`,
      { inline_keyboard: [
        [{ text: "✏️ Добавить промпты текстом", callback_data: "batch_add_text" }],
        [{ text: `🔢 На 1 промпт/фото: ${s.perPrompt} вар.`, callback_data: "batch_per_prompt" }],
        [{ text: "🚀 Генерировать!", callback_data: "batch_run" }],
        [{ text: "❌ Отмена", callback_data: "back_menu" }],
      ]}
    );
  }
  if (data === "batch_add_text") {
    s.step = "waiting_batch_prompts";
    return edit("✏️ Напиши промпты, каждый с новой строки:", cancelKb);
  }
  if (data === "batch_per_prompt") {
    return edit("🔢 Сколько генераций на 1 промпт/фото?", { inline_keyboard: [
      [1,2,3,4,5].map(n => ({ text: s.perPrompt===n?`✅${n}`:`${n}`, callback_data:`set_pp_${n}` })),
      [{ text: "◀️ Назад", callback_data: "do_batch" }],
    ]});
  }
  if (data.startsWith("set_pp_")) { s.perPrompt = parseInt(data.replace("set_pp_","")); return bot.answerCallbackQuery(query.id, { text: `Установлено: ${s.perPrompt}` }); }

  if (data === "batch_run") {
    del();
    return runBatch(chatId);
  }

  // ── Модель изображения
  if (data === "open_imgmodel") {
    const rows = Object.entries(IMAGE_MODELS).map(([k,v]) => [{
      text: `${s.imgModel===k?"✅ ":""}${v.label} (${v.credits})`,
      callback_data: `set_im_${k}`
    }]);
    rows.push([{ text: "◀️ Назад", callback_data: "back_menu" }]);
    return edit("🎨 *Модель изображения:*", { inline_keyboard: rows });
  }
  if (data.startsWith("set_im_")) { s.imgModel = data.replace("set_im_",""); del(); return showMainMenu(chatId); }

  // ── Модель видео
  if (data === "open_vidmodel") {
    const rows = Object.entries(VIDEO_MODELS).map(([k,v]) => [{
      text: `${s.vidModel===k?"✅ ":""}${v.label} (${v.credits})`,
      callback_data: `set_vm_${k}`
    }]);
    rows.push([{ text: "◀️ Назад", callback_data: "back_menu" }]);
    return edit("🎥 *Модель видео:*", { inline_keyboard: rows });
  }
  if (data.startsWith("set_vm_")) { s.vidModel = data.replace("set_vm_",""); del(); return showMainMenu(chatId); }

  // ── Соотношение
  if (data === "open_ratio") {
    const rows = [];
    for (let i=0; i<RATIOS.length; i+=3) rows.push(RATIOS.slice(i,i+3).map(r => ({ text: s.ratio===r?`✅${r}`:r, callback_data:`set_r_${r.replace(":","x")}` })));
    rows.push([{ text: "◀️ Назад", callback_data: "back_menu" }]);
    return edit("📐 *Соотношение сторон:*", { inline_keyboard: rows });
  }
  if (data.startsWith("set_r_")) { s.ratio = data.replace("set_r_","").replace("x",":"); del(); return showMainMenu(chatId); }

  // ── Количество
  if (data === "open_count") {
    const rows = [];
    for (let i=0; i<COUNTS.length; i+=4) rows.push(COUNTS.slice(i,i+4).map(c => ({ text: s.count===c?`✅${c}`:`${c}`, callback_data:`set_c_${c}` })));
    rows.push([{ text: "◀️ Назад", callback_data: "back_menu" }]);
    return edit("🔢 *Количество за раз:*", { inline_keyboard: rows });
  }
  if (data.startsWith("set_c_")) { s.count = parseInt(data.replace("set_c_","")); del(); return showMainMenu(chatId); }
});

// ─── Фото ─────────────────────────────────
bot.on("photo", async (msg) => {
  const chatId = msg.chat.id;
  const s = getState(chatId);
  const fileId = msg.photo[msg.photo.length-1].file_id;

  if (s.mode === "batch") {
    s.batchPhotos.push(fileId);
    return bot.sendMessage(chatId, `✅ Фото добавлено! Всего: ${s.batchPhotos.length} фото, ${s.batchPrompts.length} промптов`, {
      reply_markup: { inline_keyboard: [
        [{ text: "🚀 Генерировать!", callback_data: "batch_run" }],
        [{ text: "❌ Отмена", callback_data: "back_menu" }],
      ]}
    });
  }
  if (s.step === "waiting_keyframe_start") {
    s.keyframeStart = fileId;
    s.step = "waiting_keyframe_end";
    return bot.sendMessage(chatId, "✅ Первый кадр получен!\n\nТеперь отправь *второе* фото (конец видео) или нажми пропустить:", {
      parse_mode: "Markdown",
      reply_markup: { inline_keyboard: [
        [{ text: "⏭ Пропустить (только начало)", callback_data: "kf_skip_end" }],
        [{ text: "❌ Отмена", callback_data: "back_menu" }],
      ]}
    });
  }
  if (s.step === "waiting_keyframe_end") {
    s.keyframeEnd = fileId;
    s.step = "waiting_prompt";
    return bot.sendMessage(chatId, "✅ Оба кадра получены!\n\nТеперь напиши описание видео:", {
      reply_markup: { inline_keyboard: [[{ text: "❌ Отмена", callback_data: "back_menu" }]] }
    });
  }
  if (s.step === "waiting_photo") {
    s.fileId = fileId;
    s.step = "waiting_prompt";
    return bot.sendMessage(chatId, "✅ Фото получено!\n\nНапиши описание:", {
      reply_markup: { inline_keyboard: [[{ text: "❌ Отмена", callback_data: "back_menu" }]] }
    });
  }

  // Прислали фото без контекста
  s.fileId = fileId; s.tab = "video_image"; s.step = "waiting_prompt"; s.mode = "normal";
  bot.sendMessage(chatId, "✅ Фото получено! Буду делать видео.\n\nНапиши описание:", {
    reply_markup: { inline_keyboard: [[{ text: "❌ Отмена", callback_data: "back_menu" }]] }
  });
});

// ─── Callback для ключевых кадров ─────────
bot.on("callback_query", async (query) => {
  if (query.data !== "kf_skip_end") return;
  const chatId = query.message.chat.id;
  const s = getState(chatId);
  bot.answerCallbackQuery(query.id);
  s.step = "waiting_prompt";
  bot.editMessageText("✅ Используется только начальный кадр.\n\nНапиши описание видео:", {
    chat_id: chatId, message_id: query.message.message_id,
    reply_markup: { inline_keyboard: [[{ text: "❌ Отмена", callback_data: "back_menu" }]] }
  });
});

// ─── Текст (промпт или пакетные промпты) ──
bot.on("message", async (msg) => {
  const chatId = msg.chat.id;
  const s = getState(chatId);
  if (!msg.text || msg.text.startsWith("/")) return;

  // Пакетные промпты из текста
  if (s.step === "waiting_batch_prompts") {
    s.step = null;
    const prompts = msg.text.split("\n").map(p => p.trim()).filter(Boolean);
    s.batchPrompts.push(...prompts);
    return bot.sendMessage(chatId, `✅ Добавлено ${prompts.length} промптов! Всего: ${s.batchPrompts.length}`, {
      reply_markup: { inline_keyboard: [
        [{ text: "✏️ Добавить ещё", callback_data: "batch_add_text" }],
        [{ text: `🔢 На 1 промпт: ${s.perPrompt} вар.`, callback_data: "batch_per_prompt" }],
        [{ text: "🚀 Генерировать!", callback_data: "batch_run" }],
        [{ text: "❌ Отмена", callback_data: "back_menu" }],
      ]}
    });
  }

  if (s.step !== "waiting_prompt") return bot.sendMessage(chatId, "Нажми /menu чтобы начать.");

  const prompt = msg.text;
  s.step = null;

  if (s.mode === "keyframes") {
    return runKeyframes(chatId, s, prompt);
  }

  await runNormal(chatId, s, prompt);
});

// ─── Обычная генерация ────────────────────
async function runNormal(chatId, s, prompt) {
  const isImage = s.tab === "image";
  const count = s.count;
  let model, endpoint, isImg = isImage;

  if (isImage) {
    model = IMAGE_MODELS[s.imgModel];
    endpoint = model.ep;
  } else if (s.tab === "video_text") {
    model = VIDEO_MODELS[s.vidModel];
    endpoint = model.epT;
    isImg = false;
  } else {
    model = VIDEO_MODELS[s.vidModel];
    endpoint = model.epI;
    isImg = false;
  }

  const statusMsg = await bot.sendMessage(chatId,
    `⏳ Запускаю ${count} задач...\n🎨 ${model.label}\n💳 ${model.credits}`
  );

  const tasks = Array.from({length: count}, (_,i) => genOne(chatId, s, prompt, endpoint, model, isImg, i+1, count, `${Date.now()}`));
  await bot.editMessageText(`⏳ ${count} задач запущено...`, { chat_id: chatId, message_id: statusMsg.message_id });

  const results = await Promise.allSettled(tasks);
  const ok = results.filter(r => r.status==="fulfilled").length;
  await bot.editMessageText(`✅ Готово! ✓${ok}${count-ok>0?` ✗${count-ok}`:""}`, { chat_id: chatId, message_id: statusMsg.message_id }).catch(()=>{});
  showMainMenu(chatId);
}

// ─── Ключевые кадры ───────────────────────
async function runKeyframes(chatId, s, prompt) {
  const model = VIDEO_MODELS[s.vidModel];
  const statusMsg = await bot.sendMessage(chatId, `⏳ Генерирую видео из ключевых кадров...\n🎥 ${model.label}`);

  try {
    const body = { prompt, aspect_ratio: s.ratio };
    if (s.keyframeStart) {
      const f = await bot.getFile(s.keyframeStart);
      const r = await axios.get(`https://api.telegram.org/file/bot${TELEGRAM_TOKEN}/${f.file_path}`, { responseType: "arraybuffer" });
      body.start_image = `data:image/jpeg;base64,${Buffer.from(r.data).toString("base64")}`;
    }
    if (s.keyframeEnd) {
      const f = await bot.getFile(s.keyframeEnd);
      const r = await axios.get(`https://api.telegram.org/file/bot${TELEGRAM_TOKEN}/${f.file_path}`, { responseType: "arraybuffer" });
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
    await bot.editMessageText(`❌ Ошибка: ${e.message}`, { chat_id: chatId, message_id: statusMsg.message_id });
  }
  showMainMenu(chatId);
}

// ─── Пакетная генерация ───────────────────
async function runBatch(chatId) {
  const s = getState(chatId);
  const isImage = s.tab === "image";
  const model = isImage ? IMAGE_MODELS[s.imgModel] : VIDEO_MODELS[s.vidModel];
  const prompts = s.batchPrompts;
  const photos = s.batchPhotos;
  const perPrompt = s.perPrompt || 1;

  if (prompts.length === 0 && photos.length === 0) {
    return bot.sendMessage(chatId, "❌ Добавь хотя бы один промпт или фото!");
  }

  const tasks = [];

  // Промпты
  for (let pi=0; pi<prompts.length; pi++) {
    const prompt = prompts[pi];
    for (let vi=0; vi<perPrompt; vi++) {
      const idx = `${pi+1}.${vi+1}`;
      const ep = isImage ? model.ep : model.epT;
      tasks.push({ prompt, idx, ep, isImg: isImage, fileId: null });
    }
  }

  // Фото
  for (let fi=0; fi<photos.length; fi++) {
    const fileId = photos[fi];
    for (let vi=0; vi<perPrompt; vi++) {
      const idx = `${prompts.length+fi+1}.${vi+1}`;
      const ep = VIDEO_MODELS[s.vidModel].epI;
      tasks.push({ prompt: "animate", idx, ep, isImg: false, fileId });
    }
  }

  const total = tasks.length;
  const statusMsg = await bot.sendMessage(chatId,
    `📦 *Пакетный режим*\n\n` +
    `Всего задач: ${total}\n` +
    `Модель: ${model.label}\n` +
    `💳 ${model.credits}`,
    { parse_mode: "Markdown" }
  );

  let done = 0, errors = 0;
  // Запускаем группами по 5 (лимит потоков)
  for (let i=0; i<tasks.length; i+=5) {
    const batch = tasks.slice(i, i+5);
    await Promise.allSettled(batch.map(async (task) => {
      try {
        await genOne(chatId, s, task.prompt, task.ep, model, task.isImg, 0, 0, task.idx, task.fileId);
        done++;
      } catch(e) { errors++; }
      await bot.editMessageText(
        `📦 Пакетная генерация\n\n✓ ${done} / ${total}${errors>0?` | ✗ ${errors}`:""}`,
        { chat_id: chatId, message_id: statusMsg.message_id }
      ).catch(()=>{});
    }));
  }

  await bot.editMessageText(`✅ Пакет готов! ✓${done}${errors>0?` ✗${errors}`:""}`, { chat_id: chatId, message_id: statusMsg.message_id }).catch(()=>{});
  s.batchPrompts = []; s.batchPhotos = [];
  showMainMenu(chatId);
}

// ─── Одна задача ──────────────────────────
async function genOne(chatId, s, prompt, endpoint, model, isImage, index, total, batchIdx = null, overrideFileId = null) {
  const label = batchIdx || (total > 1 ? `${index}/${total}` : "");
  const displayIdx = batchIdx || (total > 1 ? index.toString() : "");
  try {
    const body = {
      prompt,
      aspect_ratio: s.ratio,
      ...(model.sub && { model: model.sub }),
      ...(model.model && { model: model.model }),
      ...(model.quality && { quality: model.quality }),
      ...(model.res && { resolution: s.resolution }),
      ...(s.seed === "fixed" && { seed: 42 }),
    };

    const fid = overrideFileId || s.fileId;
    if (fid && (s.tab === "video_image" || overrideFileId)) {
      const f = await bot.getFile(fid);
      const r = await axios.get(`https://api.telegram.org/file/bot${TELEGRAM_TOKEN}/${f.file_path}`, { responseType: "arraybuffer" });
      body.image = `data:image/jpeg;base64,${Buffer.from(r.data).toString("base64")}`;
    }

    const { data } = await axios.post(`${BASE_URL}${endpoint}`, body, {
      headers: { "X-API-Key": FASTGEN_API_KEY, "Content-Type": "application/json", Accept: "application/json" },
      timeout: 60000,
    });

    const opId = data.operation_id || data.task_id || data.id;
    if (!opId) throw new Error("Нет ID задачи");

    const result = await pollResult(opId);
    const idxLabel = displayIdx ? `*${displayIdx}*` : "";
    const caption = `${idxLabel ? idxLabel+"\n" : ""}${model.label}\n📝 _${prompt.slice(0,100)}_`;

    addHistory(chatId, {
      index: displayIdx || label,
      model: model.label,
      prompt,
      opId,
      endpoint,
      body,
      isImage,
    });

    if (result) {
      await sendMedia(chatId, result, isImage, caption);
    } else {
      await bot.sendMessage(chatId,
        `⏰ ${idxLabel} не успело.\nID: \`${opId}\`\n/check ${opId}`,
        {
          parse_mode: "Markdown",
          reply_markup: { inline_keyboard: [[{ text: "🔄 Перегенерировать", callback_data: `regen_${opId}_0` }]] }
        }
      );
    }
  } catch(e) {
    const errMsg = e.response?.data?.detail || e.response?.data?.message || e.message;
    await bot.sendMessage(chatId,
      `❌ ${label ? `[${label}] ` : ""}Ошибка: ${errMsg}`,
      { reply_markup: { inline_keyboard: [[{ text: "🔄 Повторить", callback_data: `retry_${label}` }]] } }
    );
    throw e;
  }
}

// ─── /check ───────────────────────────────
async function checkOperation(chatId, opId) {
  const msg = await bot.sendMessage(chatId, `🔍 Проверяю \`${opId}\`...`, { parse_mode: "Markdown" });
  try {
    const { data } = await axios.get(`${BASE_URL}/api/v4/operations/${opId}`, {
      headers: { "X-API-Key": FASTGEN_API_KEY }, timeout: 15000
    });
    const st = data.status || data.state;
    await bot.editMessageText(`Статус: *${st}*`, { chat_id: chatId, message_id: msg.message_id, parse_mode: "Markdown" });
    if (["completed","success","done","finished"].includes(st)) {
      const media = extractMedia(data);
      if (media) await sendMedia(chatId, media, data.media_type === "image", "✅ Результат");
    }
  } catch(e) {
    await bot.editMessageText(`❌ ${e.message}`, { chat_id: chatId, message_id: msg.message_id });
  }
}

console.log("🤖 Бот запущен!");
