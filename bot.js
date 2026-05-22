const TelegramBot = require("node-telegram-bot-api");
const axios = require("axios");
const fs = require("fs");

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const FASTGEN_API_KEY = process.env.FASTGEN_API_KEY;
const BASE_URL = "https://googler.fast-gen.ai";

const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });
const userState = {};

// ─── Все модели с сайта ───────────────────
const IMAGE_MODELS = {
  "imagen4_flow":    { label: "🖼 Imagen 4 - Flow",         endpoint: "/api/v4/flow/image/generate",    ratio: true },
  "nanobpro_flow":   { label: "🍌 Nano Banana Pro - Flow",  endpoint: "/api/v4/flow/image/generate",    ratio: true, model: "nano-banana-pro" },
  "nanob2_flow":     { label: "🍌 Nano Banana 2 - Flow",    endpoint: "/api/v4/flow/image/generate",    ratio: true, model: "nano-banana-2" },
  "grok_img":        { label: "🤖 Grok",                    endpoint: "/api/v4/grok/image/generate",    ratio: true },
  "nanob2_flower":   { label: "🌸 Nano Banana 2 - Flower",  endpoint: "/api/v4/flower/image/generate",  ratio: true },
  "chatgpt_img":     { label: "🧠 ChatGPT Images 2.0",      endpoint: "/api/v4/openai/image/generate",  ratio: true },
};

const VIDEO_MODELS = {
  "veo31_fast":      { label: "⚡ Veo 3.1 Fast",            endpoint: "/api/v4/flow/video/from-text",   submodel: "veo-3.1-fast",    fromImage: "/api/v4/flow/video/from-image" },
  "veo31_light":     { label: "💡 Veo 3.1 Light",           endpoint: "/api/v4/flow/video/from-text",   submodel: "veo-3.1-light",   fromImage: "/api/v4/flow/video/from-image" },
  "veo31_quality":   { label: "✨ Veo 3.1 Quality (10x)",   endpoint: "/api/v4/flow/video/from-text",   submodel: "veo-3.1-quality", fromImage: "/api/v4/flow/video/from-image" },
  "grok_vid":        { label: "🤖 Grok Video",              endpoint: "/api/v4/grok/video/from-text",   fromImage: "/api/v4/grok/video/from-image",   res: true },
  "veo31_flower":    { label: "🌸 Veo 3.1 Flower",          endpoint: "/api/v4/flower/video/from-text", fromImage: "/api/v4/flower/video/from-image" },
};

const RATIOS = ["16:9", "9:16", "1:1", "4:3", "3:4", "3:2", "2:3"];
const COUNTS = [1, 2, 3, 4, 5, 6, 8, 10];

function getState(chatId) {
  if (!userState[chatId]) {
    userState[chatId] = {
      step: null,
      mode: "image",           // image | video_text | video_image
      imageModel: "imagen4_flow",
      videoModel: "veo31_fast",
      ratio: "16:9",
      resolution: "720p",
      count: 1,
      seed: "random",
      fileId: null,
    };
  }
  return userState[chatId];
}

// ─── Извлечь медиа из ответа API ──────────
function extractMedia(data) {
  if (Array.isArray(data.result) && data.result.length > 0) {
    return { base64: data.result[0], type: data.media_type || "video" };
  }
  if (typeof data.result === "string" && data.result.startsWith("data:")) {
    return { base64: data.result, type: data.media_type || "video" };
  }
  const url = data.video_url || data.image_url || data.url || data.output || data.result?.url;
  if (url) return { url, type: data.media_type || "video" };
  return null;
}

// ─── Отправить base64 файл ────────────────
async function sendBase64Media(chatId, base64str, mediaType, caption) {
  let b64 = base64str;
  let ext = mediaType === "image" ? "jpg" : "mp4";
  if (base64str.includes(";base64,")) {
    const parts = base64str.split(";base64,");
    b64 = parts[1];
    const mime = parts[0].replace("data:", "");
    if (mime.includes("png")) ext = "png";
    else if (mime.includes("webp")) ext = "webp";
    else if (mime.includes("gif")) ext = "gif";
  }
  const tmpPath = `/tmp/fg_${Date.now()}_${Math.random().toString(36).slice(2)}.${ext}`;
  fs.writeFileSync(tmpPath, Buffer.from(b64, "base64"));
  try {
    if (["jpg","png","webp"].includes(ext)) {
      await bot.sendPhoto(chatId, fs.createReadStream(tmpPath), { caption, parse_mode: "Markdown" });
    } else {
      await bot.sendVideo(chatId, fs.createReadStream(tmpPath), { caption, parse_mode: "Markdown" });
    }
  } finally {
    try { fs.unlinkSync(tmpPath); } catch {}
  }
}

