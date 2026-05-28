// ═══════════════════════════════════════════════════════════════════════
// КОМАНДА /cost  —  ПОЛНАЯ СПРАВКА ПО API googler.fast-gen.ai
// Вставь ПЕРЕД строкой: bot.onText(/\/start|\/menu/, ...)
// ═══════════════════════════════════════════════════════════════════════

bot.onText(/\/cost/, async (msg) => {
  const chatId = msg.chat.id;

  // Отправляем 5 частей, чтобы не превысить лимит Telegram (4096 символов)
  const parts = [];

  // ────────────────────────────────────────────────
  // ЧАСТЬ 1 — Изображения v4
  // ────────────────────────────────────────────────
  parts.push(
`🖼 *ИЗОБРАЖЕНИЯ — V4 эндпоинты*
🌐 Base: \`https://googler.fast-gen.ai\`
🔑 Header: \`X-API-Key: YOUR_KEY\`

━━━━━━━━━━━━━━━━━━━
*1. Flow / Imagen 4*
\`POST /api/v4/flow/image/generate\`
💳 *4 кредита* = 1 фото
📥 Параметры:
  • \`prompt\` string — обязателен
  • \`aspect_ratio\` — 16:9 | 9:16 | 1:1 | 4:3 | 3:4 | 3:2 | 2:3
  • \`model\` — \`nano-banana-pro\` | \`nano-banana-2\` (по умолчанию Imagen 4)
  • \`reference_images\` array — до 10 фото (base64 или file:hash)
  • \`seed\` int — для воспроизводимости
📤 Ответ: \`{"operation_id": "..."}\` → поллинг

━━━━━━━━━━━━━━━━━━━
*2. Flower / Nano Banana 2*
\`POST /api/v4/flower/image/generate\`
💳 *1 кредит* = 1 фото
📥 Параметры:
  • \`prompt\` string — обязателен
  • \`aspect_ratio\`
  • \`image\` — 1 реф (base64 или file:hash)
  • \`seed\` int

━━━━━━━━━━━━━━━━━━━
*3. Grok (xAI) — Генерация*
\`POST /api/v4/grok/image/generate\`
💳 *1 кредит* → fast: 6 фото | quality: 4 фото
📥 Параметры:
  • \`prompt\` string — обязателен
  • \`aspect_ratio\`
  • \`quality\` — \`fast\` | \`quality\`
  • \`n\` int — кол-во (до 6)
⚠️ Референсные фото НЕ поддерживаются

━━━━━━━━━━━━━━━━━━━
*4. Grok — Редактирование*
\`POST /api/v4/grok/image/edit\`
💳 *1 кредит* = 2 варианта
📥 Параметры:
  • \`prompt\` string — обязателен
  • \`images\` array — до 6 фото
  • \`aspect_ratio\`

━━━━━━━━━━━━━━━━━━━
*5. ChatGPT / OpenAI Images*
\`POST /api/v4/openai/image/generate\`
💳 *1 кредит* = 1 фото
📥 Параметры:
  • \`prompt\` string — обязателен
  • \`aspect_ratio\`
  • \`model\` — \`gpt-image-1\`

━━━━━━━━━━━━━━━━━━━
*6. Remix (GoogleFX)*
\`POST /api/v4/flow/image/remix\`
💳 *1 кредит* = 1 фото
📥 Параметры:
  • \`prompt\` string — обязателен
  • \`aspect_ratio\`
  • \`reference_images\` array — до 3 объектов:
    \`{"image": "...", "category": "..."}\`
  Категории:
    \`MEDIA_CATEGORY_SUBJECT\` — кто/что (персонаж)
    \`MEDIA_CATEGORY_SCENE\`   — фон/место
    \`MEDIA_CATEGORY_STYLE\`   — арт-стиль
  • \`seed\` int`
  );

  // ────────────────────────────────────────────────
  // ЧАСТЬ 2 — Видео v4
  // ────────────────────────────────────────────────
  parts.push(
`🎬 *ВИДЕО — V4 эндпоинты*

━━━━━━━━━━━━━━━━━━━
*1. Flow/Veo 3.1 — из текста*
\`POST /api/v4/flow/video/from-text\`
💳 *1 кредит* (Quality: 10 кред) | TTL: 15 мин
📥 Параметры:
  • \`prompt\` string — обязателен
  • \`aspect_ratio\`
  • \`model\` — \`veo-3.1-fast\` | \`veo-3.1-light\` | \`veo-3.1-quality\` | \`gemini-2.0-flash\`
  • \`duration\` int — для gemini-2.0-flash: 4|6|8|10 сек (10s = 2 кред)
  • \`seed\` int

━━━━━━━━━━━━━━━━━━━
*2. Flow/Veo 3.1 — из картинок (ingredients)*
\`POST /api/v4/flow/video/from-ingredients\`
💳 *1 кредит* | TTL: 15 мин | Макс. фото: 3
📥 Параметры:
  • \`prompt\` string — обязателен
  • \`aspect_ratio\`
  • \`images\` array — до 3 фото (base64 или file:hash)
  • \`reference_images\` array — для gemini-2.0-flash
  • \`model\` — veo-3.1-fast | light | quality | gemini-2.0-flash
  • \`duration\` int — для gemini

━━━━━━━━━━━━━━━━━━━
*3. Flow/Veo 3.1 — ключевые кадры*
\`POST /api/v4/flow/video/from-keyframes\`
💳 *1 кредит* | TTL: 15 мин | Макс. кадров: 2
📥 Параметры:
  • \`prompt\` string — обязателен
  • \`aspect_ratio\`
  • \`start_image\` — начальный кадр (base64 или file:hash)
  • \`end_image\`   — конечный кадр (опционально)
  • \`model\` — veo-3.1-fast | light | quality
  • \`seed\` int

━━━━━━━━━━━━━━━━━━━
*4. Flower/Veo 3.1 — из текста*
\`POST /api/v4/flower/video/from-text\`
💳 *1 кредит* | TTL: 15 мин
📥 Параметры:
  • \`prompt\` string — обязателен
  • \`aspect_ratio\`
  • \`seed\` int

━━━━━━━━━━━━━━━━━━━
*5. Flower/Veo 3.1 — из фото*
\`POST /api/v4/flower/video/from-image\`
💳 *1 кредит* | TTL: 15 мин | Макс. фото: 1
📥 Параметры:
  • \`prompt\` string — обязателен
  • \`aspect_ratio\`
  • \`image\` — 1 фото (base64 или file:hash)
  • \`seed\` int

━━━━━━━━━━━━━━━━━━━
*6. Grok Video — из текста*
\`POST /api/v4/grok/video/from-text\`
💳 *1 кредит* | Разрешения: 480p | 720p | 1080p
📥 Параметры:
  • \`prompt\` string — обязателен
  • \`aspect_ratio\`
  • \`resolution\` — 480p | 720p (по умолч.) | 1080p

━━━━━━━━━━━━━━━━━━━
*7. Grok Video — из фото*
\`POST /api/v4/grok/video/from-image\`
💳 *1 кредит* | Макс. фото: 7
📥 Параметры:
  • \`prompt\` string — обязателен
  • \`aspect_ratio\`
  • \`images\` array — до 7 фото (base64 или file:hash)
  • \`resolution\` — 480p | 720p | 1080p`
  );

  // ────────────────────────────────────────────────
  // ЧАСТЬ 3 — Операции v4, Текст v4
  // ────────────────────────────────────────────────
  parts.push(
`⚙️ *ОПЕРАЦИИ — V4*

━━━━━━━━━━━━━━━━━━━
*Статус операции*
\`GET /api/v4/operations/{operation_id}\`
Query-параметры:
  • \`result_format\` — \`data_uri\` (по умолч.) | \`ref\`
    \`ref\` вернёт file:hash вместо base64
Статусы: pending → processing → success | error
📤 Ответ при success:
  \`{"status":"success","result":"data:image/jpeg;base64,...","media_type":"image"}\`

━━━━━━━━━━━━━━━━━━━
*Отмена операций (bulk)*
\`POST /api/v4/operations/cancel\`
Body: \`{"operation_ids": ["id1","id2",...]}\`
⚠️ Максимум 100 ID за раз
📤 Ответ: \`{"total_requested":N,"total_cancelled":N,"total_refunded":N}\`

━━━━━━━━━━━━━━━━━━━
*Отмена ВСЕХ операций*
\`GET /api/v4/operations/cancel-all\`
📤 Ответ: \`{"total_found":N,"total_cancelled":N,"total_refunded":N}\`

━━━━━━━━━━━━━━━━━━━
*Генерация текста / промпта (v4)*
\`POST /api/v4/prompt/generate\`
💳 Токенная тарификация (из лимита 200k токен/час)
Body: \`{"prompt": "..."}\`
📤 Ответ: \`{"text": "..."}\`
⚠️ Токены (input+output) считаются против prompt_tokens_per_hour_limit

━━━━━━━━━━━━━━━━━━━
*Health Check*
\`GET /api/health\`
Query: \`?deep=true\` — проверка зависимостей
📤 \`{"status":"ok"}\`

━━━━━━━━━━━━━━━━━━━
🔑 *АВТОРИЗАЦИЯ*
Header: \`X-API-Key: YOUR_KEY\`
ИЛИ query: \`?api_key=YOUR_KEY\`

📎 *Форматы изображений:*
• Data URI: \`"data:image/jpeg;base64,/9j/4AAQ..."\`
• File ref: \`"file:abc123def456hash"\` (после загрузки в Storage)`
  );

  // ────────────────────────────────────────────────
  // ЧАСТЬ 4 — V5 (экспериментальный) + OpenAI-compatible
  // ────────────────────────────────────────────────
  parts.push(
`🧪 *V5 — ЭКСПЕРИМЕНТАЛЬНЫЙ API*
⚠️ Финализируется, может измениться

━━━━━━━━━━━━━━━━━━━
*Генерация (универсальный эндпоинт)*
\`POST /api/v5/generations\`
Body: \`{"operation": "flow_image_generate", "prompt": "...", ...}\`
ИЛИ: \`{"model": "imagen-4", "prompt": "..."}\`
Предпочитай \`operation\` для точного биллинга

*Статус генерации v5*
\`GET /api/v5/generations/{generation_id}\`
Ответ содержит file refs + download URLs

*Отмена генерации v5*
\`DELETE /api/v5/generations/{generation_id}\`

━━━━━━━━━━━━━━━━━━━
*Операции v5*
\`GET  /api/v5/operations/{operation_id}\` — статус
\`POST /api/v5/operations/cancel\` — отмена bulk
Body: \`{"operation_ids": ["id1"]}\`
\`GET  /api/v5/operations/cancel-all\` — отмена всех

━━━━━━━━━━━━━━━━━━━
*Промпты v5*
\`POST /api/v5/prompts/generate\`
Body: \`{"prompt": "..."}\`
💳 Токенная тарификация (200k токен/час)
📤 Ответ: \`{"text": "..."}\`

━━━━━━━━━━━━━━━━━━━
*Документация v5*
\`GET /api/v5/models\`          — список всех моделей
  Query: \`?provider=flow\` | \`?media_type=image\`
\`GET /api/v5/models/{model_id}\` — инфо по одной модели
\`GET /api/v5/capabilities\`    — список capabilities + биллинг
  Query: \`?provider=...\` | \`?media_type=...\` | \`?model=...\`
\`GET /api/v5/capabilities/{operation_id}\` — одна capability
\`GET /api/v5/providers\`       — список провайдеров + модели
\`GET /api/v5/usage\`           — текущее использование API ключа

━━━━━━━━━━━━━━━━━━━
🤖 *OpenAI-COMPATIBLE API*
Совместим с OpenAI SDK и любыми OpenRouter-клиентами

*Chat Completions*
\`POST /v1/chat/completions\`
Body (OpenAI формат):
  \`{"model": "openai/gpt-4o", "messages": [...]}\`
Модели (OpenRouter-style):
  • \`openai/gpt-4o\` | \`gpt-4o\`
  • \`x-ai/grok-4\`   | \`grok-4\`
  • \`google/gemini-2.5-flash\` | \`gemini-2.5-flash\`
  • \`openai/auto\` — авто-выбор
Поддержка стриминга: \`"stream": true\` → SSE events
💳 Токены → prompt_tokens_per_hour_limit

*Список моделей*
\`GET /v1/models\` — OpenRouter-style список`
  );

  // ────────────────────────────────────────────────
  // ЧАСТЬ 5 — Storage Server
  // ────────────────────────────────────────────────
  parts.push(
`📦 *STORAGE SERVER*
🌐 \`https://storage.fast-gen.ai\`
📖 Docs: \`https://storage.fast-gen.ai/docs\`
🔑 Header: \`X-API-Key: YOUR_KEY\`

━━━━━━━━━━━━━━━━━━━
*Загрузить файл*
\`POST /upload\`
Content-Type: \`multipart/form-data\`
Поле: \`file\` (бинарные данные)
📤 Ответ: \`{"file_hash": "abc123def456..."}\`
Используй как: \`"file:abc123def456..."\` в запросах API

*Получить файл как Data URI*
\`GET /file/{file_hash}\`
📤 \`{"data": "data:image/jpeg;base64,..."}\`

*Стрим файла (сырые байты)*
\`GET /file/{file_hash}/raw\`
📤 Бинарный поток (для скачивания)

*Проверить существование*
\`HEAD /exists/{file_hash}\`
📤 200 если есть, 404 если нет

*Удалить файл*
\`DELETE /file/{file_hash}\`

*Статистика хранилища*
\`GET /stats\`
📤 \`{"used_bytes": N, "quota_bytes": N, "file_count": N}\`

━━━━━━━━━━━━━━━━━━━
📋 *Лимиты Storage:*
• Макс. файл: *10 МБ*
• Квота: *200 МБ* на API ключ
• TTL файла: *1 час* с последнего использования
• TTL результата: *30 минут* по умолчанию

━━━━━━━━━━━━━━━━━━━
💰 *СВОДНАЯ ТАБЛИЦА СТОИМОСТИ*

🖼 Imagen 4 Flow:       *4 кред* / фото
🖼 NanoBanana Pro Flow: *4 кред* / фото
🖼 NanoBanana 2 Flow:   *4 кред* / фото
🖼 NanoBanana 2 Flower: *1 кред* / фото
🖼 Grok fast:           *1 кред* → 6 фото
🖼 Grok quality:        *1 кред* → 4 фото
🖼 Grok edit:           *1 кред* → 2 варианта
🖼 ChatGPT Images:      *1 кред* / фото
🖼 Remix (GoogleFX):    *1 кред* / фото
🎬 Veo 3.1 Fast:        *1 кред* / видео
🎬 Veo 3.1 Light:       *1 кред* / видео
🎬 Veo 3.1 Quality:     *10 кред* / видео ⚠️
🎬 Veo 3.1 Flower:      *1 кред* / видео
🎬 Grok Video:          *1 кред* / видео
🎬 Gemini Omni Flash:   *1 кред* (4-8s) / *2 кред* (10s)
💬 Текст / промпты:     токенная (200k токен/час)
💬 Chat completions:    токенная (тот же лимит)

━━━━━━━━━━━━━━━━━━━
⏱ *ЧАСОВЫЕ ЛИМИТЫ (стандарт):*
• 🖼 Изображений/час: 500
• 🎬 Видео/час: 15
• 💬 Токенов/час: 200 000

Проверить свои лимиты:
\`GET /api/v5/usage\``
  );

  // Отправляем все части
  for (const part of parts) {
    await bot.sendMessage(chatId, part, { parse_mode: "Markdown" });
    await new Promise(r => setTimeout(r, 300)); // небольшая пауза между сообщениями
  }
});

// ═══════════════════════════════════════════════════════════════════════
// КОНЕЦ БЛОКА /cost
// ═══════════════════════════════════════════════════════════════════════
