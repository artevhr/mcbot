// версия v2.0
// Minecraft Discord Bot — управление МК ботом через Дискорд

require('dotenv').config();
const {
  Client,
  GatewayIntentBits,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ActivityType,
} = require('discord.js');
const mineflayer = require('mineflayer');

// ─── Конфиг ──────────────────────────────────────────────────────────────────
const GUILD_ID   = process.env.GUILD_ID   || '1123649588658700368';
const MC_HOST    = process.env.MC_HOST    || 'n42.joinserver.xyz';
const MC_PORT    = Number(process.env.MC_PORT) || 25805;
const MC_VERSION = process.env.MC_VERSION || '1.20.1';

// ─── Стейт ───────────────────────────────────────────────────────────────────
let mc            = null;
let connected     = false;
let mcName        = '';
let logChanId     = process.env.LOG_CHANNEL_ID    || '';
let bridgeChanId  = process.env.BRIDGE_CHANNEL_ID || '';

// Переключатели логов
let chatOn        = true;
let eventsOn      = true;

// Авто-функции
let antiFkOn      = false;
let autoEatOn     = false;
let autoReconnOn  = false;
let antiFkTimer   = null;

// Следование
let followTarget  = null;
let followTimer   = null;
let sneaking      = false;

// Дедупликация
let lastHpWarn    = Infinity;
let lastBridgeMsg = '';

// ─── Discord ─────────────────────────────────────────────────────────────────
// MessageContent — привилегированный интент, включи в Discord Developer Portal:
// Bot → Privileged Gateway Intents → MESSAGE CONTENT INTENT ✅
const discord = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

