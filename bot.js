const TelegramBot = require("node-telegram-bot-api");
const crypto = require("crypto");
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const FormData = require("form-data");
const mammoth = require("mammoth");

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const FASTGEN_API_KEY = process.env.FASTGEN_API_KEY;
const BASE_URL = "https://googler.fast-gen.ai";
const STORAGE_URL = "https://storage.fast-gen.ai";

if (!TELEGRAM_TOKEN) throw new Error("TELEGRAM_TOKEN is required");
if (!FASTGEN_API_KEY) throw new Error("FASTGEN_API_KEY is required");

const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });

// ─────────────────────────────────────────────────────────────
// Persistent storage
// ─────────────────────────────────────────────────────────────
const STATE_FILE = "./user_states.json";
const BALANCE_FILE = "./balance_state.json";
const HISTORY_FILE = "./history_state.json";
const VIDEO_PROJECTS_FILE = "./video_projects.json";
const VIDEO_PROJECT_HISTORY_FILE = "./video_project_history.json";

function loadJSON(file, def) {
  try {
    if (!fs.existsSync(file)) return def;
    return JSON.parse(fs.readFileSync(file, "utf-8"));
  } catch (e) {
    console.error(`[loadJSON] ${file}:`, e.message);
    return def;
  }
}

function saveJSON(file, data) {
  try {
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, file);
  } catch (e) {
    console.error(`[saveJSON] ${file}:`, e.message);
  }
}

const persistedStates = loadJSON(STATE_FILE, {});
const persistedHistory = loadJSON(HISTORY_FILE, {});
let videoProjects = loadJSON(VIDEO_PROJECTS_FILE, {});
let videoProjectHistory = loadJSON(VIDEO_PROJECT_HISTORY_FILE, {});

// ─────────────────────────────────────────────────────────────
// Queue architecture: existing style, hard concurrency cap.
// ─────────────────────────────────────────────────────────────
function createQueue(concurrency) {
  let running = 0;
  const queue = [];

  function next() {
    while (running < concurrency && queue.length > 0) {
      const { fn, resolve, reject } = queue.shift();
      running++;
      Promise.resolve()
        .then(fn)
        .then((v) => {
          running--;
          resolve(v);
          next();
        })
        .catch((e) => {
          running--;
          reject(e);
          next();
        });
    }
  }

  return function enqueue(fn) {
    return new Promise((resolve, reject) => {
      queue.push({ fn, resolve, reject });
      next();
    });
  };
}

const imageQueue = createQueue(10);
const videoQueue = createQueue(10);
const tgSendQueue = createQueue(2);

// ─────────────────────────────────────────────────────────────
// FastGen / Telegram media helpers
// ─────────────────────────────────────────────────────────────
const refCache = new Map();
const REF_CACHE_TTL = 30 * 60 * 1000;

function refCacheGet(fileId) {
  const entry = refCache.get(fileId);
  if (!entry) return null;
  if (Date.now() - entry.ts > REF_CACHE_TTL) {
    refCache.delete(fileId);
    return null;
  }
  return entry.value;
}

function refCacheSet(fileId, value) {
  refCache.set(fileId, { value, ts: Date.now() });
}

async function uploadToStorage(buffer, filename = "image.jpg") {
  const form = new FormData();
  const contentType = filename.toLowerCase().endsWith(".png") ? "image/png" : "image/jpeg";
  form.append("file", buffer, { filename, contentType });

  const { data } = await axios.post(`${STORAGE_URL}/upload`, form, {
    headers: { ...form.getHeaders(), "X-API-Key": FASTGEN_API_KEY },
    timeout: 30000,
  });

  if (!data.file_hash) throw new Error("Storage upload: no file_hash returned");
  return `file:${data.file_hash}`;
}

async function downloadTelegramFile(fileId) {
  const f = await bot.getFile(fileId);
  const resp = await axios.get(`https://api.telegram.org/file/bot${TELEGRAM_TOKEN}/${f.file_path}`, {
    responseType: "arraybuffer",
    timeout: 60000,
  });
  return { buffer: Buffer.from(resp.data), filePath: f.file_path };
}

async function tgPhotoToDataUri(fileId) {
  const cached = refCacheGet(fileId);
  if (cached) return cached;
  const { buffer, filePath } = await downloadTelegramFile(fileId);
  const ext = (filePath.split(".").pop() || "jpg").toLowerCase();
  const mime = ext === "png" ? "image/png" : ext === "webp" ? "image/webp" : "image/jpeg";
  const result = `data:${mime};base64,${buffer.toString("base64")}`;
  refCacheSet(fileId, result);
  return result;
}

async function tgPhotoToRef(fileId) {
  const { buffer, filePath } = await downloadTelegramFile(fileId);
  const ext = (filePath.split(".").pop() || "jpg").toLowerCase();
  return uploadToStorage(buffer, `ref.${ext}`);
}

function v5Headers() {
  return { "X-API-Key": FASTGEN_API_KEY, "Content-Type": "application/json" };
}

async function v5Create(body) {
  const { data } = await axios.post(`${BASE_URL}/api/v5/generations`, body, {
    headers: v5Headers(),
    timeout: 120000,
  });
  return data;
}

const WATCHDOG_MS = 12 * 60 * 1000;

async function v5Poll(genId, maxAttempts = 180, interval = 10000) {
  const deadline = Date.now() + WATCHDOG_MS;

  for (let i = 0; i < maxAttempts; i++) {
    if (Date.now() > deadline) {
      throw new Error(`Generation watchdog timeout (${WATCHDOG_MS / 1000}s)|REFUNDED:false`);
    }

    await new Promise((r) => setTimeout(r, interval));

    let data;
    try {
      const resp = await axios.get(`${BASE_URL}/api/v5/generations/${genId}`, {
        headers: v5Headers(),
        timeout: 15000,
      });
      data = resp.data;
    } catch (e) {
      console.log(`[poll] network error attempt ${i}: ${e.message}`);
      continue;
    }

    const st = data.status;
    console.log(`[poll] id=${genId} attempt=${i} status=${st}`);
    if (st === "succeeded") return { results: data.results || [], usage: data.usage };
    if (st === "failed") {
      const reason = data.error || JSON.stringify(data).slice(0, 300);
      const refunded = data.usage?.refunded || false;
      throw new Error(`Generation failed: ${reason}|REFUNDED:${refunded}`);
    }
  }

  throw new Error("Generation timed out after polling|REFUNDED:false");
}

function normalizeResultMedia(result, isImage) {
  if (!result) return null;
  if (typeof result === "string") {
    const type = result.startsWith("http") ? "url" : "base64";
    return { mediaType: isImage ? "image" : "video", type, value: result };
  }
  const value = result.url || result.image_url || result.video_url || result.output || result.base64 || result.b64 || result.data;
  if (!value) return null;
  const type = String(value).startsWith("http") ? "url" : "base64";
  return { mediaType: isImage ? "image" : "video", type, value };
}

async function sendV5Media(chatId, media, caption, replyMarkup = null) {
  return tgSendQueue(() => _sendV5MediaImpl(chatId, media, caption, replyMarkup));
}

async function _sendV5MediaImpl(chatId, media, caption, replyMarkup = null) {
  const isImage = media.mediaType === "image";
  const opts = {
    caption,
    parse_mode: "Markdown",
    ...(replyMarkup && { reply_markup: replyMarkup }),
  };

  if (media.type === "url") {
    if (isImage) await bot.sendPhoto(chatId, media.value, opts);
    else await bot.sendVideo(chatId, media.value, opts);
    return;
  }

  let b64 = media.value;
  let ext = isImage ? "jpg" : "mp4";
  if (b64.includes(";base64,")) {
    const parts = b64.split(";base64,");
    b64 = parts[1];
    if (parts[0].includes("png")) ext = "png";
    if (parts[0].includes("webm")) ext = "webm";
  }

  const tmp = `/tmp/fg_${crypto.randomUUID()}.${ext}`;
  fs.writeFileSync(tmp, Buffer.from(b64, "base64"));
  try {
    if (isImage) await bot.sendPhoto(chatId, fs.createReadStream(tmp), opts);
    else await bot.sendVideo(chatId, fs.createReadStream(tmp), opts);
  } finally {
    try { fs.unlinkSync(tmp); } catch {}
  }
}

async function v5EnhancePrompt(rawPrompt, isVideo = false) {
  const mediaType = isVideo ? "video generation" : "image generation";
  const systemPrompt = `You are an expert prompt engineer for AI ${mediaType} models. Rewrite the user's raw prompt into a detailed optimized prompt. Keep the subject intact. ${isVideo ? "Add motion, camera movement and pacing." : "Add visual style, lighting, color palette and camera angle."} Output only the improved prompt.\nUser prompt: ${rawPrompt}`;
  const { data } = await axios.post(`${BASE_URL}/api/v5/prompts/generate`, {
    user_prompt: systemPrompt,
  }, { headers: v5Headers(), timeout: 30000 });
  return data.generated_text?.trim() || null;
}

// ─────────────────────────────────────────────────────────────
// Local balance / UTC hour helpers
// ─────────────────────────────────────────────────────────────
const HOURLY_LIMITS = { images: 500, videos: 15, tokens: 200000 };

