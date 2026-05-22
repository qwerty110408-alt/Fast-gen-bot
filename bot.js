const TelegramBot = require("node-telegram-bot-api");
const axios = require("axios");

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const FASTGEN_API_KEY = process.env.FASTGEN_API_KEY;
const BASE_URL = "https://googler.fast-gen.ai";

const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });

// Состояние пользователей
const userState = {};

// Настройки по умолчанию
const defaultSettings = {
  mode: null,         // image | video_from_image | video_from_text | animation
  model: "flower",    // flower | flow
  quality: "standard",
  resolution: "1024x1024",
  count: 1,
  step: null,         // choosing_mode | waiting_photo | waiting_prompt
  fileId: null,
};

function getState(chatId) {
  if (!userState[chatId]) {
    userState[chatId] = { ...defaultSettings };
  }
  return userState[chatId];
}

// ─── /start ───────────────────────────────────────────────
bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;
  userState[chatId] = { ...defaultSettings };
  showMainMenu(chatId);
});

bot.onText(/\/menu/, (msg) => showMainMenu(msg.chat.id));

function showMainMenu(chatId) {
  const state = getState(chatId);
  bot.sendMessage(chatId,
    `🤖 *FastGen Bot*\n\nВыбери что хочешь создать:`,
    {
      parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: [
          [
            { text: "🖼️ Изображение", callback_data: "mode_image" },
            { text: "🎬 Видео из фото", callback_data: "mode_video_from_image" },
          ],
          [
            { text: "📝 Видео из текста", callback_data: "mode_video_from_text" },
            { text: "✨ Анимация", callback_data: "mode_animation" },
          ],
          [
            { text: "⚙️ Настройки", callback_data: "open_settings" },
          ],
        ],
      },
    }
  );
}

function showSettings(chatId, msgId = null) {
  const state = getState(chatId);
  const text =
    `⚙️ *Настройки*\n\n` +
    `🎨 Модель: *${state.model === "flower" ? "Flower (качественная)" : "Flow (быстрая)"}*\n` +
    `📐 Разрешение: *${state.resolution}*\n` +
    `✨ Качество: *${state.quality}*\n` +
    `🔢 Количество: *${state.count}*`;

  const keyboard = {
    inline_keyboard: [
      [
        { text: state.model === "flower" ? "✅ Flower" : "Flower", callback_data: "set_model_flower" },
        { text: state.model === "flow" ? "✅ Flow" : "Flow", callback_data: "set_model_flow" },
      ],
      [
        { text: "📐 Разрешение", callback_data: "open_resolution" },
        { text: "✨ Качество", callback_data: "open_quality" },
      ],
      [
        { text: "🔢 Количество", callback_data: "open_count" },
      ],
      [
        { text: "◀️ Назад", callback_data: "back_to_menu" },
      ],
    ],
  };

  if (msgId) {
    bot.editMessageText(text, { chat_id: chatId, message_id: msgId, parse_mode: "Markdown", reply_markup: keyboard });
  } else {
    bot.sendMessage(chatId, text, { parse_mode: "Markdown", reply_markup: keyboard });
  }
}

function showResolutionMenu(chatId, msgId) {
  const resolutions = ["512x512", "768x768", "1024x1024", "1280x720", "1920x1080", "1024x1536", "1536x1024"];
  const state = getState(chatId);
  const rows = [];
  for (let i = 0; i < resolutions.length; i += 2) {
    const row = resolutions.slice(i, i + 2).map(r => ({
      text: state.resolution === r ? `✅ ${r}` : r,
      callback_data: `set_res_${r}`
    }));
    rows.push(row);
  }
  rows.push([{ text: "◀️ Назад", callback_data: "open_settings" }]);
  bot.editMessageText("📐 Выбери разрешение:", {
    chat_id: chatId, message_id: msgId,
    reply_markup: { inline_keyboard: rows }
  });
}

function showQualityMenu(chatId, msgId) {
  const state = getState(chatId);
  const qualities = [
    { label: "Быстрое", value: "fast" },
    { label: "Стандарт", value: "standard" },
    { label: "Высокое", value: "high" },
  ];
  bot.editMessageText("✨ Выбери качество:", {
    chat_id: chatId, message_id: msgId,
    reply_markup: {
      inline_keyboard: [
        qualities.map(q => ({
          text: state.quality === q.value ? `✅ ${q.label}` : q.label,
          callback_data: `set_quality_${q.value}`
        })),
        [{ text: "◀️ Назад", callback_data: "open_settings" }],
      ]
    }
  });
}