// ─── /start /menu ─────────────────────────
bot.onText(/\/start/, (msg) => { userState[msg.chat.id] = null; showMainMenu(msg.chat.id); });
bot.onText(/\/menu/, (msg) => showMainMenu(msg.chat.id));

// ─── Главное меню ─────────────────────────
function showMainMenu(chatId) {
  const s = getState(chatId);
  const imgM = IMAGE_MODELS[s.imageModel];
  const vidM = VIDEO_MODELS[s.videoModel];
  bot.sendMessage(chatId,
    `🤖 *FastGen Bot*\n\n` +
    `🖼 Изображение: *${imgM.label}*\n` +
    `🎬 Видео: *${vidM.label}*\n` +
    `📐 Соотношение: *${s.ratio}*  🔢 Кол-во: *${s.count}*\n\n` +
    `Выбери что создать:`,
    {
      parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: [
          [{ text: "🖼️ Изображение из текста", callback_data: "do_image" }],
          [{ text: "📝 Видео из текста", callback_data: "do_vtext" }, { text: "🎬 Видео из фото", callback_data: "do_vimage" }],
          [{ text: "🎨 Модель фото", callback_data: "open_imgmodel" }, { text: "🎥 Модель видео", callback_data: "open_vidmodel" }],
          [{ text: "📐 Соотношение сторон", callback_data: "open_ratio" }],
          [{ text: "🔢 Количество", callback_data: "open_count" }, { text: "🌱 Seed", callback_data: "open_seed" }],
        ],
      },
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
  const cancelBtn = { inline_keyboard: [[{ text: "❌ Отмена", callback_data: "back_menu" }]] };

  if (data === "back_menu") { del(); return showMainMenu(chatId); }
  if (data === "noop") return;

  // ── Режимы
  if (data === "do_image") {
    s.step = "waiting_prompt"; s.mode = "image";
    return edit("🖼️ *Изображение из текста*\n\nНапиши промпт:", cancelBtn);
  }
  if (data === "do_vtext") {
    s.step = "waiting_prompt"; s.mode = "video_text";
    return edit("📝 *Видео из текста*\n\nОпиши видео:", cancelBtn);
  }
  if (data === "do_vimage") {
    s.step = "waiting_photo"; s.mode = "video_image";
    return edit("🎬 *Видео из фото*\n\nОтправь фото:", cancelBtn);
  }

  // ── Модель изображения
  if (data === "open_imgmodel") {
    const rows = Object.entries(IMAGE_MODELS).map(([k, v]) => [{
      text: s.imageModel === k ? `✅ ${v.label}` : v.label,
      callback_data: `set_imgm_${k}`
    }]);
    rows.push([{ text: "◀️ Назад", callback_data: "back_menu" }]);
    return edit("🎨 *Модель изображения:*", { inline_keyboard: rows });
  }
  if (data.startsWith("set_imgm_")) { s.imageModel = data.replace("set_imgm_", ""); del(); return showMainMenu(chatId); }

  // ── Модель видео
  if (data === "open_vidmodel") {
    const rows = Object.entries(VIDEO_MODELS).map(([k, v]) => [{
      text: s.videoModel === k ? `✅ ${v.label}` : v.label,
      callback_data: `set_vidm_${k}`
    }]);
    rows.push([{ text: "◀️ Назад", callback_data: "back_menu" }]);
    return edit("🎥 *Модель видео:*", { inline_keyboard: rows });
  }
  if (data.startsWith("set_vidm_")) { s.videoModel = data.replace("set_vidm_", ""); del(); return showMainMenu(chatId); }

  // ── Соотношение сторон
  if (data === "open_ratio") {
    const rows = [];
    for (let i = 0; i < RATIOS.length; i += 3) {
      rows.push(RATIOS.slice(i, i + 3).map(r => ({
        text: s.ratio === r ? `✅ ${r}` : r, callback_data: `set_ratio_${r.replace(":", "x")}`
      })));
    }
    rows.push([{ text: "◀️ Назад", callback_data: "back_menu" }]);
    return edit("📐 *Соотношение сторон:*", { inline_keyboard: rows });
  }
  if (data.startsWith("set_ratio_")) { s.ratio = data.replace("set_ratio_", "").replace("x", ":"); del(); return showMainMenu(chatId); }

  // ── Количество
  if (data === "open_count") {
    const rows = [];
    for (let i = 0; i < COUNTS.length; i += 4) {
      rows.push(COUNTS.slice(i, i + 4).map(c => ({
        text: s.count === c ? `✅ ${c}` : `${c}`, callback_data: `set_count_${c}`
      })));
    }
    rows.push([{ text: "◀️ Назад", callback_data: "back_menu" }]);
    return edit("🔢 *Количество за раз:*", { inline_keyboard: rows });
  }
  if (data.startsWith("set_count_")) { s.count = parseInt(data.replace("set_count_", "")); del(); return showMainMenu(chatId); }

  // ── Seed
  if (data === "open_seed") {
    return edit("🌱 *Seed:*", {
      inline_keyboard: [
        [
          { text: s.seed === "random" ? "✅ Случайный" : "Случайный", callback_data: "set_seed_random" },
          { text: s.seed === "fixed" ? "✅ Фиксированный" : "Фиксированный", callback_data: "set_seed_fixed" },
        ],
        [{ text: "◀️ Назад", callback_data: "back_menu" }],
      ]
    });
  }
  if (data === "set_seed_random") { s.seed = "random"; del(); return showMainMenu(chatId); }
  if (data === "set_seed_fixed") { s.seed = "fixed"; del(); return showMainMenu(chatId); }
});