function currentUTCHourKey(ts = Date.now()) {
  const d = new Date(ts);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}T${String(d.getUTCHours()).padStart(2, "0")}`;
}

function nextHourResetUTC() {
  const now = new Date();
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), now.getUTCHours() + 1, 0, 0, 0);
}

function getTimeUntilNextHourUTC() {
  return Math.max(0, nextHourResetUTC() - Date.now());
}

let balanceState = loadJSON(BALANCE_FILE, { images: 0, videos: 0, tokens: 0, resetAt: nextHourResetUTC() });
if (!balanceState.resetAt || balanceState.resetAt < Date.now()) {
  balanceState = { images: 0, videos: 0, tokens: 0, resetAt: nextHourResetUTC() };
  saveJSON(BALANCE_FILE, balanceState);
}

function checkResetBalance() {
  if (Date.now() >= balanceState.resetAt) {
    balanceState = { images: 0, videos: 0, tokens: 0, resetAt: nextHourResetUTC() };
    saveJSON(BALANCE_FILE, balanceState);
  }
}

function spendBalance(type, amount = 1) {
  checkResetBalance();
  balanceState[type] = (balanceState[type] || 0) + amount;
  saveJSON(BALANCE_FILE, balanceState);
}

async function getRealVideoUsage() {
  try {
    const { data } = await axios.get(`${BASE_URL}/api/v5/usage`, { headers: v5Headers(), timeout: 10000 });
    const lim = data.account_limits || {};
    const usage = data.current_usage?.hourly_usage?.video_generation || {};
    return {
      hourLimit: lim.video_gen_per_hour_limit || 15,
      usedThisHour: usage.current_usage || 0,
      windowStart: usage.window_start || null,
    };
  } catch (e) {
    console.log(`[getRealVideoUsage] failed: ${e.message}`);
    return null;
  }
}

// ─────────────────────────────────────────────────────────────
// Model registry: use existing operation names, do not invent unsupported models.
// ─────────────────────────────────────────────────────────────
const IMAGE_MODELS = {
  imagen4: { label: "Imagen 4", operation: "imagen_4_image_generate", credits: "4 кред/фото" },
  nanopro: { label: "NanoBanana Pro", operation: "nano_banana_pro_image_generate", credits: "4 кред/фото" },
  nanob2: { label: "NanoBanana 2 Flow", operation: "nano_banana_2_image_generate", credits: "4 кред/фото" },
  flower: { label: "NanaBanana 2 Flower", operation: "flower_image_generate", credits: "1 кред/фото" },
  grok_fast: { label: "Grok (быстро)", operation: "grok_image_generate", credits: "1 кред→6 фото", quality: "speed" },
  grok_qual: { label: "Grok (качество)", operation: "grok_image_generate", credits: "1 кред→4 фото", quality: "quality" },
  chatgpt: { label: "ChatGPT Images", operation: "openai_image_generate", credits: "1 кред/фото" },
};

const GROK_DURATIONS = {
  "6s": { label: "6 сек (1 кред)", duration: "6s", credits: "1 кред/видео" },
  "10s": { label: "10 сек (3 кред)", duration: "10s", credits: "3 кред/видео" },
};

function getGrokVideoCredits(duration) {
  return duration === "10s" ? 3 : 1;
}

const VIDEO_MODELS = {
  veo_fast: { label: "Veo 3.1 Fast", opText: "flow_video_from_text", opImg: "flow_video_from_ingredients", opKf: "flow_video_from_keyframes", credits: "1 кред/видео" },
  veo_light: { label: "Veo 3.1 Light", opText: "flow_video_light_from_text", opImg: "flow_video_light_from_ingredients", opKf: "flow_video_light_from_keyframes", credits: "1 кред/видео" },
  veo_ultra: { label: "Veo 3.1 Ultra-Light", opText: "flow_video_ultra_light_from_text", opImg: "flow_video_ultra_light_from_ingredients", opKf: "flow_video_ultra_light_from_keyframes", credits: "1 кред/видео" },
  veo_qual: { label: "Veo 3.1 Quality", opText: "flow_video_quality_from_text", opImg: null, opKf: "flow_video_quality_from_keyframes", credits: "10 кред/видео ⚠️" },
  flower_vid: { label: "Veo 3.1 Flower", opText: "flower_video_from_text", opImg: "flower_video_from_image", opKf: null, credits: "1 кред/видео" },
  grok_vid: { label: "Grok Video", opText: "grok_video_from_text", opImg: "grok_video_from_image", opKf: null, credits: "1/3 кред/видео", hasResolution: true, hasDuration: true },
  omni_4s: { label: "Omni Flash 4s", opText: "flow_video_omni_flash_from_text_4s", opImg: "flow_video_omni_flash_from_ingredients_4s", opKf: null, credits: "1 кред/видео" },
  omni_6s: { label: "Omni Flash 6s", opText: "flow_video_omni_flash_from_text_6s", opImg: "flow_video_omni_flash_from_ingredients_6s", opKf: null, credits: "1 кред/видео" },
  omni_8s: { label: "Omni Flash 8s", opText: "flow_video_omni_flash_from_text_8s", opImg: "flow_video_omni_flash_from_ingredients_8s", opKf: null, credits: "1 кред/видео" },
  omni_10s: { label: "Omni Flash 10s", opText: "flow_video_omni_flash_from_text_10s", opImg: "flow_video_omni_flash_from_ingredients_10s", opKf: null, credits: "2 кред/видео" },
};

const RATIOS = ["16:9", "9:16", "1:1", "4:3", "3:4", "3:2", "2:3"];
const PROJECT_HOURLY_LIMITS = [5, 10, 15, 20];
const MAX_PROJECT_REFS = 7;
const MAX_PROJECT_RETRIES = 5;

// ─────────────────────────────────────────────────────────────
// User state / history
// ─────────────────────────────────────────────────────────────
const DEFAULT_STATE = () => ({
  step: null,
  tab: null,
  imgModel: "imagen4",
  vidModel: "veo_fast",
  ratio: "16:9",
  count: 1,
  perPrompt: 1,
  seed: "random",
  resolution: "720p",
  grokDuration: "6s",
  batchType: "image",
  batchPrompts: [],
  batchPhotos: [],
  batchPromptIdx: 0,
  batchImgModel: null,
  batchVidModel: null,
  batchRatio: null,
  batchResolution: null,
  batchGrokDuration: null,
  batchHourlyLimit: 15,
  keyframeStart: null,
  keyframeEnd: null,
  pendingRefImages: [],
  menuMsgId: null,
  enhanceMode: "ask",
  pendingProject: null,
  selectedProjectId: null,
});

const userState = {};
const history = {};
const pendingGenerators = new Map();
const failedTasks = new Map();

function getState(chatId) {
  const key = String(chatId);
  if (!userState[key]) {
    const saved = persistedStates[key] || {};
    userState[key] = Object.assign(DEFAULT_STATE(), saved);
    userState[key].step = null;
    userState[key].menuMsgId = null;
  }
  return userState[key];
}

function saveState(chatId) {
  const key = String(chatId);
  const s = userState[key];
  if (!s) return;
  persistedStates[key] = {
    imgModel: s.imgModel,
    vidModel: s.vidModel,
    ratio: s.ratio,
    count: s.count,
    perPrompt: s.perPrompt,
    seed: s.seed,
    resolution: s.resolution,
    grokDuration: s.grokDuration,
    batchType: s.batchType,
    batchImgModel: s.batchImgModel,
    batchVidModel: s.batchVidModel,
    batchRatio: s.batchRatio,
    batchResolution: s.batchResolution,
    batchGrokDuration: s.batchGrokDuration,
    batchHourlyLimit: s.batchHourlyLimit,
    enhanceMode: s.enhanceMode,
  };
  saveJSON(STATE_FILE, persistedStates);
}

function getHistory(chatId) {
  const key = String(chatId);
  if (!history[key]) history[key] = persistedHistory[key] || [];
  return history[key];
}

function addHistory(chatId, entry) {
  const key = String(chatId);
  const h = getHistory(chatId);
  entry.ts = Date.now();
  h.unshift(entry);
  if (h.length > 50) h.pop();
  persistedHistory[key] = h;
  saveJSON(HISTORY_FILE, persistedHistory);
}

function storeFailedTask(chatId, errKey, taskData) {
  failedTasks.set(`${chatId}_${errKey}`, taskData);
  setTimeout(() => failedTasks.delete(`${chatId}_${errKey}`), 24 * 60 * 60 * 1000);
}

function getFailedTask(chatId, errKey) {
  return failedTasks.get(`${chatId}_${errKey}`);
}

// ─────────────────────────────────────────────────────────────
// Generic generation: existing normal + batch flows reuse this.
// ─────────────────────────────────────────────────────────────
function stripRefundFlag(message) {
  return String(message || "").replace(/\|REFUNDED:(true|false)/i, "");
}

function isRefundedError(e) {
  const m = String(e?.message || "");
  const x = m.match(/\|REFUNDED:(true|false)/i);
  return x ? x[1] === "true" : false;
}

async function genOne(chatId, s, prompt, operation, model, isImage, index, total, batchIdx = null, imageRef = null, isScheduled = false) {
  const label = batchIdx || (total > 1 ? `${index}/${total}` : "");
  const errKey = `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const MAX_RETRIES = 5;
  const refs = imageRef ? [imageRef] : (s.pendingRefImages && s.pendingRefImages.length > 0 ? s.pendingRefImages.slice(0, 7) : null);

  const body = {
    operation,
    prompt,
    aspect_ratio: s.ratio,
    ...(s.seed === "fixed" && { seed: 42 }),
    ...(model.quality && { quality: model.quality }),
    ...(model.hasResolution && { resolution: s.resolution || "720p" }),
    ...(model.hasDuration && s.grokDuration && { duration: s.grokDuration }),
    ...(refs && refs.length > 0 && { inputs: refs }),
  };

  const taskData = {
    prompt, operation, model, isImage,
    ratio: s.ratio,
    resolution: s.resolution || "720p",
    grokDuration: s.grokDuration || "6s",
    imageRef: imageRef || null,
    seed: s.seed,
  };

  let lastError = null;
  let lastRefunded = false;

  for (let retry = 0; retry < MAX_RETRIES; retry++) {
    try {
      const created = await v5Create(body);
      const genId = created.id;
      if (!genId) throw new Error(`v5Create returned no id: ${JSON.stringify(created).slice(0, 200)}`);

      const polled = await v5Poll(genId);
      const media = normalizeResultMedia(polled.results?.[0], isImage);
      if (!media) throw new Error("No media in generation result|REFUNDED:false");

      spendBalance(isImage ? "images" : "videos", 1);

      const caption = `${isImage ? "🖼" : "🎬"} *Готово*${label ? ` [${label}]` : ""}\n${model.label}\n_${prompt.slice(0, 300)}_`;
      await sendV5Media(chatId, media, caption);
      addHistory(chatId, { isImage, model: model.label, prompt, media });
      return media;
    } catch (e) {
      lastError = e;
      lastRefunded = isRefundedError(e);
      console.log(`[genOne] retry=${retry + 1}/${MAX_RETRIES} error=${e.message}`);
      if (retry < MAX_RETRIES - 1) continue;
    }
  }

  storeFailedTask(chatId, errKey, taskData);
  await bot.sendMessage(chatId,
    `❌ *Ошибка после ${MAX_RETRIES} попыток*${label ? ` [${label}]` : ""}\n` +
    `${model.label}\n${stripRefundFlag(lastError?.message).slice(0, 500)}\n` +
    `Кредиты: ${lastRefunded ? "✅ возвращены" : "❌ возможно потрачены"}`,
    { parse_mode: "Markdown", reply_markup: { inline_keyboard: [[{ text: "🔁 Перегенерировать", callback_data: `retry_err_${errKey}` }]] } }
  );
  throw lastError || new Error("Max retries exceeded");
}

async function retryFailedTask(chatId, errKey) {
  const task = getFailedTask(chatId, errKey);
  if (!task) return bot.sendMessage(chatId, "❌ Задача не найдена или устарела.");
  const fakeS = {
    ratio: task.ratio,
    resolution: task.resolution || "720p",
    grokDuration: task.grokDuration || "6s",
    seed: task.seed || "random",
    pendingRefImages: [],
  };
  const msg = await bot.sendMessage(chatId, `🔁 Перегенерирую...\n_${task.prompt.slice(0, 100)}_`, { parse_mode: "Markdown" });
  try {
    await genOne(chatId, fakeS, task.prompt, task.operation, task.model, task.isImage, 1, 1, null, task.imageRef, false);
    await bot.editMessageText("✅ Перегенерировано.", { chat_id: chatId, message_id: msg.message_id }).catch(() => {});
    failedTasks.delete(`${chatId}_${errKey}`);
  } catch (e) {
    await bot.editMessageText(`❌ Снова ошибка: ${stripRefundFlag(e.message).slice(0, 250)}`, { chat_id: chatId, message_id: msg.message_id }).catch(() => {});
  }
}

