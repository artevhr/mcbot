// deploy.js — регистрация slash-команд
// версия v2.0
// Запустить ОДИН РАЗ: node deploy.js

require('dotenv').config();
const { REST, Routes, SlashCommandBuilder } = require('discord.js');

const GUILD_ID = process.env.GUILD_ID || '1123649588658700368';

if (!process.env.DISCORD_TOKEN || !process.env.CLIENT_ID) {
  console.error('❌ Нет DISCORD_TOKEN или CLIENT_ID в .env');
  process.exit(1);
}

const on  = s => s.addSubcommand(c => c.setName('on').setDescription('Включить'));
const off = s => on(s).addSubcommand(c => c.setName('off').setDescription('Выключить'));

const commands = [
  // ── Подключение ──────────────────────────────────────────────────────────
  new SlashCommandBuilder()
    .setName('join').setDescription('Зайти на Minecraft сервер')
    .addStringOption(o => o.setName('nick').setDescription('Никнейм бота').setRequired(true)),

  new SlashCommandBuilder()
    .setName('leave').setDescription('Отключить бота от сервера'),

  new SlashCommandBuilder()
    .setName('reconnect').setDescription('Переподключить бота с тем же ником'),

  // ── Чат ──────────────────────────────────────────────────────────────────
  new SlashCommandBuilder()
    .setName('type').setDescription('Написать в игровой чат')
    .addStringOption(o => o.setName('message').setDescription('Текст или команда').setRequired(true)),

  new SlashCommandBuilder()
    .setName('passw').setDescription('Ввести пароль (только ты видишь)')
    .addStringOption(o => o.setName('command').setDescription('Напр: /l мойпароль').setRequired(true)),

  // ── Информация ───────────────────────────────────────────────────────────
  new SlashCommandBuilder()
    .setName('status').setDescription('Панель управления ботом с кнопками'),

  new SlashCommandBuilder()
    .setName('players').setDescription('Список игроков онлайн'),

  new SlashCommandBuilder()
    .setName('inventory').setDescription('Инвентарь бота'),

  new SlashCommandBuilder()
    .setName('coords').setDescription('Координаты бота'),

  new SlashCommandBuilder()
    .setName('near').setDescription('Ближайшие игроки с расстоянием'),

  new SlashCommandBuilder()
    .setName('world').setDescription('Время суток и погода в игре'),

  // ── Управление ───────────────────────────────────────────────────────────
  new SlashCommandBuilder()
    .setName('jump').setDescription('Заставить бота прыгнуть'),

  new SlashCommandBuilder()
    .setName('sneak').setDescription('Включить / выключить крадущийся режим'),

  new SlashCommandBuilder()
    .setName('eat').setDescription('Съесть еду из инвентаря'),

  new SlashCommandBuilder()
    .setName('drop').setDescription('Выбросить предмет из инвентаря')
    .addStringOption(o => o.setName('item').setDescription('Часть названия, напр: dirt, sword').setRequired(true)),

  new SlashCommandBuilder()
    .setName('look').setDescription('Посмотреть в сторону игрока')
    .addStringOption(o => o.setName('nick').setDescription('Ник игрока').setRequired(true)),

  new SlashCommandBuilder()
    .setName('follow').setDescription('Следовать за игроком')
    .addStringOption(o => o.setName('nick').setDescription('Ник игрока').setRequired(true)),

  new SlashCommandBuilder()
    .setName('unfollow').setDescription('Прекратить следование'),

  // ── Авто-функции ─────────────────────────────────────────────────────────
  new SlashCommandBuilder()
    .setName('antifk').setDescription('Anti-AFK (прыгает каждые 25 сек)')
    .addSubcommand(c => c.setName('on').setDescription('Включить'))
    .addSubcommand(c => c.setName('off').setDescription('Выключить')),

  new SlashCommandBuilder()
    .setName('autoeat').setDescription('Авто-еда (ест когда голоден)')
    .addSubcommand(c => c.setName('on').setDescription('Включить'))
    .addSubcommand(c => c.setName('off').setDescription('Выключить')),

  new SlashCommandBuilder()
    .setName('autoreconn').setDescription('Авто-реконнект после кика')
    .addSubcommand(c => c.setName('on').setDescription('Включить'))
    .addSubcommand(c => c.setName('off').setDescription('Выключить')),

  // ── Бридж ────────────────────────────────────────────────────────────────
  new SlashCommandBuilder()
    .setName('bridge').setDescription('Двусторонний чат-мост Дискорд ↔ Minecraft')
    .addSubcommand(c => c
      .setName('set').setDescription('Привязать канал')
      .addChannelOption(o => o.setName('channel').setDescription('Канал для бриджа').setRequired(true))
    )
    .addSubcommand(c => c.setName('off').setDescription('Отключить бридж')),

  // ── Логи ─────────────────────────────────────────────────────────────────
  new SlashCommandBuilder()
    .setName('chat').setDescription('Лог чата в Дискорд')
    .addSubcommand(c => c.setName('on').setDescription('Включить'))
    .addSubcommand(c => c.setName('off').setDescription('Выключить')),

  new SlashCommandBuilder()
    .setName('events').setDescription('Лог событий (вход/выход, сундуки)')
    .addSubcommand(c => c.setName('on').setDescription('Включить'))
    .addSubcommand(c => c.setName('off').setDescription('Выключить')),

  // ── Помощь ───────────────────────────────────────────────────────────────
  new SlashCommandBuilder()
    .setName('help').setDescription('Список всех команд'),

].map(c => c.toJSON());

const rest = new REST().setToken(process.env.DISCORD_TOKEN);

(async () => {
  console.log(`📋 Регистрирую ${commands.length} команд...`);
  const data = await rest.put(
    Routes.applicationGuildCommands(process.env.CLIENT_ID, GUILD_ID),
    { body: commands },
  );
  console.log(`✅ Зарегистрировано: ${data.length} команд`);
  data.forEach(c => console.log(`  /${c.name}`));
})().catch(e => {
  console.error('❌', e.message);
  process.exit(1);
});