function showCountMenu(chatId, msgId) {
  const state = getState(chatId);
  const counts = [1, 2, 3, 4, 5, 6, 8, 10];
  const rows = [];
  for (let i = 0; i < counts.length; i += 4) {
    rows.push(counts.slice(i, i + 4).map(c => ({
      text: state.count === c ? `✅ ${c}` : `${c}`,
      callback_data: `set_count_${c}`
    })));
  }
  rows.push([{ text: "◀️ Назад", callback_data: "open_settings" }]);
  bot.editMessageText("🔢 Сколько результатов генерировать?", {
    chat_id: chatId, message_id: msgId,
    reply_markup: { inline_keyboard: rows }
  });
}

// ─── Callback кнопок ──────────────────────────────────────
bot.on("callback_query", async (query) => {
  const chatId = query.message.chat.id;
  const msgId = query.message.message_id;
  const data = query.data;
  const state = getState(chatId);

  bot.answerCallbackQuery(query.id);

  // Режимы
  if (data === "back_to_menu") {
    bot.deleteMessage(chatId, msgId).catch(() => {});
    return showMainMenu(chatId);
  }

  if (data === "open_settings") return showSettings(chatId, msgId);
  if (data === "open_resolution") return showResolutionMenu(chatId, msgId);
  if (data === "open_quality") return showQualityMenu(chatId, msgId);
  if (data === "open_count") return showCountMenu(chatId, msgId);

  // Модель
  if (data === "set_model_flower") { state.model = "flower"; return showSettings(chatId, msgId); }
  if (data === "set_model_flow")   { state.model = "flow";   return showSettings(chatId, msgId); }

  // Разрешение
  if (data.startsWith("set_res_")) {
    state.resolution = data.replace("set_res_", "");
    return showSettings(chatId, msgId);
  }

  // Качество
  if (data.startsWith("set_quality_")) {
    state.quality = data.replace("set_quality_", "");
    return showSettings(chatId, msgId);
  }

  // Количество
  if (data.startsWith("set_count_")) {
    state.count = parseInt(data.replace("set_count_", ""));
    return showSettings(chatId, msgId);
  }

  // Выбор режима
  if (data === "mode_image") {
    state.mode = "image";
    state.step = "waiting_prompt";
    bot.editMessageText(
      "🖼️ *Генерация изображения*\n\nНапиши текстовый промпт — что нужно нарисовать?\n\n*Пример:* _красивый закат над горами, фотореализм_",
      { chat_id: chatId, message_id: msgId, parse_mode: "Markdown",
        reply_markup: { inline_keyboard: [[{ text: "❌ Отмена", callback_data: "back_to_menu" }]] } }
    );
    return;
  }

  if (data === "mode_video_from_text") {
    state.mode = "video_from_text";
    state.step = "waiting_prompt";
    bot.editMessageText(
      "📝 *Видео из текста*\n\nНапиши описание видео:\n\n*Пример:* _волны бьются о берег, закат_",
      { chat_id: chatId, message_id: msgId, parse_mode: "Markdown",
        reply_markup: { inline_keyboard: [[{ text: "❌ Отмена", callback_data: "back_to_menu" }]] } }
    );
    return;
  }

  if (data === "mode_video_from_image" || data === "mode_animation") {
    state.mode = data === "mode_animation" ? "animation" : "video_from_image";
    state.step = "waiting_photo";
    const label = data === "mode_animation" ? "✨ Анимация" : "🎬 Видео из фото";
    bot.editMessageText(
      `${label}\n\nОтправь фото:`,
      { chat_id: chatId, message_id: msgId, parse_mode: "Markdown",
        reply_markup: { inline_keyboard: [[{ text: "❌ Отмена", callback_data: "back_to_menu" }]] } }
    );
    return;
  }
});

// ─── Получение фото ───────────────────────────────────────
bot.on("photo", async (msg) => {
  const chatId = msg.chat.id;
  const state = getState(chatId);

  if (state.step === "waiting_photo") {
    state.fileId = msg.photo[msg.photo.length - 1].file_id;
    state.step = "waiting_prompt";
    bot.sendMessage(chatId,
      "✅ Фото получено!\n\nТеперь напиши описание — что должно происходить?",
      { reply_markup: { inline_keyboard: [[{ text: "❌ Отмена", callback_data: "back_to_menu" }]] } }
    );
  } else {
    // Если прислали фото без выбора режима
    state.fileId = msg.photo[msg.photo.length - 1].file_id;
    state.mode = "video_from_image";
    state.step = "waiting_prompt";
    bot.sendMessage(chatId,
      "✅ Фото получено! Буду генерировать видео.\n\nНапиши описание:",
      { reply_markup: { inline_keyboard: [[{ text: "❌ Отмена", callback_data: "back_to_menu" }]] } }
    );
  }
});