async function handlePromptAndGenerate(chatId, s, rawPrompt, generatorFn) {
  const mode = s.enhanceMode || "ask";
  const isVideo = s.tab === "video_text" || s.tab === "video_ref";

  if (mode === "never") return generatorFn(rawPrompt);

  if (mode === "always") {
    const waitMsg = await bot.sendMessage(chatId, "✨ Улучшаю промпт...");
    let enhanced = null;
    try { enhanced = await v5EnhancePrompt(rawPrompt, isVideo); } catch (e) { console.log(`[enhance] ${e.message}`); }
    await bot.deleteMessage(chatId, waitMsg.message_id).catch(() => {});
    return generatorFn(enhanced || rawPrompt);
  }

  const previewMsg = await bot.sendMessage(chatId, `✨ *Улучшить промпт?*\n\n_${rawPrompt.slice(0, 300)}_`, {
    parse_mode: "Markdown",
    reply_markup: { inline_keyboard: [[
      { text: "✨ Улучшить", callback_data: "enhance_yes" },
      { text: "⏭ Оригинал", callback_data: "enhance_no" },
    ]] },
  });

  s.pendingPrompt = rawPrompt;
  s.pendingIsVideo = isVideo;
  s.pendingMsgId = previewMsg.message_id;
  s.pendingGenKey = `gen_${Date.now()}_${crypto.randomUUID()}`;
  pendingGenerators.set(s.pendingGenKey, generatorFn);
}

async function runNormal(chatId, s, prompt) {
  const isImage = s.tab === "image" || s.tab === "image_ref";
  let model;
  let operation;

  if (isImage) {
    model = IMAGE_MODELS[s.imgModel];
    operation = model.operation;
  } else if (s.tab === "video_text") {
    model = VIDEO_MODELS[s.vidModel];
    operation = model.opText;
  } else {
    model = VIDEO_MODELS[s.vidModel];
    operation = model.opImg;
    if (!operation) {
      return bot.sendMessage(chatId, `❌ Модель *${model.label}* не поддерживает видео из фото.`, { parse_mode: "Markdown" });
    }
  }

  const doGenerate = async (finalPrompt) => {
    const count = Number(s.count || 1);
    const queue = isImage ? imageQueue : videoQueue;
    let done = 0, errors = 0;
    const statusMsg = await bot.sendMessage(chatId, `⏳ *${count} задач в очереди*\n${model.label}\n${model.credits}`, { parse_mode: "Markdown" });

    const tasks = [];
    for (let i = 1; i <= count; i++) {
      tasks.push(queue(async () => {
        try {
          await genOne(chatId, s, finalPrompt, operation, model, isImage, i, count);
          done++;
        } catch (_) {
          errors++;
        }
        await bot.editMessageText(`⏳ Выполнено: ✓${done}/${count}${errors ? ` ✗${errors}` : ""}`, { chat_id: chatId, message_id: statusMsg.message_id }).catch(() => {});
      }));
    }

    await Promise.allSettled(tasks);
    await bot.editMessageText(`✅ Готово: ✓${done}/${count}${errors ? ` ✗${errors}` : ""}`, { chat_id: chatId, message_id: statusMsg.message_id }).catch(() => {});
    s.pendingRefImages = [];
    s.step = null;
    saveState(chatId);
    return showMainMenu(chatId);
  };

  return handlePromptAndGenerate(chatId, s, prompt, doGenerate);
}

// ─────────────────────────────────────────────────────────────
// Batch mode + existing hourly scheduler for batch video.
// ─────────────────────────────────────────────────────────────
function batchEffective(s) {
  const bt = s.batchType || "image";
  const isImage = bt === "image";
  const imgModelKey = s.batchImgModel || s.imgModel;
  const vidModelKey = s.batchVidModel || s.vidModel;
  const model = isImage ? IMAGE_MODELS[imgModelKey] : VIDEO_MODELS[vidModelKey];
  return {
    bt,
    isImage,
    imgModelKey,
    vidModelKey,
    model,
    ratio: s.batchRatio || s.ratio,
    resolution: s.batchResolution || s.resolution || "720p",
    grokDuration: s.batchGrokDuration || s.grokDuration || "6s",
  };
}

function showBatchTypeMenu(chatId, msgId = null) {
  const s = getState(chatId);
  const bt = s.batchType || "image";
  const text = `📦 *Пакетный режим — тип*\n\nТекущий: *${bt}*`;
  const kb = { inline_keyboard: [
    [{ text: bt === "image" ? "✅ Фото из текста" : "Фото из текста", callback_data: "batch_type_image" }],
    [{ text: bt === "video_text" ? "✅ Видео из текста" : "Видео из текста", callback_data: "batch_type_video_text" }],
    [{ text: bt === "video_image" ? "✅ Видео из фото+текста" : "Видео из фото+текста", callback_data: "batch_type_video_image" }],
    [{ text: "▶️ Продолжить", callback_data: "do_batch_menu" }],
    [{ text: "❌ Отмена", callback_data: "back_menu" }],
  ] };
  editOrSend(chatId, msgId, text, kb);
}

function showBatchMenu(chatId, msgId = null) {
  const s = getState(chatId);
  const { bt, isImage, model, ratio, resolution, grokDuration, vidModelKey } = batchEffective(s);
  const isVideoImage = bt === "video_image";
  const totalTasks = isVideoImage
    ? Math.max(s.batchPrompts.length, s.batchPhotos.length) * s.perPrompt
    : s.batchPrompts.length * s.perPrompt;
  const idx = s.batchPromptIdx || 0;
  const promptPreview = s.batchPrompts.length ? s.batchPrompts[idx] : "_Промптов нет_";
  const text =
    `📦 *Пакетный режим*\n\n` +
    `Тип: *${isImage ? "Фото" : isVideoImage ? "Видео из фото" : "Видео из текста"}*\n` +
    `Модель: *${model.label}*\n` +
    `${ratio}${!isImage && vidModelKey === "grok_vid" ? ` | ${resolution} | ${grokDuration}` : ""}\n` +
    `Промптов: *${s.batchPrompts.length}*\n` +
    (isVideoImage ? `Фото: *${s.batchPhotos.length}*\n` : "") +
    `На 1 промпт: *${s.perPrompt}*\n` +
    (!isImage ? `Лимит видео/час: *${s.batchHourlyLimit}*\n` : "") +
    `Всего задач: *${totalTasks}*\n\n` +
    `*Промпт:*\n${promptPreview}`;

  const nav = s.batchPrompts.length ? [
    { text: "◀️", callback_data: "bp_prev" },
    { text: `${idx + 1}/${s.batchPrompts.length}`, callback_data: "noop" },
    { text: "▶️", callback_data: "bp_next" },
    { text: "Удалить", callback_data: "bp_delete" },
  ] : [];

  const kb = { inline_keyboard: [
    [{ text: "Сменить тип", callback_data: "batch_change_type" }, { text: "⚙️ Настройки", callback_data: "batch_settings" }],
    ...(nav.length ? [nav] : []),
    [{ text: "✏️ Добавить промпты", callback_data: "batch_add_text" }, { text: "Из .txt файла", callback_data: "batch_from_file" }],
    ...(isVideoImage ? [[{ text: "Фото", callback_data: "batch_photos_menu" }]] : []),
    [{ text: `На 1 промпт: ${s.perPrompt}`, callback_data: "batch_per_prompt" }],
    ...(!isImage ? [[{ text: `Лимит видео/час: ${s.batchHourlyLimit}`, callback_data: "batch_hourly_limit" }]] : []),
    [{ text: "🚀 Генерировать", callback_data: "batch_run" }],
    [{ text: "Очистить", callback_data: "batch_clear" }, { text: "❌ Отмена", callback_data: "back_menu" }],
  ] };
  editOrSend(chatId, msgId, text, kb);
}

function showBatchSettingsMenu(chatId, msgId = null) {
  const s = getState(chatId);
  const { isImage, imgModelKey, vidModelKey, model, ratio, resolution, grokDuration } = batchEffective(s);
  const modelRows = isImage
    ? Object.entries(IMAGE_MODELS).map(([k, v]) => [{ text: `${imgModelKey === k ? "✅ " : ""}${v.label}`, callback_data: `bset_im_${k}` }])
    : Object.entries(VIDEO_MODELS).map(([k, v]) => [{ text: `${vidModelKey === k ? "✅ " : ""}${v.label}`, callback_data: `bset_vm_${k}` }]);
  const kb = { inline_keyboard: [
    ...modelRows,
    RATIOS.map((r) => ({ text: `${ratio === r ? "✅ " : ""}${r}`, callback_data: `bset_ratio_${r.replace(":", "x")}` })),
    ...(!isImage && vidModelKey === "grok_vid" ? [
      ["480p", "720p"].map((r) => ({ text: `${resolution === r ? "✅ " : ""}${r}`, callback_data: `bset_res_${r}` })),
      ["6s", "10s"].map((d) => ({ text: `${grokDuration === d ? "✅ " : ""}${d}`, callback_data: `bset_dur_${d}` })),
    ] : []),
    [{ text: "Сбросить", callback_data: "bset_reset" }],
    [{ text: "◀️ Назад", callback_data: "do_batch_menu" }],
  ] };
  editOrSend(chatId, msgId, `⚙️ *Настройки пакета*\n\nМодель: *${model.label}*\nСоотношение: *${ratio}*`, kb);
}

async function parseTxtPromptsFromBuffer(buffer) {
  return buffer.toString("utf-8")
    .replace(/^\uFEFF/, "")
    .split(/\r?\n/)
    .map((x) => x.trim())
    .filter(Boolean);
}

async function parseDocxPromptsFromBuffer(buffer) {
  const { value } = await mammoth.extractRawText({ buffer });
  return value.split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
}

function makeBatchTasks(s) {
  const { bt, isImage, model, ratio, resolution, grokDuration } = batchEffective(s);
  const tasks = [];
  const fakeS = { ...s, ratio, resolution, grokDuration, pendingRefImages: [] };

  for (let i = 0; i < s.batchPrompts.length; i++) {
    for (let n = 0; n < s.perPrompt; n++) {
      const prompt = s.batchPrompts[i];
      let operation;
      let imageRef = null;
      if (isImage) {
        operation = model.operation;
      } else if (bt === "video_image") {
        operation = model.opImg;
        imageRef = s.batchPhotos[i] || s.batchPhotos[0] || null;
        if (!operation) throw new Error(`Модель ${model.label} не поддерживает видео из фото.`);
        if (!imageRef) throw new Error("Для batch video_image нужно добавить минимум одно фото.");
      } else {
        operation = model.opText;
      }
      tasks.push({ prompt, operation, model, isImage, fakeS, imageRef, label: `${i + 1}.${n + 1}` });
    }
  }

  return tasks;
}

