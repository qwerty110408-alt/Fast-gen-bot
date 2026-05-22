const TelegramBot = require("node-telegram-bot-api");
const axios = require("axios");

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const FASTGEN_API_KEY = process.env.FASTGEN_API_KEY;
const BASE_URL = "https://googler.fast-gen.ai";

const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });
const userState = {};

const MODELS = {
  "flower_img":  { label: "🌸 Flower Image",    type: "image",       endpoint: "/api/v4/flower/image/generate" },
  "flow_img":    { label: "⚡ Flow Image",       type: "image",       endpoint: "/api/v4/flow/image/generate" },
  "grok_img":    { label: "🤖 Grok Image",       type: "image",       endpoint: "/api/v4/grok/image/generate" },
  "openai_img":  { label: "🧠 OpenAI Image",     type: "image",       endpoint: "/api/v4/openai/image/generate" },
  "flower_vt":   { label: "🌸 Flower Video",     type: "video_text",  endpoint: "/api/v4/flower/video/from-text" },
  "flow_vt":     { label: "⚡ Flow Video",       type: "video_text",  endpoint: "/api/v4/flow/video/from-text" },
  "grok_vt":     { label: "🤖 Grok Video",       type: "video_text",  endpoint: "/api/v4/grok/video/from-text" },
  "flower_vi":   { label: "🌸 Flower Vid+Фото",  type: "video_image", endpoint: "/api/v4/flower/video/from-image" },
  "flow_vi":     { label: "⚡ Flow Vid+Фото",    type: "video_image", endpoint: "/api/v4/flow/video/from-image" },
  "grok_vi":     { label: "🤖 Grok Vid+Фото",    type: "video_image", endpoint: "/api/v4/grok/video/from-image" },
};

const RESOLUTIONS = ["512x512", "768x768", "1024x1024", "1280x720", "1920x1080", "1024x1536", "1536x1024"];
const COUNTS = [1, 2, 3, 4, 5, 6, 8, 10];

function getState(chatId) {
  if (!userState[chatId]) {
    userState[chatId] = { step: null, model: "flower_vi", resolution: "1024x1024", count: 1, fileId: null };
  }
  return userState[chatId];
}

// ─── /start ───────────────────────────────
bot.onText(/\/start/, (msg) => { userState[msg.chat.id] = null; showMainMenu(msg.chat.id); });
bot.onText(/\/menu/, (msg) => showMainMenu(msg.chat.id));

// ─── /check <id> — проверить статус задачи вручную ───────
bot.onText(/\/check (.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const opId = match[1].trim();
  const statusMsg = await bot.sendMessage(chatId, `🔍 Проверяю ID: \`${opId}\`...`, { parse_mode: "Markdown" });

  // Пробуем все возможные эндпоинты
  const endpoints = [
    `/api/v4/operations/${opId}`,
    `/api/v5/operations/${opId}`,
    `/api/v4/task/${opId}`,
    `/api/v5/generations/${opId}`,
  ];

  let found = false;
  for (const ep of endpoints) {
    try {
      const { data } = await axios.get(`${BASE_URL}${ep}`, {
        headers: { "X-API-Key": FASTGEN_API_KEY },
        timeout: 10000,
      });
      const text = `✅ Эндпоинт: \`${ep}\`\n\n\`\`\`json\n${JSON.stringify(data, null, 2).slice(0, 800)}\n\`\`\``;
      await bot.editMessageText(text, { chat_id: chatId, message_id: statusMsg.message_id, parse_mode: "Markdown" });

      // Если есть ссылка — отправляем
      const url = data.video_url || data.image_url || data.url || data.output ||
                  data.result?.url || data.result?.video_url || data.result?.image_url ||
                  data.data?.url || data.data?.video_url;
      if (url) {
        await bot.sendMessage(chatId, `🎬 Найдена ссылка: ${url}`);
        try { await bot.sendVideo(chatId, url); } catch {
          try { await bot.sendPhoto(chatId, url); } catch {
            await bot.sendMessage(chatId, `Ссылка: ${url}`);
          }
        }
      }
      found = true;
      break;
    } catch (e) {
      const code = e.response?.status;
      if (code !== 404) {
        await bot.editMessageText(
          `❌ Эндпоинт \`${ep}\`: ${code || e.message}\n\`\`\`\n${JSON.stringify(e.response?.data || {}).slice(0, 300)}\n\`\`\``,
          { chat_id: chatId, message_id: statusMsg.message_id, parse_mode: "Markdown" }
        );
      }
    }
  }

  if (!found) {
    await bot.editMessageText(`❌ Ни один эндпоинт не ответил для ID: \`${opId}\``, {
      chat_id: chatId, message_id: statusMsg.message_id, parse_mode: "Markdown"
    });
  }
});

