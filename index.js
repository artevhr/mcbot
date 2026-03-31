// версия v3.0
// Minecraft Discord Bot — ИИ-агент на OpenRouter + навигация + добыча ресурсов

require('dotenv').config();
const {
  Client, GatewayIntentBits, EmbedBuilder,
  ActionRowBuilder, ButtonBuilder, ButtonStyle, ActivityType, MessageFlags,
} = require('discord.js');
const mineflayer = require('mineflayer');
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder');
const { GoalNear, GoalBlock } = goals;

// ─── Конфиг ──────────────────────────────────────────────────────────────────
const MC_HOST    = process.env.MC_HOST    || 'n42.joinserver.xyz';
const MC_PORT    = Number(process.env.MC_PORT) || 25805;
const MC_VERSION = process.env.MC_VERSION || '1.20.1';

// OpenRouter: ключ и модель
const OR_KEY     = process.env.OPENROUTER_API_KEY || '';
// Бесплатные модели на OpenRouter (можно менять в .env):
// deepseek/deepseek-chat-v3-0324:free  — умная, чуть медленнее
// meta-llama/llama-4-scout:free        — быстрая
// google/gemma-3-27b-it:free           — хорошее понимание
const OR_MODEL   = process.env.OR_MODEL || 'deepseek/deepseek-chat-v3-0324:free';

// ─── Стейт ───────────────────────────────────────────────────────────────────
let mc            = null;
let connected     = false;
let mcName        = '';
let logChanId     = process.env.LOG_CHANNEL_ID    || '';
let bridgeChanId  = process.env.BRIDGE_CHANNEL_ID || '';

let chatOn        = true;
let eventsOn      = true;
let antiFkOn      = false;
let autoEatOn     = false;
let autoReconnOn  = false;
let antiFkTimer   = null;

let aiOn          = false;   // ИИ-режим вкл/выкл
let aiCooldown    = false;   // блокировка пока ИИ думает

let followTarget  = null;
let followTimer   = null;
let sneaking      = false;

let taskAbort     = false;   // сигнал отмены текущей задачи ИИ
let currentTask   = null;    // описание текущей задачи

let lastHpWarn    = Infinity;
let lastBridgeMsg = '';

// История чата для контекста ИИ
const chatHistory = [];
const MAX_HISTORY = 12;
function pushHistory(username, message) {
  chatHistory.push({ username, message });
  if (chatHistory.length > MAX_HISTORY) chatHistory.shift();
}

// ─── Discord ─────────────────────────────────────────────────────────────────
// Важно: включи MESSAGE CONTENT INTENT в Discord Developer Portal!
const discord = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

// ─── Цвета ───────────────────────────────────────────────────────────────────
const COL = {
  green: 0x57F287, red: 0xED4245, blue: 0x5865F2,
  yellow: 0xFEE75C, orange: 0xE67E22, purple: 0x9B59B6,
  teal: 0x1ABC9C, gray: 0x95A5A6, ai: 0x7289DA,
};

// ─── Утилиты ─────────────────────────────────────────────────────────────────
const logChan    = () => logChanId    ? discord.channels.cache.get(logChanId)    ?? null : null;
const bridgeChan = () => bridgeChanId ? discord.channels.cache.get(bridgeChanId) ?? null : null;

function embed(color, title, desc = null, fields = []) {
  const e = new EmbedBuilder().setColor(color).setTitle(title).setTimestamp();
  if (desc)          e.setDescription(String(desc).slice(0, 4000));
  if (fields.length) e.addFields(fields);
  return e;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ─── ИИ: системный промпт ────────────────────────────────────────────────────
function buildSystemPrompt() {
  if (!mc || !connected) return '';

  const pos  = mc.entity?.position;
  const inv  = mc.inventory.items().map(i => `${i.name}×${i.count}`).join(', ') || 'пусто';

  const nearPlayers = Object.values(mc.players || {})
    .filter(p => p.username !== mc.username && p.entity?.position)
    .map(p => {
      const dx = p.entity.position.x - (pos?.x ?? 0);
      const dz = p.entity.position.z - (pos?.z ?? 0);
      return `${p.username} (${Math.sqrt(dx*dx + dz*dz).toFixed(0)} бл)`;
    }).join(', ') || 'никого рядом';

  const ticks = mc.time?.timeOfDay ?? 0;
  const hour  = Math.floor(((ticks + 6000) % 24000) / 1000);
  const timeStr = hour >= 6 && hour < 18 ? `${hour}:00 День` : `${hour}:00 Ночь`;

  const weather = (mc.thunderState ?? 0) > 0.5 ? 'гроза' : mc.isRaining ? 'дождь' : 'ясно';

  return `Ты — Minecraft игрок с ником ${mc.username}. Ты живой персонаж на сервере с друзьями. Говоришь как обычный игрок, кратко, иногда используешь сленг. Ты умный, полезный и дружелюбный.

ТВОЁ СОСТОЯНИЕ:
- Позиция: X=${pos?.x.toFixed(0)} Y=${pos?.y.toFixed(0)} Z=${pos?.z.toFixed(0)}
- HP: ${((mc.health ?? 20) / 2).toFixed(1)}/10 ❤️   Еда: ${mc.food ?? 20}/20
- Инвентарь: ${inv}
- Игроки рядом: ${nearPlayers}
- Время: ${timeStr}, погода: ${weather}

ПОСЛЕДНИЕ СООБЩЕНИЯ В ЧАТЕ:
${chatHistory.map(m => `<${m.username}>: ${m.message}`).join('\n') || '(пусто)'}

ПРАВИЛА ОТВЕТА:
1. Отвечай ТОЛЬКО валидным JSON, без markdown, без \`\`\`
2. reply — короткий (1-2 предложения), как в МК чате, максимум 200 символов
3. Говори от первого лица, живо и по-игровому
4. Если просят принести/добыть — используй action "mine" или "give_item"
5. Если задача невозможна — честно скажи в reply, action = none

ДЕЙСТВИЯ (action.type):
- "none"          — только ответить в чат
- "follow"        — идти за игроком, params: { target: "ник" }
- "stop"          — остановиться, отменить задачу
- "goto_player"   — подойти к игроку, params: { target: "ник" }
- "mine"          — добыть ресурс и принести, params: { block: "название_без_minecraft:", count: 1, for_player: "ник" }
- "give_item"     — отдать предмет из инвентаря, params: { target: "ник", item: "название" }
- "collect_items" — подобрать дропы рядом
- "eat"           — съесть еду
- "look_at"       — посмотреть на игрока, params: { target: "ник" }
- "jump"          — прыгнуть
- "open_chest"    — открыть ближайший сундук и сообщить содержимое
- "build"         — строить

Примеры названий блоков: oak_log, birch_log, stone, cobblestone, coal_ore, iron_ore, gold_ore, diamond_ore, sand, gravel, dirt, oak_leaves, wheat, carrot, potato

ФОРМАТ ОТВЕТА (строго):
{"reply":"текст","action":{"type":"тип","params":{}}}`;
}

// ─── ИИ: fallback-модели ─────────────────────────────────────────────────────
const FALLBACK_MODELS = [
  process.env.OR_MODEL || 'openrouter/free', // основная из переменной Railway
  'openrouter/free',   // retry #1
  'stepfun/step-3.5-flash:free',
  'meta-llama/llama-3.3-70b-instruct:free',
  'z-ai/glm-4.5-air:free',
];

async function callOpenRouter(model, systemPrompt, userContent) {
  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type':  'application/json',
      'Authorization': `Bearer ${OR_KEY}`,
      'HTTP-Referer':  'https://github.com/mc-discord-bot',
      'X-Title':       'MC Discord Bot',
    },
    body: JSON.stringify({
      model,
      max_tokens:  300,
      temperature: 0.7,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user',   content: userContent  },
      ],
    }),
  });

  if (res.status === 429 || res.status === 404 || res.status === 403 || res.status === 402) {
    const err = await res.text();
    console.warn(`[AI] ${res.status} на ${model}:`, err.slice(0, 120));
    throw Object.assign(new Error('unavailable'), { code: res.status });
  }

  if (!res.ok) {
    const err = await res.text();
    console.error(`[AI] ${res.status} на ${model}:`, err.slice(0, 200));
    throw new Error(`http_${res.status}`);
  }

  return res.json();
}