const videoScheduler = {};

async function scheduleVideoChunk(chatId) {
  const job = videoScheduler[chatId];
  if (!job || job.stopped) {
    delete videoScheduler[chatId];
    return;
  }

  if (job.tasks.length === 0) {
    await bot.editMessageText(`✅ *Почасовой пакет завершён!*\n✓${job.doneSoFar} ✗${job.errorsSoFar}`, {
      chat_id: chatId, message_id: job.statusMsgId, parse_mode: "Markdown",
    }).catch(() => {});
    delete videoScheduler[chatId];
    showMainMenu(chatId);
    return;
  }

  let allowedThisChunk = job.hourlyLimit;
  const realUsage = await getRealVideoUsage();
  if (realUsage) {
    const apiLimit = Math.min(job.hourlyLimit, realUsage.hourLimit);
    allowedThisChunk = Math.max(0, apiLimit - (realUsage.usedThisHour || 0));
  } else {
    checkResetBalance();
    allowedThisChunk = Math.max(0, job.hourlyLimit - (balanceState.videos || 0));
  }

  if (allowedThisChunk <= 0) {
    const waitMs = getTimeUntilNextHourUTC() + 5000;
    const resetTime = new Date(Date.now() + waitMs).toLocaleTimeString("ru", { hour: "2-digit", minute: "2-digit", timeZone: "UTC" });
    await bot.sendMessage(chatId, `⏳ Лимит исчерпан. Следующая пачка в *${resetTime}* UTC.`, { parse_mode: "Markdown" });
    setTimeout(() => scheduleVideoChunk(chatId), waitMs);
    return;
  }

  const chunk = job.tasks.splice(0, allowedThisChunk);
  await Promise.allSettled(chunk.map((t, i) => videoQueue(async () => {
    try {
      await genOne(chatId, t.fakeS, t.prompt, t.operation, t.model, false, i + 1, chunk.length, t.label, t.imageRef, true);
      job.doneSoFar++;
    } catch (_) {
      job.errorsSoFar++;
    }
    await bot.editMessageText(`⏳ Пакет видео: ✓${job.doneSoFar}/${job.totalTasks} ✗${job.errorsSoFar}\nОсталось: ${job.tasks.length}`, {
      chat_id: chatId, message_id: job.statusMsgId, parse_mode: "Markdown",
    }).catch(() => {});
  })));

  if (job.tasks.length > 0) {
    const waitMs = getTimeUntilNextHourUTC() + 5000;
    const resetTime = new Date(Date.now() + waitMs).toLocaleTimeString("ru", { hour: "2-digit", minute: "2-digit", timeZone: "UTC" });
    await bot.sendMessage(chatId, `⏳ Пачка завершена. Осталось *${job.tasks.length}*. Следующая пачка в *${resetTime}* UTC.`, { parse_mode: "Markdown" });
    setTimeout(() => scheduleVideoChunk(chatId), waitMs);
  } else {
    await bot.editMessageText(`✅ *Почасовой пакет завершён!*\n✓${job.doneSoFar} ✗${job.errorsSoFar}`, {
      chat_id: chatId, message_id: job.statusMsgId, parse_mode: "Markdown",
    }).catch(() => {});
    delete videoScheduler[chatId];
    showMainMenu(chatId);
  }
}

async function runBatch(chatId) {
  const s = getState(chatId);
  let tasks;
  try {
    tasks = makeBatchTasks(s);
  } catch (e) {
    return bot.sendMessage(chatId, `❌ ${e.message}`);
  }
  if (!tasks.length) return bot.sendMessage(chatId, "❌ Нет задач для запуска.");

  const isImage = batchEffective(s).isImage;
  const statusMsg = await bot.sendMessage(chatId, `⏳ *Пакет запущен*\nЗадач: ${tasks.length}`, { parse_mode: "Markdown" });

  if (!isImage) {
    videoScheduler[chatId] = {
      tasks,
      totalTasks: tasks.length,
      hourlyLimit: Number(s.batchHourlyLimit || 15),
      doneSoFar: 0,
      errorsSoFar: 0,
      statusMsgId: statusMsg.message_id,
      stopped: false,
    };
    return scheduleVideoChunk(chatId);
  }

  let done = 0, errors = 0;
  await Promise.allSettled(tasks.map((t, i) => imageQueue(async () => {
    try {
      await genOne(chatId, t.fakeS, t.prompt, t.operation, t.model, true, i + 1, tasks.length, t.label, null, false);
      done++;
    } catch (_) {
      errors++;
    }
    await bot.editMessageText(`⏳ Пакет: ✓${done}/${tasks.length}${errors ? ` ✗${errors}` : ""}`, {
      chat_id: chatId, message_id: statusMsg.message_id, parse_mode: "Markdown",
    }).catch(() => {});
  })));

  await bot.editMessageText(`✅ *Пакет завершён!*\n✓${done} ✗${errors}`, { chat_id: chatId, message_id: statusMsg.message_id, parse_mode: "Markdown" }).catch(() => {});
  showMainMenu(chatId);
}

// ─────────────────────────────────────────────────────────────
// Video Projects: persistent project system for video generation only.
// ─────────────────────────────────────────────────────────────
const activeVideoProjectPrompts = new Set();
let videoProjectProcessorRunning = false;

function saveVideoProjects() {
  saveJSON(VIDEO_PROJECTS_FILE, videoProjects);
}

function saveVideoProjectHistory() {
  saveJSON(VIDEO_PROJECT_HISTORY_FILE, videoProjectHistory);
}

function createProjectId() {
  return `vp_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`;
}

function createPromptId() {
  return `pr_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`;
}

function getProject(projectId) {
  return videoProjects[projectId] || null;
}

function getChatProjects(chatId) {
  return Object.values(videoProjects)
    .filter((p) => String(p.chatId) === String(chatId) && p.status !== "deleted")
    .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
}

function getActiveChatProject(chatId) {
  const s = getState(chatId);
  if (s.selectedProjectId && getProject(s.selectedProjectId)) return getProject(s.selectedProjectId);
  return getChatProjects(chatId)[0] || null;
}

function addVideoProjectHistory(chatId, entry) {
  const key = String(chatId);
  if (!videoProjectHistory[key]) videoProjectHistory[key] = [];
  entry.ts = Date.now();
  videoProjectHistory[key].unshift(entry);
  if (videoProjectHistory[key].length > 100) videoProjectHistory[key].length = 100;
  saveVideoProjectHistory();
}

function projectStats(project) {
  const total = project.prompts.length;
  const done = project.prompts.filter((p) => p.status === "done").length;
  const failed = project.prompts.filter((p) => p.status === "failed").length;
  const running = project.prompts.filter((p) => p.status === "running" || p.status === "queued").length;
  const remaining = project.prompts.filter((p) => p.status === "pending").length;
  const progress = total > 0 ? Math.round(((done + failed) / total) * 100) : 0;
  return { total, done, failed, running, remaining, progress };
}

function normalizeProject(project) {
  project.id = project.id || createProjectId();
  project.name = project.name || `Project ${project.id.slice(-6)}`;
  project.status = project.status || "paused";
  project.model = project.model || "grok_vid";
  project.hourlyLimit = PROJECT_HOURLY_LIMITS.includes(Number(project.hourlyLimit)) ? Number(project.hourlyLimit) : 15;
  project.createdAt = project.createdAt || Date.now();
  project.startedAt = project.startedAt || null;
  project.completedAt = project.completedAt || null;
  project.nextIndex = Number(project.nextIndex || 0);
  project.done = Number(project.done || 0);
  project.failed = Number(project.failed || 0);
  project.defaultRefs = Array.isArray(project.defaultRefs) ? project.defaultRefs.slice(0, MAX_PROJECT_REFS) : [];
  project.prompts = Array.isArray(project.prompts) ? project.prompts : [];
  project.hourlyUsage = project.hourlyUsage || { hour: currentUTCHourKey(), count: 0 };
  project.history = Array.isArray(project.history) ? project.history : [];

  for (const prompt of project.prompts) {
    prompt.id = prompt.id || createPromptId();
    prompt.prompt = String(prompt.prompt || "").trim();
    if (prompt.status === "running" || prompt.status === "queued") prompt.status = "pending";
    prompt.status = prompt.status || "pending";
    prompt.retries = Number(prompt.retries || 0);
    prompt.refs = Array.isArray(prompt.refs) ? prompt.refs.slice(0, MAX_PROJECT_REFS) : [];
    prompt.result = prompt.result || null;
    prompt.error = prompt.error || null;
    prompt.createdAt = prompt.createdAt || Date.now();
  }
  project.done = project.prompts.filter((p) => p.status === "done").length;
  project.failed = project.prompts.filter((p) => p.status === "failed").length;
  return project;
}

function recoverVideoProjectsOnStartup() {
  let changed = false;
  for (const [id, project] of Object.entries(videoProjects)) {
    videoProjects[id] = normalizeProject(project);
    changed = true;
  }
  if (changed) saveVideoProjects();
}

function makeProjectPrompts(lines) {
  const now = Date.now();
  return lines.map((line) => ({
    id: createPromptId(),
    prompt: line,
    status: "pending",
    retries: 0,
    refs: [],
    result: null,
    error: null,
    createdAt: now,
  }));
}

function getProjectVideoOperation(project, prompt) {
  const model = VIDEO_MODELS[project.model];
  if (!model) throw new Error(`Unknown video model: ${project.model}`);
  const refs = (prompt.refs && prompt.refs.length > 0) ? prompt.refs : (project.defaultRefs || []);
  const hasRefs = refs.length > 0;
  if (hasRefs && !model.opImg) throw new Error(`Модель ${model.label} не поддерживает reference images.`);
  return { model, operation: hasRefs ? model.opImg : model.opText, refs: refs.slice(0, MAX_PROJECT_REFS) };
}