// ─── Цвета ───────────────────────────────────────────────────────────────────
const COL = {
  green:   0x57F287,
  red:     0xED4245,
  blue:    0x5865F2,
  yellow:  0xFEE75C,
  orange:  0xE67E22,
  purple:  0x9B59B6,
  teal:    0x1ABC9C,
  gray:    0x95A5A6,
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

// ─── Embeds ───────────────────────────────────────────────────────────────────
function buildStatusEmbed() {
  if (!mc || !connected) {
    return embed(COL.red, '🔴 Бот офлайн', `Не подключён к \`${MC_HOST}:${MC_PORT}\``);
  }
  const pos  = mc.entity?.position;
  const hp   = mc.health   != null ? `${(mc.health / 2).toFixed(1)} ❤️` : '—';
  const food = mc.food     != null ? `${mc.food} 🍗` : '—';
  const xp   = mc.experience?.level != null ? `Ур. ${mc.experience.level}` : '—';
  const coords = pos
    ? `X \`${pos.x.toFixed(1)}\` · Y \`${pos.y.toFixed(1)}\` · Z \`${pos.z.toFixed(1)}\``
    : '—';

  const autoFlags = [
    `Anti-AFK: ${antiFkOn ? '✅' : '❌'}`,
    `Авто-еда: ${autoEatOn ? '✅' : '❌'}`,
    `Авто-реконн: ${autoReconnOn ? '✅' : '❌'}`,
    followTarget ? `Следую: \`${followTarget}\`` : null,
    sneaking     ? '🟡 Сникает' : null,
    bridgeChanId ? '🌉 Бридж вкл' : null,
  ].filter(Boolean).join(' · ');

  return embed(COL.green, '🟢 Бот онлайн', null, [
    { name: '👤 Ник',        value: `\`${mcName}\``,              inline: true  },
    { name: '❤️ HP',         value: hp,                           inline: true  },
    { name: '🍗 Еда',        value: food,                         inline: true  },
    { name: '⭐ Опыт',       value: xp,                           inline: true  },
    { name: '👥 Онлайн',     value: `${Object.keys(mc.players || {}).length}`, inline: true },
    { name: '🌍 Сервер',     value: `\`${MC_HOST}:${MC_PORT}\``, inline: true  },
    { name: '📍 Координаты', value: coords,                       inline: false },
    { name: '🤖 Авто',       value: autoFlags || '—',             inline: false },
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
      .setCustomId('btn_antifk')
      .setLabel(`Anti-AFK ${antiFkOn ? '✅' : '❌'}`)
      .setStyle(antiFkOn ? ButtonStyle.Success : ButtonStyle.Secondary)
      .setDisabled(d),
    new ButtonBuilder()
      .setCustomId('btn_autoeat')
      .setLabel(`Авто-еда ${autoEatOn ? '✅' : '❌'}`)
      .setStyle(autoEatOn ? ButtonStyle.Success : ButtonStyle.Secondary)
      .setDisabled(d),
    new ButtonBuilder()
      .setCustomId('btn_autoreconn')
      .setLabel(`Авто-реконн ${autoReconnOn ? '✅' : '❌'}`)
      .setStyle(autoReconnOn ? ButtonStyle.Success : ButtonStyle.Secondary)
      .setDisabled(d),
    new ButtonBuilder()
      .setCustomId('btn_near')
      .setLabel('🔭 Рядом')
      .setStyle(ButtonStyle.Primary)
      .setDisabled(d),
    new ButtonBuilder()
      .setCustomId('btn_timeweather')
      .setLabel('🕐 Мир')
      .setStyle(ButtonStyle.Primary)
      .setDisabled(d),
  );
}

function buildPlayersEmbed() {
  if (!mc || !connected) return embed(COL.red, '❌', 'Бот не подключён');
  const list = Object.values(mc.players || {})
    .map((p, i) => `\`${i + 1}.\` **${p.username}**${p.ping != null ? ` · ${p.ping}ms` : ''}`);
  return embed(COL.blue, `👥 Онлайн: ${list.length}`, list.join('\n') || '*Никого нет*');
}

function buildInventoryEmbed() {
  if (!mc || !connected) return embed(COL.red, '❌', 'Бот не подключён');
  const items = mc.inventory.items();
  if (!items.length) return embed(COL.yellow, '🎒 Инвентарь', '*Пуст*');
  const lines = items.map(it => `• **${it.name}** × ${it.count}${it.nbt ? ' 🏷️' : ''}`);
  return embed(COL.purple, '🎒 Инвентарь бота', lines.join('\n').slice(0, 4000));
}

function buildCoordsEmbed() {
  if (!mc || !connected) return embed(COL.red, '❌', 'Бот не подключён');
  const p = mc.entity?.position;
  if (!p) return embed(COL.red, '❌', 'Координаты недоступны');
  return embed(COL.blue, '📍 Координаты бота', null, [
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
      const dx = p.entity.position.x - myPos.x;
      const dy = p.entity.position.y - myPos.y;
      const dz = p.entity.position.z - myPos.z;
      return { name: p.username, dist: Math.sqrt(dx * dx + dy * dy + dz * dz) };
    })
    .sort((a, b) => a.dist - b.dist);

  if (!players.length) return embed(COL.yellow, '🔭 Рядом никого', 'Нет игроков в зоне видимости');
  const lines = players.map((p, i) => `\`${i + 1}.\` **${p.name}** — \`${p.dist.toFixed(1)}\` бл.`);
  return embed(COL.teal, `🔭 Ближайшие (${players.length})`, lines.join('\n'));
}

function buildWorldEmbed() {
  if (!mc || !connected) return embed(COL.red, '❌', 'Бот не подключён');
  const ticks = mc.time?.timeOfDay ?? 0;
  const h  = Math.floor(((ticks + 6000) % 24000) / 1000);
  const m  = Math.floor(((ticks + 6000) % 1000) * 0.06);
  const hh = String(h).padStart(2, '0');
  const mm = String(m).padStart(2, '0');
  const isThunder = (mc.thunderState ?? 0) > 0.5;
  const weather = isThunder ? '⛈️ Гроза' : mc.isRaining ? '🌧️ Дождь' : '☀️ Ясно';
  return embed(COL.teal, '🌍 Мир', null, [
    { name: '🕐 Время',  value: `${hh}:${mm} ${h >= 6 && h < 18 ? '☀️ День' : '🌙 Ночь'}`, inline: true },
    { name: '🌤️ Погода', value: weather,                                                      inline: true },
    { name: '⏱️ Тики',  value: `${ticks}`,                                                    inline: true },
  ]);
}

// ─── Авто-функции ─────────────────────────────────────────────────────────────
function startAntiFk() {
  stopAntiFk();
  antiFkOn = true;
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
  stopFollow();
  followTarget = targetName;
  followTimer = setInterval(() => {
    if (!mc || !connected || !followTarget) { stopFollow(); return; }
    const target = mc.players[followTarget]?.entity;
    if (!target?.position) return;
    const myPos = mc.entity.position;
    const dx = target.position.x - myPos.x;
    const dz = target.position.z - myPos.z;
    const dist = Math.sqrt(dx * dx + dz * dz);
    mc.lookAt(target.position.offset(0, target.height ?? 1.8, 0));
    if (dist > 3) {
      mc.setControlState('forward', true);
      mc.setControlState('sprint', dist > 7);
    } else {
      mc.setControlState('forward', false);
      mc.setControlState('sprint', false);
    }
  }, 120);
}

function stopFollow() {
  followTarget = null;
  if (followTimer) { clearInterval(followTimer); followTimer = null; }
  if (mc && connected) {
    ['forward', 'sprint'].forEach(k => mc.setControlState(k, false));
  }
}

async function tryEat() {
  if (!mc || !connected || mc.food >= 18) return;
  const priority = [
    'cooked_beef', 'cooked_porkchop', 'cooked_mutton', 'cooked_chicken',
    'cooked_salmon', 'cooked_cod', 'bread', 'apple', 'carrot', 'baked_potato',
    'golden_apple', 'mushroom_stew', 'rabbit_stew', 'suspicious_stew',
  ];
  for (const name of priority) {
    const item = mc.inventory.items().find(i => i.name === name);
    if (item) {
      try {
        await mc.equip(item, 'hand');
        await mc.consume();
        console.log(`[AutoEat] Съел ${name}`);
      } catch {}
      return;
    }
  }
}

// ─── Minecraft: подключение ───────────────────────────────────────────────────
function connectMC(username) {
  if (mc) { try { mc.quit(); } catch {} mc = null; connected = false; }
  mcName = username;
  lastHpWarn = Infinity;
  stopFollow();
  stopAntiFk();
  sneaking = false;

  mc = mineflayer.createBot({
    host: MC_HOST,
    port: MC_PORT,
    username,
    version: MC_VERSION,
    auth: 'offline',
    hideErrors: false,
  });

  bindMCEvents();
}

// ─── Minecraft: события ───────────────────────────────────────────────────────
function bindMCEvents() {
  // Спаун ─────────────────────────────────────────────────────────────────────
  mc.once('spawn', () => {
    connected = true;
    console.log(`[MC] ✅ Зашёл как ${mc.username}`);
    logChan()?.send({ embeds: [embed(COL.green, '✅ Бот в игре',
      `Зашёл как \`${mc.username}\` → \`${MC_HOST}:${MC_PORT}\`\n` +
      `Если сервер требует пароль — жди уведомление ниже 👇`
    )] });
    if (bridgeChanId) bridgeChan()?.send(`> 🟢 **${mc.username}** зашёл на сервер`);
  });

  // Чат → Дискорд ─────────────────────────────────────────────────────────────
  mc.on('chat', (username, message) => {
    if (username === mc?.username) return;
    console.log(`[Chat] <${username}> ${message}`);

    // Лог-канал (embed)
    if (chatOn) {
      logChan()?.send({ embeds: [embed(COL.blue, '💬 Чат', `**${username}**: ${message}`)] });
    }

    // Бридж-канал (plain text, без эхо)
    const key = `${username}:${message}`;
    if (bridgeChanId && key !== lastBridgeMsg) {
      bridgeChan()?.send(`**${username}**: ${message}`);
    }

    // Достижения
    if (eventsOn && (
      message.includes('has made the advancement') ||
      message.includes('has completed the challenge') ||
      message.includes('has reached the goal')
    )) {
      logChan()?.send({ embeds: [embed(COL.yellow, '🏆 Достижение!', `**${username}**: ${message}`)] });
    }
  });

  // Системные сообщения (AuthMe и т.п.) ──────────────────────────────────────
  mc.on('message', (jsonMsg, position) => {
    if (position === 'game_info') return;
    const text = jsonMsg.toString().trim();
    if (!text) return;
    console.log(`[Sys/${position}] ${text}`);
    const lower = text.toLowerCase();
    if (lower.includes('password') || lower.includes('пароль') ||
        lower.includes('/login')   || lower.includes('/l ')    ||
        lower.includes('authme')   || lower.includes('/register')) {
      logChan()?.send({ embeds: [embed(COL.yellow, '🔑 Требуется пароль!',
        `\`\`\`${text.slice(0, 400)}\`\`\`\n➜ \`/passw /l твой_пароль\``
      )] });
    }
  });

  // Шёпот ─────────────────────────────────────────────────────────────────────
  mc.on('whisper', (username, message) => {
    console.log(`[Whisper] <${username}> ${message}`);
    logChan()?.send({ embeds: [embed(COL.purple, `🔔 Шёпот от ${username}`, message)] });
  });

  // Вход / выход ───────────────────────────────────────────────────────────────
  mc.on('playerJoined', (player) => {
    if (!eventsOn || player.username === mc?.username) return;
    logChan()?.send({ embeds: [embed(COL.green, '📥 Вошёл', `**${player.username}**`)] });
    if (bridgeChanId) bridgeChan()?.send(`> 📥 **${player.username}** зашёл на сервер`);
  });

  mc.on('playerLeft', (player) => {
    if (!eventsOn) return;
    logChan()?.send({ embeds: [embed(COL.orange, '📤 Вышел', `**${player.username}**`)] });
    if (bridgeChanId) bridgeChan()?.send(`> 📤 **${player.username}** покинул сервер`);
    if (followTarget === player.username) stopFollow();
  });

  // Смерть ────────────────────────────────────────────────────────────────────
  mc.on('death', () => {
    console.log('[MC] 💀 Бот умер');
    logChan()?.send({ embeds: [embed(COL.red, '💀 Бот погиб!',
      `**${mc?.username}** умер. Нажимаю возрождение...`
    )] });
    setTimeout(() => { try { mc?.look(0, 0, false); } catch {} }, 2000);
  });

  // HP / авто-еда ─────────────────────────────────────────────────────────────
  mc.on('health', () => {
    if (autoEatOn) tryEat();
    const hp = mc?.health ?? 20;
    if (hp <= 6 && hp < lastHpWarn) {
      lastHpWarn = hp;
      logChan()?.send({ embeds: [embed(COL.red, '⚠️ Критически мало HP!',
        `У бота **${(hp / 2).toFixed(1)} ❤️** из 10`
      )] });
    }
    if (hp > 10) lastHpWarn = Infinity;
  });

  // Открытие контейнера ───────────────────────────────────────────────────────
  mc.on('windowOpen', (window) => {
    if (!eventsOn) return;
    let title = 'Контейнер';
    try { title = window.title?.toString() || window.type || 'Контейнер'; } catch {}
    const slots = (window.slots || []).filter(Boolean).map(s => `**${s.name}** ×${s.count}`);
    logChan()?.send({ embeds: [embed(COL.yellow, `📦 Открыт: ${title.slice(0, 80)}`,
      slots.length ? slots.join(' · ').slice(0, 3500) : '*Пусто*'
    )] });
  });

  // Кик ───────────────────────────────────────────────────────────────────────
  mc.on('kicked', (reason) => {
    connected = false;
    stopFollow(); stopAntiFk();
    console.log(`[MC] Кикнут: ${reason}`);
    logChan()?.send({ embeds: [embed(COL.red, '🔴 Кик', `\`${String(reason).slice(0, 300)}\``)] });
    if (bridgeChanId) bridgeChan()?.send(`> 🔴 Бот кикнут с сервера`);
    if (autoReconnOn && mcName) scheduleReconn();
  });

  // Разрыв ────────────────────────────────────────────────────────────────────
  mc.on('end', (reason) => {
    connected = false;
    stopFollow(); stopAntiFk();
    console.log(`[MC] Отключён: ${reason}`);
    logChan()?.send({ embeds: [embed(COL.red, '🔴 Отключился',
      reason ? `\`${String(reason).slice(0, 200)}\`` : 'Соединение разорвано'
    )] });
    if (bridgeChanId) bridgeChan()?.send(`> 🔴 Бот отключился от сервера`);
    if (autoReconnOn && mcName) scheduleReconn();
  });

  mc.on('error', (err) => {
    console.error(`[MC Error] ${err.message}`);
    logChan()?.send({ embeds: [embed(COL.red, '⚠️ Ошибка MC', `\`${err.message.slice(0, 400)}\``)] });
  });
}

function scheduleReconn() {
  logChan()?.send({ embeds: [embed(COL.yellow, '🔄 Авто-реконнект', 'Переподключаюсь через 10 сек...')] });
  setTimeout(() => { if (!connected) connectMC(mcName); }, 10000);
}

// ─── Discord → МК: Chat Bridge ───────────────────────────────────────────────
discord.on('messageCreate', (msg) => {
  if (msg.author.bot) return;
  if (!bridgeChanId || msg.channel.id !== bridgeChanId) return;
  if (!mc || !connected) return;
  const text = `[DC] ${msg.member?.displayName ?? msg.author.username}: ${msg.content}`;
  lastBridgeMsg = `${msg.member?.displayName ?? msg.author.username}:${msg.content}`;
  mc.chat(text.slice(0, 255));
});

// ─── Discord: Ready ───────────────────────────────────────────────────────────
discord.once('ready', () => {
  console.log(`[Discord] ✅ ${discord.user.tag}`);
  discord.user.setActivity('Minecraft', { type: ActivityType.Playing });
  if (!logChanId)    console.warn('[Discord] ⚠️ LOG_CHANNEL_ID не задан');
  if (!bridgeChanId) console.info('[Discord] ℹ️ BRIDGE_CHANNEL_ID не задан (бридж выключен)');
});

// ─── Discord: Interactions ────────────────────────────────────────────────────
discord.on('interactionCreate', async (interaction) => {
  try {
    if      (interaction.isChatInputCommand()) await handleCommand(interaction);
    else if (interaction.isButton())           await handleButton(interaction);
  } catch (e) {
    console.error('[Interaction Error]', e);
    const reply = { content: `❌ Ошибка: \`${e.message}\``, ephemeral: true };
    if (interaction.replied || interaction.deferred) interaction.followUp(reply).catch(() => {});
    else                                             interaction.reply(reply).catch(() => {});
  }
});

// ─── Команды ─────────────────────────────────────────────────────────────────
async function handleCommand(interaction) {
  const cmd = interaction.commandName;

  // ── Подключение ──────────────────────────────────────────────────────────
  if (cmd === 'join') {
    if (connected) return interaction.reply({ content: '❌ Бот уже в игре. Сначала `/leave`.', ephemeral: true });
    const nick = interaction.options.getString('nick');
    await interaction.reply({ embeds: [embed(COL.yellow, '⏳ Подключение...', `Захожу как \`${nick}\`...`)] });
    connectMC(nick);
    return;
  }

  if (cmd === 'leave') {
    if (!mc || !connected) return interaction.reply({ content: '❌ Бот не подключён.', ephemeral: true });
    autoReconnOn = false; // чтобы не реконнектило после ручного выхода
    mc.quit('Disconnected by Discord'); mc = null; connected = false;
    return interaction.reply({ embeds: [embed(COL.red, '🔴 Отключён', 'Бот покинул сервер.')] });
  }

  if (cmd === 'reconnect') {
    if (!mcName) return interaction.reply({ content: '❌ Нет ника. Используй `/join` сначала.', ephemeral: true });
    if (mc) { try { mc.quit(); } catch {} mc = null; connected = false; }
    await interaction.reply({ embeds: [embed(COL.yellow, '🔄 Реконнект', `Переподключаюсь как \`${mcName}\`...`)] });
    connectMC(mcName);
    return;
  }

  // ── Чат ──────────────────────────────────────────────────────────────────
  if (cmd === 'type') {
    if (!mc || !connected) return interaction.reply({ content: '❌ Бот не в игре.', ephemeral: true });
    const message = interaction.options.getString('message');
    mc.chat(message.slice(0, 255));
    return interaction.reply({ embeds: [embed(COL.green, '✉️ Отправлено', `\`${message}\``)] });
  }

  if (cmd === 'passw') {
    if (!mc || !connected) return interaction.reply({ content: '❌ Бот не в игре.', ephemeral: true });
    const command = interaction.options.getString('command');
    mc.chat(command.slice(0, 255));
    return interaction.reply({ embeds: [embed(COL.green, '🔑 Отправлено', `\`${command}\``)], ephemeral: true });
  }

  // ── Инфо ─────────────────────────────────────────────────────────────────
  if (cmd === 'status') {
    return interaction.reply({
      embeds: [buildStatusEmbed()],
      components: [buildButtons(), buildAutoButtons()],
    });
  }

  if (cmd === 'players')   return interaction.reply({ embeds: [buildPlayersEmbed()] });
  if (cmd === 'inventory') return interaction.reply({ embeds: [buildInventoryEmbed()] });
  if (cmd === 'coords')    return interaction.reply({ embeds: [buildCoordsEmbed()] });
  if (cmd === 'near')      return interaction.reply({ embeds: [buildNearEmbed()] });
  if (cmd === 'world') {
    if (!mc || !connected) return interaction.reply({ content: '❌ Бот не в игре.', ephemeral: true });
    return interaction.reply({ embeds: [buildWorldEmbed()] });
  }

  // ── Управление ───────────────────────────────────────────────────────────
  if (cmd === 'jump') {
    if (!mc || !connected) return interaction.reply({ content: '❌ Бот не в игре.', ephemeral: true });
    mc.setControlState('jump', true);
    setTimeout(() => { if (mc) mc.setControlState('jump', false); }, 300);
    return interaction.reply({ embeds: [embed(COL.green, '⬆️ Прыжок!', 'Бот прыгнул.')] });
  }

  if (cmd === 'sneak') {
    if (!mc || !connected) return interaction.reply({ content: '❌ Бот не в игре.', ephemeral: true });
    sneaking = !sneaking;
    mc.setControlState('sneak', sneaking);
    return interaction.reply({ embeds: [embed(COL.teal, '🕵️ Сник',
      sneaking ? 'Бот теперь крадётся.' : 'Бот встал прямо.'
    )] });
  }

  if (cmd === 'eat') {
    if (!mc || !connected) return interaction.reply({ content: '❌ Бот не в игре.', ephemeral: true });
    await interaction.deferReply();
    const before = mc.food;
    await tryEat();
    return interaction.editReply({ embeds: [embed(COL.green, '🍗 Поел',
      mc.food === before ? 'Нет еды или уже сыт.' : `Еда: \`${before}\` → \`${mc.food}\` 🍗`
    )] });
  }

  if (cmd === 'drop') {
    if (!mc || !connected) return interaction.reply({ content: '❌ Бот не в игре.', ephemeral: true });
    const itemName = interaction.options.getString('item');
    const item = mc.inventory.items().find(i => i.name.includes(itemName));
    if (!item) return interaction.reply({ content: `❌ \`${itemName}\` не найдено.`, ephemeral: true });
    try {
      await mc.toss(item.type, null, item.count);
      return interaction.reply({ embeds: [embed(COL.orange, '🗑️ Выброшено', `**${item.name}** × ${item.count}`)] });
    } catch (e) {
      return interaction.reply({ content: `❌ ${e.message}`, ephemeral: true });
    }
  }

  if (cmd === 'look') {
    if (!mc || !connected) return interaction.reply({ content: '❌ Бот не в игре.', ephemeral: true });
    const nick = interaction.options.getString('nick');
    const target = mc.players[nick]?.entity;
    if (!target) return interaction.reply({ content: `❌ Игрок \`${nick}\` не найден рядом.`, ephemeral: true });
    mc.lookAt(target.position.offset(0, target.height ?? 1.8, 0));
    return interaction.reply({ embeds: [embed(COL.teal, '👀 Смотрю', `Бот смотрит на **${nick}**`)] });
  }

  if (cmd === 'follow') {
    if (!mc || !connected) return interaction.reply({ content: '❌ Бот не в игре.', ephemeral: true });
    const nick = interaction.options.getString('nick');
    if (!mc.players[nick]) return interaction.reply({ content: `❌ Игрок \`${nick}\` не найден.`, ephemeral: true });
    startFollow(nick);
    return interaction.reply({ embeds: [embed(COL.teal, '🏃 Следую', `Бот идёт за **${nick}**`)] });
  }

  if (cmd === 'unfollow') {
    stopFollow();
    return interaction.reply({ embeds: [embed(COL.gray, '🛑 Остановился', 'Бот больше не следует.')] });
  }

  // ── Авто-функции ─────────────────────────────────────────────────────────
  if (cmd === 'antifk') {
    if (interaction.options.getSubcommand() === 'on') { startAntiFk(); return interaction.reply({ content: '✅ **Anti-AFK включён** — прыгает каждые 25 сек.' }); }
    stopAntiFk();
    return interaction.reply({ content: '❌ **Anti-AFK выключен**.' });
  }

  if (cmd === 'autoeat') {
    autoEatOn = interaction.options.getSubcommand() === 'on';
    return interaction.reply({ content: autoEatOn ? '✅ **Авто-еда включена**.' : '❌ **Авто-еда выключена**.' });
  }

  if (cmd === 'autoreconn') {
    autoReconnOn = interaction.options.getSubcommand() === 'on';
    return interaction.reply({ content: autoReconnOn
      ? '✅ **Авто-реконнект включён** — переподключается через 10 сек после кика.'
      : '❌ **Авто-реконнект выключен**.' });
  }

  // ── Бридж ────────────────────────────────────────────────────────────────
  if (cmd === 'bridge') {
    const sub = interaction.options.getSubcommand();
    if (sub === 'set') {
      const channel = interaction.options.getChannel('channel');
      bridgeChanId = channel.id;
      return interaction.reply({ embeds: [embed(COL.teal, '🌉 Бридж установлен',
        `Канал ${channel} привязан.\n` +
        `Сообщения из него → в МК, и наоборот.\n\n` +
        `⚠️ Убедись, что у бота есть права на чтение и отправку в этом канале.`
      )] });
    }
    bridgeChanId = '';
    return interaction.reply({ content: '❌ Бридж отключён.' });
  }

  // ── Настройки логов ───────────────────────────────────────────────────────
  if (cmd === 'chat') {
    chatOn = interaction.options.getSubcommand() === 'on';
    return interaction.reply({ content: chatOn ? '✅ Лог чата включён.' : '🔇 Лог чата выключен.' });
  }

  if (cmd === 'events') {
    eventsOn = interaction.options.getSubcommand() === 'on';
    return interaction.reply({ content: eventsOn ? '✅ События включены.' : '🔇 События выключены.' });
  }

  // ── Помощь ───────────────────────────────────────────────────────────────
  if (cmd === 'help') {
    return interaction.reply({ embeds: [embed(COL.blue, '📖 Все команды', null, [
      { name: '🔌 Подключение', value: '`/join` `/leave` `/reconnect`',                                      inline: false },
      { name: '💬 Чат',         value: '`/type` `/passw`',                                                    inline: false },
      { name: '📊 Инфо',        value: '`/status` `/players` `/inventory` `/coords` `/near` `/world`',        inline: false },
      { name: '🎮 Управление',  value: '`/jump` `/sneak` `/eat` `/drop` `/look` `/follow` `/unfollow`',       inline: false },
      { name: '🤖 Авто-режимы', value: '`/antifk on/off` · `/autoeat on/off` · `/autoreconn on/off`',        inline: false },
      { name: '🌉 Бридж ДС↔МК', value: '`/bridge set #канал` · `/bridge off`',                               inline: false },
      { name: '⚙️ Логи',        value: '`/chat on/off` · `/events on/off`',                                  inline: false },
    ])] });
  }
}

// ─── Кнопки ──────────────────────────────────────────────────────────────────
async function handleButton(interaction) {
  const statusUpdate = () => interaction.update({
    embeds: [buildStatusEmbed()],
    components: [buildButtons(), buildAutoButtons()],
  });

  switch (interaction.customId) {
    case 'btn_refresh':      return statusUpdate();
    case 'btn_coords':       return interaction.reply({ embeds: [buildCoordsEmbed()],    ephemeral: true });
    case 'btn_players':      return interaction.reply({ embeds: [buildPlayersEmbed()],   ephemeral: true });
    case 'btn_inventory':    return interaction.reply({ embeds: [buildInventoryEmbed()], ephemeral: true });
    case 'btn_near':         return interaction.reply({ embeds: [buildNearEmbed()],      ephemeral: true });
    case 'btn_timeweather':
      if (!mc || !connected) return interaction.reply({ content: '❌ Бот не в игре.', ephemeral: true });
      return interaction.reply({ embeds: [buildWorldEmbed()], ephemeral: true });
    case 'btn_leave':
      if (mc && connected) { autoReconnOn = false; mc.quit(); mc = null; connected = false; }
      return statusUpdate();
    case 'btn_antifk':
      if (antiFkOn) stopAntiFk(); else startAntiFk();
      return statusUpdate();
    case 'btn_autoeat':
      autoEatOn = !autoEatOn;
      return statusUpdate();
    case 'btn_autoreconn':
      autoReconnOn = !autoReconnOn;
      return statusUpdate();
  }
}

// ─── Запуск ───────────────────────────────────────────────────────────────────
discord.login(process.env.DISCORD_TOKEN).catch((e) => {
  console.error('[Fatal] Не удалось войти:', e.message);
  process.exit(1);
});

// ─── Graceful shutdown ────────────────────────────────────────────────────────
async function shutdown(signal) {
  console.log(`[Shutdown] ${signal}`);
  stopFollow(); stopAntiFk();
  if (mc && connected) { try { mc.quit('Bot shutting down'); } catch {} }
  try { await discord.destroy(); } catch {}
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));
process.on('uncaughtException',  err    => console.error('[UncaughtException]',  err.message));
process.on('unhandledRejection', reason => console.error('[UnhandledRejection]', reason));