// ─── ИИ: вызов OpenRouter с авто-fallback ────────────────────────────────────
async function callAI(userMessage, username) {
  if (!OR_KEY) {
    return { reply: 'ИИ не настроен — добавь OPENROUTER_API_KEY', action: { type: 'none', params: {} } };
  }

  const systemPrompt = buildSystemPrompt();
  const userContent  = `${username} пишет тебе: ${userMessage}`;

  // НЕ дедуплицируем — openrouter/free повторяется намеренно для retry
  const models = FALLBACK_MODELS;
  let lastError = null;

  for (const model of models) {
    try {
      const data = await callOpenRouter(model, systemPrompt, userContent);
      const raw  = data.choices?.[0]?.message?.content?.trim() ?? '';
      console.log(`[AI] Ответ от ${model}:`, raw.slice(0, 100));

      if (!raw) {
        // Пустой ответ — пробуем следующую модель
        throw Object.assign(new Error('no_json'), { code: 'empty' });
      }

      const clean     = raw.replace(/```json\s*/g, '').replace(/```/g, '').trim();
      const jsonMatch = clean.match(/\{[\s\S]*\}/);

      if (!jsonMatch) {
        // Модель ответила plain text без JSON — используем как reply, action = none
        console.log(`[AI] Plain text от ${model}, используем как reply`);
        return {
          reply:  clean.slice(0, 255),
          action: { type: 'none', params: {} },
          model,
        };
      }

      const parsed = JSON.parse(jsonMatch[0]);

      // Если использовали не основную модель — сообщаем в лог
      if (model !== FALLBACK_MODELS[0]) {
        console.log(`[AI] Использован fallback: ${model}`);
        logChan()?.send({ embeds: [embed(COL.yellow, '⚠️ ИИ: fallback модель',
          `Основная модель была недоступна (429).\nИспользовано: \`${model}\``
        )] });
      }

      return {
        reply:  String(parsed.reply  ?? '...').slice(0, 255),
        action: parsed.action ?? { type: 'none', params: {} },
        model,
      };
    } catch (e) {
      lastError = e;
      if (e.code === 429 || e.code === 404 || e.code === 403 || e.code === 402 || e.message === 'no_json' || e.code === 'empty') {
        // недоступна или пустой ответ — пробуем следующую
        await new Promise(r => setTimeout(r, 500));
        continue;
      }
      // другая ошибка — логируем и пробуем следующую
      console.error(`[AI] Ошибка ${model}:`, e.message);
      continue;
    }
  }

  console.error('[AI] Все модели недоступны:', lastError?.message);
  return { reply: 'Все ИИ-модели сейчас перегружены, попробуй чуть позже', action: { type: 'none', params: {} } };
}