async function generateVideoProjectPrompt(projectId, promptId) {
  const project = getProject(projectId);
  if (!project || project.status !== "running") return;
  const prompt = project.prompts.find((p) => p.id === promptId);
  if (!prompt || prompt.status !== "queued") return;

  prompt.status = "running";
  prompt.error = null;
  saveVideoProjects();

  try {
    const { model, operation, refs } = getProjectVideoOperation(project, prompt);
    const body = {
      operation,
      prompt: prompt.prompt,
      aspect_ratio: project.ratio || "16:9",
      ...(model.hasResolution && { resolution: project.resolution || "720p" }),
      ...(model.hasDuration && { duration: project.grokDuration || "6s" }),
      ...(refs.length > 0 && { inputs: refs }),
    };

    const created = await v5Create(body);
    const genId = created.id;
    if (!genId) throw new Error(`v5Create returned no id: ${JSON.stringify(created).slice(0, 200)}`);

    const polled = await v5Poll(genId);
    const media = normalizeResultMedia(polled.results?.[0], false);
    if (!media) throw new Error("No video in generation result|REFUNDED:false");

    spendBalance("videos", 1);
    prompt.status = "done";
    prompt.result = media;
    prompt.error = null;
    project.done = (project.done || 0) + 1;

    const stats = projectStats(project);
    const caption =
      `🎬 *Video Ready*\n\n` +
      `Project: *${escapeMd(project.name)}*\n` +
      `Prompt: _${escapeMd(prompt.prompt.slice(0, 300))}_\n` +
      `Progress: *${stats.progress}%* (${stats.done}/${stats.total})`;
    await sendV5Media(project.chatId, media, caption);

    const histEntry = {
      projectId: project.id,
      projectName: project.name,
      promptId: prompt.id,
      prompt: prompt.prompt,
      model: model.label,
      result: media,
    };
    project.history.unshift({ ...histEntry, ts: Date.now() });
    if (project.history.length > 100) project.history.length = 100;
    addVideoProjectHistory(project.chatId, histEntry);

    maybeCompleteProject(project);
  } catch (e) {
    prompt.retries = Number(prompt.retries || 0) + 1;
    prompt.error = stripRefundFlag(e.message).slice(0, 1000);

    if (prompt.retries >= MAX_PROJECT_RETRIES) {
      prompt.status = "failed";
      project.failed = (project.failed || 0) + 1;
      await bot.sendMessage(project.chatId,
        `❌ *Video Project prompt failed*\n\nProject: *${escapeMd(project.name)}*\nRetries: *${prompt.retries}/${MAX_PROJECT_RETRIES}*\nPrompt: _${escapeMd(prompt.prompt.slice(0, 300))}_\nError: ${escapeMd(prompt.error.slice(0, 300))}`,
        { parse_mode: "Markdown" }
      ).catch(() => {});
      maybeCompleteProject(project);
    } else {
      prompt.status = "pending";
    }
  } finally {
    activeVideoProjectPrompts.delete(`${projectId}:${promptId}`);
    saveVideoProjects();
  }
}

function maybeCompleteProject(project) {
  const stats = projectStats(project);
  if (stats.total > 0 && stats.done + stats.failed >= stats.total && project.status !== "completed") {
    project.status = "completed";
    project.completedAt = Date.now();
    const durationMs = Math.max(0, project.completedAt - (project.startedAt || project.createdAt || project.completedAt));
    const duration = formatDuration(durationMs);
    saveVideoProjects();
    bot.sendMessage(project.chatId,
      `🎉 *Project Completed*\n\n` +
      `Project: *${escapeMd(project.name)}*\n` +
      `Total: *${stats.total}*\n` +
      `Completed: *${stats.done}*\n` +
      `Failed: *${stats.failed}*\n` +
      `Duration: *${duration}*`,
      { parse_mode: "Markdown" }
    ).catch(() => {});
  }
}

async function processVideoProjects() {
  if (videoProjectProcessorRunning) return;
  videoProjectProcessorRunning = true;

  try {
    const hour = currentUTCHourKey();

    for (const project of Object.values(videoProjects)) {
      normalizeProject(project);
      if (project.status !== "running") continue;
      if (!VIDEO_MODELS[project.model]) {
        project.status = "paused";
        await bot.sendMessage(project.chatId, `❌ Project paused: unsupported video model ${project.model}`).catch(() => {});
        continue;
      }

      if (!project.startedAt) project.startedAt = Date.now();
      if (!project.hourlyUsage || project.hourlyUsage.hour !== hour) {
        project.hourlyUsage = { hour, count: 0 };
      }

      const available = Math.max(0, Number(project.hourlyLimit || 15) - Number(project.hourlyUsage.count || 0));
      if (available <= 0) continue;

      const pending = project.prompts.filter((p) => p.status === "pending").slice(0, available);
      if (pending.length === 0) {
        maybeCompleteProject(project);
        continue;
      }

      for (const prompt of pending) {
        const key = `${project.id}:${prompt.id}`;
        if (activeVideoProjectPrompts.has(key)) continue;
        prompt.status = "queued";
        project.hourlyUsage.count++;
        project.nextIndex = project.prompts.findIndex((p) => p.id === prompt.id) + 1;
        activeVideoProjectPrompts.add(key);
        videoQueue(() => generateVideoProjectPrompt(project.id, prompt.id)).catch((e) => {
          console.error(`[videoProjectQueue] ${project.id}/${prompt.id}:`, e.message);
          activeVideoProjectPrompts.delete(key);
        });
      }

      saveVideoProjects();
    }
  } catch (e) {
    console.error("[processVideoProjects]", e.message);
  } finally {
    videoProjectProcessorRunning = false;
  }
}

function showVideoProjectsMenu(chatId, msgId = null) {
  const projects = getChatProjects(chatId);
  const running = projects.filter((p) => p.status === "running").length;
  const text = `🎬 *Video Projects*\n\nПроектов: *${projects.length}*\nАктивных: *${running}*`;
  const kb = { inline_keyboard: [
    [{ text: "📂 New Project", callback_data: "vp_new" }, { text: "📊 My Projects", callback_data: "vp_my" }],
    [{ text: "⏸ Pause Project", callback_data: "vp_pause_menu" }, { text: "▶ Resume Project", callback_data: "vp_resume_menu" }],
    [{ text: "🗑 Delete Project", callback_data: "vp_delete_menu" }, { text: "📜 History", callback_data: "vp_history" }],
    [{ text: "⚙ Settings", callback_data: "vp_settings" }],
    [{ text: "◀️ Назад", callback_data: "back_menu" }],
  ] };
  editOrSend(chatId, msgId, text, kb);
}

function showProjectList(chatId, msgId = null, action = "status") {
  const projects = getChatProjects(chatId);
  if (!projects.length) {
    return editOrSend(chatId, msgId, "📭 Video Projects пока нет.", { inline_keyboard: [[{ text: "📂 New Project", callback_data: "vp_new" }], [{ text: "◀️ Назад", callback_data: "vp_menu" }]] });
  }

  const rows = projects.slice(0, 30).map((p) => {
    const stats = projectStats(p);
    const label = `${statusIcon(p.status)} ${p.name.slice(0, 28)} | ${stats.progress}%`;
    return [{ text: label, callback_data: `vp_${action}_${p.id}` }];
  });
  rows.push([{ text: "◀️ Назад", callback_data: "vp_menu" }]);
  editOrSend(chatId, msgId, `📊 *My Projects*\n\nВыбери проект:`, { inline_keyboard: rows });
}

function showProjectStatus(chatId, projectId, msgId = null) {
  const project = getProject(projectId);
  if (!project || String(project.chatId) !== String(chatId)) return bot.sendMessage(chatId, "❌ Проект не найден.");
  const stats = projectStats(project);
  const model = VIDEO_MODELS[project.model];
  const text =
    `📊 *Project Status*\n\n` +
    `Project: *${escapeMd(project.name)}*\n` +
    `Status: *${project.status}*\n` +
    `Model: *${escapeMd(model?.label || project.model)}*\n\n` +
    `Completed: *${stats.done}*\n` +
    `Failed: *${stats.failed}*\n` +
    `Running/Queued: *${stats.running}*\n` +
    `Remaining: *${stats.remaining}*\n\n` +
    `Progress: *${stats.progress}%*\n` +
    `Hourly Limit: *${project.hourlyLimit}/hour*\n` +
    `Refs: *${project.defaultRefs.length}/${MAX_PROJECT_REFS}*`;
  const kb = { inline_keyboard: [
    [{ text: "📸 Add refs", callback_data: `vp_addrefs_${project.id}` }, { text: "📜 History", callback_data: `vp_hist_${project.id}` }],
    [{ text: project.status === "running" ? "⏸ Pause" : "▶ Resume", callback_data: project.status === "running" ? `vp_pause_${project.id}` : `vp_resume_${project.id}` }],
    [{ text: "🗑 Delete", callback_data: `vp_delete_${project.id}` }],
    [{ text: "◀️ Назад", callback_data: "vp_my" }],
  ] };
  editOrSend(chatId, msgId, text, kb);
}

function showProjectHistory(chatId, projectId, msgId = null) {
  const project = getProject(projectId);
  if (!project || String(project.chatId) !== String(chatId)) return bot.sendMessage(chatId, "❌ Проект не найден.");
  const latest = (project.history || []).slice(0, 10);
  if (!latest.length) {
    return editOrSend(chatId, msgId, "📜 История проекта пуста.", { inline_keyboard: [[{ text: "◀️ Назад", callback_data: `vp_status_${projectId}` }]] });
  }
  const rows = latest.map((h, i) => [{ text: `${i + 1}. ${String(h.prompt || "").slice(0, 40)}`, callback_data: `vp_sendhist_${project.id}_${i}` }]);
  rows.push([{ text: "◀️ Назад", callback_data: `vp_status_${projectId}` }]);
  editOrSend(chatId, msgId, `📜 *History: ${escapeMd(project.name)}*\n\nПоследние готовые видео:`, { inline_keyboard: rows });
}

function showGlobalProjectHistory(chatId, msgId = null) {
  const latest = (videoProjectHistory[String(chatId)] || []).slice(0, 10);
  if (!latest.length) {
    return editOrSend(chatId, msgId, "📜 Video Projects history пуста.", { inline_keyboard: [[{ text: "◀️ Назад", callback_data: "vp_menu" }]] });
  }
  const rows = latest.map((h, i) => [{ text: `${i + 1}. ${String(h.projectName || "Project").slice(0, 18)} | ${String(h.prompt || "").slice(0, 30)}`, callback_data: `vp_globalhist_${i}` }]);
  rows.push([{ text: "◀️ Назад", callback_data: "vp_menu" }]);
  editOrSend(chatId, msgId, "📜 *Video Projects History*", { inline_keyboard: rows });
}

function showProjectSettings(chatId, msgId = null) {
  const p = getActiveChatProject(chatId);
  if (!p) return editOrSend(chatId, msgId, "⚙ Нет проекта для настроек.", { inline_keyboard: [[{ text: "📂 New Project", callback_data: "vp_new" }], [{ text: "◀️ Назад", callback_data: "vp_menu" }]] });
  const model = VIDEO_MODELS[p.model];
  const text = `⚙ *Video Project Settings*\n\nActive: *${escapeMd(p.name)}*\nModel: *${escapeMd(model?.label || p.model)}*\nHourly limit: *${p.hourlyLimit}/hour*\nRefs: *${p.defaultRefs.length}/${MAX_PROJECT_REFS}*`;
  const kb = { inline_keyboard: [
    [{ text: "Сменить модель", callback_data: `vp_setmodel_${p.id}` }],
    [{ text: "Сменить hourly limit", callback_data: `vp_setlimit_${p.id}` }],
    [{ text: "Очистить refs", callback_data: `vp_clearrefs_${p.id}` }],
    [{ text: "◀️ Назад", callback_data: "vp_menu" }],
  ] };
  editOrSend(chatId, msgId, text, kb);
}

