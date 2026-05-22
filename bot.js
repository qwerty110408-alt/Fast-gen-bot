const TelegramBot = require("node-telegram-bot-api");
const axios = require("axios");
const fs = require("fs");
const path = require("path");

// ============================
// НАСТРОЙКИ — вставьте свои ключи
// ============================
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN
const FASTGEN_API_KEY = process.env.FASTGEN_API_KEY
const FASTGEN_BASE_URL = "https://googler.fast-gen.ai";

const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });

// Хранение состояния пользователя (ожидает ли текст после фото)
const userState = {};

console.log("🤖 Бот запущен...");

// /start — приветствие
bot.onText(/\/start/, (msg) => {
  bot.sendMessage(
    msg.chat.id,
    `👋 Привет! Я генерирую видео из твоих фотографий.

📌 *Как пользоваться:*
1. Отправь мне фото
2. Напиши описание (что должно происходить в видео)
3. Получи видео!

Отправь фото, чтобы начать.`,
    { parse_mode: "Markdown" }
  );
});

// Получение фото
bot.on("photo", async (msg) => {
  const chatId = msg.chat.id;

  // Берём фото наибольшего размера
  const photo = msg.photo[msg.photo.length - 1];
  const fileId = photo.file_id;

  // Сохраняем fileId и ждём текстового описания
  userState[chatId] = { fileId, step: "waiting_prompt" };

  bot.sendMessage(
    chatId,
    "✅ Фото получено!\n\nТеперь напиши описание — что должно происходить в видео?\n\n*Пример:* _камера медленно отдаляется, ветер колышет листья_",
    { parse_mode: "Markdown" }
  );
});

// Получение текстового описания
bot.on("message", async (msg) => {
  const chatId = msg.chat.id;
  const state = userState[chatId];

  // Игнорируем команды и сообщения без состояния
  if (!state || state.step !== "waiting_prompt") return;
  if (msg.text && msg.text.startsWith("/")) return;
  if (!msg.text) return;

  const prompt = msg.text;
  const fileId = state.fileId;

  // Сбрасываем состояние
  delete userState[chatId];

  const statusMsg = await bot.sendMessage(
    chatId,
    "⏳ Генерирую видео... Это может занять 1–2 минуты."
  );

  try {
    // 1. Получаем URL файла от Telegram
    const telegramFile = await bot.getFile(fileId);
    const imageUrl = `https://api.telegram.org/file/bot${TELEGRAM_TOKEN}/${telegramFile.file_path}`;

    // 2. Скачиваем изображение как base64
    const imageResponse = await axios.get(imageUrl, {
      responseType: "arraybuffer",
    });
    const base64Image = Buffer.from(imageResponse.data).toString("base64");
    const mimeType = "image/jpeg";

    // 3. Отправляем запрос на генерацию видео
    const generateResponse = await axios.post(
      `${FASTGEN_BASE_URL}/api/v4/flower/video/from-image`,
      {
        image: `data:${mimeType};base64,${base64Image}`,
        prompt: prompt,
      },
      {
        headers: {
          "X-API-Key": FASTGEN_API_KEY,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        timeout: 120000,
      }
    );

    const result = generateResponse.data;
    console.log("API ответ:", JSON.stringify(result, null, 2));

    // 4. Ищем ссылку на видео в ответе
    const videoUrl =
      result.video_url ||
      result.url ||
      result.output ||
      result.result?.url ||
      result.data?.url;

    if (videoUrl) {
      await bot.editMessageText("✅ Видео готово! Отправляю...", {
        chat_id: chatId,
        message_id: statusMsg.message_id,
      });

      await bot.sendVideo(chatId, videoUrl, {
        caption: `🎬 *Готово!*\n📝 Промпт: _${prompt}_`,
        parse_mode: "Markdown",
      });
    } else {
      // Если видео ещё генерируется (асинхронная задача)
      const taskId = result.task_id || result.id || result.job_id;

      if (taskId) {
        await bot.editMessageText(
          `⏳ Задача принята (ID: \`${taskId}\`)\nОжидаю результат...`,
          {
            chat_id: chatId,
            message_id: statusMsg.message_id,
            parse_mode: "Markdown",
          }
        );

        // Поллинг результата
        const videoResult = await pollForResult(taskId);

        if (videoResult) {
          await bot.editMessageText("✅ Видео готово!", {
            chat_id: chatId,
            message_id: statusMsg.message_id,
          });

          await bot.sendVideo(chatId, videoResult, {
            caption: `🎬 *Готово!*\n📝 Промпт: _${prompt}_`,
            parse_mode: "Markdown",
          });
        } else {
          await bot.editMessageText(
            `✅ Задача создана!\n\nID задачи: \`${taskId}\`\n\nВидео будет готово через несколько минут. Проверьте в личном кабинете fast-gen.ai.`,
            {
              chat_id: chatId,
              message_id: statusMsg.message_id,
              parse_mode: "Markdown",
            }
          );
        }
      } else {
        // Неизвестный формат ответа
        await bot.editMessageText(
          `📋 Ответ API:\n\`\`\`\n${JSON.stringify(result, null, 2).slice(0, 500)}\n\`\`\``,
          {
            chat_id: chatId,
            message_id: statusMsg.message_id,
            parse_mode: "Markdown",
          }
        );
      }
    }
  } catch (error) {
    console.error("Ошибка:", error.response?.data || error.message);

    const errMsg =
      error.response?.data?.detail ||
      error.response?.data?.message ||
      error.message;

    await bot.editMessageText(`❌ Ошибка: ${errMsg}\n\nПопробуйте ещё раз.`, {
      chat_id: chatId,
      message_id: statusMsg.message_id,
    });
  }
});

// Поллинг для асинхронных задач
async function pollForResult(taskId, maxAttempts = 20, interval = 10000) {
  for (let i = 0; i < maxAttempts; i++) {
    await new Promise((resolve) => setTimeout(resolve, interval));

    try {
      const response = await axios.get(
        `${FASTGEN_BASE_URL}/api/v4/task/${taskId}`,
        {
          headers: { "X-API-Key": FASTGEN_API_KEY },
        }
      );

      const data = response.data;
      const status = data.status || data.state;

      console.log(`Попытка ${i + 1}: статус = ${status}`);

      if (status === "completed" || status === "success" || status === "done") {
        return data.video_url || data.url || data.output || data.result?.url;
      }

      if (status === "failed" || status === "error") {
        throw new Error("Генерация завершилась с ошибкой");
      }
    } catch (e) {
      console.log(`Поллинг ${i + 1} не удался:`, e.message);
    }
  }

  return null;
}

// Обработка неизвестных сообщений
bot.on("message", (msg) => {
  const chatId = msg.chat.id;
  const state = userState[chatId];

  if (state || msg.text?.startsWith("/") || msg.photo) return;

  if (msg.text) {
    bot.sendMessage(
      chatId,
      "📸 Сначала отправь фото, а потом напиши описание!",
      { parse_mode: "Markdown" }
    );
  }
});