// ─── ИИ: выполнение действия ──────────────────────────────────────────────────
async function executeAction(action, requestedBy) {
  if (!mc || !connected || !action?.type || action.type === 'none') return;

  const { type, params = {} } = action;
  console.log(`[AI Action] ${type}`, params);
  currentTask = type;
  taskAbort   = false;

  logChan()?.send({ embeds: [embed(COL.ai, `🤖 ИИ: ${type}`,
    `Для **${requestedBy}** · \`${JSON.stringify(params)}\``
  )] });

  try {
    switch (type) {

      // ── Стоп ──────────────────────────────────────────────────────────────
      case 'stop':
        taskAbort = true;
        stopFollow();
        try { mc.pathfinder?.stop?.(); } catch {}
        ['forward','sprint','sneak'].forEach(k => mc.setControlState(k, false));
        mc.chat('Останавливаюсь.');
        break;

      // ── Простые действия ──────────────────────────────────────────────────
      case 'jump':
        mc.setControlState('jump', true);
        await sleep(300);
        mc.setControlState('jump', false);
        break;

      case 'eat':
        await tryEat();
        break;

      case 'look_at': {
        const t = mc.players[params.target]?.entity;
        if (t) mc.lookAt(t.position.offset(0, t.height ?? 1.8, 0));
        break;
      }

      case 'follow':
        startFollow(params.target);
        break;

      // ── Подойти к игроку ──────────────────────────────────────────────────
      case 'goto_player': {
        const p = mc.players[params.target]?.entity;
        if (!p?.position) { mc.chat(`Не вижу ${params.target}`); break; }
        mc.pathfinder.setMovements(new Movements(mc));
        await navTo(p.position.x, p.position.y, p.position.z, 2, 15000);
        break;
      }

      // ── Добыча ────────────────────────────────────────────────────────────
      case 'mine': {
        const blockName = String(params.block || 'oak_log').replace('minecraft:', '');
        const count     = Math.min(Number(params.count) || 1, 32);
        const forPlayer = params.for_player || null;

        mc.chat(`Иду за ${blockName}...`);
        let mined = 0;

        while (mined < count && !taskAbort) {
          // Ищем ближайший блок
          const block = mc.findBlock({
            matching: b => b.name === blockName,
            maxDistance: 80,
          });

          if (!block) {
            mc.chat(`Не нашёл ${blockName} поблизости :(`);
            break;
          }

          // Идём к нему
          mc.pathfinder.setMovements(new Movements(mc));
          const reached = await navTo(
            block.position.x, block.position.y, block.position.z, 1, 12000
          );
          if (!reached || taskAbort) break;

          // Копаем
          try {
            await mc.dig(block);
            mined++;
            console.log(`[AI Mine] ${mined}/${count} ${blockName}`);
          } catch { /* блок мог исчезнуть */ }

          await sleep(400);
        }

        if (taskAbort) break;

        if (mined === 0) { mc.chat(`Не вышло добыть ${blockName}`); break; }

        mc.chat(`Добыл ${mined}×${blockName}!`);

        // Несём игроку
        if (forPlayer) {
          await giveItemToPlayer(forPlayer, blockName);
        }

        break;
      }

      // ── Подобрать дропы ───────────────────────────────────────────────────
      case 'collect_items': {
        const itemName = params.item || null;
        const myPos    = mc.entity.position;

        const drops = Object.values(mc.entities)
          .filter(e => e.type === 'object' && e.objectType === 'Item')
          .sort((a, b) => a.position.distanceTo(myPos) - b.position.distanceTo(myPos))
          .slice(0, 5);

        if (!drops.length) { mc.chat('Ничего нет на земле'); break; }

        for (const drop of drops) {
          if (taskAbort) break;
          mc.pathfinder.setMovements(new Movements(mc));
          await navTo(drop.position.x, drop.position.y, drop.position.z, 1, 6000);
          await sleep(300);
        }
        break;
      }

      // ── Отдать предмет ────────────────────────────────────────────────────
      case 'give_item':
        await giveItemToPlayer(params.target, params.item);
        break;

      // ── Открыть сундук ────────────────────────────────────────────────────
      case 'open_chest': {
        // Ищем ближайший сундук в радиусе 5 блоков
        const chest = mc.findBlock({
          matching: b => b.name === 'chest' || b.name === 'trapped_chest' || b.name === 'barrel',
          maxDistance: 5,
        });
        if (!chest) { mc.chat('Нет сундука рядом...'); break; }
        mc.pathfinder.setMovements(new Movements(mc));
        await navTo(chest.position.x, chest.position.y, chest.position.z, 2, 6000);
        try {
          const container = await mc.openContainer(chest);
          const items = container.containerItems()
            .map(i => `${i.name}×${i.count}`).join(', ') || 'пусто';
          mc.chat(`В сундуке: ${items.slice(0, 200)}`);
          logChan()?.send({ embeds: [embed(COL.yellow, '📦 Открыл сундук',
            items.slice(0, 2000)
          )] });
          container.close();
        } catch { mc.chat('Не смог открыть сундук'); }
        break;
      }

      default:
        // Неизвестное действие — просто логируем, не крашим
        console.log(`[AI] Неизвестное действие: ${type}`);
    }
  } catch (e) {
    console.error('[AI Action Error]', e.message);
    mc.chat('Что-то пошло не так...');
  } finally {
    currentTask = null;
  }
}

// Навигация с таймаутом, возвращает true если дошёл
function navTo(x, y, z, range, timeout) {
  return new Promise((resolve) => {
    if (!mc || !connected) return resolve(false);
    mc.pathfinder.setGoal(new GoalNear(x, y, z, range));
    const timer = setTimeout(() => {
      try { mc.pathfinder.stop(); } catch {}
      resolve(false);
    }, timeout);
    const done = (ok) => {
      clearTimeout(timer);
      mc.removeListener('goal_reached', onReach);
      mc.removeListener('path_stop',    onStop);
      resolve(ok);
    };
    const onReach = () => done(true);
    const onStop  = () => done(false);
    mc.once('goal_reached', onReach);
    mc.once('path_stop',    onStop);
  });
}

async function giveItemToPlayer(playerName, itemName) {
  if (!mc || !connected) return;

  const target = mc.players[playerName]?.entity;
  if (!target?.position) { mc.chat(`Не вижу ${playerName}`); return; }

  mc.chat(`Несу тебе, ${playerName}!`);
  mc.pathfinder.setMovements(new Movements(mc));
  await navTo(target.position.x, target.position.y, target.position.z, 2, 12000);

  const item = mc.inventory.items().find(i =>
    i.name.includes(itemName) || itemName.includes(i.name)
  );

  if (!item) { mc.chat(`У меня нет ${itemName}...`); return; }

  try {
    await mc.toss(item.type, null, item.count);
    mc.chat(`Держи! ${item.name} ×${item.count} 🎁`);
  } catch {
    mc.chat('Не смог бросить предмет...');
  }
}

// ─── Авто-функции ─────────────────────────────────────────────────────────────
function startAntiFk() {
  stopAntiFk(); antiFkOn = true;
  antiFkTimer = setInterval(() => {
    if (!mc || !connected) return;
    mc.look(mc.entity.yaw + (Math.random() - 0.5) * 0.4, 0, false);
    mc.setControlState('jump', true);
    setTimeout(() => { if (mc) mc.setControlState('jump', false); }, 350);
  }, 25000);
}
function stopAntiFk() {
  antiFkOn = false;
  if (antiFkTimer) { clearInterval(antiFkTimer); antiFkTimer = null; }
}