// ─── Фото ─────────────────────────────────
bot.on("photo", async (msg) => {
  const chatId = msg.chat.id;
  const s = getState(chatId);
  s.fileId = msg.photo[msg.photo.length - 1].file_id;
  s.mode = "video_image";
  s.step = "waiting_prompt";
  bot.sendMessage(chatId, "✅ Фото получено!\n\nТеперь напиши описание движения:", {
    reply_markup: { inline_keyboard: [[{ text: "❌ Отмена", callback_data: "back_menu" }]] }
  });
});

// ─── Промпт ───────────────────────────────
bot.on("message", async (msg) => {
  const chatId = msg.chat.id;
  const s = getState(chatId);
  if (!msg.text || msg.text.startsWith("/")) return;
  if (s.step !== "waiting_prompt") return bot.sendMessage(chatId, "Нажми /menu чтобы начать.");

  const prompt = msg.text;
  s.step = null;
  const count = s.count;

  // Определяем модель и эндпоинт
  let modelInfo, endpoint, isImage;
  if (s.mode === "image") {
    modelInfo = IMAGE_MODELS[s.imageModel];
    endpoint = modelInfo.endpoint;
    isImage = true;
  } else if (s.mode === "video_text") {
    modelInfo = VIDEO_MODELS[s.videoModel];
    endpoint = modelInfo.endpoint;
    isImage = false;
  } else {
    modelInfo = VIDEO_MODELS[s.videoModel];
    endpoint = modelInfo.fromImage;
    isImage = false;
  }

  const statusMsg = await bot.sendMessage(chatId,
    `⏳ Запускаю ${count} задач...\n${modelInfo.label}\n📐 ${s.ratio}`
  );

  const tasks = Array.from({ length: count }, (_, i) =>
    generateOne(chatId, s, prompt, endpoint, modelInfo, isImage, i + 1, count)
  );
  await bot.editMessageText(`⏳ ${count} задач запущено. Ожидай...`, { chat_id: chatId, message_id: statusMsg.message_id });

  const results = await Promise.allSettled(tasks);
  const ok = results.filter(r => r.status === "fulfilled").length;
  const fail = count - ok;
  await bot.editMessageText(
    `✅ Готово! Успешно: ${ok}${fail > 0 ? ` | ❌ Ошибок: ${fail}` : ""}`,
    { chat_id: chatId, message_id: statusMsg.message_id }
  ).catch(() => {});

  showMainMenu(chatId);
});

