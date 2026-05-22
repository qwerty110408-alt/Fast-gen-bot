const TelegramBot = require("node-telegram-bot-api");
const axios = require("axios");

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const FASTGEN_API_KEY = process.env.FASTGEN_API_KEY;
const FASTGEN_BASE_URL = "https://googler.fast-gen.ai";

const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });
const userState = {};

console.log("🤖 Бот запущен...");

// /start
bot.onText(/\/start/, (msg) => {
  bot.sendMessage(
    msg.chat.id,
    `👋 Привет! Я генерирую видео из твоих фотографий.\n\n📌 *Как пользоваться:*\n1. Отправь мне фото\n2. Выбери настройки\n3. Напиши описание\n4. Получи видео!\n\nОтправь фото, чтобы начать.`,
    { parse_mode: "Markdown" }
  );
});

// Получение фото
bot.on("photo", async (msg) => {
  const chatId = msg.chat.id;
  const photo = msg.photo[msg.photo.length - 1];

  userState[chatId] = { fileId: photo.file_id, step: "waiting_prompt" };

  await bot.sendMessage(chatId, "✅ Фото получено!\n\nТеперь напиши описание — что должно происходить в видео?\n\n*Пример:* _камера медленно отдаляется, ветер колышет листья_", {
    parse_mode: "Markdown",
  });
});

// Получение текста (промпт)
bot.on("message", async (msg) => {
  const chatId = msg.chat.id;
  const state = userState[chatId];

  if (!state || state.step !== "waiting_prompt") return;
  if (!msg.text || msg.text.startsWith("/")) return;

  const prompt = msg.text;
  const fileId = state.fileId;
  delete userState[chatId];

  const statusMsg = await bot.sendMessage(chatId, "⏳ Отправляю запрос...");

  try {
    // Скачиваем фото
    const telegramFile = await bot.getFile(fileId);
    const imageUrl = `https://api.telegram.org/file/bot${TELEGRAM_TOKEN}/${telegramFile.file_path}`;
    const imageResponse = await axios.get(imageUrl, { responseType: "arraybuffer" });
    const base64Image = Buffer.from(imageResponse.data).toString("base64");

    // Отправляем запрос
    const generateResponse = await axios.post(
      `${FASTGEN_BASE_URL}/api/v4/flower/video/from-image`,
      {
        image: `data:image/jpeg;base64,${base64Image}`,
        prompt: prompt,
      },
      {
        headers: {
          "X-API-Key": FASTGEN_API_KEY,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        timeout: 60000,
      }
    );

    const result = generateResponse.data;
    console.log("API ответ:", JSON.stringify(result));

    // Получаем operation_id
    const operationId = result.operation_id || result.task_id || result.id || result.job_id;

    if (!operationId) {
      throw new Error("Не получен ID задачи от API");
    }

    await bot.editMessageText(`⏳ Видео генерируется...\nID: \`${operationId}\`\n\nОжидаю результат (до 3 минут)`, {
      chat_id: chatId,
      message_id: statusMsg.message_id,
      parse_mode: "Markdown",
    });

    // Поллинг
    const videoUrl = await pollForResult(operationId);

    if (videoUrl) {
      await bot.editMessageText("✅ Видео готово! Отправляю...", {
        chat_id: chatId,
        message_id: statusMsg.message_id,
      });
      await bot.sendVideo(chatId, videoUrl, {
        caption: `🎬 *Готово!*\n📝 _${prompt}_`,
        parse_mode: "Markdown",
      });
    } else {
      await bot.editMessageText(
        `⏰ Видео всё ещё генерируется.\n\nID задачи: \`${operationId}\`\n\nПроверьте позже на fast-gen.ai`,
        {
          chat_id: chatId,
          message_id: statusMsg.message_id,
          parse_mode: "Markdown",
        }
      );
    }
  } catch (error) {
    console.error("Ошибка:", error.response?.data || error.message);
    const errMsg = error.response?.data?.detail || error.response?.data?.message || error.message;
    await bot.editMessageText(`❌ Ошибка: ${errMsg}\n\nПопробуйте ещё раз.`, {
      chat_id: chatId,
      message_id: statusMsg.message_id,
    });
  }
});

// Поллинг результата
async function pollForResult(operationId, maxAttempts = 24, interval = 10000) {
  const endpoints = [
    `/api/v4/operations/${operationId}`,
    `/api/v4/task/${operationId}`,
    `/api/v4/flower/video/status/${operationId}`,
  ];

  for (let i = 0; i < maxAttempts; i++) {
    await new Promise((resolve) => setTimeout(resolve, interval));

    for (const endpoint of endpoints) {
      try {
        const response = await axios.get(`${FASTGEN_BASE_URL}${endpoint}`, {
          headers: { "X-API-Key": FASTGEN_API_KEY },
        });

        const data = response.data;
        const status = data.status || data.state;
        console.log(`Попытка ${i + 1} [${endpoint}]: статус = ${status}`);
        console.log("Данные:", JSON.stringify(data));

        if (status === "completed" || status === "success" || status === "done" || status === "finished") {
          return (
            data.video_url ||
            data.url ||
            data.output ||
            data.result?.url ||
            data.data?.url ||
            data.result?.video_url
          );
        }

        if (status === "failed" || status === "error") {
          throw new Error("Генерация завершилась с ошибкой");
        }

        break; // Если запрос прошёл успешно — не пробуем другие endpoint'ы
      } catch (e) {
        if (e.response?.status !== 404) {
          console.log(`Endpoint ${endpoint} ошибка:`, e.message);
        }
      }
    }
  }

  return null;
}

// Неизвестные сообщения
bot.on("message", (msg) => {
  const chatId = msg.chat.id;
  if (userState[chatId] || msg.text?.startsWith("/") || msg.photo) return;
  if (msg.text) {
    bot.sendMessage(chatId, "📸 Сначала отправь фото!");
  }
});