function startFollow(targetName) {
  stopFollow(); followTarget = targetName;
  followTimer = setInterval(() => {
    if (!mc || !connected || !followTarget) { stopFollow(); return; }
    const t = mc.players[followTarget]?.entity;
    if (!t?.position) return;
    const myPos = mc.entity.position;
    const dist  = Math.hypot(t.position.x - myPos.x, t.position.z - myPos.z);
    mc.lookAt(t.position.offset(0, t.height ?? 1.8, 0));
    mc.setControlState('forward', dist > 3);
    mc.setControlState('sprint',  dist > 7);
  }, 120);
}
function stopFollow() {
  followTarget = null;
  if (followTimer) { clearInterval(followTimer); followTimer = null; }
  if (mc && connected) ['forward', 'sprint'].forEach(k => mc.setControlState(k, false));
}

async function tryEat() {
  if (!mc || !connected || mc.food >= 18) return;
  const foods = ['cooked_beef','cooked_porkchop','cooked_mutton','cooked_chicken',
    'cooked_salmon','bread','apple','carrot','baked_potato','golden_apple','mushroom_stew'];
  for (const name of foods) {
    const item = mc.inventory.items().find(i => i.name === name);
    if (item) {
      try { await mc.equip(item, 'hand'); await mc.consume(); } catch {}
      return;
    }
  }
}

// ─── Minecraft: подключение ───────────────────────────────────────────────────
function connectMC(username) {
  if (mc) { try { mc.quit(); } catch {} mc = null; connected = false; }
  mcName = username; lastHpWarn = Infinity; taskAbort = true;
  stopFollow(); stopAntiFk(); sneaking = false;

  mc = mineflayer.createBot({
    host: MC_HOST, port: MC_PORT, username,
    version: MC_VERSION, auth: 'offline', hideErrors: false,
  });

  bindMCEvents();
}

// ─── Minecraft: события ───────────────────────────────────────────────────────
function bindMCEvents() {
  mc.once('spawn', () => {
    connected = true;
    taskAbort = false;
    mc.loadPlugin(pathfinder);
    mc.pathfinder.setMovements(new Movements(mc));
    console.log(`[MC] ✅ Зашёл как ${mc.username}`);
    logChan()?.send({ embeds: [embed(COL.green, '✅ Бот в игре',
      `\`${mc.username}\` → \`${MC_HOST}:${MC_PORT}\`` +
      (aiOn ? '\n\n🤖 **ИИ-режим активен** — пиши `ИИ ...` в чате МК' : '')
    )] });
    if (bridgeChanId) bridgeChan()?.send(`> 🟢 **${mc.username}** зашёл на сервер`);
  });

  // ── Чат → ИИ + Дискорд ──────────────────────────────────────────────────
  mc.on('chat', async (username, message) => {
    if (username === mc?.username) return;

    pushHistory(username, message);
    console.log(`[Chat] <${username}> ${message}`);

    if (chatOn)
      logChan()?.send({ embeds: [embed(COL.blue, '💬 Чат', `**${username}**: ${message}`)] });

    const key = `${username}:${message}`;
    if (bridgeChanId && key !== lastBridgeMsg)
      bridgeChan()?.send(`**${username}**: ${message}`);

    if (eventsOn && message.includes('has made the advancement'))
      logChan()?.send({ embeds: [embed(COL.yellow, '🏆 Достижение!', `**${username}**: ${message}`)] });

    // ── ИИ ──────────────────────────────────────────────────────────────
    if (!aiOn) return;
    if (!message.toLowerCase().startsWith('ии ')) return;

    if (aiCooldown) { mc.chat('Подожди, ещё думаю...'); return; }
    if (!OR_KEY)    { mc.chat('ИИ не настроен (нет OPENROUTER_API_KEY)'); return; }

    const userMsg = message.slice(3).trim();
    if (!userMsg) return;

    aiCooldown = true;
    mc.chat(`${username}, думаю...`);
    logChan()?.send({ embeds: [embed(COL.ai, '🧠 ИИ думает...', `**${username}**: ${userMsg}`)] });

    try {
      const { reply, action } = await callAI(userMsg, username);

      if (reply) mc.chat(reply);

      logChan()?.send({ embeds: [embed(COL.ai, '🤖 ИИ ответил', null, [
        { name: '👤 Запрос',    value: `**${username}**: ${userMsg}`,              inline: false },
        { name: '💬 Ответ',     value: reply || '—',                               inline: false },
        { name: '⚙️ Действие',  value: `\`${action.type}\` ${JSON.stringify(action.params)}`, inline: false },
        { name: '🧩 Модель',    value: `\`${OR_MODEL}\``,                          inline: false },
      ])] });

      if (action.type && action.type !== 'none')
        executeAction(action, username).catch(e => console.error('[Action]', e));

    } catch (e) {
      console.error('[AI]', e);
      mc.chat('Ой, ошибка ИИ...');
    } finally {
      aiCooldown = false;
    }
  });

  // ── Системные сообщения (AuthMe) ────────────────────────────────────────
  mc.on('message', (jsonMsg, pos) => {
    if (pos === 'game_info') return;
    const text  = jsonMsg.toString().trim();
    if (!text) return;
    const lower = text.toLowerCase();
    if (lower.includes('password') || lower.includes('пароль') ||
        lower.includes('/login')   || lower.includes('/l ')    ||
        lower.includes('authme')   || lower.includes('/register')) {
      logChan()?.send({ embeds: [embed(COL.yellow, '🔑 Пароль!',
        `\`\`\`${text.slice(0, 400)}\`\`\`\n➜ \`/passw /l пароль\``
      )] });
    }
  });

  mc.on('whisper', (username, message) => {
    logChan()?.send({ embeds: [embed(COL.purple, `🔔 Шёпот от ${username}`, message)] });
    pushHistory(username, `(шёпот) ${message}`);
  });

  mc.on('playerJoined', (player) => {
    if (!eventsOn || player.username === mc?.username) return;
    logChan()?.send({ embeds: [embed(COL.green, '📥 Вошёл', `**${player.username}**`)] });
    if (bridgeChanId) bridgeChan()?.send(`> 📥 **${player.username}** зашёл`);
  });

  mc.on('playerLeft', (player) => {
    if (!eventsOn) return;
    logChan()?.send({ embeds: [embed(COL.orange, '📤 Вышел', `**${player.username}**`)] });
    if (bridgeChanId) bridgeChan()?.send(`> 📤 **${player.username}** вышел`);
    if (followTarget === player.username) stopFollow();
  });

  mc.on('death', () => {
    taskAbort = true; currentTask = null;
    logChan()?.send({ embeds: [embed(COL.red, '💀 Бот погиб!', mc?.username)] });
    if (aiOn) mc.chat('Ай, умер... Возрождаюсь');
    setTimeout(() => { taskAbort = false; }, 3000);
  });

  mc.on('health', () => {
    if (autoEatOn) tryEat();
    const hp = mc?.health ?? 20;
    if (hp <= 6 && hp < lastHpWarn) {
      lastHpWarn = hp;
      if (aiOn) mc.chat(`Мне плохо, всего ${(hp/2).toFixed(1)} сердца...`);
      logChan()?.send({ embeds: [embed(COL.red, '⚠️ Мало HP!', `${(hp/2).toFixed(1)} ❤️`)] });
    }
    if (hp > 10) lastHpWarn = Infinity;
  });

  mc.on('windowOpen', (window) => {
    if (!eventsOn) return;
    let title = 'Контейнер';
    try { title = window.title?.toString() || window.type || 'Контейнер'; } catch {}
    const slots = (window.slots || []).filter(Boolean).map(s => `**${s.name}** ×${s.count}`);
    logChan()?.send({ embeds: [embed(COL.yellow, `📦 ${title.slice(0,80)}`,
      slots.length ? slots.join(' · ').slice(0, 3500) : '*Пусто*'
    )] });
  });

  mc.on('kicked', (reason) => {
    connected = false; taskAbort = true;
    stopFollow(); stopAntiFk();
    logChan()?.send({ embeds: [embed(COL.red, '🔴 Кик', `\`${String(reason).slice(0,300)}\``)] });
    if (bridgeChanId) bridgeChan()?.send('> 🔴 Бот кикнут');
    if (autoReconnOn && mcName) scheduleReconn();
  });

  mc.on('end', (reason) => {
    connected = false; taskAbort = true;
    stopFollow(); stopAntiFk();
    logChan()?.send({ embeds: [embed(COL.red, '🔴 Отключился',
      reason ? `\`${String(reason).slice(0,200)}\`` : 'Соединение разорвано'
    )] });
    if (bridgeChanId) bridgeChan()?.send('> 🔴 Бот отключился');
    if (autoReconnOn && mcName) scheduleReconn();
  });

  mc.on('error', (err) => console.error('[MC Error]', err.message));
}