// ─── Главное меню ─────────────────────────
function showMainMenu(chatId) {
  const state = getState(chatId);
  const m = MODELS[state.model];
  bot.sendMessage(chatId,
    `🤖 *FastGen Bot*\n\nМодель: *${m.label}*\nРазрешение: *${state.resolution}*\nКоличество: *${state.count}*\n\nВыбери действие:`,
    {
      parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: [
          [{ text: "🖼️ Изображение из текста", callback_data: "do_image" }],
          [{ text: "📝 Видео из текста", callback_data: "do_video_text" }, { text: "🎬 Видео из фото", callback_data: "do_video_image" }],
          [{ text: "⚙️ Модель", callback_data: "open_model" }, { text: "📐 Разрешение", callback_data: "open_resolution" }],
          [{ text: "🔢 Количество", callback_data: "open_count" }],
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
  const state = getState(chatId);
  bot.answerCallbackQuery(query.id);

  if (data === "back_menu") { bot.deleteMessage(chatId, msgId).catch(() => {}); return showMainMenu(chatId); }
  if (data === "noop") return;

  if (data === "do_image") {
    if (MODELS[state.model].type !== "image") state.model = "flower_img";
    state.step = "waiting_prompt";
    return bot.editMessageText("🖼️ *Генерация изображения*\n\nНапиши промпт:", {
      chat_id: chatId, message_id: msgId, parse_mode: "Markdown",
      reply_markup: { inline_keyboard: [[{ text: "❌ Отмена", callback_data: "back_menu" }]] }
    });
  }

  if (data === "do_video_text") {
    if (MODELS[state.model].type !== "video_text") state.model = "flower_vt";
    state.step = "waiting_prompt";
    return bot.editMessageText("📝 *Видео из текста*\n\nНапиши описание:", {
      chat_id: chatId, message_id: msgId, parse_mode: "Markdown",
      reply_markup: { inline_keyboard: [[{ text: "❌ Отмена", callback_data: "back_menu" }]] }
    });
  }

  if (data === "do_video_image") {
    if (MODELS[state.model].type !== "video_image") state.model = "flower_vi";
    state.step = "waiting_photo";
    return bot.editMessageText("🎬 *Видео из фото*\n\nОтправь фото:", {
      chat_id: chatId, message_id: msgId, parse_mode: "Markdown",
      reply_markup: { inline_keyboard: [[{ text: "❌ Отмена", callback_data: "back_menu" }]] }
    });
  }

  if (data === "open_model") {
    const groups = [
      { label: "── Изображения ──", keys: ["flower_img", "flow_img", "grok_img", "openai_img"] },
      { label: "── Видео из текста ──", keys: ["flower_vt", "flow_vt", "grok_vt"] },
      { label: "── Видео из фото ──", keys: ["flower_vi", "flow_vi", "grok_vi"] },
    ];
    const rows = [];
    for (const g of groups) {
      rows.push([{ text: g.label, callback_data: "noop" }]);
      const btns = g.keys.map(k => ({ text: state.model === k ? `✅ ${MODELS[k].label}` : MODELS[k].label, callback_data: `set_model_${k}` }));
      for (let i = 0; i < btns.length; i += 2) rows.push(btns.slice(i, i + 2));
    }
    rows.push([{ text: "◀️ Назад", callback_data: "back_menu" }]);
    return bot.editMessageText("🎨 Выбери модель:", { chat_id: chatId, message_id: msgId, reply_markup: { inline_keyboard: rows } });
  }

  if (data.startsWith("set_model_")) { state.model = data.replace("set_model_", ""); bot.deleteMessage(chatId, msgId).catch(() => {}); return showMainMenu(chatId); }

  if (data === "open_resolution") {
    const rows = [];
    for (let i = 0; i < RESOLUTIONS.length; i += 2) {
      rows.push(RESOLUTIONS.slice(i, i + 2).map(r => ({ text: state.resolution === r ? `✅ ${r}` : r, callback_data: `set_res_${r}` })));
    }
    rows.push([{ text: "◀️ Назад", callback_data: "back_menu" }]);
    return bot.editMessageText("📐 Выбери разрешение:", { chat_id: chatId, message_id: msgId, reply_markup: { inline_keyboard: rows } });
  }

  if (data.startsWith("set_res_")) { state.resolution = data.replace("set_res_", ""); bot.deleteMessage(chatId, msgId).catch(() => {}); return showMainMenu(chatId); }

  if (data === "open_count") {
    const rows = [];
    for (let i = 0; i < COUNTS.length; i += 4) {
      rows.push(COUNTS.slice(i, i + 4).map(c => ({ text: state.count === c ? `✅ ${c}` : `${c}`, callback_data: `set_count_${c}` })));
    }
    rows.push([{ text: "◀️ Назад", callback_data: "back_menu" }]);
    return bot.editMessageText("🔢 Сколько генерировать?", { chat_id: chatId, message_id: msgId, reply_markup: { inline_keyboard: rows } });
  }

  if (data.startsWith("set_count_")) { state.count = parseInt(data.replace("set_count_", "")); bot.deleteMessage(chatId, msgId).catch(() => {}); return showMainMenu(chatId); }
});

// ─── Фото ─────────────────────────────────
bot.on("photo", async (msg) => {
  const chatId = msg.chat.id;
  const state = getState(chatId);
  state.fileId = msg.photo[msg.photo.length - 1].file_id;
  if (state.step === "waiting_photo") {
    state.step = "waiting_prompt";
    bot.sendMessage(chatId, "✅ Фото получено!\n\nНапиши описание:", {
      reply_markup: { inline_keyboard: [[{ text: "❌ Отмена", callback_data: "back_menu" }]] }
    });
  } else {
    state.model = "flower_vi";
    state.step = "waiting_prompt";
    bot.sendMessage(chatId, "✅ Фото получено! Буду делать видео.\n\nНапиши описание:", {
      reply_markup: { inline_keyboard: [[{ text: "❌ Отмена", callback_data: "back_menu" }]] }
    });
  }
});

// ─── Текст/промпт ────────────────────────
bot.on("message", async (msg) => {
  const chatId = msg.chat.id;
  const state = getState(chatId);
  if (!msg.text || msg.text.startsWith("/")) return;
  if (state.step !== "waiting_prompt") return bot.sendMessage(chatId, "Нажми /menu чтобы начать.");

  const prompt = msg.text;
  state.step = null;
  const modelInfo = MODELS[state.model];
  const count = state.count;

  const statusMsg = await bot.sendMessage(chatId,
    `⏳ Запускаю ${count} задач...\n🎨 ${modelInfo.label}\n📐 ${state.resolution}`
  );

  const tasks = Array.from({ length: count }, (_, i) => generateOne(chatId, state, prompt, modelInfo, i + 1, count));
  await bot.editMessageText(`⏳ ${count} задач запущено. Жди...`, { chat_id: chatId, message_id: statusMsg.message_id });

  const results = await Promise.allSettled(tasks);
  const ok = results.filter(r => r.status === "fulfilled").length;
  const fail = count - ok;
  await bot.editMessageText(`✅ Готово! Успешно: ${ok}${fail > 0 ? ` | ❌ Ошибок: ${fail}` : ""}`, {
    chat_id: chatId, message_id: statusMsg.message_id
  }).catch(() => {});

  showMainMenu(chatId);
});

// ─── Генерация ────────────────────────────
async function generateOne(chatId, state, prompt, modelInfo, index, total) {
  const label = total > 1 ? ` (${index}/${total})` : "";
  try {
    let body = { prompt, resolution: state.resolution };
    if (modelInfo.type === "video_image") {
      const f = await bot.getFile(state.fileId);
      const imgResp = await axios.get(`https://api.telegram.org/file/bot${TELEGRAM_TOKEN}/${f.file_path}`, { responseType: "arraybuffer" });
      body.image = `data:image/jpeg;base64,${Buffer.from(imgResp.data).toString("base64")}`;
    }

    const { data } = await axios.post(`${BASE_URL}${modelInfo.endpoint}`, body, {
      headers: { "X-API-Key": FASTGEN_API_KEY, "Content-Type": "application/json", Accept: "application/json" },
      timeout: 60000,
    });

    console.log(`[${index}] API:`, JSON.stringify(data));
    const opId = data.operation_id || data.task_id || data.id;
    if (!opId) throw new Error("Нет ID задачи");

    const output = await pollResult(opId, chatId, index);

    if (output) {
      const caption = `${modelInfo.label}${label}\n📝 _${prompt.slice(0, 100)}_`;
      if (modelInfo.type === "image") {
        await bot.sendPhoto(chatId, output, { caption, parse_mode: "Markdown" }).catch(async () => {
          await bot.sendMessage(chatId, `🖼️ Готово${label}! Ссылка: ${output}`);
        });
      } else {
        await bot.sendVideo(chatId, output, { caption, parse_mode: "Markdown" }).catch(async () => {
          await bot.sendMessage(chatId, `🎬 Готово${label}! Ссылка: ${output}`);
        });
      }
    } else {
      await bot.sendMessage(chatId, `⏰ Задача${label} не успела.\nID: \`${opId}\`\nНапиши: /check ${opId}`, { parse_mode: "Markdown" });
    }
  } catch (e) {
    const errMsg = e.response?.data?.detail || e.response?.data?.message || e.message;
    await bot.sendMessage(chatId, `❌ Задача${label}: ${errMsg}`);
    throw e;
  }
}

// ─── Поллинг ──────────────────────────────
async function pollResult(opId, chatId, index, maxAttempts = 36, interval = 10000) {
  const endpoints = [
    `/api/v4/operations/${opId}`,
    `/api/v5/operations/${opId}`,
    `/api/v5/generations/${opId}`,
  ];

  for (let i = 0; i < maxAttempts; i++) {
    await new Promise(r => setTimeout(r, interval));
    for (const ep of endpoints) {
      try {
        const { data } = await axios.get(`${BASE_URL}${ep}`, {
          headers: { "X-API-Key": FASTGEN_API_KEY }, timeout: 10000
        });
        const status = data.status || data.state;
        console.log(`[${index}] Poll[${i+1}] ${ep}: ${status} | ${JSON.stringify(data).slice(0, 150)}`);

        if (["completed", "success", "done", "finished"].includes(status)) {
          return data.video_url || data.image_url || data.url || data.output ||
                 data.result?.url || data.result?.video_url || data.result?.image_url ||
                 data.data?.url || data.data?.video_url || data.data?.image_url;
        }
        if (["failed", "error", "cancelled"].includes(status)) throw new Error(`Статус: ${status}`);
        break;
      } catch (e) {
        if (e.response?.status !== 404) console.log(`Poll err ${ep}:`, e.message);
      }
    }
  }
  return null;
}

console.log("🤖 Бот запущен!");