// ─── Получение промпта ────────────────────────────────────
bot.on("message", async (msg) => {
  const chatId = msg.chat.id;
  const state = getState(chatId);

  if (!msg.text || msg.text.startsWith("/")) return;
  if (state.step !== "waiting_prompt") return;

  const prompt = msg.text;
  state.step = null;

  const count = state.count || 1;
  const model = state.model || "flower";
  const mode = state.mode;

  const statusMsg = await bot.sendMessage(chatId,
    `⏳ Запускаю генерацию...\n\n🎨 Модель: ${model}\n🔢 Количество: ${count}\n📐 Разрешение: ${state.resolution}\n\nЭто может занять 1-3 минуты.`
  );

  // Запускаем count задач параллельно
  const tasks = Array.from({ length: count }, (_, i) => generateOne(chatId, state, prompt, i + 1, count));
  
  await bot.editMessageText(`⏳ Запущено ${count} задач. Ожидаю результаты...`, {
    chat_id: chatId, message_id: statusMsg.message_id
  });

  const results = await Promise.allSettled(tasks);
  let success = 0;
  let fail = 0;
  results.forEach(r => r.status === "fulfilled" ? success++ : fail++);

  await bot.editMessageText(
    `✅ Готово! Успешно: ${success}${fail > 0 ? ` | ❌ Ошибок: ${fail}` : ""}`,
    { chat_id: chatId, message_id: statusMsg.message_id }
  ).catch(() => {});

  showMainMenu(chatId);
});

// ─── Генерация одной задачи ───────────────────────────────
async function generateOne(chatId, state, prompt, index, total) {
  const { model, mode, resolution, quality, fileId } = state;
  const label = total > 1 ? ` (${index}/${total})` : "";

  try {
    let endpoint, body;

    if (mode === "image") {
      endpoint = `/api/v4/${model}/image/generate`;
      body = { prompt, resolution, quality };

    } else if (mode === "video_from_text") {
      endpoint = `/api/v4/${model}/video/from-text`;
      body = { prompt, resolution, quality };

    } else if (mode === "video_from_image" || mode === "animation") {
      // Скачиваем фото
      const telegramFile = await bot.getFile(fileId);
      const imageUrl = `https://api.telegram.org/file/bot${TELEGRAM_TOKEN}/${telegramFile.file_path}`;
      const imageResponse = await axios.get(imageUrl, { responseType: "arraybuffer" });
      const base64Image = Buffer.from(imageResponse.data).toString("base64");

      endpoint = `/api/v4/${model}/video/from-image`;
      body = { image: `data:image/jpeg;base64,${base64Image}`, prompt, resolution, quality };
    }

    const resp = await axios.post(`${BASE_URL}${endpoint}`, body, {
      headers: { "X-API-Key": FASTGEN_API_KEY, "Content-Type": "application/json", Accept: "application/json" },
      timeout: 60000,
    });

    const result = resp.data;
    const operationId = result.operation_id || result.task_id || result.id;

    if (!operationId) throw new Error("Нет ID задачи");

    // Поллинг
    const output = await pollResult(operationId);

    if (output) {
      if (mode === "image") {
        await bot.sendPhoto(chatId, output, { caption: `🖼️ Изображение${label}\n📝 _${prompt.slice(0, 100)}_`, parse_mode: "Markdown" });
      } else {
        await bot.sendVideo(chatId, output, { caption: `🎬 Видео${label}\n📝 _${prompt.slice(0, 100)}_`, parse_mode: "Markdown" });
      }
    } else {
      await bot.sendMessage(chatId, `⏰ Задача${label} ещё генерируется.\nID: \`${operationId}\`\nПроверьте на fast-gen.ai`, { parse_mode: "Markdown" });
    }
  } catch (e) {
    console.error(`Ошибка задачи ${index}:`, e.response?.data || e.message);
    const errMsg = e.response?.data?.detail || e.response?.data?.message || e.message;
    await bot.sendMessage(chatId, `❌ Задача${label} провалилась: ${errMsg}`);
    throw e;
  }
}

// ─── Поллинг ──────────────────────────────────────────────
async function pollResult(operationId, maxAttempts = 30, interval = 10000) {
  const endpoints = [
    `/api/v4/operations/${operationId}`,
    `/api/v4/task/${operationId}`,
  ];

  for (let i = 0; i < maxAttempts; i++) {
    await new Promise(r => setTimeout(r, interval));

    for (const ep of endpoints) {
      try {
        const { data } = await axios.get(`${BASE_URL}${ep}`, {
          headers: { "X-API-Key": FASTGEN_API_KEY },
          timeout: 10000,
        });

        const status = data.status || data.state;
        console.log(`Poll [${i+1}] ${ep}: ${status}`);

        if (["completed", "success", "done", "finished"].includes(status)) {
          return data.video_url || data.image_url || data.url || data.output || data.result?.url;
        }
        if (["failed", "error"].includes(status)) throw new Error("Генерация провалилась");
        break;
      } catch (e) {
        if (e.response?.status !== 404) console.log(`Poll error ${ep}:`, e.message);
      }
    }
  }
  return null;
}

console.log("🤖 Бот запущен!");