function scheduleReconn() {
  logChan()?.send({ embeds: [embed(COL.yellow, '🔄 Авто-реконнект', 'Через 10 сек...')] });
  setTimeout(() => { if (!connected) connectMC(mcName); }, 10000);
}

// ─── Bridge: Дискорд → МК ────────────────────────────────────────────────────
discord.on('messageCreate', (msg) => {
  if (msg.author.bot) return;
  if (!bridgeChanId || msg.channel.id !== bridgeChanId) return;
  if (!mc || !connected) return;
  const text = `[DC] ${msg.member?.displayName ?? msg.author.username}: ${msg.content}`;
  lastBridgeMsg = `${msg.member?.displayName ?? msg.author.username}:${msg.content}`;
  mc.chat(text.slice(0, 255));
});

// ─── Embeds: статус ───────────────────────────────────────────────────────────
function buildStatusEmbed() {
  if (!mc || !connected) return embed(COL.red, '🔴 Офлайн', `\`${MC_HOST}:${MC_PORT}\``);
  const pos  = mc.entity?.position;
  const hp   = mc.health   != null ? `${(mc.health/2).toFixed(1)} ❤️` : '—';
  const food = mc.food     != null ? `${mc.food} 🍗` : '—';
  const xp   = mc.experience?.level != null ? `Ур. ${mc.experience.level}` : '—';
  const coords = pos
    ? `X \`${pos.x.toFixed(1)}\` · Y \`${pos.y.toFixed(1)}\` · Z \`${pos.z.toFixed(1)}\`` : '—';
  const flags = [
    `Anti-AFK: ${antiFkOn?'✅':'❌'}`, `Авто-еда: ${autoEatOn?'✅':'❌'}`,
    `Авто-реконн: ${autoReconnOn?'✅':'❌'}`,
    `🤖 ИИ: ${aiOn?'✅ ВКЛ':'❌ ВЫКЛ'}`,
    followTarget ? `Следую: \`${followTarget}\`` : null,
    sneaking     ? '🟡 Сникает'        : null,
    bridgeChanId ? '🌉 Бридж вкл'      : null,
    currentTask  ? `⚙️ Задача: ${currentTask}` : null,
  ].filter(Boolean).join(' · ');
  return embed(COL.green, '🟢 Бот онлайн', null, [
    { name: '👤 Ник',        value: `\`${mcName}\``,              inline: true  },
    { name: '❤️ HP',         value: hp,                           inline: true  },
    { name: '🍗 Еда',        value: food,                         inline: true  },
    { name: '⭐ Опыт',       value: xp,                           inline: true  },
    { name: '👥 Онлайн',     value: `${Object.keys(mc.players||{}).length}`, inline: true },
    { name: '🌍 Сервер',     value: `\`${MC_HOST}:${MC_PORT}\``, inline: true  },
    { name: '📍 Координаты', value: coords,                       inline: false },
    { name: '🤖 Состояние',  value: flags || '—',                 inline: false },
  ]);
}

function buildButtons() {
  const d = !connected;
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('btn_refresh').setLabel('🔄').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('btn_coords').setLabel('📍 Коорды').setStyle(ButtonStyle.Primary).setDisabled(d),
    new ButtonBuilder().setCustomId('btn_players').setLabel('👥 Игроки').setStyle(ButtonStyle.Primary).setDisabled(d),
    new ButtonBuilder().setCustomId('btn_inventory').setLabel('🎒 Инвентарь').setStyle(ButtonStyle.Primary).setDisabled(d),
    new ButtonBuilder().setCustomId('btn_leave').setLabel('❌ Откл').setStyle(ButtonStyle.Danger).setDisabled(d),
  );
}