function showProjectModelMenu(chatId, projectId = null, msgId = null, callbackPrefix = "vp_model") {
  const rows = Object.entries(VIDEO_MODELS).map(([k, v]) => [{ text: `${v.label} — ${v.credits}`, callback_data: `${callbackPrefix}_${projectId || "new"}_${k}` }]);
  rows.push([{ text: "◀️ Назад", callback_data: projectId ? `vp_status_${projectId}` : "vp_menu" }]);
  editOrSend(chatId, msgId, "🎬 *Выбери video model*", { inline_keyboard: rows });
}

function showProjectLimitMenu(chatId, projectId = null, msgId = null, callbackPrefix = "vp_limit") {
  const rows = PROJECT_HOURLY_LIMITS.map((n) => [{ text: `${n}/hour`, callback_data: `${callbackPrefix}|${projectId || "new"}|${n}` }]);
  rows.push([{ text: "◀️ Назад", callback_data: projectId ? `vp_status_${projectId}` : "vp_menu" }]);
  editOrSend(chatId, msgId, "⏱ *Выбери hourly limit*", { inline_keyboard: rows });
}

function startNewProjectFlow(chatId, msgId = null) {
  const s = getState(chatId);
  s.pendingProject = { name: null, model: null, hourlyLimit: null };
  s.step = "vp_new_name";
  editOrSend(chatId, msgId, "📂 *New Video Project*\n\nОтправь название проекта.", { inline_keyboard: [[{ text: "❌ Отмена", callback_data: "vp_menu" }]] });
}

async function createVideoProjectFromPending(chatId, prompts) {
  const s = getState(chatId);
  const pending = s.pendingProject || {};
  const id = createProjectId();
  const project = normalizeProject({
    id,
    name: pending.name || `Project ${id.slice(-6)}`,
    chatId,
    status: "paused",
    model: pending.model || "grok_vid",
    hourlyLimit: Number(pending.hourlyLimit || 15),
    createdAt: Date.now(),
    startedAt: null,
    nextIndex: 0,
    done: 0,
    failed: 0,
    defaultRefs: [],
    prompts: makeProjectPrompts(prompts),
  });
  videoProjects[id] = project;
  saveVideoProjects();
  s.selectedProjectId = id;
  s.pendingProject = null;
  s.step = null;

  await bot.sendMessage(chatId,
    `✅ *Video Project создан*\n\nProject: *${escapeMd(project.name)}*\nPrompts: *${project.prompts.length}*\nModel: *${escapeMd(VIDEO_MODELS[project.model].label)}*\nLimit: *${project.hourlyLimit}/hour*\nStatus: *paused*\n\nДобавь до ${MAX_PROJECT_REFS} reference images через "Add refs", затем нажми Resume.`,
    {
      parse_mode: "Markdown",
      reply_markup: { inline_keyboard: [[{ text: "📸 Add refs", callback_data: `vp_addrefs_${project.id}` }, { text: "▶ Resume", callback_data: `vp_resume_${project.id}` }]] },
    }
  );
}

async function importPromptsFromDocument(msg) {
  const doc = msg.document;
  const fileName = doc.file_name || "prompts.txt";
  const ext = path.extname(fileName).toLowerCase();
  if (!['.txt', '.docx'].includes(ext)) {
    throw new Error("Поддерживаются только TXT и DOCX.");
  }
  const { buffer } = await downloadTelegramFile(doc.file_id);
  if (ext === ".docx") return parseDocxPromptsFromBuffer(buffer);
  return parseTxtPromptsFromBuffer(buffer);
}

function pauseProject(project) {
  if (!project) return false;
  project.status = "paused";
  for (const p of project.prompts) {
    if (p.status === "queued") p.status = "pending";
  }
  saveVideoProjects();
  return true;
}

function resumeProject(project) {
  if (!project || project.status === "deleted" || project.status === "completed") return false;
  project.status = "running";
  if (!project.startedAt) project.startedAt = Date.now();
  saveVideoProjects();
  processVideoProjects().catch(() => {});
  return true;
}

function deleteProject(project) {
  if (!project) return false;
  project.status = "deleted";
  saveVideoProjects();
  return true;
}

async function sendProjectHistoryItem(chatId, item, backCallback) {
  if (!item?.result) return bot.sendMessage(chatId, "❌ Result недоступен.");
  await sendV5Media(chatId, item.result, `🎬 *History*\n\nProject: *${escapeMd(item.projectName || "Project")}*\nPrompt: _${escapeMd(String(item.prompt || "").slice(0, 300))}_`, {
    inline_keyboard: [[{ text: "◀️ Назад", callback_data: backCallback }]],
  });
}

