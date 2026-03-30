// deploy.js — регистрация slash-команд
// версия v3.0
// Запустить один раз: node deploy.js

require('dotenv').config();
const { REST, Routes, SlashCommandBuilder, ChannelType } = require('discord.js');

const GUILD_ID = process.env.GUILD_ID || '1123649588658700368';

if (!process.env.DISCORD_TOKEN || !process.env.CLIENT_ID) {
  console.error('❌ Нет DISCORD_TOKEN или CLIENT_ID в .env');
  process.exit(1);
}

const on  = c => c.addSubcommand(s => s.setName('on').setDescription('Включить'));
const off = c => c.addSubcommand(s => s.setName('off').setDescription('Выключить'));

const commands = [
  // ── Подключение ──────────────────────────────────────────────────────────
  new SlashCommandBuilder()
    .setName('join').setDescription('Зайти на Minecraft сервер')
    .addStringOption(o => o.setName('nick').setDescription('Никнейм бота').setRequired(true)),

  new SlashCommandBuilder().setName('leave').setDescription('Отключить бота'),
  new SlashCommandBuilder().setName('reconnect').setDescription('Переподключить'),

  // ── Чат ──────────────────────────────────────────────────────────────────
  new SlashCommandBuilder()
    .setName('type').setDescription('Написать в игровой чат')
    .addStringOption(o => o.setName('message').setDescription('Текст').setRequired(true)),

  new SlashCommandBuilder()
    .setName('passw').setDescription('Ввести пароль (только ты видишь)')
    .addStringOption(o => o.setName('command').setDescription('Напр: /l пароль').setRequired(true)),

  // ── Инфо ─────────────────────────────────────────────────────────────────
  new SlashCommandBuilder().setName('status').setDescription('Панель управления'),
  new SlashCommandBuilder().setName('players').setDescription('Игроки онлайн'),
  new SlashCommandBuilder().setName('inventory').setDescription('Инвентарь бота'),
  new SlashCommandBuilder().setName('coords').setDescription('Координаты'),
  new SlashCommandBuilder().setName('near').setDescription('Ближайшие игроки'),
  new SlashCommandBuilder().setName('world').setDescription('Время и погода'),

  // ── Управление ───────────────────────────────────────────────────────────
  new SlashCommandBuilder().setName('jump').setDescription('Прыжок'),
  new SlashCommandBuilder().setName('sneak').setDescription('Тоггл крадущегося режима'),
  new SlashCommandBuilder().setName('eat').setDescription('Съесть еду из инвентаря'),

  new SlashCommandBuilder()
    .setName('drop').setDescription('Выбросить предмет')
    .addStringOption(o => o.setName('item').setDescription('Часть названия (напр: dirt)').setRequired(true)),

  new SlashCommandBuilder()
    .setName('look').setDescription('Посмотреть на игрока')
    .addStringOption(o => o.setName('nick').setDescription('Ник').setRequired(true)),

  new SlashCommandBuilder()
    .setName('follow').setDescription('Следовать за игроком')
    .addStringOption(o => o.setName('nick').setDescription('Ник').setRequired(true)),

  new SlashCommandBuilder().setName('unfollow').setDescription('Остановить следование'),

  // ── ИИ-агент ─────────────────────────────────────────────────────────────
  new SlashCommandBuilder()
    .setName('ai').setDescription('ИИ-агент на OpenRouter (бесплатно)')
    .addSubcommand(s => s.setName('on').setDescription('Включить ИИ — бот будет отвечать на "ИИ ..." в чате МК'))
    .addSubcommand(s => s.setName('off').setDescription('Выключить ИИ'))
    .addSubcommand(s => s.setName('stop').setDescription('Отменить текущую задачу ИИ'))
    .addSubcommand(s => s.setName('model').setDescription('Показать доступные бесплатные модели')),

  // ── Авто-функции ─────────────────────────────────────────────────────────
  new SlashCommandBuilder()
    .setName('antifk').setDescription('Anti-AFK прыжки каждые 25 сек')
    .addSubcommand(s => s.setName('on').setDescription('Включить'))
    .addSubcommand(s => s.setName('off').setDescription('Выключить')),

  new SlashCommandBuilder()
    .setName('autoeat').setDescription('Авто-еда при голоде')
    .addSubcommand(s => s.setName('on').setDescription('Включить'))
    .addSubcommand(s => s.setName('off').setDescription('Выключить')),

  new SlashCommandBuilder()
    .setName('autoreconn').setDescription('Авто-реконнект после кика')
    .addSubcommand(s => s.setName('on').setDescription('Включить'))
    .addSubcommand(s => s.setName('off').setDescription('Выключить')),

  // ── Бридж ────────────────────────────────────────────────────────────────
  new SlashCommandBuilder()
    .setName('bridge').setDescription('Двусторонний чат-мост ДС ↔ МК')
    .addSubcommand(s => s
      .setName('set').setDescription('Привязать канал')
      .addChannelOption(o => o.setName('channel').setDescription('Канал').setRequired(true)
        .addChannelTypes(ChannelType.GuildText))
    )
    .addSubcommand(s => s.setName('off').setDescription('Отключить')),

  // ── Логи ─────────────────────────────────────────────────────────────────
  new SlashCommandBuilder()
    .setName('chat').setDescription('Лог чата в Дискорд')
    .addSubcommand(s => s.setName('on').setDescription('Включить'))
    .addSubcommand(s => s.setName('off').setDescription('Выключить')),

  new SlashCommandBuilder()
    .setName('events').setDescription('Лог событий')
    .addSubcommand(s => s.setName('on').setDescription('Включить'))
    .addSubcommand(s => s.setName('off').setDescription('Выключить')),

  new SlashCommandBuilder().setName('help').setDescription('Список всех команд'),

].map(c => c.toJSON());

const rest = new REST().setToken(process.env.DISCORD_TOKEN);

(async () => {
  console.log(`📋 Регистрирую ${commands.length} команд для гильдии ${GUILD_ID}...`);
  const data = await rest.put(
    Routes.applicationGuildCommands(process.env.CLIENT_ID, GUILD_ID),
    { body: commands },
  );
  console.log(`✅ Зарегистрировано: ${data.length}`);
  data.forEach(c => console.log(`  /${c.name}`));
})().catch(e => { console.error('❌', e.message); process.exit(1); });