function buildAutoButtons() {
  const d = !connected;
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('btn_antifk').setLabel(`Anti-AFK ${antiFkOn?'✅':'❌'}`)
      .setStyle(antiFkOn ? ButtonStyle.Success : ButtonStyle.Secondary).setDisabled(d),
    new ButtonBuilder()
      .setCustomId('btn_autoeat').setLabel(`Авто-еда ${autoEatOn?'✅':'❌'}`)
      .setStyle(autoEatOn ? ButtonStyle.Success : ButtonStyle.Secondary).setDisabled(d),
    new ButtonBuilder()
      .setCustomId('btn_autoreconn').setLabel(`Авто-реконн ${autoReconnOn?'✅':'❌'}`)
      .setStyle(autoReconnOn ? ButtonStyle.Success : ButtonStyle.Secondary).setDisabled(d),
    new ButtonBuilder()
      .setCustomId('btn_ai').setLabel(`🤖 ИИ ${aiOn?'✅':'❌'}`)
      .setStyle(aiOn ? ButtonStyle.Success : ButtonStyle.Secondary).setDisabled(d),
    new ButtonBuilder()
      .setCustomId('btn_near').setLabel('🔭 Рядом').setStyle(ButtonStyle.Primary).setDisabled(d),
  );
}

function buildPlayersEmbed() {
  if (!mc || !connected) return embed(COL.red, '❌', 'Бот не подключён');
  const list = Object.values(mc.players || {})
    .map((p, i) => `\`${i+1}.\` **${p.username}**${p.ping != null ? ` · ${p.ping}ms` : ''}`);
  return embed(COL.blue, `👥 Онлайн: ${list.length}`, list.join('\n') || '*Никого нет*');
}

function buildInventoryEmbed() {
  if (!mc || !connected) return embed(COL.red, '❌', 'Бот не подключён');
  const items = mc.inventory.items();
  if (!items.length) return embed(COL.yellow, '🎒 Инвентарь', '*Пуст*');
  return embed(COL.purple, '🎒 Инвентарь',
    items.map(it => `• **${it.name}** × ${it.count}${it.nbt?' 🏷️':''}`).join('\n').slice(0,4000));
}

function buildCoordsEmbed() {
  if (!mc || !connected) return embed(COL.red, '❌', 'Бот не подключён');
  const p = mc.entity?.position;
  if (!p) return embed(COL.red, '❌', 'Координаты недоступны');
  return embed(COL.blue, '📍 Координаты', null, [
    { name: 'X', value: `\`${p.x.toFixed(2)}\``, inline: true },
    { name: 'Y', value: `\`${p.y.toFixed(2)}\``, inline: true },
    { name: 'Z', value: `\`${p.z.toFixed(2)}\``, inline: true },
  ]);
}

function buildNearEmbed() {
  if (!mc || !connected) return embed(COL.red, '❌', 'Бот не подключён');
  const myPos = mc.entity?.position;
  if (!myPos) return embed(COL.red, '❌', 'Позиция недоступна');
  const players = Object.values(mc.players || {})
    .filter(p => p.username !== mc.username && p.entity?.position)
    .map(p => {
      const dist = Math.hypot(p.entity.position.x - myPos.x, p.entity.position.z - myPos.z);
      return { name: p.username, dist };
    })
    .sort((a, b) => a.dist - b.dist);
  if (!players.length) return embed(COL.yellow, '🔭 Рядом никого', '');
  return embed(COL.teal, `🔭 Ближайшие (${players.length})`,
    players.map((p, i) => `\`${i+1}.\` **${p.name}** — \`${p.dist.toFixed(1)}\` бл.`).join('\n'));
}

function buildWorldEmbed() {
  if (!mc || !connected) return embed(COL.red, '❌', 'Бот не подключён');
  const ticks = mc.time?.timeOfDay ?? 0;
  const h  = Math.floor(((ticks + 6000) % 24000) / 1000);
  const m  = Math.floor(((ticks + 6000) % 1000) * 0.06);
  const weather = (mc.thunderState ?? 0) > 0.5 ? '⛈️ Гроза' : mc.isRaining ? '🌧️ Дождь' : '☀️ Ясно';
  return embed(COL.teal, '🌍 Мир', null, [
    { name: '🕐 Время',  value: `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')} ${h>=6&&h<18?'☀️ День':'🌙 Ночь'}`, inline: true },
    { name: '🌤️ Погода', value: weather, inline: true },
  ]);
}

// ─── Discord: Ready ───────────────────────────────────────────────────────────
discord.once('clientReady', () => {
  console.log(`[Discord] ✅ ${discord.user.tag}`);
  console.log(`[AI] Модель: ${OR_MODEL}`);
  if (!OR_KEY) console.warn('[AI] ⚠️ OPENROUTER_API_KEY не задан — ИИ не будет работать');
  discord.user.setActivity('Minecraft', { type: ActivityType.Playing });
});

// ─── Discord: Interactions ────────────────────────────────────────────────────
discord.on('interactionCreate', async (interaction) => {
  try {
    if      (interaction.isChatInputCommand()) await handleCommand(interaction);
    else if (interaction.isButton())           await handleButton(interaction);
  } catch (e) {
    console.error('[Interaction]', e);
    const reply = { content: `❌ Ошибка: \`${e.message}\``, flags: MessageFlags.Ephemeral };
    if (interaction.replied || interaction.deferred) interaction.followUp(reply).catch(() => {});
    else                                             interaction.reply(reply).catch(() => {});
  }
});