// ─────────────────────────────────────────────────────────────
// Menus
// ─────────────────────────────────────────────────────────────
function escapeMd(text) {
  return String(text || "").replace(/([_*`\[])/g, "\\$1");
}

function statusIcon(status) {
  if (status === "running") return "▶";
  if (status === "paused") return "⏸";
  if (status === "completed") return "✅";
  if (status === "deleted") return "🗑";
  return "•";
}

function formatDuration(ms) {
  const sec = Math.floor(ms / 1000);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  if (h > 0) return `${h}ч ${m}м`;
  if (m > 0) return `${m}м ${s}с`;
  return `${s}с`;
}

function editOrSend(chatId, msgId, text, replyMarkup = null) {
  const opts = { parse_mode: "Markdown", ...(replyMarkup && { reply_markup: replyMarkup }) };
  if (msgId) {
    return bot.editMessageText(text, { chat_id: chatId, message_id: msgId, ...opts }).catch(() => bot.sendMessage(chatId, text, opts));
  }
  return bot.sendMessage(chatId, text, opts);
}

async function formatBalance() {
  checkResetBalance();
  const imgLeft = Math.max(0, HOURLY_LIMITS.images - (balanceState.images || 0));
  const vidLeft = Math.max(0, HOURLY_LIMITS.videos - (balanceState.videos || 0));
  const msLeft = Math.max(0, balanceState.resetAt - Date.now());
  const totalMin = Math.ceil(msLeft / 60000);
  const resetStr = totalMin > 60 ? `${Math.floor(totalMin / 60)}ч ${totalMin % 60}м` : `${totalMin}м`;
  let realBlock = "";
  try {
    const { data } = await axios.get(`${BASE_URL}/api/v5/usage`, { headers: v5Headers(), timeout: 10000 });
    const lim = data.account_limits || {};
    const threads = data.current_usage?.active_threads || {};
    realBlock = `\nAPI: фото/час=${lim.img_gen_per_hour_limit ?? "?"}, видео/час=${lim.video_gen_per_hour_limit ?? "?"}, active video=${threads.video_threads || 0}`;
  } catch (e) {
    realBlock = `\nAPI: не удалось получить (${e.message})`;
  }
  return `💳 *Баланс*\n\nИзображений осталось: *${imgLeft}/${HOURLY_LIMITS.images}*\nВидео осталось: *${vidLeft}/${HOURLY_LIMITS.videos}*\nСброс через: *${resetStr}*${realBlock}`;
}

async function showBalance(chatId, msgId = null) {
  const text = await formatBalance();
  editOrSend(chatId, msgId, text, { inline_keyboard: [[{ text: "Обновить", callback_data: "refresh_balance" }], [{ text: "◀️ Назад", callback_data: "back_menu" }]] });
}

function showHistoryMenu(chatId, msgId = null, page = 0) {
  const h = getHistory(chatId);
  if (h.length === 0) return editOrSend(chatId, msgId, "📭 История пуста.", { inline_keyboard: [[{ text: "◀️ Назад", callback_data: "open_misc" }]] });
  const PAGE = 8;
  const slice = h.slice(page * PAGE, page * PAGE + PAGE);
  const rows = slice.map((item, i) => [{ text: `${item.isImage ? "🖼" : "🎬"} ${item.model.slice(0, 16)} | ${item.prompt.slice(0, 22)}`, callback_data: `hist_${page * PAGE + i}` }]);
  rows.push([{ text: "◀️ Назад", callback_data: "open_misc" }]);
  editOrSend(chatId, msgId, `📜 *История* (${h.length})`, { inline_keyboard: rows });
}

async function showMainMenu(chatId) {
  const s = getState(chatId);
  const im = IMAGE_MODELS[s.imgModel];
  const vm = VIDEO_MODELS[s.vidModel];
  const enhLabel = { always: "Всегда", never: "Никогда", ask: "Спрашивать" }[s.enhanceMode];
  const grokDurLabel = s.vidModel === "grok_vid" ? ` | ${s.grokDuration}` : "";
  const text =
    `*FastGen Bot v5*\n\n` +
    `Фото: *${im.label}* — ${im.credits}\n` +
    `Видео: *${vm.label}* — ${vm.credits}\n` +
    `${s.ratio} | ${s.count} шт. | ${s.seed === "fixed" ? "Фикс. seed" : "Случ. seed"}${grokDurLabel}\n` +
    `Промпт: *${enhLabel}*`;

  const kb = { inline_keyboard: [
    [{ text: "Изображение", callback_data: "do_image" }, { text: "Из референсов", callback_data: "do_image_ref" }],
    [{ text: "Видео из текста", callback_data: "do_vtext" }, { text: "Видео из фото", callback_data: "do_vimage" }],
    [{ text: "Пакетный режим", callback_data: "do_batch" }, { text: "🎬 Video Projects", callback_data: "vp_menu" }],
    [{ text: "Модель фото", callback_data: "open_imgmodel" }, { text: "Модель видео", callback_data: "open_vidmodel" }],
    [{ text: "Соотношение", callback_data: "open_ratio" }, { text: "Количество", callback_data: "open_count" }],
    [{ text: "Баланс", callback_data: "show_balance" }, { text: "⚙️ Прочее", callback_data: "open_misc" }],
  ] };

  if (s.menuMsgId) {
    const ok = await bot.editMessageText(text, { chat_id: chatId, message_id: s.menuMsgId, parse_mode: "Markdown", reply_markup: kb }).catch(() => null);
    if (ok) return;
    await bot.deleteMessage(chatId, s.menuMsgId).catch(() => {});
  }
  const m = await bot.sendMessage(chatId, text, { parse_mode: "Markdown", reply_markup: kb });
  s.menuMsgId = m.message_id;
}

function showMiscMenu(chatId, msgId = null) {
  const s = getState(chatId);
  const text = `⚙️ *Прочее*`;
  const kb = { inline_keyboard: [
    [{ text: `Seed: ${s.seed === "fixed" ? "Фикс." : "Случ."}`, callback_data: "open_seed" }],
    ...(VIDEO_MODELS[s.vidModel]?.hasResolution ? [[{ text: `Разрешение Grok: ${s.resolution}`, callback_data: "open_resolution" }]] : []),
    ...(VIDEO_MODELS[s.vidModel]?.hasDuration ? [[{ text: `Длительность Grok: ${s.grokDuration}`, callback_data: "open_grok_duration" }]] : []),
    [{ text: `Промпт: ${s.enhanceMode}`, callback_data: "open_enhance" }],
    [{ text: "История", callback_data: "show_history" }],
    [{ text: "◀️ Назад", callback_data: "back_menu" }],
  ] };
  editOrSend(chatId, msgId, text, kb);
}

function showImageModelMenu(chatId, msgId = null) {
  const s = getState(chatId);
  const rows = Object.entries(IMAGE_MODELS).map(([k, v]) => [{ text: `${s.imgModel === k ? "✅ " : ""}${v.label}`, callback_data: `set_img_${k}` }]);
  rows.push([{ text: "◀️ Назад", callback_data: "back_menu" }]);
  editOrSend(chatId, msgId, "🖼 *Модель фото*", { inline_keyboard: rows });
}

function showVideoModelMenu(chatId, msgId = null) {
  const s = getState(chatId);
  const rows = Object.entries(VIDEO_MODELS).map(([k, v]) => [{ text: `${s.vidModel === k ? "✅ " : ""}${v.label}`, callback_data: `set_vid_${k}` }]);
  rows.push([{ text: "◀️ Назад", callback_data: "back_menu" }]);
  editOrSend(chatId, msgId, "🎬 *Модель видео*", { inline_keyboard: rows });
}

function showRatioMenu(chatId, msgId = null) {
  const s = getState(chatId);
  const rows = [RATIOS.map((r) => ({ text: `${s.ratio === r ? "✅ " : ""}${r}`, callback_data: `set_ratio_${r.replace(":", "x")}` }))];
  rows.push([{ text: "◀️ Назад", callback_data: "back_menu" }]);
  editOrSend(chatId, msgId, "📐 *Соотношение*", { inline_keyboard: rows });
}

function showCountMenu(chatId, msgId = null) {
  const s = getState(chatId);
  const rows = [[1, 2, 3, 4, 5].map((n) => ({ text: `${s.count === n ? "✅ " : ""}${n}`, callback_data: `set_count_${n}` }))];
  rows.push([{ text: "◀️ Назад", callback_data: "back_menu" }]);
  editOrSend(chatId, msgId, "🔢 *Количество*", { inline_keyboard: rows });
}

function showEnhanceMenu(chatId, msgId = null) {
  const s = getState(chatId);
  const modes = { ask: "Спрашивать", always: "Всегда", never: "Никогда" };
  const rows = Object.entries(modes).map(([k, v]) => [{ text: `${s.enhanceMode === k ? "✅ " : ""}${v}`, callback_data: `set_enh_${k}` }]);
  rows.push([{ text: "◀️ Назад", callback_data: "open_misc" }]);
  editOrSend(chatId, msgId, "✨ *Улучшение промпта*", { inline_keyboard: rows });
}

function showGrokDurationMenu(chatId, msgId = null) {
  const s = getState(chatId);
  const rows = Object.entries(GROK_DURATIONS).map(([k, v]) => [{ text: `${s.grokDuration === k ? "✅ " : ""}${v.label}`, callback_data: `set_grok_dur_${k}` }]);
  rows.push([{ text: "◀️ Назад", callback_data: "open_misc" }]);
  editOrSend(chatId, msgId, "⏱ *Длительность Grok Video*", { inline_keyboard: rows });
}

// ─────────────────────────────────────────────────────────────
// Telegram handlers
// ─────────────────────────────────────────────────────────────
bot.onText(/\/start/, (msg) => showMainMenu(msg.chat.id));
bot.onText(/\/menu/, (msg) => showMainMenu(msg.chat.id));
bot.onText(/\/project_status/, (msg) => {
  const p = getActiveChatProject(msg.chat.id);
  if (!p) return bot.sendMessage(msg.chat.id, "📭 Нет Video Projects.");
  return showProjectStatus(msg.chat.id, p.id);
});

bot.on("callback_query", async (q) => {
  const chatId = q.message.chat.id;
  const msgId = q.message.message_id;
  const data = q.data;
  const s = getState(chatId);
  await bot.answerCallbackQuery(q.id).catch(() => {});

  try {
    if (data === "noop") return;
    if (data === "back_menu") { s.step = null; return showMainMenu(chatId); }
    if (data === "show_balance" || data === "refresh_balance") return showBalance(chatId, msgId);
    if (data === "open_misc") return showMiscMenu(chatId, msgId);
    if (data === "show_history") return showHistoryMenu(chatId, msgId);

    if (data === "do_image") { s.tab = "image"; s.step = "await_prompt"; return editOrSend(chatId, msgId, "🖼 Отправь промпт для изображения.", { inline_keyboard: [[{ text: "❌ Отмена", callback_data: "back_menu" }]] }); }
    if (data === "do_image_ref") { s.tab = "image_ref"; s.step = "await_refs"; s.pendingRefImages = []; return editOrSend(chatId, msgId, "🖼 Отправь до 7 фото-референсов, затем текстовый промпт.", { inline_keyboard: [[{ text: "Готово, ввести промпт", callback_data: "refs_done" }], [{ text: "❌ Отмена", callback_data: "back_menu" }]] }); }
    if (data === "do_vtext") { s.tab = "video_text"; s.step = "await_prompt"; return editOrSend(chatId, msgId, "🎬 Отправь промпт для видео.", { inline_keyboard: [[{ text: "❌ Отмена", callback_data: "back_menu" }]] }); }
    if (data === "do_vimage") { s.tab = "video_ref"; s.step = "await_refs"; s.pendingRefImages = []; return editOrSend(chatId, msgId, "🎬 Отправь до 7 фото-референсов, затем текстовый промпт.", { inline_keyboard: [[{ text: "Готово, ввести промпт", callback_data: "refs_done" }], [{ text: "❌ Отмена", callback_data: "back_menu" }]] }); }
    if (data === "refs_done") { s.step = "await_prompt"; return bot.sendMessage(chatId, "Теперь отправь текстовый промпт."); }

    if (data === "open_imgmodel") return showImageModelMenu(chatId, msgId);
    if (data === "open_vidmodel") return showVideoModelMenu(chatId, msgId);
    if (data === "open_ratio") return showRatioMenu(chatId, msgId);
    if (data === "open_count") return showCountMenu(chatId, msgId);
    if (data === "open_seed") { s.seed = s.seed === "fixed" ? "random" : "fixed"; saveState(chatId); return showMiscMenu(chatId, msgId); }
    if (data === "open_resolution") { s.resolution = s.resolution === "720p" ? "480p" : "720p"; saveState(chatId); return showMiscMenu(chatId, msgId); }
    if (data === "open_grok_duration") return showGrokDurationMenu(chatId, msgId);
    if (data === "open_enhance") return showEnhanceMenu(chatId, msgId);

    if (data.startsWith("set_img_")) { s.imgModel = data.replace("set_img_", ""); saveState(chatId); return showMainMenu(chatId); }
    if (data.startsWith("set_vid_")) { s.vidModel = data.replace("set_vid_", ""); saveState(chatId); return showMainMenu(chatId); }
    if (data.startsWith("set_ratio_")) { s.ratio = data.replace("set_ratio_", "").replace("x", ":"); saveState(chatId); return showMainMenu(chatId); }
    if (data.startsWith("set_count_")) { s.count = Number(data.replace("set_count_", "")); saveState(chatId); return showMainMenu(chatId); }
    if (data.startsWith("set_enh_")) { s.enhanceMode = data.replace("set_enh_", ""); saveState(chatId); return showMiscMenu(chatId, msgId); }
    if (data.startsWith("set_grok_dur_")) { s.grokDuration = data.replace("set_grok_dur_", ""); saveState(chatId); return showMiscMenu(chatId, msgId); }

    if (data === "enhance_yes" || data === "enhance_no") {
      const gen = pendingGenerators.get(s.pendingGenKey);
      if (!gen) return bot.sendMessage(chatId, "❌ Генератор не найден.");
      let prompt = s.pendingPrompt;
      await bot.deleteMessage(chatId, s.pendingMsgId).catch(() => {});
      if (data === "enhance_yes") {
        const wait = await bot.sendMessage(chatId, "✨ Улучшаю промпт...");
        try { prompt = await v5EnhancePrompt(prompt, s.pendingIsVideo) || prompt; } catch (e) { console.log(e.message); }
        await bot.deleteMessage(chatId, wait.message_id).catch(() => {});
      }
      pendingGenerators.delete(s.pendingGenKey);
      return gen(prompt);
    }

    if (data.startsWith("retry_err_")) return retryFailedTask(chatId, data.replace("retry_err_", ""));

    // Batch callbacks
    if (data === "do_batch") return showBatchTypeMenu(chatId, msgId);
    if (data === "batch_change_type") return showBatchTypeMenu(chatId, msgId);
    if (data === "do_batch_menu") return showBatchMenu(chatId, msgId);
    if (data === "batch_type_image") { s.batchType = "image"; saveState(chatId); return showBatchMenu(chatId, msgId); }
    if (data === "batch_type_video_text") { s.batchType = "video_text"; saveState(chatId); return showBatchMenu(chatId, msgId); }
    if (data === "batch_type_video_image") { s.batchType = "video_image"; saveState(chatId); return showBatchMenu(chatId, msgId); }
    if (data === "batch_settings") return showBatchSettingsMenu(chatId, msgId);
    if (data === "batch_add_text") { s.step = "batch_add_text"; return editOrSend(chatId, msgId, "Отправь промпты строками. Каждая строка = один промпт.", { inline_keyboard: [[{ text: "❌ Отмена", callback_data: "do_batch_menu" }]] }); }
    if (data === "batch_from_file") { s.step = "batch_from_file"; return editOrSend(chatId, msgId, "Отправь TXT файл. Каждая строка = один промпт.", { inline_keyboard: [[{ text: "❌ Отмена", callback_data: "do_batch_menu" }]] }); }
    if (data === "batch_photos_menu") { s.step = "batch_photos"; return editOrSend(chatId, msgId, `Отправь фото для batch. Сейчас: ${s.batchPhotos.length}`, { inline_keyboard: [[{ text: "◀️ Назад", callback_data: "do_batch_menu" }]] }); }
    if (data === "batch_per_prompt") { s.perPrompt = s.perPrompt >= 5 ? 1 : s.perPrompt + 1; saveState(chatId); return showBatchMenu(chatId, msgId); }
    if (data === "batch_hourly_limit") { const cur = Number(s.batchHourlyLimit || 15); s.batchHourlyLimit = cur === 5 ? 10 : cur === 10 ? 15 : cur === 15 ? 20 : 5; saveState(chatId); return showBatchMenu(chatId, msgId); }
    if (data === "bp_prev") { s.batchPromptIdx = Math.max(0, (s.batchPromptIdx || 0) - 1); return showBatchMenu(chatId, msgId); }
    if (data === "bp_next") { s.batchPromptIdx = Math.min(s.batchPrompts.length - 1, (s.batchPromptIdx || 0) + 1); return showBatchMenu(chatId, msgId); }
    if (data === "bp_delete") { s.batchPrompts.splice(s.batchPromptIdx || 0, 1); s.batchPromptIdx = 0; return showBatchMenu(chatId, msgId); }
    if (data === "batch_clear") { s.batchPrompts = []; s.batchPhotos = []; s.batchPromptIdx = 0; return showBatchMenu(chatId, msgId); }
    if (data === "batch_run") return runBatch(chatId);
    if (data.startsWith("bset_im_")) { s.batchImgModel = data.replace("bset_im_", ""); saveState(chatId); return showBatchSettingsMenu(chatId, msgId); }
    if (data.startsWith("bset_vm_")) { s.batchVidModel = data.replace("bset_vm_", ""); saveState(chatId); return showBatchSettingsMenu(chatId, msgId); }
    if (data.startsWith("bset_ratio_")) { s.batchRatio = data.replace("bset_ratio_", "").replace("x", ":"); saveState(chatId); return showBatchSettingsMenu(chatId, msgId); }
    if (data.startsWith("bset_res_")) { s.batchResolution = data.replace("bset_res_", ""); saveState(chatId); return showBatchSettingsMenu(chatId, msgId); }
    if (data.startsWith("bset_dur_")) { s.batchGrokDuration = data.replace("bset_dur_", ""); saveState(chatId); return showBatchSettingsMenu(chatId, msgId); }
    if (data === "bset_reset") { s.batchImgModel = null; s.batchVidModel = null; s.batchRatio = null; s.batchResolution = null; s.batchGrokDuration = null; saveState(chatId); return showBatchSettingsMenu(chatId, msgId); }

    // Video Projects callbacks
    if (data === "vp_menu") return showVideoProjectsMenu(chatId, msgId);
    if (data === "vp_new") return startNewProjectFlow(chatId, msgId);
    if (data === "vp_my") return showProjectList(chatId, msgId, "status");
    if (data === "vp_pause_menu") return showProjectList(chatId, msgId, "pause");
    if (data === "vp_resume_menu") return showProjectList(chatId, msgId, "resume");
    if (data === "vp_delete_menu") return showProjectList(chatId, msgId, "delete");
    if (data === "vp_history") return showGlobalProjectHistory(chatId, msgId);
    if (data === "vp_settings") return showProjectSettings(chatId, msgId);

    if (data === "vp_new_choose_model") return showProjectModelMenu(chatId, null, msgId, "vp_newmodel");
    if (data === "vp_new_choose_limit") return showProjectLimitMenu(chatId, null, msgId, "vp_newlimit");
    if (data.startsWith("vp_newmodel|new|")) { s.pendingProject.model = data.replace("vp_newmodel|new|", ""); return showProjectLimitMenu(chatId, null, msgId, "vp_newlimit"); }
    if (data.startsWith("vp_newlimit|new|")) { s.pendingProject.hourlyLimit = Number(data.replace("vp_newlimit|new|", "")); s.step = "vp_wait_file"; return editOrSend(chatId, msgId, "📄 Отправь TXT или DOCX файл. Каждая строка = один prompt.", { inline_keyboard: [[{ text: "❌ Отмена", callback_data: "vp_menu" }]] }); }

    if (data.startsWith("vp_status_")) { const id = data.replace("vp_status_", ""); s.selectedProjectId = id; return showProjectStatus(chatId, id, msgId); }
    if (data.startsWith("vp_pause_")) { const id = data.replace("vp_pause_", ""); pauseProject(getProject(id)); return showProjectStatus(chatId, id, msgId); }
    if (data.startsWith("vp_resume_")) { const id = data.replace("vp_resume_", ""); resumeProject(getProject(id)); return showProjectStatus(chatId, id, msgId); }
    if (data.startsWith("vp_delete_")) { const id = data.replace("vp_delete_", ""); deleteProject(getProject(id)); return showVideoProjectsMenu(chatId, msgId); }
    if (data.startsWith("vp_hist_")) return showProjectHistory(chatId, data.replace("vp_hist_", ""), msgId);
    if (data.startsWith("vp_addrefs_")) { const id = data.replace("vp_addrefs_", ""); s.selectedProjectId = id; s.step = "vp_add_refs"; return editOrSend(chatId, msgId, `📸 Отправь до ${MAX_PROJECT_REFS} reference images для проекта.`, { inline_keyboard: [[{ text: "Готово", callback_data: `vp_status_${id}` }]] }); }
    if (data.startsWith("vp_setmodel_")) return showProjectModelMenu(chatId, data.replace("vp_setmodel_", ""), msgId, "vp_model");
    if (data.startsWith("vp_setlimit_")) return showProjectLimitMenu(chatId, data.replace("vp_setlimit_", ""), msgId, "vp_limit");
    if (data.startsWith("vp_model|")) { const [, projectId, modelKey] = data.split("|"); const p = getProject(projectId); if (p && VIDEO_MODELS[modelKey]) { p.model = modelKey; saveVideoProjects(); } return showProjectStatus(chatId, projectId, msgId); }
    if (data.startsWith("vp_limit|")) { const [, projectId, limitRaw] = data.split("|"); const p = getProject(projectId); if (p && PROJECT_HOURLY_LIMITS.includes(Number(limitRaw))) { p.hourlyLimit = Number(limitRaw); saveVideoProjects(); } return showProjectStatus(chatId, projectId, msgId); }
    if (data.startsWith("vp_clearrefs_")) { const id = data.replace("vp_clearrefs_", ""); const p = getProject(id); if (p) { p.defaultRefs = []; saveVideoProjects(); } return showProjectSettings(chatId, msgId); }
    if (data.startsWith("vp_sendhist_")) { const m = data.match(/^vp_sendhist_(.+)_(\d+)$/); if (m) { const p = getProject(m[1]); const item = p?.history?.[Number(m[2])]; return sendProjectHistoryItem(chatId, item, `vp_hist_${m[1]}`); } }
    if (data.startsWith("vp_globalhist_")) { const idx = Number(data.replace("vp_globalhist_", "")); const item = (videoProjectHistory[String(chatId)] || [])[idx]; return sendProjectHistoryItem(chatId, item, "vp_history"); }
  } catch (e) {
    console.error("[callback]", e);
    await bot.sendMessage(chatId, `❌ Ошибка: ${stripRefundFlag(e.message).slice(0, 500)}`).catch(() => {});
  }
});

bot.on("photo", async (msg) => {
  const chatId = msg.chat.id;
  const s = getState(chatId);
  const fileId = msg.photo[msg.photo.length - 1].file_id;

  try {
    if (s.step === "await_refs") {
      if (s.pendingRefImages.length >= 7) return bot.sendMessage(chatId, "❌ Максимум 7 reference images.");
      const ref = await tgPhotoToRef(fileId);
      s.pendingRefImages.push(ref);
      return bot.sendMessage(chatId, `✅ Reference image добавлен: ${s.pendingRefImages.length}/7`);
    }

    if (s.step === "batch_photos") {
      const ref = await tgPhotoToRef(fileId);
      s.batchPhotos.push(ref);
      return bot.sendMessage(chatId, `✅ Фото добавлено в batch: ${s.batchPhotos.length}`);
    }

    if (s.step === "vp_add_refs") {
      const project = getProject(s.selectedProjectId);
      if (!project) return bot.sendMessage(chatId, "❌ Проект не найден.");
      const model = VIDEO_MODELS[project.model];
      if (!model?.opImg) return bot.sendMessage(chatId, `❌ ${model?.label || project.model} не поддерживает reference images.`);
      if (project.defaultRefs.length >= MAX_PROJECT_REFS) return bot.sendMessage(chatId, `❌ Максимум ${MAX_PROJECT_REFS} refs.`);
      const ref = await tgPhotoToRef(fileId);
      project.defaultRefs.push(ref);
      saveVideoProjects();
      return bot.sendMessage(chatId, `✅ Ref добавлен в project: ${project.defaultRefs.length}/${MAX_PROJECT_REFS}`);
    }
  } catch (e) {
    return bot.sendMessage(chatId, `❌ Ошибка загрузки фото: ${e.message}`);
  }
});

bot.on("document", async (msg) => {
  const chatId = msg.chat.id;
  const s = getState(chatId);

  try {
    if (s.step === "batch_from_file") {
      const prompts = await importPromptsFromDocument(msg);
      const before = s.batchPrompts.length;
      s.batchPrompts.push(...prompts);
      s.batchPromptIdx = 0;
      s.step = null;
      await bot.sendMessage(chatId, `✅ Импортировано: ${s.batchPrompts.length - before} prompts.`);
      return showBatchMenu(chatId);
    }

    if (s.step === "vp_wait_file") {
      const prompts = await importPromptsFromDocument(msg);
      if (!prompts.length) return bot.sendMessage(chatId, "❌ Файл не содержит prompts.");
      return createVideoProjectFromPending(chatId, prompts);
    }
  } catch (e) {
    return bot.sendMessage(chatId, `❌ Ошибка импорта: ${e.message}`);
  }
});

bot.on("message", async (msg) => {
  if (!msg.text || msg.text.startsWith("/")) return;
  const chatId = msg.chat.id;
  const text = msg.text.trim();
  const s = getState(chatId);

  try {
    if (text === "📊 Project Status") {
      const p = getActiveChatProject(chatId);
      if (!p) return bot.sendMessage(chatId, "📭 Нет Video Projects.");
      return showProjectStatus(chatId, p.id);
    }

    if (s.step === "await_prompt") {
      s.step = null;
      return runNormal(chatId, s, text);
    }

    if (s.step === "batch_add_text") {
      const lines = text.split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
      s.batchPrompts.push(...lines);
      s.batchPromptIdx = 0;
      s.step = null;
      await bot.sendMessage(chatId, `✅ Добавлено prompts: ${lines.length}`);
      return showBatchMenu(chatId);
    }

    if (s.step === "vp_new_name") {
      s.pendingProject = s.pendingProject || {};
      s.pendingProject.name = text.slice(0, 80);
      s.step = "vp_new_model";
      return showProjectModelMenu(chatId, null, null, "vp_newmodel");
    }
  } catch (e) {
    await bot.sendMessage(chatId, `❌ Ошибка: ${stripRefundFlag(e.message).slice(0, 500)}`);
  }
});

// ─────────────────────────────────────────────────────────────
// Startup recovery
// ─────────────────────────────────────────────────────────────
recoverVideoProjectsOnStartup();
setInterval(() => processVideoProjects().catch((e) => console.error(e)), 60 * 1000);
processVideoProjects().catch((e) => console.error(e));

console.log("FastGen bot started. Video Projects processor enabled.");