// ─── Генерация ────────────────────────────
async function generateOne(chatId, s, prompt, endpoint, modelInfo, isImage, index, total) {
  const label = total > 1 ? ` (${index}/${total})` : "";
  try {
    const body = {
      prompt,
      aspect_ratio: s.ratio,
      ...(modelInfo.submodel && { model: modelInfo.submodel }),
      ...(modelInfo.model && { model: modelInfo.model }),
      ...(s.seed === "fixed" && { seed: 42 }),
    };

    if (s.mode === "video_image" && s.fileId) {
      const f = await bot.getFile(s.fileId);
      const imgResp = await axios.get(`https://api.telegram.org/file/bot${TELEGRAM_TOKEN}/${f.file_path}`, { responseType: "arraybuffer" });
      body.image = `data:image/jpeg;base64,${Buffer.from(imgResp.data).toString("base64")}`;
    }

    if (modelInfo.res) body.resolution = s.resolution || "720p";

    const { data } = await axios.post(`${BASE_URL}${endpoint}`, body, {
      headers: { "X-API-Key": FASTGEN_API_KEY, "Content-Type": "application/json", Accept: "application/json" },
      timeout: 60000,
    });

    const opId = data.operation_id || data.task_id || data.id;
    if (!opId) throw new Error("Нет ID задачи");

    const result = await pollResult(opId);
    const caption = `${modelInfo.label}${label}\n📝 _${prompt.slice(0, 100)}_`;

    if (result) {
      if (result.base64) {
        await sendBase64Media(chatId, result.base64, isImage ? "image" : "video", caption);
      } else if (result.url) {
        if (isImage) await bot.sendPhoto(chatId, result.url, { caption, parse_mode: "Markdown" });
        else await bot.sendVideo(chatId, result.url, { caption, parse_mode: "Markdown" });
      }
    } else {
      await bot.sendMessage(chatId, `⏰ Задача${label} не успела.\nID: \`${opId}\`\n/check ${opId}`, { parse_mode: "Markdown" });
    }
  } catch (e) {
    const errMsg = e.response?.data?.detail || e.response?.data?.message || e.message;
    await bot.sendMessage(chatId, `❌ Задача${label}: ${errMsg}`);
    throw e;
  }
}

// ─── Поллинг ──────────────────────────────
async function pollResult(opId, maxAttempts = 36, interval = 10000) {
  for (let i = 0; i < maxAttempts; i++) {
    await new Promise(r => setTimeout(r, interval));
    try {
      const { data } = await axios.get(`${BASE_URL}/api/v4/operations/${opId}`, {
        headers: { "X-API-Key": FASTGEN_API_KEY }, timeout: 10000
      });
      const status = data.status || data.state;
      console.log(`Poll[${i+1}] ${opId}: ${status}`);
      if (["completed", "success", "done", "finished"].includes(status)) return extractMedia(data);
      if (["failed", "error", "cancelled"].includes(status)) throw new Error(`Статус: ${status}`);
    } catch (e) {
      if (!e.message.includes("Статус")) console.log(`Poll err:`, e.message);
      else throw e;
    }
  }
  return null;
}

// ─── /check <id> ──────────────────────────
bot.onText(/\/check (.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const opId = match[1].trim();
  const statusMsg = await bot.sendMessage(chatId, `🔍 Проверяю \`${opId}\`...`, { parse_mode: "Markdown" });
  try {
    const { data } = await axios.get(`${BASE_URL}/api/v4/operations/${opId}`, {
      headers: { "X-API-Key": FASTGEN_API_KEY }, timeout: 15000
    });
    const status = data.status || data.state;
    await bot.editMessageText(`Статус: *${status}*`, { chat_id: chatId, message_id: statusMsg.message_id, parse_mode: "Markdown" });
    if (["completed", "success", "done", "finished"].includes(status)) {
      const media = extractMedia(data);
      if (media?.base64) await sendBase64Media(chatId, media.base64, media.type, "✅ Результат");
      else if (media?.url) await bot.sendMessage(chatId, media.url);
    }
  } catch (e) {
    await bot.editMessageText(`❌ ${e.message}`, { chat_id: chatId, message_id: statusMsg.message_id });
  }
});

console.log("🤖 Бот запущен!");