// ─── Команды ─────────────────────────────────────────────────────────────────
async function handleCommand(interaction) {
  const cmd = interaction.commandName;

  // ── Подключение ──────────────────────────────────────────────────────────
  if (cmd === 'join') {
    if (connected) return interaction.reply({ content: '❌ Бот уже в игре.', flags: MessageFlags.Ephemeral });
    const nick = interaction.options.getString('nick');
    await interaction.reply({ embeds: [embed(COL.yellow, '⏳ Подключение...', `Захожу как \`${nick}\`...`)] });
    connectMC(nick);
    return;
  }
  if (cmd === 'leave') {
    if (!mc || !connected) return interaction.reply({ content: '❌ Не подключён.', flags: MessageFlags.Ephemeral });
    autoReconnOn = false; taskAbort = true;
    mc.quit(); mc = null; connected = false;
    return interaction.reply({ embeds: [embed(COL.red, '🔴 Отключён', 'Бот покинул сервер.')] });
  }
  if (cmd === 'reconnect') {
    if (!mcName) return interaction.reply({ content: '❌ Нет ника. Используй `/join`.', flags: MessageFlags.Ephemeral });
    if (mc) { try { mc.quit(); } catch {} mc = null; connected = false; }
    await interaction.reply({ embeds: [embed(COL.yellow, '🔄 Реконнект', `\`${mcName}\`...`)] });
    connectMC(mcName);
    return;
  }

  // ── Чат ──────────────────────────────────────────────────────────────────
  if (cmd === 'type') {
    if (!mc || !connected) return interaction.reply({ content: '❌ Бот не в игре.', flags: MessageFlags.Ephemeral });
    const message = interaction.options.getString('message');
    mc.chat(message.slice(0, 255));
    return interaction.reply({ embeds: [embed(COL.green, '✉️ Отправлено', `\`${message}\``)] });
  }
  if (cmd === 'passw') {
    if (!mc || !connected) return interaction.reply({ content: '❌ Бот не в игре.', flags: MessageFlags.Ephemeral });
    mc.chat(interaction.options.getString('command').slice(0, 255));
    return interaction.reply({ embeds: [embed(COL.green, '🔑 Отправлено', '✓')], flags: MessageFlags.Ephemeral });
  }

  // ── Инфо ─────────────────────────────────────────────────────────────────
  if (cmd === 'status') {
    return interaction.reply({ embeds: [buildStatusEmbed()], components: [buildButtons(), buildAutoButtons()] });
  }
  if (cmd === 'players')   return interaction.reply({ embeds: [buildPlayersEmbed()] });
  if (cmd === 'inventory') return interaction.reply({ embeds: [buildInventoryEmbed()] });
  if (cmd === 'coords')    return interaction.reply({ embeds: [buildCoordsEmbed()] });
  if (cmd === 'near')      return interaction.reply({ embeds: [buildNearEmbed()] });
  if (cmd === 'world') {
    if (!mc || !connected) return interaction.reply({ content: '❌ Бот не в игре.', flags: MessageFlags.Ephemeral });
    return interaction.reply({ embeds: [buildWorldEmbed()] });
  }

  // ── Управление ───────────────────────────────────────────────────────────
  if (cmd === 'jump') {
    if (!mc || !connected) return interaction.reply({ content: '❌ Бот не в игре.', flags: MessageFlags.Ephemeral });
    mc.setControlState('jump', true);
    setTimeout(() => { if (mc) mc.setControlState('jump', false); }, 300);
    return interaction.reply({ embeds: [embed(COL.green, '⬆️ Прыжок!')] });
  }
  if (cmd === 'sneak') {
    if (!mc || !connected) return interaction.reply({ content: '❌ Бот не в игре.', flags: MessageFlags.Ephemeral });
    sneaking = !sneaking; mc.setControlState('sneak', sneaking);
    return interaction.reply({ embeds: [embed(COL.teal, '🕵️ Сник', sneaking ? 'Крадётся.' : 'Встал прямо.')] });
  }
  if (cmd === 'eat') {
    if (!mc || !connected) return interaction.reply({ content: '❌ Бот не в игре.', flags: MessageFlags.Ephemeral });
    await interaction.deferReply();
    const before = mc.food; await tryEat();
    return interaction.editReply({ embeds: [embed(COL.green, '🍗 Поел',
      mc.food === before ? 'Нет еды или уже сыт.' : `${before} → ${mc.food} 🍗`
    )] });
  }
  if (cmd === 'drop') {
    if (!mc || !connected) return interaction.reply({ content: '❌ Бот не в игре.', flags: MessageFlags.Ephemeral });
    const itemName = interaction.options.getString('item');
    const item = mc.inventory.items().find(i => i.name.includes(itemName));
    if (!item) return interaction.reply({ content: `❌ \`${itemName}\` не найдено.`, flags: MessageFlags.Ephemeral });
    await mc.toss(item.type, null, item.count);
    return interaction.reply({ embeds: [embed(COL.orange, '🗑️ Выброшено', `**${item.name}** × ${item.count}`)] });
  }
  if (cmd === 'look') {
    if (!mc || !connected) return interaction.reply({ content: '❌', flags: MessageFlags.Ephemeral });
    const t = mc.players[interaction.options.getString('nick')]?.entity;
    if (!t) return interaction.reply({ content: '❌ Игрок не найден.', flags: MessageFlags.Ephemeral });
    mc.lookAt(t.position.offset(0, t.height ?? 1.8, 0));
    return interaction.reply({ embeds: [embed(COL.teal, '👀 Смотрит', `На **${interaction.options.getString('nick')}**`)] });
  }
  if (cmd === 'follow') {
    if (!mc || !connected) return interaction.reply({ content: '❌', flags: MessageFlags.Ephemeral });
    const nick = interaction.options.getString('nick');
    if (!mc.players[nick]) return interaction.reply({ content: '❌ Игрок не найден.', flags: MessageFlags.Ephemeral });
    startFollow(nick);
    return interaction.reply({ embeds: [embed(COL.teal, '🏃 Следую', `За **${nick}**`)] });
  }
  if (cmd === 'unfollow') {
    stopFollow();
    return interaction.reply({ embeds: [embed(COL.gray, '🛑 Стоп', 'Бот остановился.')] });
  }

  // ── ИИ ───────────────────────────────────────────────────────────────────
  if (cmd === 'ai') {
    const sub = interaction.options.getSubcommand();
    if (sub === 'on') {
      if (!OR_KEY) return interaction.reply({
        content: '❌ Нет `OPENROUTER_API_KEY` — добавь переменную в Railway/`.env`',
        flags: MessageFlags.Ephemeral,
      });
      aiOn = true;
      return interaction.reply({ embeds: [embed(COL.ai, '🤖 ИИ включён!',
        `Пиши в чате МК:\n\`ИИ что делаешь?\`\n\`ИИ принеси мне дерево\`\n\`ИИ иди за мной\`\n\n` +
        `Модель: \`${OR_MODEL}\``
      )] });
    }
    if (sub === 'off') {
      aiOn = false; taskAbort = true; aiCooldown = false;
      return interaction.reply({ content: '❌ **ИИ выключен**.' });
    }
    if (sub === 'model') {
      // Показать доступные бесплатные модели
      return interaction.reply({ embeds: [embed(COL.ai, '🧩 Бесплатные модели OpenRouter', null, [
        { name: 'Текущая', value: `\`${OR_MODEL}\``, inline: false },
        { name: 'Доступные (вставь в OR_MODEL в .env)', value:
          '`deepseek/deepseek-chat-v3-0324:free` — умная\n' +
          '`meta-llama/llama-4-scout:free` — быстрая\n' +
          '`google/gemma-3-27b-it:free` — хорошая\n' +
          '`microsoft/phi-3-mini-128k-instruct:free` — лёгкая',
          inline: false,
        },
      ])] });
    }
    if (sub === 'stop') {
      taskAbort = true; currentTask = null; aiCooldown = false;
      try { mc?.pathfinder?.stop?.(); } catch {}
      stopFollow();
      if (mc && connected) mc.chat('Стоп!');
      return interaction.reply({ content: '🛑 Текущая ИИ-задача отменена.' });
    }
  }

  // ── Авто-функции ─────────────────────────────────────────────────────────
  if (cmd === 'antifk') {
    if (interaction.options.getSubcommand() === 'on') { startAntiFk(); return interaction.reply({ content: '✅ Anti-AFK включён.' }); }
    stopAntiFk(); return interaction.reply({ content: '❌ Anti-AFK выключен.' });
  }
  if (cmd === 'autoeat') {
    autoEatOn = interaction.options.getSubcommand() === 'on';
    return interaction.reply({ content: autoEatOn ? '✅ Авто-еда включена.' : '❌ Авто-еда выключена.' });
  }
  if (cmd === 'autoreconn') {
    autoReconnOn = interaction.options.getSubcommand() === 'on';
    return interaction.reply({ content: autoReconnOn ? '✅ Авто-реконнект включён.' : '❌ Авто-реконнект выключен.' });
  }

  // ── Бридж ────────────────────────────────────────────────────────────────
  if (cmd === 'bridge') {
    const sub = interaction.options.getSubcommand();
    if (sub === 'set') {
      const ch = interaction.options.getChannel('channel');
      bridgeChanId = ch.id;
      return interaction.reply({ embeds: [embed(COL.teal, '🌉 Бридж', `${ch} привязан. ДС ↔ МК`)] });
    }
    bridgeChanId = '';
    return interaction.reply({ content: '❌ Бридж отключён.' });
  }

  if (cmd === 'chat') {
    chatOn = interaction.options.getSubcommand() === 'on';
    return interaction.reply({ content: chatOn ? '✅ Лог чата вкл.' : '🔇 Выкл.' });
  }
  if (cmd === 'events') {
    eventsOn = interaction.options.getSubcommand() === 'on';
    return interaction.reply({ content: eventsOn ? '✅ События вкл.' : '🔇 Выкл.' });
  }

  // ── Помощь ───────────────────────────────────────────────────────────────
  if (cmd === 'help') {
    return interaction.reply({ embeds: [embed(COL.blue, '📖 Команды', null, [
      { name: '🔌 Подключение', value: '`/join` `/leave` `/reconnect`', inline: false },
      { name: '💬 Чат',         value: '`/type` `/passw`', inline: false },
      { name: '📊 Инфо',        value: '`/status` `/players` `/inventory` `/coords` `/near` `/world`', inline: false },
      { name: '🎮 Управление',  value: '`/jump` `/sneak` `/eat` `/drop` `/look` `/follow` `/unfollow`', inline: false },
      { name: '🤖 ИИ-агент',    value: '`/ai on` `/ai off` `/ai stop` `/ai model`\nЗатем в МК чате: **ИИ принеси дерево**', inline: false },
      { name: '⚙️ Авто',        value: '`/antifk on/off` `/autoeat on/off` `/autoreconn on/off`', inline: false },
      { name: '🌉 Бридж',       value: '`/bridge set #канал` `/bridge off`', inline: false },
    ])] });
  }
}

// ─── Кнопки ──────────────────────────────────────────────────────────────────
async function handleButton(interaction) {
  const upd = () => interaction.update({
    embeds: [buildStatusEmbed()],
    components: [buildButtons(), buildAutoButtons()],
  });

  switch (interaction.customId) {
    case 'btn_refresh':   return upd();
    case 'btn_coords':    return interaction.reply({ embeds: [buildCoordsEmbed()],    flags: MessageFlags.Ephemeral });
    case 'btn_players':   return interaction.reply({ embeds: [buildPlayersEmbed()],   flags: MessageFlags.Ephemeral });
    case 'btn_inventory': return interaction.reply({ embeds: [buildInventoryEmbed()], flags: MessageFlags.Ephemeral });
    case 'btn_near':      return interaction.reply({ embeds: [buildNearEmbed()],      flags: MessageFlags.Ephemeral });
    case 'btn_leave':
      if (mc && connected) { autoReconnOn = false; taskAbort = true; mc.quit(); mc = null; connected = false; }
      return upd();
    case 'btn_antifk':
      if (antiFkOn) stopAntiFk(); else startAntiFk(); return upd();
    case 'btn_autoeat':
      autoEatOn = !autoEatOn; return upd();
    case 'btn_autoreconn':
      autoReconnOn = !autoReconnOn; return upd();
    case 'btn_ai':
      if (!aiOn && !OR_KEY) {
        return interaction.reply({ content: '❌ Нет `OPENROUTER_API_KEY`', flags: MessageFlags.Ephemeral });
      }
      aiOn = !aiOn;
      if (!aiOn) { taskAbort = true; aiCooldown = false; }
      return upd();
  }
}

// ─── Запуск ───────────────────────────────────────────────────────────────────
discord.login(process.env.DISCORD_TOKEN).catch((e) => {
  console.error('[Fatal]', e.message);
  process.exit(1);
});

// ─── Graceful shutdown ────────────────────────────────────────────────────────
async function shutdown(signal) {
  console.log(`[Shutdown] ${signal}`);
  taskAbort = true; stopFollow(); stopAntiFk();
  if (mc && connected) { try { mc.quit('shutdown'); } catch {} }
  try { await discord.destroy(); } catch {}
  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));
process.on('uncaughtException',  err    => console.error('[UncaughtException]',  err.message));
process.on('unhandledRejection', reason => console.error('[UnhandledRejection]', reason));
