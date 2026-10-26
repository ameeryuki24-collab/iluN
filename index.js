/**
 * Nw Community Bot (v7 - Full / index.js)
 * Module 1: Custom Roles (gradient colors, emoji/sticker icons, try-role, edit-in-place)
 * Module 2: Temporary Voice Rooms (Join-to-Create + Full In-Room Control Panel + Help Explainer)
 * Module 3: Owner Tools (/owner-server)
 * Module 4: /addemote, /language
 * Module 5: Unified /settings command (Role Maker / Voice Maker / Staff Warn) — replaces 12 separate config commands
 *
 * v7 changes:
 * - FIX: /embedimage (now inside /settings) validates the URL before saving, and every place that
 *   uses it is wrapped in try/catch with a safe fallback — this was the cause of "fails on some servers only".
 * - All config commands merged into one /settings command with Role/Channel select menus.
 * - New Staff Warn feature: pick a staff role, it gets pinged (in message content, not embed — Discord
 *   does not send notifications for mentions written inside an embed) whenever someone reports a voice room.
 * - Every bot message is a black embed except: Discord Modals (Discord doesn't support embeds inside
 *   modals) and role-color preview embeds (intentionally colored like the actual role).
 *
 * Author: xh51
 * ⚠️ الأمان: التوكن لازم يوضع بمتغير بيئة (.env) ولا يُكتب هنا مباشرة أبداً.
 */

const {
  Client, GatewayIntentBits, EmbedBuilder, ActionRowBuilder,
  ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder,
  TextInputStyle, PermissionFlagsBits, REST, Routes,
  SlashCommandBuilder, ChannelType, PermissionsBitField, StringSelectMenuBuilder,
  RoleSelectMenuBuilder, ChannelSelectMenuBuilder, UserSelectMenuBuilder, StickerFormatType
} = require('discord.js');
const fs = require('fs');
const path = require('path');
require('dotenv').config();
const { createCanvas, loadImage, GlobalFonts } = require('@napi-rs/canvas');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildVoiceStates
  ]
});

const EMBED_COLOR = 0x000000;
const DEFAULT_ROLE_PANEL_IMAGE = 'https://images.unsplash.com/photo-1618005182384-a83a8bd57fbe';

// ==========================================
// EMBED HELPER
// ==========================================
function embedMsg(description, opts = {}) {
  const embed = new EmbedBuilder().setColor(opts.color !== undefined ? opts.color : EMBED_COLOR);
  if (description) embed.setDescription(description);
  if (opts.title) embed.setTitle(opts.title);
  if (opts.footer) embed.setFooter({ text: opts.footer });
  return { embeds: [embed] };
}

function isValidImageUrl(url) {
  return typeof url === 'string' && /^https?:\/\/\S+$/i.test(url.trim());
}

function backRow(customId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(customId).setLabel('رجوع').setStyle(ButtonStyle.Secondary).setEmoji('⬅️')
  );
}

// ==========================================
// PERSISTENT DATABASE
// ==========================================
const DB_FILE = path.join(__dirname, 'database.json');

function loadDatabase() {
  if (!fs.existsSync(DB_FILE)) {
    const initialData = { serverSettings: {}, userCustomRoles: {}, voiceRooms: {}, userVoiceStats: {}, userLanguage: {}, guildLanguage: {}, userWarnings: {}, gameProfiles: {}, premium: { guilds: {} }, globalEmojis: {}, catalog: { items: {} }, streaks: {} };
    fs.writeFileSync(DB_FILE, JSON.stringify(initialData, null, 2));
    return initialData;
  }
  try {
    const data = fs.readFileSync(DB_FILE, 'utf8');
    const parsed = JSON.parse(data);
    if (!parsed.voiceRooms) parsed.voiceRooms = {};
    if (!parsed.userVoiceStats) parsed.userVoiceStats = {};
    if (!parsed.userLanguage) parsed.userLanguage = {};
    if (!parsed.guildLanguage) parsed.guildLanguage = {};
    if (!parsed.userWarnings) parsed.userWarnings = {};
    if (!parsed.gameProfiles) parsed.gameProfiles = {};
    if (!parsed.premium) parsed.premium = { guilds: {} };
    if (!parsed.premium.guilds) parsed.premium.guilds = {};
    if (!parsed.globalEmojis) parsed.globalEmojis = {};
    if (!parsed.catalog) parsed.catalog = { items: {} };
    if (!parsed.streaks) parsed.streaks = {};
    return parsed;
  } catch (err) {
    console.error('Error loading database file:', err);
    return { serverSettings: {}, userCustomRoles: {}, voiceRooms: {}, userVoiceStats: {}, userLanguage: {}, guildLanguage: {}, userWarnings: {}, gameProfiles: {}, premium: { guilds: {} }, globalEmojis: {}, catalog: { items: {} }, streaks: {} };
  }
}

let dbDirty = null, dbTimer = null;
function writeDbNow() {
  if (!dbDirty) return;
  try { const tmp = DB_FILE + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(dbDirty)); fs.renameSync(tmp, DB_FILE); dbDirty = null; }
  catch (err) { console.error('Error saving database file:', err); }
}
// حفظ مؤجّل (يجمّع الحفظات المتتالية) — كان يكتب الملف كامل عند كل نقطة وهذا اللي يسبب التعليق
function saveDatabase(d) {
  dbDirty = d;
  if (dbTimer) return;
  dbTimer = setTimeout(() => { dbTimer = null; writeDbNow(); }, 500);
}
function flushDatabase() { if (dbTimer) { clearTimeout(dbTimer); dbTimer = null; } writeDbNow(); }
process.on('exit', flushDatabase);
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { flushDatabase(); process.exit(0); });

let db = loadDatabase();
const activeSetups = new Map();
// ==========================================
// MODULE 6: GAMES / ECONOMY — حالات بالذاكرة
// ==========================================
const voiceJoinTimestamps = new Map(); // userId -> timestamp لحساب وقت التواجد الصوتي
const rouletteSessions = new Map(); // channelId -> جلسة روليت نشطة
const shortcutCooldown = new Map();
const lastXpMessageAt = new Map(); // userId -> timestamp آخر رسالة احتسبت لها خبرة (مانع سبام)
// حارس ضد الضغط المزدوج/السريع اللي يسبب إنشاء أكثر من رتبة لنفس العضو بنفس اللحظة
const processingRoleUsers = new Set();

const CONFIG = {
  TOKEN: process.env.BOT_TOKEN,
  CLIENT_ID: process.env.CLIENT_ID,
  OWNER_IDS: (process.env.OWNER_IDS || '').split(',').map(id => id.trim()).filter(Boolean)
};

if (!CONFIG.TOKEN || !CONFIG.CLIENT_ID) {
  console.error('❌ ناقص BOT_TOKEN أو CLIENT_ID بملف .env — تأكد إنك عبيت الملف صحيح.');
  process.exit(1);
}

// ==========================================
// I18N
// ==========================================
const STRINGS = {
  ar: {
    notOwner: '❌ بس صاحب الروم يقدر يستخدم هذا الزر.',
    roomWelcome: (id) => `أهلاً <@${id}>! هذا رومك الخاص — تحكم فيه من الأزرار تحت:`
  },
  en: {
    notOwner: '❌ Only the room owner can use this button.',
    roomWelcome: (id) => `Welcome <@${id}>! This is your private room — control it with the buttons below:`
  }
};
// ⚠️ ملاحظة: اللغة أصبحت على مستوى السيرفر كامل (مو كل مستخدم لحاله) — getUserLang تتوقع آيدي سيرفر الآن.
function getUserLang(guildId) { return (db.guildLanguage && db.guildLanguage[guildId]) || 'ar'; }
// يرجع النص الإنجليزي إذا كان السيرفر مضبوط إنجليزي (/language)، وإلا يرجع النص العربي الأصلي
function bi(interaction, arText, enText) {
  const guildId = interaction && interaction.guild ? interaction.guild.id : null;
  return getUserLang(guildId) === 'en' ? enText : arText;
}
function t(userId, key, ...args) {
  const lang = getUserLang(userId);
  const dict = STRINGS[lang] && STRINGS[lang][key] !== undefined ? STRINGS[lang] : STRINGS.ar;
  const entry = dict[key];
  return typeof entry === 'function' ? entry(...args) : entry;
}

// ==========================================
// EMOJI TARGET MAPS (الرتب + الفويس)
// ==========================================
const ROLE_EMOJI_TARGETS = [
  { value: 'r_emoji_btn1', name: 'زر الإنشاء', field: 'emojiBtn1', default: '✨' },
  { value: 'r_emoji_btn2', name: 'زر رتبتي', field: 'emojiBtn2', default: '🎨' },
  { value: 'r_emoji_submit', name: 'زر الحفظ', field: 'emojiSubmit', default: '✅' },
  { value: 'r_emoji_cancel', name: 'زر الإلغاء', field: 'emojiCancel', default: '🚪' },
  { value: 'r_emoji_try', name: 'زر التجربة', field: 'emojiTry', default: '👀' },
  { value: 'r_emoji_primary', name: 'إيموجي اللون', field: 'emojiPrimary', default: '🎨' },
  { value: 'r_emoji_farewell', name: 'إيموجي التوديع', field: 'emojiFarewell', default: '👋' }
];
const ROLE_EMOJI_FIELD_MAP = Object.fromEntries(ROLE_EMOJI_TARGETS.map(t => [t.value, t.field]));

const VC_EMOJI_TARGETS = [
  { value: 'vc_emoji_rename', name: 'تغيير الاسم', field: 'vcEmojiRename', default: '✏️' },
  { value: 'vc_emoji_limit', name: 'حد الأعضاء', field: 'vcEmojiLimit', default: '👥' },
  { value: 'vc_emoji_privacy', name: 'الخصوصية', field: 'vcEmojiPrivacy', default: '🔒' },
  { value: 'vc_emoji_joinrequest', name: 'طلب انضمام', field: 'vcEmojiJoinrequest', default: '↪️' },
  { value: 'vc_emoji_help', name: 'شرح الأزرار', field: 'vcEmojiHelp', default: '📖' },
  { value: 'vc_emoji_trust', name: 'ثقة', field: 'vcEmojiTrust', default: '➕' },
  { value: 'vc_emoji_untrust', name: 'سحب الثقة', field: 'vcEmojiUntrust', default: '➖' },
  { value: 'vc_emoji_trustedlist', name: 'الموثوقين', field: 'vcEmojiTrustedlist', default: '📋' },
  { value: 'vc_emoji_status', name: 'حالة الروم', field: 'vcEmojiStatus', default: '💬' },
  { value: 'vc_emoji_invite', name: 'دعوة', field: 'vcEmojiInvite', default: '📞' },
  { value: 'vc_emoji_kick', name: 'طرد', field: 'vcEmojiKick', default: '✂️' },
  { value: 'vc_emoji_ban', name: 'حظر', field: 'vcEmojiBan', default: '🚫' },
  { value: 'vc_emoji_unban', name: 'رفع الحظر', field: 'vcEmojiUnban', default: '✅' },
  { value: 'vc_emoji_waitingroom', name: 'غرفة الانتظار', field: 'vcEmojiWaitingroom', default: '🕐' },
  { value: 'vc_emoji_transfer', name: 'نقل الملكية', field: 'vcEmojiTransfer', default: '🔁' },
  { value: 'vc_emoji_claim', name: 'أخذ الملكية', field: 'vcEmojiClaim', default: '👑' },
  { value: 'vc_emoji_stats', name: 'إحصائياتي', field: 'vcEmojiStats', default: '📊' },
  { value: 'vc_emoji_mute', name: 'كتم عضو', field: 'vcEmojiMute', default: '🔇' },
  { value: 'vc_emoji_deafen', name: 'إصمام عضو', field: 'vcEmojiDeafen', default: '🔕' },
  { value: 'vc_emoji_report', name: 'إبلاغ الإدارة', field: 'vcEmojiReport', default: '🚩' },
  { value: 'vc_emoji_delete', name: 'حذف الروم', field: 'vcEmojiDelete', default: '🗑️' }
];
const VC_EMOJI_FIELD_MAP = Object.fromEntries(VC_EMOJI_TARGETS.map(t => [t.value, t.field]));

const VC_HELP_TEXTS = {
  vc_rename: { ar: '✏️ **تغيير الاسم**\nيغيّر اسم الروم الصوتي الظاهر للجميع.', en: "✏️ **Rename**\nChanges the voice room's name that everyone sees." },
  vc_limit: { ar: '👥 **حد الأعضاء**\nيحدد أقصى عدد أعضاء يقدرون يدخلون الروم بنفس الوقت (0 = بدون حد).', en: '👥 **Member Limit**\nSets the max number of members who can join the room at once (0 = no limit).' },
  vc_privacy: { ar: '🔒 **الخصوصية**\nيقفل أو يفتح الروم — إذا مقفول ما يقدر يدخل إلا الموثوقين أو من تمت الموافقة عليه.', en: "🔒 **Privacy**\nLocks or unlocks the room — when locked, only trusted members or approved members can join." },
  vc_joinrequest: { ar: '↪️ **طلب انضمام**\nيفعّل نظام يخلي أي عضو يبي يدخل يرسل طلب، وصاحب الروم يوافق أو يرفض.', en: '↪️ **Join Request**\nEnables a system where new members must request to join, and the owner approves or denies.' },
  vc_trust: { ar: '➕ **ثقة**\nيضيف عضو لقائمة الموثوقين، يقدر يدخل حتى لو الروم مقفول.', en: '➕ **Trust**\nAdds a member to the trusted list, letting them join even when the room is locked.' },
  vc_untrust: { ar: '➖ **سحب الثقة**\nيشيل عضو من قائمة الموثوقين.', en: '➖ **Untrust**\nRemoves a member from the trusted list.' },
  vc_trustedlist: { ar: '📋 **الموثوقين**\nيعرض لك كل الأعضاء الموثوقين بالروم حالياً.', en: '📋 **Trusted List**\nShows all members currently trusted in this room.' },
  vc_status: { ar: '💬 **حالة الروم**\nيحط وصف نصي قصير يظهر جنب اسم الروم.', en: "💬 **Room Status**\nSets a short text status that appears next to the room's name." },
  vc_invite: { ar: '📞 **دعوة**\nينشئ رابط دعوة صالح لمدة ساعة وحتى 5 استخدامات.', en: '📞 **Invite**\nCreates an invite link valid for 1 hour, up to 5 uses.' },
  vc_kick: { ar: '✂️ **طرد**\nيطرد عضو من الروم الصوتي.', en: '✂️ **Kick**\nKicks a member from the voice room.' },
  vc_ban: { ar: '🚫 **حظر**\nيمنع عضو نهائياً من دخول هذا الروم بالذات.', en: '🚫 **Ban**\nPermanently bans a member from this specific room.' },
  vc_unban: { ar: '✅ **رفع الحظر**\nيلغي حظر عضو محظور مسبقاً من الروم.', en: '✅ **Unban**\nLifts a previous ban on a member for this room.' },
  vc_waitingroom: { ar: '🕐 **غرفة الانتظار**\nيفعّل روم صوتي مؤقت "ينتظر" فيه العضو لين توافق على طلبه.', en: '🕐 **Waiting Room**\nEnables a temporary voice room where a requester waits until you approve their request.' },
  vc_transfer: { ar: '🔁 **نقل الملكية**\nينقل ملكية الروم بالكامل لعضو ثاني تختاره.', en: '🔁 **Transfer Ownership**\nFully transfers room ownership to another member you choose.' },
  vc_claim: { ar: '👑 **أخذ الملكية**\nيخليك تصير مالك الروم إذا صاحبه الأصلي مو موجود بالروم.', en: '👑 **Claim Ownership**\nLets you become the room owner if the original owner isn\'t in the room.' },
  vc_stats: { ar: '📊 **إحصائياتي**\nيعرض لك عدد الرومات اللي أنشأتها وعدد الموجودين بالروم الحالي.', en: '📊 **My Stats**\nShows how many rooms you\'ve created and how many members are in this room now.' },
  vc_mute: { ar: '🔇 **كتم عضو**\nيكتم أو يفك كتم صوت عضو داخل الروم.', en: "🔇 **Mute Member**\nMutes or unmutes a member's voice inside the room." },
  vc_deafen: { ar: '🔕 **إصمام عضو**\nيمنع أو يسمح لعضو بسماع صوت باقي الأعضاء بالروم.', en: '🔕 **Deafen Member**\nPrevents or allows a member from hearing audio in the room.' },
  vc_report: { ar: '🚩 **إبلاغ الإدارة**\nيرسل بلاغ مباشر للإدارة عن أي مشكلة صايرة بالروم.', en: '🚩 **Report to Staff**\nSends a direct report to the staff about any issue happening in the room.' },
  vc_delete: { ar: '🗑️ **حذف الروم**\nيحذف الروم نهائياً.', en: '🗑️ **Delete Room**\nPermanently deletes the room.' }
};

// ==========================================
// COMMANDS REGISTRATION
// ==========================================
client.once('clientReady', async () => {
  console.log(`Nw Bot Logged in as ${client.user.tag}!`);

  const commands = [
    new SlashCommandBuilder().setName('settings').setDescription('لوحة إعدادات البوت الكاملة (رتب / فويس / تحذير إدارة)').setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

    new SlashCommandBuilder().setName('deleterole').setDescription('حذف رتبة عضو كمسؤول')
      .addUserOption(option => option.setName('user').setDescription('العضو').setRequired(true))
      .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

    new SlashCommandBuilder().setName('addemote').setDescription('إضافة إيموجي واحد أو أكثر للسيرفر تلقائياً من رسالة تحتوي عليهم')
      .addStringOption(o => o.setName('emotes').setDescription('الرسالة اللي فيها الإيموجي/الإيموجيات المطلوب إضافتها').setRequired(true))
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageEmojisAndStickers),

    new SlashCommandBuilder().setName('language').setDescription('[إدارة] تغيير لغة البوت لكامل السيرفر / [Admin] Change the bot language for the whole server')
      .addStringOption(o => o.setName('language').setDescription('Choose the language').setRequired(true)
        .addChoices({ name: 'Arabic', value: 'ar' }, { name: 'English', value: 'en' }))
      .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

    new SlashCommandBuilder().setName('owner-server').setDescription('[مالك البوت فقط] عرض جميع سيرفرات البوت مع روابط دعوة جديدة'),

    new SlashCommandBuilder().setName('help').setDescription('شرح كامل عن البوت وكل مميزاته'),

    new SlashCommandBuilder().setName('roulette').setDescription('🎃 بدء مباراة روليت جديدة بهذا الروم'),
    new SlashCommandBuilder().setName('shop').setDescription('🛒 فتح متجر الألعاب'),
    new SlashCommandBuilder().setName('profile').setDescription('👤 عرض بطاقة بروفايلك')
      .addUserOption(o => o.setName('user').setDescription('عضو آخر (اختياري)').setRequired(false)),
    new SlashCommandBuilder().setName('stats').setDescription('📊 عرض إحصائياتك كنص')
      .addUserOption(o => o.setName('user').setDescription('عضو آخر (اختياري)').setRequired(false)),
    new SlashCommandBuilder().setName('balance').setDescription('💰 عرض رصيد نقاطك'),
    new SlashCommandBuilder().setName('inventory').setDescription('🎒 عرض الأدوات والقدرات اللي تملكها'),
    new SlashCommandBuilder().setName('top').setDescription('🌍 عرض لوحات التصنيف')
      .addStringOption(o => o.setName('type').setDescription('نوع التصنيف').setRequired(true)
        .addChoices({ name: 'النقاط', value: 'points' }, { name: 'الفوز', value: 'wins' }, { name: 'الخبرة', value: 'xp' }, { name: 'الصوتيات', value: 'voice' }))
      .addStringOption(o => o.setName('scope').setDescription('النطاق').setRequired(true)
        .addChoices({ name: 'هذا السيرفر', value: 'server' }, { name: 'عالمي (كل السيرفرات)', value: 'global' })),
    new SlashCommandBuilder().setName('leaderboard').setDescription('🏆 توب 15 فوز بهذا السيرفر'),
    new SlashCommandBuilder().setName('edit').setDescription('🎨 تعديل بروفايلك (بانر/شارة/إطار/لقب من اللي اشتريته فقط)'),
    new SlashCommandBuilder().setName('history').setDescription('📜 عرض سجل آخر مبارياتك'),
    new SlashCommandBuilder().setName('log').setDescription('🧾 سجل حركة نقاطك'),
    new SlashCommandBuilder().setName('streak').setDescription('🔥 ستريكك وتوب الستريك (بريميوم)'),
    new SlashCommandBuilder().setName('activity').setDescription('🛍️ فتح المتجر كتطبيق (Activity) داخل ديسكورد')
  ];
  commands.forEach(c => { if (c.name !== 'owner-server') c.setDMPermission(false); }); // منع الأوامر بالخاص (كانت تسبب أخطاء)

  const rest = new REST({ version: '10' }).setToken(CONFIG.TOKEN);
  try {
    const body = commands.map(c => c.toJSON());
    // أمر نقطة الدخول للـ Activity (نوع 4) لازم يبقى، وإلا ديسكورد يرفض التحديث
    try {
      const existing = await rest.get(Routes.applicationCommands(CONFIG.CLIENT_ID));
      for (const c of existing) if (c.type === 4 && !body.some(b => b.name === c.name)) body.push({ name: c.name, description: c.description || 'Launch', type: 4, handler: c.handler, integration_types: c.integration_types, contexts: c.contexts });
    } catch (e) { console.warn('تعذر قراءة الأوامر الحالية:', e.message); }
    await rest.put(Routes.applicationCommands(CONFIG.CLIENT_ID), { body });
    console.log('Successfully registered all Nw commands.');
    startActivity();
  } catch (error) {
    console.error('Error registering commands:', error);
  }
});

// ==========================================
// 🌐 ACTIVITY (متجر داخل ديسكورد)
// ==========================================
let activityStarted = false;
async function renderItemPreviewPng(item) {
  const c = createCanvas(360, 240), g = c.getContext('2d');
  g.fillStyle = '#0a1630'; g.fillRect(0, 0, 360, 240);
  await drawItemPreview(g, item, 180, 120, 300, 190);
  return c.toBuffer('image/png');
}
function startActivity() {
  if (activityStarted) return; activityStarted = true;
  try {
    require('./activity').startActivityServer({
      client, getGameProfile, getShopItem, shopItemsForCategory, SHOP_CATEGORIES, SHOP_BUNDLES, bundleInfo,
      purchaseItem, purchaseBundle, rarityOf, itemState, ownedListKey, getLeaderboard, getRankOf, saveDatabase: () => saveDatabase(db),
      renderItemPreviewPng
    });
  } catch (e) { console.error('Activity لم يشتغل:', e.message); }
}

// ==========================================
// DB HELPERS
// ==========================================
function getServerSettings(guildId) {
  if (!db.serverSettings[guildId]) {
    db.serverSettings[guildId] = {
      baseRoleId: null, categoryId: null, logChannelId: null, allowedRoleId: null, embedImage: null,
      emojiBtn1: '✨', emojiBtn2: '🎨', emojiSubmit: '✅', emojiCancel: '🚪', emojiTry: '👀',
      emojiPrimary: '🎨', emojiSecondary: '🌈', emojiFarewell: '👋',
      allowGradient: true, allowImages: true,
      voiceHubChannelId: null, voiceCategoryId: null, voiceLogChannelId: null, voicePanelChannelId: null,
      staffRoleId: null,
      gamesChannelId: null, rouletteWinPoints: 30, rouletteLosePoints: 5, rouletteFinalBonus: 50, rouletteMaxPlayers: 10
    };
    for (const tgt of VC_EMOJI_TARGETS) db.serverSettings[guildId][tgt.field] = tgt.default;
    saveDatabase(db);
  } else {
    let changed = false;
    for (const tgt of VC_EMOJI_TARGETS) {
      if (!db.serverSettings[guildId][tgt.field]) { db.serverSettings[guildId][tgt.field] = tgt.default; changed = true; }
    }
    if (db.serverSettings[guildId].staffRoleId === undefined) { db.serverSettings[guildId].staffRoleId = null; changed = true; }
    if (db.serverSettings[guildId].gamesChannelId === undefined) { db.serverSettings[guildId].gamesChannelId = null; changed = true; }
    if (db.serverSettings[guildId].rouletteWinPoints === undefined) { db.serverSettings[guildId].rouletteWinPoints = 30; changed = true; }
    if (db.serverSettings[guildId].rouletteLosePoints === undefined) { db.serverSettings[guildId].rouletteLosePoints = 5; changed = true; }
    if (db.serverSettings[guildId].rouletteFinalBonus === undefined) { db.serverSettings[guildId].rouletteFinalBonus = 50; changed = true; }
    if (db.serverSettings[guildId].rouletteMaxPlayers === undefined) { db.serverSettings[guildId].rouletteMaxPlayers = 10; changed = true; }
    if (changed) saveDatabase(db);
  }
  return db.serverSettings[guildId];
}

function getRoleEntry(userId) {
  const raw = db.userCustomRoles[userId];
  if (!raw) return null;
  if (typeof raw === 'string') return { roleId: raw };
  return raw;
}

function checkMemberPermission(interaction) {
  const settings = getServerSettings(interaction.guild.id);
  if (interaction.member.permissions.has(PermissionFlagsBits.Administrator)) return true;
  if (settings.allowedRoleId && interaction.member.roles.cache.has(settings.allowedRoleId)) return true;
  return false;
}

function blendHexColors(c1, c2) {
  try {
    let hex1 = c1.replace('#', ''); let hex2 = c2.replace('#', '');
    if (hex1.length === 3) hex1 = hex1.split('').map(x => x + x).join('');
    if (hex2.length === 3) hex2 = hex2.split('').map(x => x + x).join('');
    const r1 = parseInt(hex1.substring(0, 2), 16), g1 = parseInt(hex1.substring(2, 4), 16), b1 = parseInt(hex1.substring(4, 6), 16);
    const r2 = parseInt(hex2.substring(0, 2), 16), g2 = parseInt(hex2.substring(2, 4), 16), b2 = parseInt(hex2.substring(4, 6), 16);
    const r = Math.round((r1 + r2) / 2), g = Math.round((g1 + g2) / 2), b = Math.round((b1 + b2) / 2);
    return (r << 16) | (g << 8) | b;
  } catch { return 0x3B0000; }
}

function normalizeHexColor(input) {
  if (!input) return null;
  let hex = input.trim().replace(/^#/, '').toUpperCase();
  if (/^[0-9A-F]{3}$/.test(hex)) hex = hex.split('').map(c => c + c).join('');
  if (!/^[0-9A-F]{6}$/.test(hex)) return null;
  return `#${hex}`;
}

// ==========================================
// MODULE 1: CORE — إنشاء/تعديل الرتب المخصصة
// ==========================================
async function createOrUpdateCustomRole(guild, member, session, settings) {
  const baseRole = guild.roles.cache.get(settings.baseRoleId);
  const targetPosition = baseRole ? baseRole.position + 1 : 1;
  const entry = getRoleEntry(member.id);
  const existingRole = entry ? guild.roles.cache.get(entry.roleId) : null;
  const warnings = [];

  let colorOptions;
  if (session.type === 'متدرج') colorOptions = { colors: { primaryColor: session.primary, secondaryColor: session.secondary } };
  else colorOptions = { color: session.primary };

  let iconOptions = {};
  if (session.iconType === 'unicode' && session.iconValue) iconOptions = { unicodeEmoji: session.iconValue };
  else if (session.iconType === 'custom' && session.iconValue) iconOptions = { icon: session.iconValue };
  else if ((session.iconType === 'upload' || session.iconType === 'sticker') && session.uploadedEmojiUrl && settings.allowImages) iconOptions = { icon: session.uploadedEmojiUrl };

  const baseData = { name: session.name, reason: `Custom Role for ${member.user.tag}` };

  // ⚠️ هذي الدالة تسوي فقط create/edit — بدون أي منطق خاص بالموضع، عشان فشل ضبط الموضع
  // ما يسبب أبداً إعادة محاولة أو إنشاء رتبة ثانية (هذا كان سبب تكرار الرتب).
  async function attempt(options) {
    if (existingRole) return await existingRole.edit(options);
    return await guild.roles.create({ ...options, position: targetPosition });
  }

  let role; let finalColorInt = null;
  try {
    role = await attempt({ ...baseData, ...colorOptions, ...iconOptions });
  } catch (errWithIcon) {
    console.error('فشلت المحاولة مع الأيقونة:', errWithIcon);
    warnings.push('icon');
    try {
      role = await attempt({ ...baseData, ...colorOptions });
    } catch (errWithGradient) {
      console.error('فشلت المحاولة مع التدرج الحقيقي:', errWithGradient);
      warnings.push('gradient');
      finalColorInt = blendHexColors(session.primary, session.secondary);
      role = await attempt({ ...baseData, color: finalColorInt });
    }
  }

  if (finalColorInt === null) finalColorInt = role.color;

  // ✅ نحفظ الرتبة بقاعدة البيانات فوراً هنا، فور نجاح الإنشاء/التعديل، وقبل أي خطوة إضافية (الموضع، إضافة الرتبة للعضو).
  // بهذا الشكل، أي فشل بعد هذي النقطة (موضع، صلاحيات) ما يسبب رتبة جديدة لاحقاً — الضغطة الجاية تعدّل على نفس الرتبة.
  db.userCustomRoles[member.id] = {
    roleId: role.id, name: session.name, type: session.type, primary: session.primary, secondary: session.secondary,
    iconType: session.iconType || 'none', iconValue: session.iconValue || null, uploadedEmojiUrl: session.uploadedEmojiUrl || null
  };
  saveDatabase(db);

  if (!member.roles.cache.has(role.id)) await member.roles.add(role).catch(() => {});

  // ضبط الموضع منفصل تماماً — فشله يضيف تحذير فقط، ولا يعيد أي محاولة إنشاء
  try {
    if (role.position !== targetPosition) {
      await role.setPosition(targetPosition, { relative: false });
    }
  } catch (posErr) {
    console.error('تعذر ضبط موضع الرتبة فوق رتبة الأساس (تأكد إن رتبة البوت أعلى من رتبة الأساس):', posErr);
    warnings.push('position');
  }

  return { role, finalColorInt, warnings };
}

// ==========================================
// MODULE 1: EMBEDS — لوحة تخصيص الرتبة
// ⚠️ هذي تبقى بلون الرتبة الفعلي، مو أسود — الهدف معاينة شكل الرتبة الحقيقي
// ==========================================
function getLexaSetupEmbed(sessionData, settings) {
  const name = sessionData.name || 'غير محدد';
  const type = sessionData.type || 'صلب';
  const primary = sessionData.primary || '#3B0000';
  const secondary = sessionData.secondary || '#8B0000';
  const icon = sessionData.icon || 'بدون';
  const editingNote = sessionData.isEditing ? `🔄 **ملاحظة:** لديك رتبة محفوظة مسبقاً، أي تجربة أو حفظ سيُطبَّق على نفس الرتبة.\n\n` : '';

  return new EmbedBuilder()
    .setTitle(`${settings.emojiPrimary || '🎨'} لوحة تخصيص رتبتك المخصصة`)
    .setDescription(`أهلاً بك **<@${sessionData.userId}>**، اضبط رتبتك بالكامل عبر الأزرار والقوائم أدناه:\n\n` +
      editingNote +
      `**اسم الرتبة:** ${name}\n**نمط اللون:** ${type}\n**اللون الأساسي:** \`${primary}\`\n**اللون الثانوي:** \`${secondary}\`\n**الملصق / الأيقونة:** ${icon}\n\n` +
      `👀 اضغط **جرب الرتبة** لتشوفها فعلياً على حسابك قبل الحفظ النهائي.\n` +
      `⏳ سيتم إغلاق وحذف هذا الروم تلقائياً بعد **5 دقائق** من عدم النشاط.`)
    .setColor(primary)
    .setTimestamp();
}

function getLexaComponents(settings) {
  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('lexa_set_name').setLabel('اسم الرتبة').setStyle(ButtonStyle.Secondary).setEmoji('✏️')
  );
  const selectMenuOptions = [{ label: 'صلب (Solid)', description: 'لون ثابت محدد', value: 'solid', emoji: '⬛' }];
  if (settings.allowGradient) selectMenuOptions.push({ label: 'متدرج (Gradient)', description: 'تدرج حقيقي بلونين', value: 'gradient', emoji: '🌈' });
  const row2 = new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder().setCustomId('lexa_select_type').setPlaceholder('اختر نمط اللون').addOptions(selectMenuOptions)
  );
  const row3Components = [new ButtonBuilder().setCustomId('lexa_set_primary').setLabel('اللون الأساسي').setStyle(ButtonStyle.Primary).setEmoji(settings.emojiPrimary || '🎨')];
  if (settings.allowGradient) row3Components.push(new ButtonBuilder().setCustomId('lexa_set_secondary').setLabel('اللون الثانوي').setStyle(ButtonStyle.Primary).setEmoji(settings.emojiSecondary || '🌈'));
  const row3 = new ActionRowBuilder().addComponents(row3Components);
  const iconOptions = [
    { label: 'بدون', description: 'بدون أيقونة', value: 'none', emoji: '❌' },
    { label: 'إيموجي / ملصق شات', description: 'أرسل إيموجي أو ملصق في الشات', value: 'emoji', emoji: '😀' }
  ];
  if (settings.allowImages) iconOptions.push({ label: 'رفع صورة إيموجي للسيرفر', description: 'رابط صورة ليتم رفعها إيموجي', value: 'image', emoji: '🖼️' });
  const row4 = new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder().setCustomId('lexa_select_icon_mode').setPlaceholder('اختر نوع الأيقونة / الملصق').addOptions(iconOptions)
  );
  const row5 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('lexa_try_role').setLabel('جرب الرتبة').setStyle(ButtonStyle.Secondary).setEmoji(settings.emojiTry || '👀'),
    new ButtonBuilder().setCustomId('lexa_submit_role').setLabel('حفظ وإنشاء الرتبة').setStyle(ButtonStyle.Success).setEmoji(settings.emojiSubmit || '✅'),
    new ButtonBuilder().setCustomId('lexa_cancel_role').setLabel('إلغاء وخروج').setStyle(ButtonStyle.Danger).setEmoji(settings.emojiCancel || '🚪')
  );
  return [row1, row2, row3, row4, row5];
}

// ==========================================
// MODULE 2: VOICE ROOMS — HELPERS
// ==========================================
function isRoomOwner(room, userId) { return room && room.ownerId === userId; }
function isOwnerOrTrusted(room, userId) { return room && (room.ownerId === userId || room.trustedUsers.includes(userId)); }

function collectMentionedMember(interaction, promptText) {
  return interaction.reply({ ...embedMsg(promptText), ephemeral: true }).then(() => {
    return new Promise((resolve) => {
      const filter = m => m.author.id === interaction.user.id;
      const collector = interaction.channel.createMessageCollector({ filter, time: 30000, max: 1 });
      let resolved = false;
      collector.on('collect', async m => {
        resolved = true;
        const mentioned = m.mentions.members.first();
        await m.delete().catch(() => {});
        resolve(mentioned || null);
      });
      collector.on('end', () => { if (!resolved) resolve(null); });
    });
  });
}

async function ensureWaitingRoomChannel(guild, room, mainChannel) {
  if (room.waitingRoomChannelId) {
    const existing = guild.channels.cache.get(room.waitingRoomChannelId);
    if (existing) return existing;
  }
  const waitingChannel = await guild.channels.create({
    name: `⏳-انتظار-${mainChannel.name}`.slice(0, 100),
    type: ChannelType.GuildVoice,
    parent: mainChannel.parentId || null
  });
  room.waitingRoomChannelId = waitingChannel.id;
  saveDatabase(db);
  return waitingChannel;
}

function getVoiceControlEmbed(room, settings) {
  const helpEmoji = settings.vcEmojiHelp || '📖';
  return new EmbedBuilder()
    .setTitle('🎛️ لوحة التحكم الصوتية')
    .setDescription(
      `أهلاً بك 👋 هذا رومك الخاص، تتحكم فيه بالكامل من الأزرار تحت.\n\n` +
      `👑 **صاحب الروم:** <@${room.ownerId}>\n` +
      `🔒 **الحالة:** ${room.locked ? 'مقفل' : 'مفتوح'}\n\n` +
      `ما تعرف وظيفة زر؟ اضغط **${helpEmoji}** لشرح كل الأزرار.`
    )
    .setColor(EMBED_COLOR)
    .setFooter({ text: 'Nw Voice System' })
    .setTimestamp();
}

function getVoiceControlComponents(settings) {
  const e = {};
  for (const tgt of VC_EMOJI_TARGETS) e[tgt.field] = settings[tgt.field] || tgt.default;
  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('vc_rename').setStyle(ButtonStyle.Secondary).setEmoji(e.vcEmojiRename),
    new ButtonBuilder().setCustomId('vc_limit').setStyle(ButtonStyle.Secondary).setEmoji(e.vcEmojiLimit),
    new ButtonBuilder().setCustomId('vc_privacy').setStyle(ButtonStyle.Secondary).setEmoji(e.vcEmojiPrivacy),
    new ButtonBuilder().setCustomId('vc_joinrequest').setStyle(ButtonStyle.Secondary).setEmoji(e.vcEmojiJoinrequest),
    new ButtonBuilder().setCustomId('vc_help').setStyle(ButtonStyle.Primary).setEmoji(e.vcEmojiHelp)
  );
  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('vc_trust').setStyle(ButtonStyle.Success).setEmoji(e.vcEmojiTrust),
    new ButtonBuilder().setCustomId('vc_untrust').setStyle(ButtonStyle.Danger).setEmoji(e.vcEmojiUntrust),
    new ButtonBuilder().setCustomId('vc_trustedlist').setStyle(ButtonStyle.Secondary).setEmoji(e.vcEmojiTrustedlist),
    new ButtonBuilder().setCustomId('vc_status').setStyle(ButtonStyle.Secondary).setEmoji(e.vcEmojiStatus)
  );
  const row3 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('vc_invite').setStyle(ButtonStyle.Primary).setEmoji(e.vcEmojiInvite),
    new ButtonBuilder().setCustomId('vc_kick').setStyle(ButtonStyle.Danger).setEmoji(e.vcEmojiKick),
    new ButtonBuilder().setCustomId('vc_ban').setStyle(ButtonStyle.Danger).setEmoji(e.vcEmojiBan),
    new ButtonBuilder().setCustomId('vc_unban').setStyle(ButtonStyle.Success).setEmoji(e.vcEmojiUnban)
  );
  const row4 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('vc_waitingroom').setStyle(ButtonStyle.Secondary).setEmoji(e.vcEmojiWaitingroom),
    new ButtonBuilder().setCustomId('vc_transfer').setStyle(ButtonStyle.Secondary).setEmoji(e.vcEmojiTransfer),
    new ButtonBuilder().setCustomId('vc_claim').setStyle(ButtonStyle.Secondary).setEmoji(e.vcEmojiClaim),
    new ButtonBuilder().setCustomId('vc_stats').setStyle(ButtonStyle.Secondary).setEmoji(e.vcEmojiStats)
  );
  const row5 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('vc_mute').setStyle(ButtonStyle.Secondary).setEmoji(e.vcEmojiMute),
    new ButtonBuilder().setCustomId('vc_deafen').setStyle(ButtonStyle.Secondary).setEmoji(e.vcEmojiDeafen),
    new ButtonBuilder().setCustomId('vc_report').setStyle(ButtonStyle.Danger).setEmoji(e.vcEmojiReport),
    new ButtonBuilder().setCustomId('vc_delete').setStyle(ButtonStyle.Danger).setEmoji(e.vcEmojiDelete)
  );
  return [row1, row2, row3, row4, row5];
}

function getVoiceHelpSelectRow(settings) {
  const e = {};
  for (const tgt of VC_EMOJI_TARGETS) e[tgt.field] = settings[tgt.field] || tgt.default;
  const options = VC_EMOJI_TARGETS.map(tgt => ({ label: tgt.name, value: tgt.value.replace('_emoji_', '_').replace('vc_', 'vc_'), emoji: e[tgt.field] }));
  // نحول القيم لنفس الـ customId المستخدم بالأزرار (vc_rename, vc_limit, ...)
  const helpOptions = [
    { label: 'تغيير الاسم', value: 'vc_rename', emoji: e.vcEmojiRename },
    { label: 'حد الأعضاء', value: 'vc_limit', emoji: e.vcEmojiLimit },
    { label: 'الخصوصية', value: 'vc_privacy', emoji: e.vcEmojiPrivacy },
    { label: 'طلب انضمام', value: 'vc_joinrequest', emoji: e.vcEmojiJoinrequest },
    { label: 'ثقة', value: 'vc_trust', emoji: e.vcEmojiTrust },
    { label: 'سحب الثقة', value: 'vc_untrust', emoji: e.vcEmojiUntrust },
    { label: 'الموثوقين', value: 'vc_trustedlist', emoji: e.vcEmojiTrustedlist },
    { label: 'حالة الروم', value: 'vc_status', emoji: e.vcEmojiStatus },
    { label: 'دعوة', value: 'vc_invite', emoji: e.vcEmojiInvite },
    { label: 'طرد', value: 'vc_kick', emoji: e.vcEmojiKick },
    { label: 'حظر', value: 'vc_ban', emoji: e.vcEmojiBan },
    { label: 'رفع الحظر', value: 'vc_unban', emoji: e.vcEmojiUnban },
    { label: 'غرفة الانتظار', value: 'vc_waitingroom', emoji: e.vcEmojiWaitingroom },
    { label: 'نقل الملكية', value: 'vc_transfer', emoji: e.vcEmojiTransfer },
    { label: 'أخذ الملكية', value: 'vc_claim', emoji: e.vcEmojiClaim },
    { label: 'إحصائياتي', value: 'vc_stats', emoji: e.vcEmojiStats },
    { label: 'كتم عضو', value: 'vc_mute', emoji: e.vcEmojiMute },
    { label: 'إصمام عضو', value: 'vc_deafen', emoji: e.vcEmojiDeafen },
    { label: 'إبلاغ الإدارة', value: 'vc_report', emoji: e.vcEmojiReport },
    { label: 'حذف الروم', value: 'vc_delete', emoji: e.vcEmojiDelete }
  ];
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder().setCustomId('vc_help_select').setPlaceholder('اختر الزر اللي تبي تعرف وظيفته').addOptions(helpOptions)
  );
}

async function createVoiceRoom(guild, member, settings) {
  const hubChannel = settings.voiceHubChannelId ? guild.channels.cache.get(settings.voiceHubChannelId) : null;
  const categoryId = settings.voiceCategoryId || (hubChannel ? hubChannel.parentId : null);
  const channelName = `🔊 روم ${member.displayName}`.slice(0, 100);

  const newChannel = await guild.channels.create({
    name: channelName,
    type: ChannelType.GuildVoice,
    parent: categoryId || null,
    permissionOverwrites: [
      { id: guild.id, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.Connect] },
      { id: member.id, allow: [
          PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.Connect,
          PermissionsBitField.Flags.ManageChannels, PermissionsBitField.Flags.MoveMembers,
          PermissionsBitField.Flags.MuteMembers, PermissionsBitField.Flags.DeafenMembers
        ] },
      { id: client.user.id, allow: [
          PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.Connect,
          PermissionsBitField.Flags.ManageChannels, PermissionsBitField.Flags.MoveMembers,
          PermissionsBitField.Flags.MuteMembers, PermissionsBitField.Flags.DeafenMembers,
          PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.CreateInstantInvite
        ] }
    ]
  });

  db.voiceRooms[newChannel.id] = {
    guildId: guild.id, ownerId: member.id, name: channelName, createdAt: Date.now(),
    locked: false, requireApproval: false, waitingRoomEnabled: false, waitingRoomChannelId: null,
    trustedUsers: [], bannedUsers: []
  };

  if (!db.userVoiceStats[member.id]) db.userVoiceStats[member.id] = { roomsCreated: 0 };
  db.userVoiceStats[member.id].roomsCreated += 1;
  db.userVoiceStats[member.id].lastRoomAt = Date.now();
  saveDatabase(db);

  try {
    await newChannel.send({
      embeds: [getVoiceControlEmbed(db.voiceRooms[newChannel.id], settings)],
      components: getVoiceControlComponents(settings)
    });
  } catch (e) {
    console.error('فشل إرسال لوحة تحكم الروم:', e);
  }

  if (settings.voiceLogChannelId) {
    const logChannel = guild.channels.cache.get(settings.voiceLogChannelId);
    if (logChannel) {
      const logLang = getUserLang(guild.id);
      const logDesc = logLang === 'en' ? `**Member:** ${member}\n**Room:** ${newChannel}` : `**العضو:** ${member}\n**الروم:** ${newChannel}`;
      const logTitle = logLang === 'en' ? '🔊 New Voice Room' : '🔊 روم صوتي جديد';
      await logChannel.send(embedMsg(logDesc, { title: logTitle })).catch(() => {});
    }
  }
  return newChannel;
}

// ==========================================
// MODULE 5: SETTINGS PANELS (الرول ميكر / الفويس ميكر / تحذير الإدارة)
// ==========================================
function getSettingsMainEmbed() {
  return new EmbedBuilder().setTitle('⚙️ إعدادات البوت').setDescription('اختر من القائمة تحت الجزء اللي تبي تعدله:').setColor(EMBED_COLOR);
}
function getSettingsMainComponents() {
  const row = new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder().setCustomId('settings_main').setPlaceholder('اختر القسم').addOptions(
      { label: 'صانع الرتب (Role Maker)', value: 'rolemaker', emoji: '🎭' },
      { label: 'صانع الفويس (Voice Maker)', value: 'voicemaker', emoji: '🔊' },
      { label: 'تحذير الإدارة (Staff Warn)', value: 'staffwarn', emoji: '🛡️' },
      { label: 'الإدارة (Moderation)', value: 'admin', emoji: '🛠️' },
      { label: 'الألعاب (Games)', value: 'games', emoji: '🎮' },
      { label: 'بريميوم (Premium)', value: 'premium', emoji: '🌟' }
    )
  );
  return [row];
}

function getRoleMakerEmbed(settings) {
  return new EmbedBuilder()
    .setTitle('🎭 صانع الرتب — الإعدادات')
    .setDescription(
      `**رتبة الأساس:** ${settings.baseRoleId ? `<@&${settings.baseRoleId}>` : 'غير محددة'}\n` +
      `**الكاتيجوري:** ${settings.categoryId ? `<#${settings.categoryId}>` : 'غير محددة'}\n` +
      `**قناة السجلات:** ${settings.logChannelId ? `<#${settings.logChannelId}>` : 'غير محددة'}\n` +
      `**الرتبة المسموحة:** ${settings.allowedRoleId ? `<@&${settings.allowedRoleId}>` : 'الكل (بدون تحديد)'}\n` +
      `**صورة الإمبيد:** ${settings.embedImage ? 'محددة ✅' : 'الافتراضية'}\n` +
      `**التدرج (لونين):** ${settings.allowGradient ? 'مفعّل ✅' : 'معطّل ❌'}\n` +
      `**الصور/الملصقات المرفوعة:** ${settings.allowImages ? 'مفعّل ✅' : 'معطّل ❌'}`
    )
    .setColor(EMBED_COLOR);
}
function getRoleMakerComponents() {
  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('rm_baserole').setLabel('رتبة الأساس').setStyle(ButtonStyle.Secondary).setEmoji('🏷️'),
    new ButtonBuilder().setCustomId('rm_category').setLabel('الكاتيجوري').setStyle(ButtonStyle.Secondary).setEmoji('📁'),
    new ButtonBuilder().setCustomId('rm_logchannel').setLabel('قناة السجلات').setStyle(ButtonStyle.Secondary).setEmoji('📜')
  );
  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('rm_allowedrole').setLabel('الرتبة المسموحة').setStyle(ButtonStyle.Secondary).setEmoji('🔑'),
    new ButtonBuilder().setCustomId('rm_embedimage').setLabel('صورة الإمبيد').setStyle(ButtonStyle.Secondary).setEmoji('🖼️'),
    new ButtonBuilder().setCustomId('rm_sendpanel').setLabel('إرسال لوحة الرتب').setStyle(ButtonStyle.Primary).setEmoji('📤')
  );
  const row3 = new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder().setCustomId('rm_emoji_select').setPlaceholder('✏️ تعديل إيموجي زر معين').addOptions(
      ROLE_EMOJI_TARGETS.map(t => ({ label: t.name, value: t.value }))
    )
  );
  const row4 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('rm_toggle_gradient').setLabel('تبديل: إظهار/إخفاء التدرج').setStyle(ButtonStyle.Secondary).setEmoji('🌈'),
    new ButtonBuilder().setCustomId('rm_toggle_images').setLabel('تبديل: إظهار/إخفاء الصور').setStyle(ButtonStyle.Secondary).setEmoji('🖼️')
  );
  const row5 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('settings_back').setLabel('رجوع للقائمة الرئيسية').setStyle(ButtonStyle.Danger).setEmoji('⬅️')
  );
  return [row1, row2, row3, row4, row5];
}

function getVoiceMakerEmbed(settings) {
  return new EmbedBuilder()
    .setTitle('🔊 صانع الفويس — الإعدادات')
    .setDescription(
      `**روم الإنشاء (الهب):** ${settings.voiceHubChannelId ? `<#${settings.voiceHubChannelId}>` : 'غير محدد'}\n` +
      `**كاتيجوري الرومات:** ${settings.voiceCategoryId ? `<#${settings.voiceCategoryId}>` : 'غير محددة'}\n` +
      `**قناة سجلات الفويس:** ${settings.voiceLogChannelId ? `<#${settings.voiceLogChannelId}>` : 'غير محددة'}`
    )
    .setColor(EMBED_COLOR);
}
function getVoiceMakerComponents() {
  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('vm_joinchannel').setLabel('روم الإنشاء').setStyle(ButtonStyle.Secondary).setEmoji('🎙️'),
    new ButtonBuilder().setCustomId('vm_category').setLabel('كاتيجوري الرومات').setStyle(ButtonStyle.Secondary).setEmoji('📁'),
    new ButtonBuilder().setCustomId('vm_logchannel').setLabel('قناة سجلات الفويس').setStyle(ButtonStyle.Secondary).setEmoji('📜')
  );
  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('vm_sendpanel').setLabel('إرسال لوحة المعلومات').setStyle(ButtonStyle.Primary).setEmoji('📤')
  );
  const row3 = new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder().setCustomId('vm_emoji_select').setPlaceholder('✏️ تعديل إيموجي زر فويس معين').addOptions(
      VC_EMOJI_TARGETS.map(t => ({ label: t.name, value: t.value }))
    )
  );
  const row4 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('settings_back').setLabel('رجوع للقائمة الرئيسية').setStyle(ButtonStyle.Danger).setEmoji('⬅️')
  );
  return [row1, row2, row3, row4];
}

function getStaffWarnEmbed(settings) {
  return new EmbedBuilder()
    .setTitle('🛡️ تحذير الإدارة — الإعدادات')
    .setDescription(
      `**رتبة الستاف:** ${settings.staffRoleId ? `<@&${settings.staffRoleId}>` : 'غير محددة'}\n\n` +
      `لما تحدد رتبة، أي بلاغ (🚩 إبلاغ الإدارة) داخل روم صوتي بيتمنشن فيها تلقائياً بقناة سجلات الفويس.`
    )
    .setColor(EMBED_COLOR);
}
function getStaffWarnComponents() {
  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('sw_setrole').setLabel('تحديد رتبة الستاف').setStyle(ButtonStyle.Secondary).setEmoji('🛡️'),
    new ButtonBuilder().setCustomId('sw_removerole').setLabel('إزالة الرتبة').setStyle(ButtonStyle.Danger).setEmoji('🗑️')
  );
  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('settings_back').setLabel('رجوع للقائمة الرئيسية').setStyle(ButtonStyle.Secondary).setEmoji('⬅️')
  );
  return [row1, row2];
}

function getAdminEmbed(settings) {
  const rl = settings && settings.rlShortcutOn && settings.rlShortcutChannelId ? `✅ مفعّل في <#${settings.rlShortcutChannelId}>` : '⛔ متوقف';
  return new EmbedBuilder()
    .setTitle('🛠️ الإدارة')
    .setDescription('أدوات إدارية سريعة: قفل/فتح الرومات النصية، حذف الرسائل، تحذير الأعضاء، وعرض لائحة تحذيرات أي عضو.\n\n' +
      `🎡 **اختصار الروليت:** ${rl}\nلما يكون مفعّل: اكتب **-روليت** بالروم المحدد لبدء روليت، و**-الغاء** لإلغائها.`)
    .setColor(EMBED_COLOR);
}
function getAdminComponents(settings) {
  const rlOn = !!(settings && settings.rlShortcutOn && settings.rlShortcutChannelId);
  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('adm_lock').setLabel('قفل روم').setStyle(ButtonStyle.Danger).setEmoji('🔒'),
    new ButtonBuilder().setCustomId('adm_unlock').setLabel('فتح روم').setStyle(ButtonStyle.Success).setEmoji('🔓'),
    new ButtonBuilder().setCustomId('adm_purge').setLabel('حذف رسائل').setStyle(ButtonStyle.Secondary).setEmoji('🧹')
  );
  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('adm_warn').setLabel('تحذير عضو').setStyle(ButtonStyle.Danger).setEmoji('⚠️'),
    new ButtonBuilder().setCustomId('adm_warnlist').setLabel('لائحة تحذيرات عضو').setStyle(ButtonStyle.Secondary).setEmoji('📋'),
    new ButtonBuilder().setCustomId('adm_rlshortcut').setLabel(rlOn ? 'اختصار الروليت: مفعّل (إيقاف)' : 'اختصار الروليت: متوقف (تفعيل)').setStyle(rlOn ? ButtonStyle.Success : ButtonStyle.Secondary).setEmoji('🎡')
  );
  const row3 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('settings_back').setLabel('رجوع للقائمة الرئيسية').setStyle(ButtonStyle.Secondary).setEmoji('⬅️')
  );
  return [row1, row2, row3];
}

// دالة إرسال لوحة الرتب فعلياً في قناة معينة (كانت أمر /setup-roles سابقاً)
async function sendRolePanel(channel, settings) {
  const embed = new EmbedBuilder().setTitle('🎨 نظام الرتب الخاصة').setDescription('تفاعل مع الأزرار أدناه لفتح لوحة تخصيص وإنشاء رتبتك المخصصة.').setColor(EMBED_COLOR);
  let usedFallback = false;
  try {
    embed.setImage(settings.embedImage && isValidImageUrl(settings.embedImage) ? settings.embedImage : DEFAULT_ROLE_PANEL_IMAGE);
    if (settings.embedImage && !isValidImageUrl(settings.embedImage)) throw new Error('invalid saved url');
  } catch (e) {
    console.error('رابط صورة الإمبيد غير صالح، استخدام الصورة الافتراضية:', e);
    embed.setImage(DEFAULT_ROLE_PANEL_IMAGE);
    usedFallback = true;
    settings.embedImage = null;
    saveDatabase(db);
  }
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('open_lexa_setup').setLabel('Create / Edit Role').setStyle(ButtonStyle.Primary).setEmoji(settings.emojiBtn1 || '✨'),
    new ButtonBuilder().setCustomId('my_role_info').setLabel('My Role').setStyle(ButtonStyle.Secondary).setEmoji(settings.emojiBtn2 || '🎨')
  );
  await channel.send({ embeds: [embed], components: [row] });
  return usedFallback;
}

// دالة إرسال لوحة معلومات الفويس (كانت أمر /setup-voice-panel سابقاً)
async function sendVoicePanel(channel, settings) {
  const hubMention = settings.voiceHubChannelId ? `<#${settings.voiceHubChannelId}>` : 'روم الإنشاء الصوتي';
  const embed = new EmbedBuilder()
    .setTitle('🔊 الرومات الصوتية الخاصة')
    .setDescription(`الرومات هنا **تلقائية بالكامل** ✨\n\nفقط ادخل ${hubMention} وبينشئ لك البوت روم خاص فيك وينقلك له مباشرة.\n\nبعد ما تدخل، بتلاقي **لوحة تحكم كاملة** داخل الروم.`)
    .setColor(EMBED_COLOR)
    .setFooter({ text: 'Nw Voice System' });
  await channel.send({ embeds: [embed] });
}

// ==========================================
// MODULE 6: GAMES / ECONOMY (روليت + متجر + بروفايل + تصنيفات)
// ==========================================
// ⭐ هنا تحط روابط صور البانرات الجاهزة (PNG/JPG مباشر) إذا تبي تثبتها بالكود.
// (الأسهل: مالك البوت يضيف بانرات جديدة بصورها وأسعارها من أمر /owner-server ← الكتالوج.)
// إذا حطيت رابط بـ imageUrl، البطاقة بترسم الصورة نفسها بدال التدرج اللوني. خليه null إذا تبي التدرج بس.
const SUPPORT_INVITE = 'https://discord.gg/fbzZnKYPCQ';
const MIN_SHOP_PRICE = 150; // أقل سعر لأي عنصر معروض بالمتجر (بانرات/شارات/إطارات/ألقاب)

// ---------- إيموجيات قابلة للتخصيص من مالك البوت (عالمي لكل السيرفرات) ----------
const GAME_EMOJI_KEYS = [
  { key: 'rl_join', name: 'زر انضمام الروليت', def: '🎃' },
  { key: 'rl_leave', name: 'زر انسحاب الروليت', def: '🚪' },
  { key: 'rl_start', name: 'زر بدء الروليت', def: '▶️' },
  { key: 'rl_cancel', name: 'زر إلغاء الروليت', def: '❌' },
  { key: 'rl_stop', name: 'زر إيقاف الروليت', def: '🛑' },
  { key: 'rl_revive', name: 'زر الإحياء', def: '💖' },
  { key: 'roulette', name: 'إيموجي الروليت (العناوين)', def: '🎡' },
  { key: 'win', name: 'إيموجي الفوز', def: '🏆' },
  { key: 'out', name: 'إيموجي الطرد', def: '💀' },
  { key: 'points', name: 'إيموجي النقاط', def: '💰' },
  { key: 'shop', name: 'إيموجي المتجر', def: '🛒' },
  { key: 'buy', name: 'زر الشراء', def: '💳' },
  { key: 'prev', name: 'زر السهم السابق', def: '◀️' },
  { key: 'next', name: 'زر السهم التالي', def: '▶️' },
  { key: 'home', name: 'زر الرجوع للمتجر', def: '🏠' },
  { key: 'shield', name: 'إيموجي درع النجاة', def: '🛡️' },
  { key: 'luck', name: 'إيموجي أنت وحظك', def: '🎲' },
  { key: 'doubleluck', name: 'إيموجي حظك وحظك', def: '🍀' },
  { key: 'kick', name: 'إيموجي الطرد المزدوج', def: '✂️' },
  { key: 'levelup', name: 'إيموجي رفع المستوى', def: '🎉' },
  { key: 'streak', name: 'إيموجي الستريك', def: '🔥' },
  { key: 'premium', name: 'إيموجي البريميوم', def: '🌟' },
  { key: 'owned', name: 'إيموجي "مملوك"', def: '✅' },
  { key: 'chan', name: 'زر تحديد الروم', def: '💬' },
  { key: 'profile', name: 'زر بروفايلي', def: '👤' },
  { key: 'inventory', name: 'زر مخزوني', def: '🎒' },
  { key: 'top', name: 'زر التوب', def: '🏆' },
  { key: 'edit', name: 'زر تعديل البروفايل', def: '🎨' },
  { key: 'history', name: 'زر سجل المباريات', def: '📜' },
  { key: 'log', name: 'زر سجل النقاط', def: '🧾' }
];
function validEmojiInput(s) {
  if (typeof s !== 'string') return false;
  const v = s.trim();
  if (/^<a?:\w{2,32}:\d{15,25}>$/.test(v)) return true;
  if (/^\p{Regional_Indicator}{2}$/u.test(v)) return true;
  return /^\p{Extended_Pictographic}(️|‍\p{Extended_Pictographic}|\p{Emoji_Modifier})*️?$/u.test(v);
}
function E(key) {
  const o = db.globalEmojis && db.globalEmojis[key];
  if (o) return o;
  const d = GAME_EMOJI_KEYS.find(k => k.key === key);
  return d ? d.def : '❔';
}

// ---------- الشارات ----------
const BADGE_KINDS = {
  star: { name: 'نجمة', color: '#ffd34d' }, heart: { name: 'قلب', color: '#ff4d6d' }, bolt: { name: 'صاعقة', color: '#ffe14d' },
  moon: { name: 'هلال', color: '#9fb4ff' }, crown: { name: 'تاج', color: '#ffb800' }, diamond: { name: 'ألماسة', color: '#4de1ff' },
  flame: { name: 'لهب', color: '#ff7518' }, skull: { name: 'جمجمة', color: '#e8e8e8' }, clover: { name: 'برسيم', color: '#2ecc71' },
  shield: { name: 'درع', color: '#4da3ff' }
};
// شارات خاصة يمنحها مالك البوت فقط وتظهر جنب الاسم تلقائياً (مثل التوثيق). c1/c2/glyph = شكلها لو ما فيه صورة.
const SPECIAL_BADGES = {
  verified: { name: 'موثّق', nameEn: 'Verified', emoji: '✅' },
  developer: { name: 'مطوّر', nameEn: 'Developer', emoji: '💻' },
  owner: { name: 'مالك البوت', nameEn: 'Bot Owner', emoji: '👑' },
  admin: { name: 'إدارة عليا', nameEn: 'Admin', emoji: '🛡️', c1: '#ef4444', c2: '#7f1d1d', glyph: 'shield' },
  moderator: { name: 'مشرف', nameEn: 'Moderator', emoji: '🔨', c1: '#3b82f6', c2: '#1e3a8a', glyph: 'check' },
  staff: { name: 'فريق الدعم', nameEn: 'Support Team', emoji: '🎧', c1: '#22c55e', c2: '#14532d', glyph: 'check' },
  partner: { name: 'شريك', nameEn: 'Partner', emoji: '🤝', c1: '#14b8a6', c2: '#0f766e', glyph: 'diamond' },
  vip: { name: 'VIP', nameEn: 'VIP', emoji: '💎', c1: '#a855f7', c2: '#6b21a8', glyph: 'diamond' },
  supporter: { name: 'داعم', nameEn: 'Supporter', emoji: '💖', c1: '#ec4899', c2: '#9d174d', glyph: 'heart' },
  premium: { name: 'بريميوم', nameEn: 'Premium', emoji: '🌟', c1: '#f59e0b', c2: '#b45309', glyph: 'star' },
  bughunter: { name: 'صائد ثغرات', nameEn: 'Bug Hunter', emoji: '🐛', c1: '#22c55e', c2: '#166534', glyph: 'bolt' },
  designer: { name: 'مصمم', nameEn: 'Designer', emoji: '🎨', c1: '#f472b6', c2: '#6366f1', glyph: 'star' },
  legend: { name: 'أسطورة', nameEn: 'Legend', emoji: '🏆', c1: '#facc15', c2: '#ca8a04', glyph: 'crown' }
};
// دمج الشارات الأساسية + تعديلات المالك (اسم/صورة) + الشارات المخصصة اللي يضيفها المالك
function specialBadge(key) {
  const cat = getCatalog();
  const base = SPECIAL_BADGES[key];
  const custom = cat.specials && cat.specials[key];
  const src = base || custom;
  if (!src) return null;
  const ov = (cat.specialOv && cat.specialOv[key]) || {};
  const out = { key, ...src, ...ov };
  if (!out.nameEn) out.nameEn = out.name;
  return out;
}
function specialKeys() { return [...Object.keys(SPECIAL_BADGES), ...Object.keys(getCatalog().specials || {})]; }

// ---------- كتالوج المتجر ----------
const SHOP_ITEMS = [
  // 🎡 أدوات الروليت — كلها استخدام مرة وحدة (تنخزن بالمخزون وتنصرف عند التفعيل)
  { id: 'shield', name: 'درع النجاة', emoji: '🛡️', price: 250, type: 'consumable', desc: 'يمنع طرد واحد. يُستهلك عند الاستخدام.' },
  { id: 'ability_luck', name: 'أنت وحظك', emoji: '🎲', price: 300, type: 'consumable', desc: 'لما تنختار للطرد: 40% تنجو وتنربط روحك بلاعب عشوائي. يُستهلك لما ينجح.' },
  { id: 'ability_doubleluck', name: 'حظك وحظك', emoji: '🍀', price: 450, type: 'consumable', desc: 'لما تنختار للطرد: 20% تنجو بمحاولة إضافية. يُستهلك لما ينجح.' },
  { id: 'ability_revive', name: 'إعادة الإحياء', emoji: '💖', price: 300, type: 'consumable', desc: 'ترجع للمباراة بعد الطرد (زر 15 ثانية). يُستهلك عند الاستخدام.' },
  { id: 'double_kick', name: 'طرد مرتين', emoji: '✂️', price: 200, type: 'consumable', desc: 'تفعّله بدورك وتطرد لاعبين بدل واحد. يُستهلك عند الاستخدام.' },
  // 🖼️ البانرات
  { id: 'banner_halloween', name: 'بانر هالوين', emoji: '🎃', price: 150, type: 'banner', desc: 'بانر برتقالي-أسود لبطاقتك الشخصية.', colors: ['#120403', '#ff7518', '#2a0a06'], imageUrl: null },
  { id: 'banner_midnight', name: 'بانر منتصف الليل', emoji: '🌙', price: 150, type: 'banner', desc: 'بانر أزرق داكن غامض لبطاقتك.', colors: ['#03040c', '#1b2a6b', '#05070f'], imageUrl: null },
  { id: 'banner_blood', name: 'بانر دموي', emoji: '🩸', price: 200, type: 'banner', desc: 'بانر أحمر قاتم لبطاقتك.', colors: ['#0d0000', '#8b0000', '#1a0202'], imageUrl: null },
  { id: 'banner_ocean', name: 'بانر المحيط', emoji: '🌊', price: 200, type: 'banner', desc: 'بانر أزرق بحري هادي.', colors: ['#021a2b', '#0a6c9b', '#03121c'], imageUrl: null },
  { id: 'banner_forest', name: 'بانر الغابة', emoji: '🌲', price: 200, type: 'banner', desc: 'بانر أخضر غامق.', colors: ['#031a0a', '#1f8f4a', '#04140a'], imageUrl: null },
  { id: 'banner_sunset', name: 'بانر الغروب', emoji: '🌅', price: 250, type: 'banner', desc: 'بانر غروب وردي-برتقالي.', colors: ['#2a0a1f', '#ff5f6d', '#ffc371'], imageUrl: null },
  { id: 'banner_royal', name: 'بانر ملكي', emoji: '👑', price: 300, type: 'banner', desc: 'بانر بنفسجي فخم.', colors: ['#0d0221', '#6a0dad', '#1b0a3a'], imageUrl: null },
  { id: 'banner_gold', name: 'بانر ذهبي', emoji: '✨', price: 350, type: 'banner', desc: 'بانر ذهبي لامع.', colors: ['#1a1205', '#d4af37', '#2b1d05'], imageUrl: null },
  // 🔲 الإطارات
  { id: 'frame_gold', name: 'إطار ذهبي', emoji: '🥇', price: 250, type: 'frame', desc: 'إطار ذهبي حول صورتك بالبطاقة.', color: '#d4af37' },
  { id: 'frame_blood', name: 'إطار دموي', emoji: '🩸', price: 200, type: 'frame', desc: 'إطار أحمر داكن حول صورتك بالبطاقة.', color: '#c0141c' },
  { id: 'frame_ghost', name: 'إطار شبحي', emoji: '👻', price: 200, type: 'frame', desc: 'إطار أبيض لامع حول صورتك بالبطاقة.', color: '#e9ecff' },
  { id: 'frame_neon', name: 'إطار نيون', emoji: '💠', price: 250, type: 'frame', desc: 'إطار سماوي نيون.', color: '#00e5ff' },
  { id: 'frame_emerald', name: 'إطار زمردي', emoji: '💚', price: 250, type: 'frame', desc: 'إطار أخضر زمردي.', color: '#2ecc71' },
  { id: 'frame_royal', name: 'إطار ملكي', emoji: '💜', price: 300, type: 'frame', desc: 'إطار بنفسجي ملكي.', color: '#a855f7' },
  { id: 'frame_rose', name: 'إطار وردي', emoji: '🌸', price: 250, type: 'frame', desc: 'إطار وردي.', color: '#ff6fb5' },
  { id: 'frame_rainbow', name: 'إطار قوس قزح', emoji: '🌈', price: 400, type: 'frame', desc: 'إطار متدرج بألوان قوس قزح.', color: '#ff4d4d', colors: ['#ff4d4d', '#ffd34d', '#4dff88', '#4dc3ff', '#b84dff'] },
  // 🏷️ الألقاب
  { id: 'title_rookie', name: 'مبتدئ', emoji: '🌱', price: 150, type: 'title', desc: 'لقب يظهر تحت اسمك على البطاقة.', text: 'ROOKIE' },
  { id: 'title_ghost', name: 'شبح', emoji: '👻', price: 150, type: 'title', desc: 'لقب يظهر تحت اسمك على البطاقة.', text: 'GHOST' },
  { id: 'title_lucky', name: 'محظوظ', emoji: '🍀', price: 150, type: 'title', desc: 'لقب يظهر تحت اسمك على البطاقة.', text: 'LUCKY' },
  { id: 'title_survivor', name: 'الناجي', emoji: '🛡️', price: 200, type: 'title', desc: 'لقب يظهر تحت اسمك على البطاقة.', text: 'SURVIVOR' },
  { id: 'title_gambler', name: 'مقامر', emoji: '🎲', price: 200, type: 'title', desc: 'لقب يظهر تحت اسمك على البطاقة.', text: 'GAMBLER' },
  { id: 'title_shadow', name: 'ظل', emoji: '🌑', price: 200, type: 'title', desc: 'لقب يظهر تحت اسمك على البطاقة.', text: 'SHADOW' },
  { id: 'title_nightowl', name: 'سهران', emoji: '🦉', price: 200, type: 'title', desc: 'لقب يظهر تحت اسمك على البطاقة.', text: 'NIGHT OWL' },
  { id: 'title_champion', name: 'بطل الروليت', emoji: '🏆', price: 250, type: 'title', desc: 'لقب يظهر تحت اسمك على البطاقة.', text: 'ROULETTE CHAMPION' },
  { id: 'title_phantom', name: 'فانتوم', emoji: '🕸️', price: 250, type: 'title', desc: 'لقب يظهر تحت اسمك على البطاقة.', text: 'PHANTOM' },
  { id: 'title_legend', name: 'أسطورة', emoji: '👑', price: 300, type: 'title', desc: 'لقب نادر يظهر تحت اسمك على البطاقة.', text: 'LEGEND' },
  { id: 'title_streak100', name: 'لهب البنفسج', emoji: '🔥', price: 0, forSale: false, type: 'title', desc: 'لقب أسطوري لمن وصل ستريك 100 يوم.', text: 'VIOLET FLAME LEGEND' },
  { id: 'badge_streak_violet', name: 'بادج الستريك البنفسجي', emoji: '🟣', price: 0, forSale: false, type: 'badge', kind: 'flame', color: '#9b5cff', desc: 'بادج بنفسجي لمن وصل ستريك 75 يوم.' },
  { id: 'title_hking', name: 'ملك الهالوين', emoji: '🎃', price: 300, type: 'title', desc: 'لقب يظهر تحت اسمك على البطاقة.', text: 'HALLOWEEN KING' },
  { id: 'title_hqueen', name: 'ملكة الهالوين', emoji: '🦇', price: 300, type: 'title', desc: 'لقب يظهر تحت اسمك على البطاقة.', text: 'HALLOWEEN QUEEN' },
  { id: 'title_untouchable', name: 'ما أحد يلمسه', emoji: '💪', price: 350, type: 'title', desc: 'لقب يظهر تحت اسمك على البطاقة.', text: 'UNTOUCHABLE' },
  { id: 'title_godluck', name: 'إله الحظ', emoji: '🔮', price: 400, type: 'title', desc: 'لقب يظهر تحت اسمك على البطاقة.', text: 'GOD OF LUCK' },
  { id: 'title_mythic', name: 'خرافي', emoji: '🐉', price: 500, type: 'title', desc: 'لقب أسطوري يظهر تحت اسمك على البطاقة.', text: 'MYTHIC' },
  // 🏅 الشارات (تظهر جنب الاسم)
  { id: 'badge_star', name: 'شارة نجمة', emoji: '⭐', price: 150, type: 'badge', kind: 'star', desc: 'شارة نجمة تظهر جنب اسمك.' },
  { id: 'badge_heart', name: 'شارة قلب', emoji: '❤️', price: 150, type: 'badge', kind: 'heart', desc: 'شارة قلب تظهر جنب اسمك.' },
  { id: 'badge_moon', name: 'شارة هلال', emoji: '🌙', price: 200, type: 'badge', kind: 'moon', desc: 'شارة هلال تظهر جنب اسمك.' },
  { id: 'badge_bolt', name: 'شارة صاعقة', emoji: '⚡', price: 200, type: 'badge', kind: 'bolt', desc: 'شارة صاعقة تظهر جنب اسمك.' },
  { id: 'badge_clover', name: 'شارة برسيم', emoji: '🍀', price: 250, type: 'badge', kind: 'clover', desc: 'شارة برسيم الحظ تظهر جنب اسمك.' },
  { id: 'badge_flame', name: 'شارة لهب', emoji: '🔥', price: 250, type: 'badge', kind: 'flame', desc: 'شارة لهب تظهر جنب اسمك.' },
  { id: 'badge_skull', name: 'شارة جمجمة', emoji: '💀', price: 250, type: 'badge', kind: 'skull', desc: 'شارة جمجمة تظهر جنب اسمك.' },
  { id: 'badge_shield', name: 'شارة درع', emoji: '🛡️', price: 300, type: 'badge', kind: 'shield', desc: 'شارة درع تظهر جنب اسمك.' },
  { id: 'badge_crown', name: 'شارة تاج', emoji: '👑', price: 300, type: 'badge', kind: 'crown', desc: 'شارة تاج تظهر جنب اسمك.' },
  { id: 'badge_diamond', name: 'شارة ألماسة', emoji: '💎', price: 350, type: 'badge', kind: 'diamond', desc: 'شارة ألماسة تظهر جنب اسمك.' },
  // ✨ الديكورات (تتركب فوق صورتك الشخصية)
  { id: 'deco_halo', name: 'هالة ملاك', emoji: '😇', price: 300, type: 'decoration', kind: 'halo', desc: 'هالة ذهبية فوق صورتك.' },
  { id: 'deco_horns', name: 'قرون شيطان', emoji: '😈', price: 300, type: 'decoration', kind: 'horns', desc: 'قرون حمراء فوق صورتك.' },
  { id: 'deco_sparkles', name: 'بريق', emoji: '✨', price: 350, type: 'decoration', kind: 'sparkles', desc: 'نجوم لامعة حول صورتك.' },
  { id: 'deco_flames', name: 'نار', emoji: '🔥', price: 400, type: 'decoration', kind: 'flames', desc: 'ألسنة نار حول صورتك.' },
  { id: 'deco_crown', name: 'تاج ملكي', emoji: '👑', price: 450, type: 'decoration', kind: 'crown', desc: 'تاج ذهبي فوق صورتك.' }
];
// عناصر المالك + تعديلاته على العناصر الأساسية — عالمية لكل السيرفرات
function getCatalog() {
  if (!db.catalog) db.catalog = {};
  if (!db.catalog.items) db.catalog.items = {};
  if (!db.catalog.overrides) db.catalog.overrides = {};
  if (!db.catalog.specials) db.catalog.specials = {};
  if (!db.catalog.specialOv) db.catalog.specialOv = {};
  return db.catalog;
}
function applyOverride(it) { const ov = getCatalog().overrides[it.id]; return ov ? { ...it, ...ov } : it; }
function getAllShopItems() { return [...SHOP_ITEMS.map(applyOverride), ...Object.values(getCatalog().items)]; }
function getShopItem(id) { const b = SHOP_ITEMS.find(i => i.id === id); return b ? applyOverride(b) : (getCatalog().items[id] || null); }
function ownedListKey(type) {
  return { banner: 'banners', frame: 'frames', title: 'titles', badge: 'badges', decoration: 'decorations' }[type] || 'abilities';
}
const SHOP_CATEGORIES = [
  { id: 'banner', label: 'صور البانرات', labelEn: 'Banners', emoji: '🖼️', desc: 'خلفيات لبطاقتك' },
  { id: 'badge', label: 'الشارات', labelEn: 'Badges', emoji: '🏅', desc: 'تظهر جنب اسمك' },
  { id: 'decoration', label: 'الديكورات', labelEn: 'Decorations', emoji: '✨', desc: 'تتركب فوق صورتك' },
  { id: 'frame', label: 'الإطارات', labelEn: 'Frames', emoji: '🔲', desc: 'إطار حول صورتك' },
  { id: 'title', label: 'الألقاب', labelEn: 'Titles', emoji: '🏷️', desc: 'لقب تحت اسمك' },
  { id: 'roulette', label: 'أدوات الروليت', labelEn: 'Roulette Items', emoji: '🎡', desc: 'استخدام مرة وحدة' }
];
function shopItemsForCategory(cat) {
  if (cat === 'roulette') return getAllShopItems().filter(i => i.type === 'consumable' && !i.hidden && i.price > 0);
  return getAllShopItems().filter(i => i.type === cat && i.forSale !== false && !i.hidden && i.price > 0).sort((a, b) => a.price - b.price);
}

// ---------- ملف اللاعب (اقتصاد عام يشمل كل السيرفرات) ----------
function getGameProfile(userId) {
  if (!db.gameProfiles) db.gameProfiles = {};
  if (!db.gameProfiles[userId]) {
    db.gameProfiles[userId] = {
      points: 0, xp: 0, level: 1,
      wins: 0, losses: 0, roulettePlays: 0, matchWins: 0,
      kicksGiven: 0, savesGiven: 0, voiceMs: 0,
      inventory: {},
      owned: { banners: [], frames: [], titles: [], abilities: [], badges: [], decorations: [] },
      equipped: { banner: null, frame: null, title: null, badge: null, decoration: null },
      special: [], log: [], history: [], shieldClaimed: false
    };
    saveDatabase(db);
  }
  const p = db.gameProfiles[userId];
  if (!p.inventory) p.inventory = {};
  if (!p.owned) p.owned = {};
  for (const k of ['banners', 'frames', 'titles', 'abilities', 'badges', 'decorations']) if (!Array.isArray(p.owned[k])) p.owned[k] = [];
  if (!p.equipped) p.equipped = {};
  for (const k of ['banner', 'frame', 'title', 'badge', 'decoration']) if (p.equipped[k] === undefined) p.equipped[k] = null;
  // ترحيل: القدرات القديمة (دائمة) صارت أدوات استخدام مرة — كل قدرة قديمة تتحول لواحدة بالمخزون
  if (p.owned.abilities.length) { for (const id of p.owned.abilities) p.inventory[id] = (p.inventory[id] || 0) + 1; p.owned.abilities = []; saveDatabase(db); }
  if (!Array.isArray(p.special)) p.special = [];
  if (!Array.isArray(p.log)) p.log = [];
  if (!Array.isArray(p.history)) p.history = [];
  return p;
}
function xpForLevel(level) { return Math.round(100 * Math.pow(level, 1.4)); }
function totalXpOf(p) { let t = p.xp; for (let l = 1; l < p.level; l++) t += xpForLevel(l); return t; }
function addXp(userId, amount) {
  const p = getGameProfile(userId);
  p.xp += amount;
  let leveledUp = false;
  while (p.xp >= xpForLevel(p.level)) { p.xp -= xpForLevel(p.level); p.level += 1; leveledUp = true; }
  saveDatabase(db);
  return leveledUp;
}
const REASON_TEXT = {
  roulette_win: { ar: 'فوز بالروليت', en: 'Roulette win' },
  roulette_final: { ar: 'مكافأة الفوز النهائي', en: 'Final win bonus' },
  roulette_out: { ar: 'مشاركة (طرد) بالروليت', en: 'Roulette participation' },
  levelup: { ar: 'مكافأة رفع المستوى', en: 'Level-up bonus' },
  shop: { ar: 'شراء من المتجر', en: 'Shop purchase' },
  owner: { ar: 'من إدارة البوت', en: 'From bot staff' }
};
function addPoints(userId, amount, reason) {
  const p = getGameProfile(userId);
  const before = p.points;
  p.points = Math.max(0, p.points + amount);
  const applied = p.points - before;
  if (applied !== 0) {
    p.log.unshift({ a: applied, r: reason || 'owner', t: Date.now() });
    p.log = p.log.slice(0, 40);
  }
  saveDatabase(db);
  return p.points;
}
function addInventory(userId, itemId, count = 1) {
  const p = getGameProfile(userId);
  p.inventory[itemId] = (p.inventory[itemId] || 0) + count;
  saveDatabase(db);
}
function consumeInventory(userId, itemId) {
  const p = getGameProfile(userId);
  if (!p.inventory[itemId] || p.inventory[itemId] <= 0) return false;
  p.inventory[itemId] -= 1;
  saveDatabase(db);
  return true;
}
function pushMatchHistory(userId, entry) {
  const p = getGameProfile(userId);
  p.history.unshift(entry);
  p.history = p.history.slice(0, 15);
  saveDatabase(db);
}
function formatDuration(ms) {
  const totalMinutes = Math.floor((ms || 0) / 60000);
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  return h === 0 ? `${m} د` : `${h} س ${m} د`;
}
function formatDurationEn(ms) {
  const totalMinutes = Math.floor((ms || 0) / 60000);
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  return h === 0 ? `${m}m` : `${h}h ${m}m`;
}
const LEADERBOARD_SIZE = 15; // التوب 15 فقط (للجوائز)
function getLeaderboard(type, scope, guildMemberIds) {
  const entries = Object.entries(db.gameProfiles || {});
  const filtered = scope === 'server' && guildMemberIds ? entries.filter(([uid]) => guildMemberIds.has(uid)) : entries;
  const sortKey = {
    points: p => p.points, wins: p => p.wins, xp: p => (p.level * 1000000) + p.xp, voice: p => p.voiceMs
  }[type] || (p => p.points);
  return filtered.map(([uid, p]) => ({ uid, value: sortKey(p), profile: p }))
    .filter(e => e.value > 0)
    .sort((a, b) => b.value - a.value).slice(0, LEADERBOARD_SIZE);
}
function getRankOf(userId, type, scope, guildMemberIds) {
  const all = Object.entries(db.gameProfiles || {})
    .filter(([uid]) => scope !== 'server' || !guildMemberIds || guildMemberIds.has(uid))
    .map(([uid, p]) => ({ uid, value: type === 'points' ? p.points : type === 'wins' ? p.wins : type === 'voice' ? p.voiceMs : (p.level * 1000000) + p.xp }))
    .sort((a, b) => b.value - a.value);
  const idx = all.findIndex(e => e.uid === userId);
  return idx === -1 ? null : idx + 1;
}

// ---------- أدوات رسم البطاقة (Canvas) ----------
const CARD_FONT = '"NwFont","Cairo","Noto Sans Arabic","Noto Sans","DejaVu Sans","Segoe UI",Arial,sans-serif';
let HAS_CUSTOM_FONT = false;
try {
  const fontsDir = path.join(__dirname, 'fonts');
  if (fs.existsSync(fontsDir)) {
    for (const f of fs.readdirSync(fontsDir)) {
      if (/\.(ttf|otf)$/i.test(f)) { GlobalFonts.registerFromPath(path.join(fontsDir, f), 'NwFont'); HAS_CUSTOM_FONT = true; }
    }
  }
} catch (e) { console.error('تعذر تحميل الخطوط من مجلد fonts:', e); }
// ينظّف الاسم قبل رسمه على الصور: بدون خط مخصص الحروف غير اللاتينية تطلع مربعات، فنشيلها
function safeName(name, fallback) {
  let t = String(name == null ? '' : name).normalize('NFKC');
  t = t.replace(/[\u0000-\u001f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufe0e\ufe0f]/g, '').replace(/[\u{1F000}-\u{1FFFF}\u{2190}-\u{2BFF}]/gu, '');
  if (!HAS_CUSTOM_FONT) t = t.replace(/[^A-Za-z0-9 _.\-!?@#$%&*()+=:;,'"\/|<>\[\]{}~^`\u00C0-\u024F]/g, '');
  t = t.replace(/\s+/g, ' ').trim();
  return t || fallback;
}

function rrect(ctx, x, y, w, h, r) {
  r = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y); ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r); ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h); ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r); ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}
async function loadRemoteImage(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 9000);
  try {
    const resp = await fetch(url, { signal: ctrl.signal });
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    return await loadImage(Buffer.from(await resp.arrayBuffer()));
  } finally { clearTimeout(timer); }
}
function poly(ctx, pts) { ctx.beginPath(); pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y))); ctx.closePath(); }
// يرسم شارة بأشكال vector (ما يعتمد على خط إيموجي بالاستضافة)
function drawBadge(ctx, kind, cx, cy, s, color) {
  const r = s / 2;
  ctx.save();
  ctx.translate(cx, cy);
  ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  const fillShape = (col) => { ctx.fillStyle = col; ctx.fill(); ctx.strokeStyle = 'rgba(0,0,0,0.45)'; ctx.lineWidth = Math.max(1.5, r * 0.08); ctx.stroke(); };
  switch (kind) {
    case 'verified': {
      ctx.beginPath(); ctx.arc(0, 0, r, 0, Math.PI * 2); fillShape('#2f8cff');
      ctx.strokeStyle = '#ffffff'; ctx.lineWidth = r * 0.24;
      ctx.beginPath(); ctx.moveTo(-r * 0.45, r * 0.02); ctx.lineTo(-r * 0.1, r * 0.38); ctx.lineTo(r * 0.5, -r * 0.32); ctx.stroke();
      break;
    }
    case 'developer': {
      rrect(ctx, -r, -r, s, s, r * 0.35);
      const g = ctx.createLinearGradient(-r, -r, r, r); g.addColorStop(0, '#8b5cf6'); g.addColorStop(1, '#4f46e5');
      fillShape(g);
      ctx.strokeStyle = '#ffffff'; ctx.lineWidth = r * 0.2;
      ctx.beginPath(); ctx.moveTo(-r * 0.2, -r * 0.45); ctx.lineTo(-r * 0.6, 0); ctx.lineTo(-r * 0.2, r * 0.45); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(r * 0.2, -r * 0.45); ctx.lineTo(r * 0.6, 0); ctx.lineTo(r * 0.2, r * 0.45); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(r * 0.12, -r * 0.55); ctx.lineTo(-r * 0.12, r * 0.55); ctx.stroke();
      break;
    }
    case 'owner': {
      const g = ctx.createLinearGradient(-r, -r, r, r); g.addColorStop(0, '#ffe08a'); g.addColorStop(1, '#b8860b');
      ctx.beginPath(); ctx.arc(0, 0, r, 0, Math.PI * 2); fillShape(g);
      ctx.beginPath(); ctx.arc(0, 0, r * 0.78, 0, Math.PI * 2); ctx.fillStyle = '#2a0f4d'; ctx.fill();
      poly(ctx, [[-r * 0.5, r * 0.3], [-r * 0.55, -r * 0.3], [-r * 0.25, 0], [0, -r * 0.5], [r * 0.25, 0], [r * 0.55, -r * 0.3], [r * 0.5, r * 0.3]]);
      ctx.fillStyle = '#ffd34d'; ctx.fill();
      rrect(ctx, -r * 0.5, r * 0.3, r, r * 0.15, r * 0.05); ctx.fill();
      ctx.fillStyle = '#ff4d6d'; ctx.beginPath(); ctx.arc(0, r * 0.05, r * 0.09, 0, Math.PI * 2); ctx.fill();
      break;
    }
    case 'crown': {
      poly(ctx, [[-r * 0.85, r * 0.55], [-r * 0.85, -r * 0.4], [-r * 0.4, 0.05 * r], [0, -r * 0.7], [r * 0.4, 0.05 * r], [r * 0.85, -r * 0.4], [r * 0.85, r * 0.55]]);
      fillShape(color || '#ffb800');
      break;
    }
    case 'skull': {
      ctx.beginPath(); ctx.arc(0, -r * 0.1, r * 0.82, Math.PI, 0); ctx.lineTo(r * 0.55, r * 0.55); ctx.lineTo(-r * 0.55, r * 0.55); ctx.closePath();
      fillShape(color || '#e8e8e8');
      ctx.fillStyle = '#1a1a1a'; for (const sx of [-1, 1]) { ctx.beginPath(); ctx.arc(sx * r * 0.34, -r * 0.08, r * 0.2, 0, Math.PI * 2); ctx.fill(); }
      poly(ctx, [[0, r * 0.12], [-r * 0.1, r * 0.34], [r * 0.1, r * 0.34]]); ctx.fill();
      ctx.strokeStyle = '#1a1a1a'; ctx.lineWidth = r * 0.07; ctx.beginPath(); for (const x of [-0.25, 0, 0.25]) { ctx.moveTo(x * r, r * 0.42); ctx.lineTo(x * r, r * 0.55); } ctx.stroke();
      break;
    }
    case 'clover': {
      ctx.fillStyle = color || '#2ecc71'; ctx.strokeStyle = 'rgba(0,0,0,0.45)'; ctx.lineWidth = Math.max(1.5, r * 0.08);
      for (const [dx, dy] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) { ctx.beginPath(); ctx.arc(dx * r * 0.36, dy * r * 0.36, r * 0.42, 0, Math.PI * 2); ctx.fill(); ctx.stroke(); }
      ctx.strokeStyle = '#1b7a43'; ctx.lineWidth = r * 0.14; ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(r * 0.45, r * 0.95); ctx.stroke();
      break;
    }
    case 'shield': {
      ctx.beginPath(); ctx.moveTo(0, -r); ctx.lineTo(r * 0.82, -r * 0.6); ctx.lineTo(r * 0.82, r * 0.1);
      ctx.quadraticCurveTo(r * 0.82, r * 0.7, 0, r); ctx.quadraticCurveTo(-r * 0.82, r * 0.7, -r * 0.82, r * 0.1);
      ctx.lineTo(-r * 0.82, -r * 0.6); ctx.closePath(); fillShape(color || '#4da3ff');
      ctx.strokeStyle = 'rgba(255,255,255,0.8)'; ctx.lineWidth = r * 0.1; ctx.beginPath(); ctx.moveTo(0, -r * 0.65); ctx.lineTo(0, r * 0.6); ctx.stroke();
      break;
    }
    case 'staff': {
      ctx.beginPath(); ctx.moveTo(0, -r); ctx.lineTo(r * 0.82, -r * 0.6); ctx.lineTo(r * 0.82, r * 0.1);
      ctx.quadraticCurveTo(r * 0.82, r * 0.7, 0, r); ctx.quadraticCurveTo(-r * 0.82, r * 0.7, -r * 0.82, r * 0.1);
      ctx.lineTo(-r * 0.82, -r * 0.6); ctx.closePath(); fillShape('#22c55e');
      ctx.strokeStyle = '#ffffff'; ctx.lineWidth = r * 0.2;
      ctx.beginPath(); ctx.moveTo(-r * 0.3, 0); ctx.lineTo(-r * 0.05, r * 0.28); ctx.lineTo(r * 0.38, -r * 0.25); ctx.stroke();
      break;
    }
    case 'star': {
      const pts = [];
      for (let i = 0; i < 10; i++) { const a = -Math.PI / 2 + i * Math.PI / 5; const rad = i % 2 === 0 ? r : r * 0.45; pts.push([Math.cos(a) * rad, Math.sin(a) * rad]); }
      poly(ctx, pts); fillShape(color || '#ffd34d'); break;
    }
    case 'heart': {
      ctx.beginPath(); ctx.moveTo(0, r * 0.85);
      ctx.bezierCurveTo(-r * 1.3, r * 0.1, -r * 0.8, -r * 0.95, 0, -r * 0.35);
      ctx.bezierCurveTo(r * 0.8, -r * 0.95, r * 1.3, r * 0.1, 0, r * 0.85); ctx.closePath();
      fillShape(color || '#ff4d6d'); break;
    }
    case 'bolt': {
      poly(ctx, [[r * 0.2, -r], [-r * 0.6, r * 0.1], [-r * 0.08, r * 0.1], [-r * 0.25, r], [r * 0.6, -r * 0.2], [r * 0.08, -r * 0.2]]);
      fillShape(color || '#ffe14d'); break;
    }
    case 'moon': {
      ctx.beginPath(); ctx.arc(0, 0, r, Math.PI * 0.32, Math.PI * 1.68, false);
      ctx.arc(r * 0.42, 0, r * 0.82, Math.PI * 1.58, Math.PI * 0.42, true); ctx.closePath();
      fillShape(color || '#9fb4ff'); break;
    }
    case 'diamond': {
      poly(ctx, [[0, -r], [r * 0.85, -r * 0.2], [0, r], [-r * 0.85, -r * 0.2]]); fillShape(color || '#4de1ff');
      ctx.strokeStyle = 'rgba(255,255,255,0.65)'; ctx.lineWidth = r * 0.09;
      ctx.beginPath(); ctx.moveTo(-r * 0.85, -r * 0.2); ctx.lineTo(r * 0.85, -r * 0.2); ctx.moveTo(-r * 0.3, -r * 0.2); ctx.lineTo(0, r); ctx.moveTo(r * 0.3, -r * 0.2); ctx.lineTo(0, r); ctx.stroke();
      break;
    }
    case 'flame': {
      ctx.beginPath(); ctx.moveTo(0, -r);
      ctx.bezierCurveTo(r * 0.95, -r * 0.1, r * 0.85, r * 0.95, 0, r);
      ctx.bezierCurveTo(-r * 0.85, r * 0.95, -r * 0.95, -r * 0.1, 0, -r); ctx.closePath();
      fillShape(color || '#ff7518'); break;
    }
    default: {
      ctx.beginPath(); ctx.arc(0, 0, r, 0, Math.PI * 2); fillShape(color || '#aaaaaa');
    }
  }
  ctx.restore();
}
async function drawBadgeForItem(ctx, item, cx, cy, s) {
  if (item && item.imageUrl) {
    try {
      const img = await getAvatarImage(item.imageUrl);
      ctx.save(); ctx.beginPath(); ctx.arc(cx, cy, s / 2, 0, Math.PI * 2); ctx.clip();
      ctx.drawImage(img, cx - s / 2, cy - s / 2, s, s); ctx.restore();
      return;
    } catch (e) { console.error('فشل تحميل صورة الشارة:', e); }
  }
  const kind = item && item.kind && BADGE_KINDS[item.kind] ? item.kind : 'star';
  drawBadge(ctx, kind, cx, cy, s, item && item.color ? item.color : BADGE_KINDS[kind].color);
}
// ---------- مشفّر GIF مدمج (بدون مكتبات خارجية) ----------
function buildPalette(rgbaList, maxColors = 256) {
  // هيستوغرام 15-bit ثم median-cut موزون
  const cnt = new Uint32Array(32768), sr = new Float64Array(32768), sg = new Float64Array(32768), sb = new Float64Array(32768);
  for (const px of rgbaList) {
    for (let i = 0; i < px.length; i += 16) { // عينة كل 4 بكسل
      const r = px[i], g = px[i + 1], b = px[i + 2];
      const k = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
      cnt[k]++; sr[k] += r; sg[k] += g; sb[k] += b;
    }
  }
  let items = [];
  for (let k = 0; k < 32768; k++) if (cnt[k]) items.push({ k, n: cnt[k], r: sr[k] / cnt[k], g: sg[k] / cnt[k], b: sb[k] / cnt[k] });
  if (!items.length) items.push({ k: 0, n: 1, r: 0, g: 0, b: 0 });
  let boxes = [items];
  const range = (box) => {
    let rl = 255, rh = 0, gl = 255, gh = 0, bl = 255, bh = 0;
    for (const c of box) { if (c.r < rl) rl = c.r; if (c.r > rh) rh = c.r; if (c.g < gl) gl = c.g; if (c.g > gh) gh = c.g; if (c.b < bl) bl = c.b; if (c.b > bh) bh = c.b; }
    return [rh - rl, gh - gl, bh - bl];
  };
  while (boxes.length < maxColors) {
    let bi = -1, best = -1, bch = 0;
    for (let i = 0; i < boxes.length; i++) {
      if (boxes[i].length < 2) continue;
      const rg = range(boxes[i]); const m = Math.max(rg[0], rg[1], rg[2]);
      const score = m * Math.log2(1 + boxes[i].length);
      if (score > best) { best = score; bi = i; bch = rg.indexOf(m); }
    }
    if (bi === -1) break;
    const box = boxes[bi]; const ch = ['r', 'g', 'b'][bch];
    box.sort((a, b) => a[ch] - b[ch]);
    let total = 0; for (const c of box) total += c.n;
    let acc = 0, cut = 1;
    for (let i = 0; i < box.length; i++) { acc += box[i].n; if (acc >= total / 2) { cut = Math.min(Math.max(i + 1, 1), box.length - 1); break; } }
    boxes.splice(bi, 1, box.slice(0, cut), box.slice(cut));
  }
  const pal = new Uint8Array(256 * 3);
  boxes.forEach((box, i) => {
    let n = 0, r = 0, g = 0, b = 0;
    for (const c of box) { n += c.n; r += c.r * c.n; g += c.g * c.n; b += c.b * c.n; }
    pal[i * 3] = Math.round(r / n); pal[i * 3 + 1] = Math.round(g / n); pal[i * 3 + 2] = Math.round(b / n);
  });
  return { pal, size: boxes.length };
}
function makeIndexer(palInfo) {
  const { pal, size } = palInfo;
  const cache = new Int16Array(32768).fill(-1);
  return (r, g, b) => {
    const k = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
    let v = cache[k];
    if (v !== -1) return v;
    const rr = (r & 0xF8) | 4, gg = (g & 0xF8) | 4, bb = (b & 0xF8) | 4;
    let best = 0, bd = 1e9;
    for (let i = 0; i < size; i++) {
      const dr = pal[i * 3] - rr, dg = pal[i * 3 + 1] - gg, db2 = pal[i * 3 + 2] - bb;
      const d = dr * dr * 2 + dg * dg * 4 + db2 * db2 * 3;
      if (d < bd) { bd = d; best = i; if (d === 0) break; }
    }
    cache[k] = best; return best;
  };
}
function lzwEncode(indices, minCode) {
  const clear = 1 << minCode, eoi = clear + 1;
  const out = []; let cur = 0, bits = 0;
  const emit = (code, size) => { cur |= code << bits; bits += size; while (bits >= 8) { out.push(cur & 255); cur >>>= 8; bits -= 8; } };
  const table = new Int32Array(1 << 20);
  let next, size;
  const reset = () => { table.fill(-1); next = eoi + 1; size = minCode + 1; };
  reset(); emit(clear, size);
  let prefix = indices[0];
  for (let i = 1; i < indices.length; i++) {
    const c = indices[i]; const key = (prefix << 8) | c; const f = table[key];
    if (f !== -1) { prefix = f; continue; }
    emit(prefix, size);
    if (next < 4096) { table[key] = next++; if (next > (1 << size) && size < 12) size++; }
    else { emit(clear, size); reset(); }
    prefix = c;
  }
  emit(prefix, size); emit(eoi, size);
  if (bits > 0) out.push(cur & 255);
  return out;
}
// frames: [{ data: RGBA Uint8Array, delay: ms }]
function encodeGif(frames, w, h, palSource, loop = true) {
  const palInfo = buildPalette(palSource || frames.map(f => f.data));
  const idx = makeIndexer(palInfo);
  const bytes = [];
  const w16 = (v) => bytes.push(v & 255, (v >> 8) & 255);
  bytes.push(...Buffer.from('GIF89a'));
  w16(w); w16(h); bytes.push(0xF7, 0, 0);
  for (let i = 0; i < 768; i++) bytes.push(palInfo.pal[i] || 0);
  if (loop) bytes.push(0x21, 0xFF, 0x0B, ...Buffer.from('NETSCAPE2.0'), 3, 1, 0, 0, 0);
  for (const f of frames) {
    bytes.push(0x21, 0xF9, 4, 0x04, 0, 0, 0, 0); // disposal=1
    const dpos = bytes.length - 4; const cs = Math.max(2, Math.round(f.delay / 10));
    bytes[dpos + 1] = cs & 255; bytes[dpos + 2] = (cs >> 8) & 255;
    bytes.push(0x2C); w16(0); w16(0); w16(w); w16(h); bytes.push(0);
    const px = new Uint8Array(w * h); const d = f.data;
    for (let i = 0, j = 0; j < px.length; i += 4, j++) px[j] = idx(d[i], d[i + 1], d[i + 2]);
    bytes.push(8);
    const lz = lzwEncode(px, 8);
    for (let i = 0; i < lz.length; i += 255) { const n = Math.min(255, lz.length - i); bytes.push(n); for (let k = 0; k < n; k++) bytes.push(lz[i + k]); }
    bytes.push(0);
  }
  bytes.push(0x3B);
  return Buffer.from(bytes);
}

// كاش صور (أفتار/ديكورات/شارات) — يقلل الطلبات والتعليق
const imageCache = new Map();
async function getAvatarImage(url) {
  if (!url) return null;
  const hit = imageCache.get(url);
  if (hit && Date.now() - hit.t < 10 * 60 * 1000) return hit.img;
  const img = await loadRemoteImage(url);
  imageCache.set(url, { img, t: Date.now() });
  if (imageCache.size > 200) imageCache.delete(imageCache.keys().next().value);
  return img;
}

function drawMedal(ctx, r, c1, c2, glyph) {
  const g = ctx.createLinearGradient(-r, -r, r, r); g.addColorStop(0, c1 || '#888'); g.addColorStop(1, c2 || '#444');
  ctx.beginPath(); ctx.arc(0, 0, r, 0, Math.PI * 2); ctx.fillStyle = g; ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,0.55)'; ctx.lineWidth = Math.max(1.5, r * 0.09); ctx.stroke();
  ctx.fillStyle = '#ffffff'; ctx.strokeStyle = '#ffffff'; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  const k = r * 0.52;
  switch (glyph) {
    case 'shield':
      ctx.beginPath(); ctx.moveTo(0, -k); ctx.lineTo(k * 0.85, -k * 0.55); ctx.lineTo(k * 0.85, k * 0.1);
      ctx.quadraticCurveTo(k * 0.85, k * 0.7, 0, k); ctx.quadraticCurveTo(-k * 0.85, k * 0.7, -k * 0.85, k * 0.1);
      ctx.lineTo(-k * 0.85, -k * 0.55); ctx.closePath(); ctx.fill(); break;
    case 'check':
      ctx.lineWidth = r * 0.22; ctx.beginPath(); ctx.moveTo(-k * 0.75, 0); ctx.lineTo(-k * 0.2, k * 0.6); ctx.lineTo(k * 0.85, -k * 0.5); ctx.stroke(); break;
    case 'diamond': poly(ctx, [[0, -k], [k * 0.9, -k * 0.2], [0, k], [-k * 0.9, -k * 0.2]]); ctx.fill(); break;
    case 'heart':
      ctx.beginPath(); ctx.moveTo(0, k * 0.85); ctx.bezierCurveTo(-k * 1.4, k * 0.1, -k * 0.9, -k, 0, -k * 0.35);
      ctx.bezierCurveTo(k * 0.9, -k, k * 1.4, k * 0.1, 0, k * 0.85); ctx.closePath(); ctx.fill(); break;
    case 'bolt': poly(ctx, [[k * 0.25, -k], [-k * 0.65, k * 0.1], [-k * 0.1, k * 0.1], [-k * 0.3, k], [k * 0.65, -k * 0.2], [k * 0.1, -k * 0.2]]); ctx.fill(); break;
    case 'crown': poly(ctx, [[-k * 0.9, k * 0.6], [-k * 0.9, -k * 0.5], [-k * 0.45, 0], [0, -k * 0.8], [k * 0.45, 0], [k * 0.9, -k * 0.5], [k * 0.9, k * 0.6]]); ctx.fill(); break;
    default: {
      const pts = [];
      for (let i = 0; i < 10; i++) { const a = -Math.PI / 2 + i * Math.PI / 5; const rad = i % 2 === 0 ? k : k * 0.45; pts.push([Math.cos(a) * rad, Math.sin(a) * rad]); }
      poly(ctx, pts); ctx.fill();
    }
  }
}
async function drawSpecialBadge(ctx, sb, cx, cy, s) {
  if (sb.imageUrl) {
    try {
      const img = await getAvatarImage(sb.imageUrl);
      if (img) { ctx.save(); ctx.beginPath(); ctx.arc(cx, cy, s / 2, 0, Math.PI * 2); ctx.clip(); ctx.drawImage(img, cx - s / 2, cy - s / 2, s, s); ctx.restore(); return; }
    } catch (e) { /* نرجع للشكل الافتراضي */ }
  }
  if (['verified', 'developer', 'owner'].includes(sb.key)) return drawBadge(ctx, sb.key, cx, cy, s);
  ctx.save(); ctx.translate(cx, cy); drawMedal(ctx, s / 2, sb.c1 || '#8b5cf6', sb.c2 || '#4c1d95', sb.glyph || 'star'); ctx.restore();
}
async function drawDecoration(ctx, item, ax, ay, ar) {
  if (item.imageUrl) {
    try {
      const img = await getAvatarImage(item.imageUrl);
      if (img) { const sz = ar * 2 * 1.4; ctx.drawImage(img, ax - sz / 2, ay - sz / 2, sz, sz); return; }
    } catch (e) { /* نرجع للشكل vector */ }
  }
  ctx.save(); ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  switch (item.kind) {
    case 'halo':
      ctx.shadowColor = '#ffd34d'; ctx.shadowBlur = 20; ctx.strokeStyle = '#ffe27a'; ctx.lineWidth = 9;
      ctx.beginPath(); ctx.ellipse(ax, ay - ar - 10, ar * 0.55, ar * 0.16, 0, 0, Math.PI * 2); ctx.stroke(); break;
    case 'horns':
      for (const sd of [-1, 1]) {
        ctx.beginPath(); ctx.moveTo(ax + sd * ar * 0.35, ay - ar * 0.92);
        ctx.bezierCurveTo(ax + sd * ar * 0.5, ay - ar * 1.35, ax + sd * ar * 0.85, ay - ar * 1.45, ax + sd * ar * 0.95, ay - ar * 1.2);
        ctx.bezierCurveTo(ax + sd * ar * 0.8, ay - ar * 1.2, ax + sd * ar * 0.62, ay - ar * 1.05, ax + sd * ar * 0.62, ay - ar * 0.82); ctx.closePath();
        const g = ctx.createLinearGradient(ax, ay - ar * 1.4, ax, ay - ar * 0.8); g.addColorStop(0, '#ff3b3b'); g.addColorStop(1, '#7a0000');
        ctx.fillStyle = g; ctx.fill(); ctx.strokeStyle = 'rgba(0,0,0,0.5)'; ctx.lineWidth = 3; ctx.stroke();
      } break;
    case 'crown': {
      const w = ar * 1.1, top = ay - ar - 52, bot = ay - ar + 6;
      poly(ctx, [[ax - w / 2, bot], [ax - w / 2, top + 14], [ax - w / 4, top + 38], [ax, top], [ax + w / 4, top + 38], [ax + w / 2, top + 14], [ax + w / 2, bot]]);
      const g = ctx.createLinearGradient(0, top, 0, bot); g.addColorStop(0, '#ffe27a'); g.addColorStop(1, '#c9971c');
      ctx.fillStyle = g; ctx.fill(); ctx.strokeStyle = 'rgba(0,0,0,0.5)'; ctx.lineWidth = 3; ctx.stroke();
      ctx.fillStyle = '#ff4d6d'; ctx.beginPath(); ctx.arc(ax, bot - 14, 7, 0, Math.PI * 2); ctx.fill(); break;
    }
    case 'sparkles':
      ctx.fillStyle = '#fff6b0'; ctx.shadowColor = '#ffd34d'; ctx.shadowBlur = 14;
      [[-1.0, -0.6, 17], [0.95, -0.75, 22], [1.12, 0.35, 15], [-1.1, 0.5, 20], [0.2, -1.15, 14], [-0.4, 1.1, 13]].forEach(([dx, dy, sz]) => {
        const x = ax + dx * ar, y = ay + dy * ar;
        ctx.beginPath(); ctx.moveTo(x, y - sz); ctx.quadraticCurveTo(x, y, x + sz, y); ctx.quadraticCurveTo(x, y, x, y + sz); ctx.quadraticCurveTo(x, y, x - sz, y); ctx.quadraticCurveTo(x, y, x, y - sz); ctx.fill();
      }); break;
    case 'flames':
      for (let i = 0; i < 14; i++) {
        const a = Math.PI * 0.05 + (i / 13) * Math.PI * 0.9; // أسفل الصورة
        const bx = ax + Math.cos(a) * (ar + 4), by = ay + Math.sin(a) * (ar + 4);
        const tx = ax + Math.cos(a) * (ar + 38 + (i % 3) * 8), ty = ay + Math.sin(a) * (ar + 38 + (i % 3) * 8);
        const nx = -Math.sin(a) * 9, ny = Math.cos(a) * 9;
        const g = ctx.createLinearGradient(bx, by, tx, ty); g.addColorStop(0, '#ff3b00'); g.addColorStop(1, 'rgba(255,200,0,0.85)');
        ctx.beginPath(); ctx.moveTo(bx + nx, by + ny); ctx.quadraticCurveTo((bx + tx) / 2 + nx * 0.4, (by + ty) / 2 + ny * 0.4, tx, ty); ctx.quadraticCurveTo((bx + tx) / 2 - nx * 0.4, (by + ty) / 2 - ny * 0.4, bx - nx, by - ny); ctx.closePath();
        ctx.fillStyle = g; ctx.fill();
      } break;
  }
  ctx.restore();
}

function drawTile(ctx, x, y, w, h, label, value, accent) {
  rrect(ctx, x, y, w, h, 16);
  ctx.fillStyle = 'rgba(0,0,0,0.42)'; ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,0.12)'; ctx.lineWidth = 1.5; ctx.stroke();
  rrect(ctx, x + 12, y + 16, 5, h - 32, 3); ctx.fillStyle = accent; ctx.fill();
  ctx.textAlign = 'left';
  ctx.fillStyle = 'rgba(255,255,255,0.62)'; ctx.font = `bold 15px ${CARD_FONT}`;
  ctx.fillText(label, x + 30, y + 28);
  ctx.fillStyle = '#ffffff'; ctx.font = `bold 30px ${CARD_FONT}`;
  ctx.fillText(String(value), x + 30, y + h - 17);
}

// ---------- توليد صورة بطاقة البروفايل ----------
async function generateProfileCard(member, profile, rankServer, rankGlobal, lang) {
  const W = 1200, H = 580;
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');
  const eq = profile.equipped || {};

  // قص الزوايا الدائرية للبطاقة كاملة
  rrect(ctx, 0, 0, W, H, 34); ctx.clip();

  const bannerItem = eq.banner ? getShopItem(eq.banner) : null;
  const colors = (bannerItem && bannerItem.colors) || ['#0b0b0f', '#3b0a0a', '#120505'];

  let bannerDrawn = false;
  if (bannerItem && bannerItem.imageUrl) {
    try {
      const img = await loadRemoteImage(bannerItem.imageUrl);
      const scale = Math.max(W / img.width, H / img.height);
      const dw = img.width * scale, dh = img.height * scale;
      ctx.drawImage(img, (W - dw) / 2, (H - dh) / 2, dw, dh);
      bannerDrawn = true;
    } catch (e) { console.error('فشل تحميل صورة البانر، نرجع للتدرج:', e); }
  }
  if (!bannerDrawn) {
    const grad = ctx.createLinearGradient(0, 0, W, H);
    grad.addColorStop(0, colors[0]); grad.addColorStop(0.5, colors[1]); grad.addColorStop(1, colors[2] || colors[0]);
    ctx.fillStyle = grad; ctx.fillRect(0, 0, W, H);
    ctx.globalAlpha = 0.06;
    for (let i = 0; i < 8; i++) { ctx.beginPath(); ctx.fillStyle = '#ffffff'; ctx.arc(60 + i * 170, 40 + (i % 2) * 330, 95, 0, Math.PI * 2); ctx.fill(); }
    ctx.globalAlpha = 1;
  }
  const ov = ctx.createLinearGradient(0, 0, W, 0);
  ov.addColorStop(0, 'rgba(0,0,0,0.78)'); ov.addColorStop(0.55, 'rgba(0,0,0,0.55)'); ov.addColorStop(1, 'rgba(0,0,0,0.36)');
  ctx.fillStyle = ov; ctx.fillRect(0, 0, W, H);
  rrect(ctx, 5, 5, W - 10, H - 10, 30); ctx.strokeStyle = 'rgba(255,255,255,0.16)'; ctx.lineWidth = 2; ctx.stroke();

  // ---- الأفتار + الإطار + شارة المستوى ----
  const ax = 195, ay = 190, ar = 120;
  const frameItem = eq.frame ? getShopItem(eq.frame) : null;
  const frameColor = frameItem && frameItem.color ? frameItem.color : '#8a8f99';
  ctx.beginPath(); ctx.arc(ax, ay, ar + 8, 0, Math.PI * 2); ctx.fillStyle = 'rgba(0,0,0,0.55)'; ctx.fill();
  try {
    const img = await getAvatarImage(member.displayAvatarURL({ extension: 'png', size: 256, forceStatic: true }));
    ctx.save(); ctx.beginPath(); ctx.arc(ax, ay, ar, 0, Math.PI * 2); ctx.closePath(); ctx.clip();
    ctx.drawImage(img, ax - ar, ay - ar, ar * 2, ar * 2); ctx.restore();
  } catch (e) {
    console.error('فشل تحميل صورة الأفتار للبطاقة:', e);
    ctx.fillStyle = '#2b2d33'; ctx.beginPath(); ctx.arc(ax, ay, ar, 0, Math.PI * 2); ctx.fill();
  }
  ctx.save();
  ctx.shadowColor = frameColor; ctx.shadowBlur = frameItem ? 26 : 8;
  ctx.lineWidth = 9; ctx.strokeStyle = frameColor;
  if (frameItem && frameItem.colors) { const fg = ctx.createLinearGradient(ax - ar, ay - ar, ax + ar, ay + ar); frameItem.colors.forEach((c, i) => fg.addColorStop(i / Math.max(1, frameItem.colors.length - 1), c)); ctx.strokeStyle = fg; }
  ctx.beginPath(); ctx.arc(ax, ay, ar + 2, 0, Math.PI * 2); ctx.stroke();
  ctx.restore();
  const decoItem = eq.decoration ? getShopItem(eq.decoration) : null;
  if (decoItem) await drawDecoration(ctx, decoItem, ax, ay, ar);
  const lx = ax + ar * 0.72, ly = ay + ar * 0.72;
  ctx.beginPath(); ctx.arc(lx, ly, 40, 0, Math.PI * 2); ctx.fillStyle = '#ff7518'; ctx.fill();
  ctx.lineWidth = 6; ctx.strokeStyle = '#111111'; ctx.stroke();
  ctx.fillStyle = '#ffffff'; ctx.textAlign = 'center'; ctx.font = `bold ${String(profile.level).length > 2 ? 26 : 32}px ${CARD_FONT}`;
  ctx.fillText(String(profile.level), lx, ly + 11);

  // ---- الاسم + الشارات + اللقب ----
  const textX = 360;
  ctx.textAlign = 'left'; ctx.fillStyle = '#ffffff';
  const displayName = safeName(member.displayName || member.user.username, safeName(member.user.username, 'Player')).slice(0, 26);
  let fsz = 56; ctx.font = `bold ${fsz}px ${CARD_FONT}`;
  let nameW = ctx.measureText(displayName).width;
  while (nameW > 470 && fsz > 30) { fsz -= 2; ctx.font = `bold ${fsz}px ${CARD_FONT}`; nameW = ctx.measureText(displayName).width; }
  ctx.fillText(displayName, textX, 100);

  const spList = (profile.special || []).map(specialBadge).filter(Boolean).slice(0, 6);
  const badgeSize = spList.length + (eq.badge ? 1 : 0) > 4 ? 38 : 46;
  let bx = textX + nameW + 20 + badgeSize / 2; const by = 100 - badgeSize / 2 + 4;
  for (const sb of spList) { await drawSpecialBadge(ctx, sb, bx, by, badgeSize); bx += badgeSize + 10; }
  const shopBadge = eq.badge ? getShopItem(eq.badge) : null;
  if (shopBadge) { await drawBadgeForItem(ctx, shopBadge, bx, by, badgeSize); bx += badgeSize + 10; }

  const titleItem = eq.title ? getShopItem(eq.title) : null;
  if (titleItem && titleItem.text) {
    ctx.font = `bold 22px ${CARD_FONT}`;
    const tw = ctx.measureText(titleItem.text).width;
    rrect(ctx, textX, 124, tw + 40, 40, 20); ctx.fillStyle = 'rgba(255,211,77,0.16)'; ctx.fill();
    ctx.strokeStyle = 'rgba(255,211,77,0.75)'; ctx.lineWidth = 1.8; ctx.stroke();
    ctx.fillStyle = '#ffd34d'; ctx.textAlign = 'left'; ctx.fillText(titleItem.text, textX + 20, 152);
  }

  // ---- شريط الخبرة ----
  const need = xpForLevel(profile.level);
  const ratio = Math.max(0, Math.min(1, profile.xp / need));
  const barX = textX, barY = 218, barW = 790, barH = 30;
  ctx.textAlign = 'left'; ctx.fillStyle = 'rgba(255,255,255,0.8)'; ctx.font = `bold 18px ${CARD_FONT}`;
  ctx.fillText(`LEVEL ${profile.level}`, barX, barY - 10);
  ctx.textAlign = 'right'; ctx.fillText(`${profile.xp} / ${need} XP`, barX + barW, barY - 10);
  rrect(ctx, barX, barY, barW, barH, barH / 2); ctx.fillStyle = 'rgba(255,255,255,0.16)'; ctx.fill();
  if (ratio > 0) {
    const fw = Math.max(barH, barW * ratio);
    const bg = ctx.createLinearGradient(barX, 0, barX + barW, 0); bg.addColorStop(0, '#ff9d42'); bg.addColorStop(1, '#ff4d1a');
    rrect(ctx, barX, barY, fw, barH, barH / 2); ctx.fillStyle = bg; ctx.fill();
  }
  rrect(ctx, barX, barY, barW, barH, barH / 2); ctx.strokeStyle = 'rgba(255,255,255,0.35)'; ctx.lineWidth = 1.5; ctx.stroke();

  // ---- بطاقات الإحصائيات ----
  const tw = 250, th = 76;
  const cols = [textX, textX + 270, textX + 540];
  const rows = [292, 380, 468];
  const itemsCount = ['banners', 'frames', 'titles', 'abilities', 'badges', 'decorations'].reduce((n, k) => n + (profile.owned[k] ? profile.owned[k].length : 0), 0);
  const tiles = [
    ['POINTS', profile.points, '#ffd34d'], ['WINS', profile.wins, '#22c55e'], ['LOSSES', profile.losses, '#ef4444'],
    ['ROULETTE PLAYS', profile.roulettePlays, '#ff7518'], ['KICKS', profile.kicksGiven, '#f97316'], ['SAVES', profile.savesGiven, '#38bdf8'],
    ['VOICE TIME', formatDurationEn(profile.voiceMs), '#a78bfa'], ['TOTAL XP', totalXpOf(profile), '#f472b6'], ['ITEMS', itemsCount, '#34d399']
  ];
  tiles.forEach((t, i) => drawTile(ctx, cols[i % 3], rows[Math.floor(i / 3)], tw, th, t[0], t[1], t[2]));
  drawTile(ctx, 60, 372, 270, 82, 'SERVER RANK', rankServer ? `#${rankServer}` : '-', '#ffd34d');
  drawTile(ctx, 60, 468, 270, 82, 'GLOBAL RANK', rankGlobal ? `#${rankGlobal}` : '-', '#38bdf8');

  ctx.textAlign = 'right'; ctx.fillStyle = 'rgba(255,255,255,0.32)'; ctx.font = `bold 14px ${CARD_FONT}`;
  ctx.fillText('NW COMMUNITY BOT', W - 34, H - 14);

  return canvas.toBuffer('image/png');
}


// ---------- صورة عجلة الروليت ----------
function buildRouletteWheelImage(players, highlightId, highlightColor) {
  const size = 500;
  const canvas = createCanvas(size, size + 60); // مساحة إضافية فوق للمؤشر المثلث
  const ctx = canvas.getContext('2d');
  const cx = size / 2, cy = size / 2 + 60, radius = size / 2 - 14;
  // ألوان هالوين متبادلة (أحمر داكن / برتقالي) مطابقة لشكل العجلة المرجعي
  const halloweenColors = ['#8b0000', '#ff7518'];
  const slice = (Math.PI * 2) / Math.max(1, players.length);

  ctx.clearRect(0, 0, size, size + 60);

  // ظل خفيف خلف العجلة
  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy + 4, radius + 6, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(0,0,0,0.5)';
  ctx.fill();
  ctx.restore();

  players.forEach((p, i) => {
    const start = i * slice - Math.PI / 2;
    const end = start + slice;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.arc(cx, cy, radius, start, end);
    ctx.closePath();
    ctx.fillStyle = p.id === highlightId ? (highlightColor || '#ff0000') : halloweenColors[i % halloweenColors.length];
    ctx.fill();
    ctx.strokeStyle = '#ff9d42';
    ctx.lineWidth = 3;
    ctx.stroke();

    const mid = start + slice / 2;
    const tx = cx + Math.cos(mid) * radius * 0.65;
    const ty = cy + Math.sin(mid) * radius * 0.65;
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 18px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(p.name.slice(0, 10), tx, ty);
  });

  // الحلقة الخارجية البرتقالية
  ctx.beginPath();
  ctx.arc(cx, cy, radius, 0, Math.PI * 2);
  ctx.lineWidth = 6;
  ctx.strokeStyle = '#ff9d42';
  ctx.stroke();

  // المركز الأسود
  ctx.beginPath();
  ctx.arc(cx, cy, 36, 0, Math.PI * 2);
  ctx.fillStyle = '#140402';
  ctx.fill();
  ctx.lineWidth = 4;
  ctx.strokeStyle = '#ff9d42';
  ctx.stroke();

  // مؤشر مثلث برتقالي فوق العجلة
  ctx.beginPath();
  ctx.moveTo(cx - 30, 10);
  ctx.lineTo(cx + 30, 10);
  ctx.lineTo(cx, 55);
  ctx.closePath();
  ctx.fillStyle = '#ffb347';
  ctx.fill();
  ctx.strokeStyle = '#140402';
  ctx.lineWidth = 3;
  ctx.stroke();

  return canvas.toBuffer('image/png');
}

// ---------- مساعدات عامة لواجهات الألعاب ----------
function safeEmoji(e) { return validEmojiInput(e) ? e : undefined; }
function gbtn(id, label, style, emojiKey) {
  const b = new ButtonBuilder().setCustomId(id).setLabel(label).setStyle(style);
  const em = emojiKey ? safeEmoji(E(emojiKey)) : undefined;
  if (em) b.setEmoji(em);
  return b;
}
function itemEmoji(it) { return it && it.emoji && validEmojiInput(it.emoji) ? it.emoji : undefined; }
function embedWithImage(text, opts, buffer, name) {
  const m = embedMsg(text, opts);
  m.embeds[0].setImage(`attachment://${name}`);
  m.files = [{ attachment: buffer, name }];
  return m;
}
function ranksFor(guild, userId) {
  const ids = guild ? new Set(guild.members.cache.keys()) : null;
  return { server: getRankOf(userId, 'points', 'server', ids), global: getRankOf(userId, 'points', 'global', null) };
}
// يعطي XP + مكافأة نقاط عند رفع المستوى (النقاط عامة لكل السيرفرات)
function grantXp(userId, amount) {
  const before = getGameProfile(userId).level;
  addXp(userId, amount);
  const after = getGameProfile(userId).level;
  if (after > before) {
    let bonus = 0;
    for (let l = before + 1; l <= after; l++) bonus += l * 20;
    addPoints(userId, bonus, 'levelup');
    return { leveledUp: true, level: after, bonus };
  }
  return { leveledUp: false };
}
function promoRow(lang) {
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setLabel(lang === 'en' ? 'Join our Discord — get a shield' : 'انضم لديسكوردنا واحصل على درع').setStyle(ButtonStyle.Link).setURL(SUPPORT_INVITE)
  );
  if (process.env.SUPPORT_GUILD_ID) row.addComponents(gbtn('claim_shield', lang === 'en' ? 'Claim my shield' : 'استلم درعي', ButtonStyle.Success, 'shield'));
  return row;
}

// ---------- بناء رسائل الأوامر (مشتركة بين الأوامر / الاختصارات / أزرار الإعدادات) ----------
async function buildProfileMessage(guild, member, lang) {
  const profile = getGameProfile(member.id);
  const r = ranksFor(guild, member.id);
  const buf = await generateProfileCard(member, profile, r.server, r.global, lang);
  return { files: [{ attachment: buf, name: 'profile.png' }] };
}
function buildStatsMsg(guild, user, lang) {
  const profile = getGameProfile(user.id);
  const r = ranksFor(guild, user.id);
  const need = xpForLevel(profile.level);
  const desc = lang === 'en'
    ? `**Level:** ${profile.level} (${profile.xp}/${need} XP)\n**Points:** ${profile.points}\n**Wins:** ${profile.wins} | **Losses:** ${profile.losses}\n**Roulette Plays:** ${profile.roulettePlays}\n**Kicks Given:** ${profile.kicksGiven} | **Saves:** ${profile.savesGiven}\n**Voice Time:** ${formatDuration(profile.voiceMs)}\n**Rank:** #${r.server || '-'} server / #${r.global || '-'} global`
    : `**المستوى:** ${profile.level} (${profile.xp}/${need} XP)\n**النقاط:** ${profile.points}\n**الفوز:** ${profile.wins} | **الخسارة:** ${profile.losses}\n**مشاركات الروليت:** ${profile.roulettePlays}\n**الطرد:** ${profile.kicksGiven} | **النجاة:** ${profile.savesGiven}\n**وقت الصوتي:** ${formatDuration(profile.voiceMs)}\n**الترتيب:** سيرفر #${r.server || '-'} / عالمي #${r.global || '-'}`;
  return embedMsg(desc, { title: lang === 'en' ? `📊 ${user.username}'s Stats` : `📊 إحصائيات ${user.username}` });
}
async function buildBalanceMsg(userId, lang) {
  const p = getGameProfile(userId);
  const text = lang === 'en' ? `${E('points')} Your balance: **${p.points}** points (works in every server).` : `${E('points')} رصيدك: **${p.points}** نقطة (يشتغل بكل السيرفرات).`;
  try { return embedWithImage(text, {}, await generateBalanceImage(p, p.level), 'balance.png'); }
  catch (e) { console.error('فشل رسم بطاقة الرصيد:', e); return embedMsg(text); }
}
function buildInventoryMsg(userId, lang) {
  const p = getGameProfile(userId);
  const line = (it, extra = '') => `${it.emoji || '•'} **${it.name}**${extra}`;
  const cons = Object.entries(p.inventory).filter(([, q]) => q > 0).map(([id, q]) => { const it = getShopItem(id); return it ? line(it, ` × ${q}`) : null; }).filter(Boolean);
  const group = (keys) => keys.flatMap(k => p.owned[k] || []).map(id => { const it = getShopItem(id); return it ? line(it) : null; }).filter(Boolean);
  const abil = group(['abilities']); const cos = group(['banners', 'badges', 'decorations', 'frames', 'titles']);
  const parts = [];
  if (cons.length) parts.push((lang === 'en' ? '**Consumables:**\n' : '**الاستهلاكيات:**\n') + cons.join('\n'));
  if (abil.length) parts.push((lang === 'en' ? '**Abilities:**\n' : '**القدرات:**\n') + abil.join('\n'));
  if (cos.length) parts.push((lang === 'en' ? '**Cosmetics:**\n' : '**التجميل (بانرات/شارات/إطارات/ألقاب):**\n') + cos.join('\n'));
  const sp = (p.special || []).map(specialBadge).filter(Boolean).map(b => `${b.emoji || '🏅'} ${lang === 'en' ? b.nameEn : b.name}`);
  if (sp.length) parts.push((lang === 'en' ? '**Special badges:**\n' : '**شارات خاصة:**\n') + sp.join('\n'));
  const desc = parts.length ? parts.join('\n\n') : (lang === 'en' ? "ℹ️ You don't own anything yet — try /shop." : 'ℹ️ ما تملك شيء للحين — جرب /shop.');
  return embedMsg(desc.slice(0, 4000), { title: lang === 'en' ? '🎒 Your Inventory' : '🎒 مخزونك' });
}
function buildTopMsg(guild, type, scope, lang) {
  const ids = scope === 'server' && guild ? new Set(guild.members.cache.keys()) : null;
  const board = getLeaderboard(type, scope, ids);
  if (!board.length) return embedMsg(lang === 'en' ? 'ℹ️ Not enough data to show a leaderboard yet.' : 'ℹ️ ما فيه بيانات كافية لعرض التصنيف بعد.');
  const typeAr = { points: 'النقاط', wins: 'الفوز', xp: 'الخبرة', voice: 'الصوتيات' }[type] || 'النقاط';
  const typeEn = { points: 'Points', wins: 'Wins', xp: 'XP', voice: 'Voice Time' }[type] || 'Points';
  const medals = ['🥇', '🥈', '🥉'];
  const lines = board.map((e, i) => {
    const v = type === 'voice' ? formatDuration(e.value) : type === 'xp' ? `Lv.${e.profile.level}` : e.value;
    return `${medals[i] || `**#${i + 1}**`} <@${e.uid}> — **${v}**`;
  }).join('\n');
  const title = lang === 'en' ? `${E('win')} ${scope === 'server' ? 'Server' : 'Global'} Top ${LEADERBOARD_SIZE} — ${typeEn}` : `${E('win')} توب ${LEADERBOARD_SIZE} ${scope === 'server' ? 'السيرفر' : 'عالمي'} — ${typeAr}`;
  return embedMsg(lines, { title });
}
function buildLogMsg(userId, lang) {
  const p = getGameProfile(userId);
  if (!p.log.length) return embedMsg(lang === 'en' ? 'ℹ️ No points activity yet.' : 'ℹ️ ما فيه حركة نقاط بعد.');
  const lines = p.log.slice(0, 15).map(l => {
    const r = REASON_TEXT[l.r] ? REASON_TEXT[l.r][lang === 'en' ? 'en' : 'ar'] : l.r;
    return `${l.a > 0 ? '🟢 +' : '🔴 '}${l.a} — ${r} — <t:${Math.floor(l.t / 1000)}:R>`;
  }).join('\n');
  return embedMsg(lines + `\n\n${E('points')} ${lang === 'en' ? 'Balance' : 'الرصيد'}: **${p.points}**`, { title: lang === 'en' ? '🧾 Points Log' : '🧾 سجل النقاط' });
}
function buildHistoryMsg(userId, lang) {
  const p = getGameProfile(userId);
  if (!p.history.length) return embedMsg(lang === 'en' ? 'ℹ️ No match history yet.' : 'ℹ️ ما فيه سجل مباريات بعد.');
  const lines = p.history.map(h => {
    const when = `<t:${Math.floor(h.date / 1000)}:R>`;
    if (lang === 'en') return h.result === 'win' ? `${E('win')} Won a match — ${when}` : `${E('out')} Eliminated — ${when}`;
    return h.result === 'win' ? `${E('win')} فاز بمباراة — ${when}` : `${E('out')} طُرد — ${when}`;
  }).join('\n');
  return embedMsg(lines, { title: lang === 'en' ? '📜 Your Match History' : '📜 سجل مبارياتك' });
}

// ---------- /edit — تعديل البروفايل (من المشتريات فقط) ----------
function editSelectRow(customId, placeholder, ids, currentId, lang) {
  const opts = [{ label: lang === 'en' ? 'None' : 'بدون', value: 'none', default: !currentId }];
  for (const id of ids.slice(0, 24)) {
    const it = getShopItem(id); if (!it) continue;
    const o = { label: it.name.slice(0, 100), value: id, default: id === currentId };
    const em = itemEmoji(it); if (em) o.emoji = em;
    opts.push(o);
  }
  return new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId(customId).setPlaceholder(placeholder).addOptions(opts));
}
async function buildEditMessage(guild, member, lang) {
  const p = getGameProfile(member.id);
  const rows = [];
  const defs = [
    ['ed_banner', 'banners', 'banner', lang === 'en' ? 'Choose a banner' : 'اختر بانر'],
    ['ed_badge', 'badges', 'badge', lang === 'en' ? 'Choose a badge' : 'اختر شارة'],
    ['ed_decoration', 'decorations', 'decoration', lang === 'en' ? 'Choose a decoration' : 'اختر ديكور'],
    ['ed_frame', 'frames', 'frame', lang === 'en' ? 'Choose a frame' : 'اختر إطار'],
    ['ed_title', 'titles', 'title', lang === 'en' ? 'Choose a title' : 'اختر لقب']
  ];
  for (const [cid, listKey, eqKey, ph] of defs) if (p.owned[listKey].length) rows.push(editSelectRow(cid, ph, p.owned[listKey], p.equipped[eqKey], lang));
  const r = ranksFor(guild, member.id);
  const buf = await generateProfileCard(member, p, r.server, r.global, lang);
  const desc = rows.length
    ? (lang === 'en' ? 'Pick what to wear on your card. Only items you bought (or were gifted) are listed.' : 'اختر اللي تبي تلبسه ببطاقتك. تظهر لك فقط العناصر اللي اشتريتها (أو انهديت لك).')
    : (lang === 'en' ? "You don't own any banners/badges/frames/titles yet — buy some from /shop." : 'ما تملك أي بانر/شارة/إطار/لقب للحين — اشتري من /shop.');
  const m = embedWithImage(desc, { title: lang === 'en' ? '🎨 Edit Your Profile' : '🎨 تعديل بروفايلك' }, buf, 'preview.png');
  m.components = rows;
  return m;
}

// ---------- /shop — المتجر المتقدم ----------
// ==========================================
// 🛍️ المتجر المرئي: شبكة بطاقات + حزم بخصم + تجهيز + عملة النقاط
// ==========================================
const SHOP_PAGE = 6;
const RARITIES = [
  { max: 200, key: 'COMMON', ar: 'عادي', color: '#8a93a6' },
  { max: 300, key: 'RARE', ar: 'نادر', color: '#4aa3ff' },
  { max: 450, key: 'EPIC', ar: 'ملحمي', color: '#b86bff' },
  { max: Infinity, key: 'LEGENDARY', ar: 'أسطوري', color: '#ffc83d' }
];
function rarityOf(price) { return RARITIES.find(r => price <= r.max); }
const SHOP_BUNDLES = [
  { id: 'halloween', ar: 'حزمة الهالوين', en: 'Halloween Set', ids: ['banner_halloween', 'title_hking', 'badge_skull', 'deco_horns', 'frame_ghost'], off: 30 },
  { id: 'royal', ar: 'الحزمة الملكية', en: 'Royal Set', ids: ['banner_royal', 'frame_royal', 'badge_crown', 'deco_crown', 'title_legend'], off: 35 },
  { id: 'fire', ar: 'حزمة النار', en: 'Fire Set', ids: ['banner_blood', 'frame_blood', 'badge_flame', 'deco_flames'], off: 30 },
  { id: 'lucky', ar: 'حزمة الحظ', en: 'Lucky Set', ids: ['badge_clover', 'title_lucky', 'title_godluck', 'frame_emerald', 'banner_forest'], off: 30 },
  { id: 'ocean', ar: 'حزمة المحيط', en: 'Ocean Set', ids: ['banner_ocean', 'frame_neon', 'badge_bolt', 'title_phantom'], off: 25 },
  { id: 'roulette', ar: 'حزمة الروليت', en: 'Roulette Pack', ids: ['shield', 'double_kick', 'ability_revive', 'ability_luck'], off: 25 }
];
function bundleInfo(b, profile) {
  const items = b.ids.map(getShopItem).filter(i => i && i.price > 0 && i.forSale !== false && !i.hidden);
  const unowned = items.filter(i => i.type === 'consumable' || !profile.owned[ownedListKey(i.type)].includes(i.id));
  const full = items.reduce((s, i) => s + i.price, 0);
  const cost = Math.round(unowned.reduce((s, i) => s + i.price, 0) * (1 - b.off / 100));
  return { items, unowned, full, cost };
}
function purchaseBundle(userId, b) {
  const p = getGameProfile(userId);
  const info = bundleInfo(b, p);
  if (!info.items.length) return { ok: false, reason: 'notforsale' };
  if (!info.unowned.length) return { ok: false, reason: 'owned' };
  if (p.points < info.cost) return { ok: false, reason: 'poor', cost: info.cost };
  addPoints(userId, -info.cost, 'shop');
  for (const it of info.unowned) {
    if (it.type === 'consumable') addInventory(userId, it.id, 1);
    else { const k = ownedListKey(it.type); if (!p.owned[k].includes(it.id)) p.owned[k].push(it.id); }
  }
  saveDatabase(db);
  return { ok: true, cost: info.cost, count: info.unowned.length };
}
const fmtNum = (n) => Number(n || 0).toLocaleString('en-US');

// 💠 عملة النقاط: قطعة زرقاء متوهجة بإطار برتقالي وصاعقة
function drawCoin(ctx, x, y, r) {
  ctx.save(); ctx.translate(x, y);
  ctx.shadowColor = 'rgba(80,160,255,0.85)'; ctx.shadowBlur = r * 0.8;
  const g = ctx.createRadialGradient(-r * 0.3, -r * 0.35, r * 0.1, 0, 0, r);
  g.addColorStop(0, '#a8d8ff'); g.addColorStop(0.55, '#3b7cff'); g.addColorStop(1, '#16277f');
  ctx.beginPath(); ctx.arc(0, 0, r, 0, Math.PI * 2); ctx.fillStyle = g; ctx.fill();
  ctx.shadowBlur = 0; ctx.shadowColor = 'transparent';
  ctx.lineWidth = r * 0.16; ctx.strokeStyle = '#ffb347'; ctx.stroke();
  ctx.beginPath(); ctx.arc(0, 0, r * 0.74, 0, Math.PI * 2); ctx.lineWidth = Math.max(1, r * 0.05); ctx.strokeStyle = 'rgba(255,255,255,0.35)'; ctx.stroke();
  const k = r * 0.5, bg = ctx.createLinearGradient(0, -k, 0, k); bg.addColorStop(0, '#fff6c2'); bg.addColorStop(1, '#ffb347');
  ctx.fillStyle = bg; ctx.shadowColor = 'rgba(255,200,80,0.9)'; ctx.shadowBlur = r * 0.25;
  poly(ctx, [[k * 0.25, -k], [-k * 0.65, k * 0.1], [-k * 0.1, k * 0.1], [-k * 0.3, k], [k * 0.65, -k * 0.2], [k * 0.1, -k * 0.2]]); ctx.fill();
  ctx.restore();
}
function drawPointsPill(ctx, x, y, w, h, points) {
  rrect(ctx, x, y, w, h, h / 2); ctx.fillStyle = 'rgba(12,28,56,0.92)'; ctx.fill(); ctx.lineWidth = 2; ctx.strokeStyle = 'rgba(76,160,255,0.75)'; ctx.stroke();
  ctx.beginPath(); ctx.arc(x + h / 2, y + h / 2, h * 0.3, 0, Math.PI * 2); ctx.fillStyle = '#4aa3ff'; ctx.fill();
  ctx.fillStyle = '#071223'; ctx.fillRect(x + h / 2 - h * 0.16, y + h / 2 - h * 0.04, h * 0.32, h * 0.08); ctx.fillRect(x + h / 2 - h * 0.04, y + h / 2 - h * 0.16, h * 0.08, h * 0.32);
  ctx.textAlign = 'right'; ctx.textBaseline = 'middle'; ctx.fillStyle = '#ffffff'; ctx.font = `bold ${Math.round(h * 0.5)}px ${CARD_FONT}`;
  ctx.fillText(fmtNum(points), x + w - h - 10, y + h / 2 + 2);
  drawCoin(ctx, x + w - h / 2 - 4, y + h / 2, h * 0.34);
}
function drawAvatarPlaceholder(ctx, cx, cy, r) {
  ctx.save(); ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.fillStyle = '#243553'; ctx.fill(); ctx.clip();
  ctx.fillStyle = '#3b5078'; ctx.beginPath(); ctx.arc(cx, cy - r * 0.18, r * 0.3, 0, Math.PI * 2); ctx.fill();
  ctx.beginPath(); ctx.ellipse(cx, cy + r * 0.85, r * 0.7, r * 0.55, 0, 0, Math.PI * 2); ctx.fill(); ctx.restore();
}
const CONSUMABLE_LOOK = { shield: ['shield', '#2b78ff', '#0b2a73'], ability_luck: ['diamond', '#2fbf71', '#0c4a2a'], ability_doubleluck: ['star', '#ffc83d', '#7a5200'], ability_revive: ['heart', '#ff4d6d', '#7a0f26'], double_kick: ['bolt', '#ff7518', '#7a2a00'] };
async function drawItemPreview(ctx, item, cx, cy, w, h) {
  const s = Math.min(w, h);
  if (item.type === 'banner') {
    const bw = w, bh = Math.min(h, w * 0.4);
    ctx.save(); rrect(ctx, cx - bw / 2, cy - bh / 2, bw, bh, 12); ctx.clip();
    let drew = false;
    if (item.imageUrl) { try { const im = await getAvatarImage(item.imageUrl); if (im) { const sc = Math.max(bw / im.width, bh / im.height); ctx.drawImage(im, cx - im.width * sc / 2, cy - im.height * sc / 2, im.width * sc, im.height * sc); drew = true; } } catch (e) { /* gradient */ } }
    if (!drew) { const c = item.colors || ['#222', '#555', '#222']; const g = ctx.createLinearGradient(cx - bw / 2, 0, cx + bw / 2, 0); c.forEach((col, i) => g.addColorStop(i / Math.max(1, c.length - 1), col)); ctx.fillStyle = g; ctx.fillRect(cx - bw / 2, cy - bh / 2, bw, bh); }
    ctx.restore(); ctx.lineWidth = 2; ctx.strokeStyle = 'rgba(255,255,255,0.25)'; rrect(ctx, cx - bw / 2, cy - bh / 2, bw, bh, 12); ctx.stroke();
  } else if (item.type === 'badge') {
    await drawBadgeForItem(ctx, item, cx, cy, s * 0.72);
  } else if (item.type === 'frame') {
    const r = s * 0.34; drawAvatarPlaceholder(ctx, cx, cy, r);
    ctx.lineWidth = Math.max(4, r * 0.14);
    if (item.colors) { const g = ctx.createLinearGradient(cx - r, cy - r, cx + r, cy + r); item.colors.forEach((c, i) => g.addColorStop(i / Math.max(1, item.colors.length - 1), c)); ctx.strokeStyle = g; } else ctx.strokeStyle = item.color || '#d4af37';
    ctx.beginPath(); ctx.arc(cx, cy, r + 3, 0, Math.PI * 2); ctx.stroke();
  } else if (item.type === 'decoration') {
    const r = s * 0.3; drawAvatarPlaceholder(ctx, cx, cy + s * 0.08, r); await drawDecoration(ctx, item, cx, cy + s * 0.08, r);
  } else if (item.type === 'title') {
    const t = String(item.text || item.name || '').slice(0, 28) || 'TITLE';
    let fs = 30; ctx.font = `bold ${fs}px ${CARD_FONT}`; while (ctx.measureText(t).width > w - 10 && fs > 12) { fs -= 2; ctx.font = `bold ${fs}px ${CARD_FONT}`; }
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillStyle = '#ffffff'; ctx.shadowColor = 'rgba(120,180,255,0.8)'; ctx.shadowBlur = 12; ctx.fillText(safeName(t, 'TITLE'), cx, cy); ctx.shadowBlur = 0;
  } else {
    const [glyph, c1, c2] = CONSUMABLE_LOOK[item.id] || ['star', '#4aa3ff', '#12306b'];
    ctx.save(); ctx.translate(cx, cy); drawMedal(ctx, s * 0.36, c1, c2, glyph); ctx.restore();
  }
}
async function drawShopCard(ctx, x, y, w, h, item, st, num) {
  const rar = rarityOf(item.price);
  rrect(ctx, x, y, w, h, 22);
  const bg = ctx.createLinearGradient(x, y, x, y + h); bg.addColorStop(0, '#0f2241'); bg.addColorStop(1, '#091428'); ctx.fillStyle = bg; ctx.fill();
  ctx.lineWidth = rar.key === 'LEGENDARY' ? 3 : 2; ctx.strokeStyle = rar.color; ctx.globalAlpha = rar.key === 'COMMON' ? 0.5 : 0.9; ctx.stroke(); ctx.globalAlpha = 1;
  const ph = h * 0.5;
  await drawItemPreview(ctx, item, x + w / 2, y + ph / 2 + 14, w - 50, ph - 14);
  // رقم العنصر
  ctx.beginPath(); ctx.arc(x + 28, y + 28, 17, 0, Math.PI * 2); ctx.fillStyle = rar.color; ctx.fill();
  ctx.fillStyle = '#071223'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.font = `bold 20px ${CARD_FONT}`; ctx.fillText(String(num), x + 28, y + 30);
  // حالة العنصر
  const tag = st.equipped ? ['EQUIPPED', '#2ecc71'] : st.owned ? ['OWNED', '#8a93a6'] : st.count ? [`x${st.count}`, '#4aa3ff'] : null;
  if (tag) { ctx.font = `bold 14px ${CARD_FONT}`; const tw = ctx.measureText(tag[0]).width + 20; rrect(ctx, x + w - tw - 12, y + 12, tw, 26, 13); ctx.fillStyle = 'rgba(8,16,32,0.85)'; ctx.fill(); ctx.lineWidth = 2; ctx.strokeStyle = tag[1]; ctx.stroke(); ctx.fillStyle = tag[1]; ctx.textAlign = 'center'; ctx.fillText(tag[0], x + w - tw / 2 - 12, y + 26); }
  ctx.strokeStyle = 'rgba(120,160,220,0.18)'; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(x + 14, y + h * 0.58); ctx.lineTo(x + w - 14, y + h * 0.58); ctx.stroke();
  // الاسم (لاتيني فقط، والعربي في القائمة تحت) + الندرة
  const nm = safeName(item.name, '') || String(item.text || '') || `ITEM ${num}`;
  let fs = 22; ctx.font = `bold ${fs}px ${CARD_FONT}`; while (ctx.measureText(nm).width > w - 36 && fs > 12) { fs -= 1; ctx.font = `bold ${fs}px ${CARD_FONT}`; }
  ctx.textAlign = 'left'; ctx.fillStyle = '#ffffff'; ctx.fillText(nm, x + 18, y + h * 0.58 + 26);
  ctx.font = `bold 14px ${CARD_FONT}`; ctx.fillStyle = rar.color; ctx.fillText(rar.key, x + 18, y + h * 0.58 + 52);
  // السعر
  const py = y + h - 58; rrect(ctx, x + 16, py, w - 32, 44, 22); ctx.fillStyle = '#0b1830'; ctx.fill(); ctx.lineWidth = 1.5; ctx.strokeStyle = 'rgba(120,160,220,0.35)'; ctx.stroke();
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  if (st.owned && item.type !== 'consumable') { ctx.fillStyle = '#7d8aa3'; ctx.font = `bold 20px ${CARD_FONT}`; ctx.fillText(st.equipped ? 'EQUIPPED' : 'OWNED', x + w / 2, py + 23); }
  else { const t = fmtNum(item.price); ctx.font = `bold 24px ${CARD_FONT}`; const tw = ctx.measureText(t).width; ctx.fillStyle = '#ffffff'; ctx.fillText(t, x + w / 2 - 20, py + 23); drawCoin(ctx, x + w / 2 - 20 + tw / 2 + 20, py + 22, 14); }
}
function shopBg(ctx, W, H) {
  ctx.fillStyle = '#071223'; ctx.fillRect(0, 0, W, H);
  const g = ctx.createRadialGradient(W * 0.2, 0, 10, W * 0.2, 0, W * 0.8); g.addColorStop(0, 'rgba(255,150,60,0.18)'); g.addColorStop(1, 'rgba(255,150,60,0)'); ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
  const g2 = ctx.createRadialGradient(W, H, 10, W, H, W * 0.7); g2.addColorStop(0, 'rgba(70,120,255,0.20)'); g2.addColorStop(1, 'rgba(70,120,255,0)'); ctx.fillStyle = g2; ctx.fillRect(0, 0, W, H);
}
function itemState(p, item) {
  if (item.type === 'consumable') return { count: p.inventory[item.id] || 0 };
  const owned = p.owned[ownedListKey(item.type)].includes(item.id);
  return { owned, equipped: owned && p.equipped[item.type] === item.id };
}
async function generateShopGridImage(cat, items, page, pages, profile, startNum) {
  const W = 1090, H = 770, cw = 330, ch = 290;
  const canvas = createCanvas(W, H), ctx = canvas.getContext('2d'); shopBg(ctx, W, H);
  const cinfo = SHOP_CATEGORIES.find(c => c.id === cat);
  ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic'; ctx.fillStyle = '#ffffff'; ctx.font = `bold 44px ${CARD_FONT}`; ctx.fillText(`SHOP  •  ${(cinfo ? cinfo.labelEn : cat).toUpperCase()}`, 40, 70);
  ctx.fillStyle = '#ffb347'; ctx.font = `bold 18px ${CARD_FONT}`; ctx.fillText(`PAGE ${page + 1} / ${pages}`, 42, 100);
  drawPointsPill(ctx, W - 40 - 270, 30, 270, 62, profile.points);
  for (let i = 0; i < items.length; i++) {
    const col = i % 3, row = Math.floor(i / 3);
    await drawShopCard(ctx, 30 + col * (cw + 20), 125 + row * (ch + 20), cw, ch, items[i], itemState(profile, items[i]), startNum + i);
  }
  return canvas.toBuffer('image/png');
}
async function generateBundlesImage(profile) {
  const W = 1090, H = 790, cw = 515, ch = 200;
  const canvas = createCanvas(W, H), ctx = canvas.getContext('2d'); shopBg(ctx, W, H);
  ctx.textAlign = 'left'; ctx.fillStyle = '#ffffff'; ctx.font = `bold 44px ${CARD_FONT}`; ctx.fillText('SHOP  •  BUNDLES', 40, 70);
  ctx.fillStyle = '#ffb347'; ctx.font = `bold 18px ${CARD_FONT}`; ctx.fillText('BUY A SET AND SAVE', 42, 100);
  drawPointsPill(ctx, W - 40 - 270, 30, 270, 62, profile.points);
  for (let i = 0; i < SHOP_BUNDLES.length; i++) {
    const b = SHOP_BUNDLES[i], info = bundleInfo(b, profile);
    const x = 30 + (i % 2) * (cw + 20), y = 125 + Math.floor(i / 2) * (ch + 20);
    rrect(ctx, x, y, cw, ch, 22); const bg = ctx.createLinearGradient(x, y, x, y + ch); bg.addColorStop(0, '#102548'); bg.addColorStop(1, '#091428'); ctx.fillStyle = bg; ctx.fill();
    ctx.lineWidth = 2; ctx.strokeStyle = '#4aa3ff'; ctx.stroke();
    for (let k = 0; k < info.items.length && k < 5; k++) await drawItemPreview(ctx, info.items[k], x + 62 + k * 86, y + 70, 64, 64);
    ctx.beginPath(); ctx.arc(x + 28, y + 26, 17, 0, Math.PI * 2); ctx.fillStyle = '#ffc83d'; ctx.fill();
    ctx.fillStyle = '#071223'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.font = `bold 20px ${CARD_FONT}`; ctx.fillText(String(i + 1), x + 28, y + 28);
    const tag = `-${b.off}%`; ctx.font = `bold 18px ${CARD_FONT}`; const tw = ctx.measureText(tag).width + 22; rrect(ctx, x + cw - tw - 14, y + 12, tw, 30, 15); ctx.fillStyle = 'rgba(255,200,60,0.15)'; ctx.fill(); ctx.strokeStyle = '#ffc83d'; ctx.lineWidth = 2; ctx.stroke(); ctx.fillStyle = '#ffc83d'; ctx.fillText(tag, x + cw - tw / 2 - 14, y + 28);
    ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic'; ctx.fillStyle = '#ffffff'; ctx.font = `bold 24px ${CARD_FONT}`; ctx.fillText(`${b.en}  •  ${info.items.length} ITEMS`, x + 20, y + 146);
    ctx.textBaseline = 'middle';
    if (!info.unowned.length) { ctx.fillStyle = '#7d8aa3'; ctx.font = `bold 22px ${CARD_FONT}`; ctx.fillText('ALL OWNED', x + 20, y + 178); }
    else {
      ctx.fillStyle = '#ffffff'; ctx.font = `bold 26px ${CARD_FONT}`; const t = fmtNum(info.cost); ctx.fillText(t, x + 20, y + 178); const tw2 = ctx.measureText(t).width;
      drawCoin(ctx, x + 20 + tw2 + 20, y + 177, 14);
      if (info.unowned.length === info.items.length) { ctx.fillStyle = '#7d8aa3'; ctx.font = `bold 20px ${CARD_FONT}`; const o = fmtNum(info.full), ox = x + 20 + tw2 + 52; ctx.fillText(o, ox, y + 178); ctx.fillRect(ox, y + 178, ctx.measureText(o).width, 2); }
    }
  }
  return canvas.toBuffer('image/png');
}
async function generateShopHomeImage(profile) {
  const W = 1090, H = 600;
  const canvas = createCanvas(W, H), ctx = canvas.getContext('2d'); shopBg(ctx, W, H);
  ctx.textAlign = 'left'; ctx.fillStyle = '#ffffff'; ctx.font = `bold 50px ${CARD_FONT}`; ctx.fillText('NW SHOP', 40, 72);
  ctx.fillStyle = '#ffb347'; ctx.font = `bold 18px ${CARD_FONT}`; ctx.fillText('PICK A SECTION BELOW', 42, 102);
  drawPointsPill(ctx, W - 40 - 270, 30, 270, 62, profile.points);
  const tiles = SHOP_CATEGORIES.map(c => ({ id: c.id, en: c.labelEn.toUpperCase(), n: shopItemsForCategory(c.id).length, sample: shopItemsForCategory(c.id)[0] }));
  tiles.push({ id: 'bundles', en: 'BUNDLES', n: SHOP_BUNDLES.length, sample: null });
  for (let i = 0; i < tiles.length; i++) {
    const t = tiles[i], x = 30 + (i % 4) * 258, y = 135 + Math.floor(i / 4) * 215, w = 238, h = 195;
    rrect(ctx, x, y, w, h, 22); const bg = ctx.createLinearGradient(x, y, x, y + h); bg.addColorStop(0, '#0f2241'); bg.addColorStop(1, '#091428'); ctx.fillStyle = bg; ctx.fill();
    ctx.lineWidth = 2; ctx.strokeStyle = t.id === 'bundles' ? '#ffc83d' : 'rgba(110,160,255,0.55)'; ctx.stroke();
    if (t.sample) await drawItemPreview(ctx, t.sample, x + w / 2, y + 66, w - 70, 90);
    else { const items = SHOP_BUNDLES[1].ids.map(getShopItem).filter(i => i && i.type !== 'title').slice(0, 3); for (let k = 0; k < items.length; k++) await drawItemPreview(ctx, items[k], x + 52 + k * 68, y + 66, 56, 56); }
    ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic'; ctx.fillStyle = '#ffffff'; ctx.font = `bold 22px ${CARD_FONT}`; ctx.fillText(t.en, x + w / 2, y + 150);
    ctx.fillStyle = '#ffb347'; ctx.font = `bold 15px ${CARD_FONT}`; ctx.fillText(t.id === 'bundles' ? 'SAVE UP TO 35%' : `${t.n} ITEMS`, x + w / 2, y + 176);
  }
  // مربع رصيدك
  const x = 30 + 3 * 258, y = 135 + 215, w = 238, h = 195;
  rrect(ctx, x, y, w, h, 22); const g = ctx.createLinearGradient(x, y, x + w, y + h); g.addColorStop(0, '#16327a'); g.addColorStop(1, '#0b1840'); ctx.fillStyle = g; ctx.fill(); ctx.lineWidth = 2; ctx.strokeStyle = '#4aa3ff'; ctx.stroke();
  drawCoin(ctx, x + w / 2, y + 70, 42);
  ctx.textAlign = 'center'; ctx.fillStyle = '#ffffff'; ctx.font = `bold 34px ${CARD_FONT}`; ctx.fillText(fmtNum(profile.points), x + w / 2, y + 152);
  ctx.fillStyle = '#9ec6ff'; ctx.font = `bold 15px ${CARD_FONT}`; ctx.fillText('YOUR POINTS', x + w / 2, y + 178);
  return canvas.toBuffer('image/png');
}
async function generateBalanceImage(profile, level) {
  const W = 700, H = 250;
  const canvas = createCanvas(W, H), ctx = canvas.getContext('2d'); shopBg(ctx, W, H);
  rrect(ctx, 14, 14, W - 28, H - 28, 26); ctx.lineWidth = 3; ctx.strokeStyle = '#4aa3ff'; ctx.stroke();
  drawCoin(ctx, 120, H / 2, 70);
  ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic'; ctx.fillStyle = '#9ec6ff'; ctx.font = `bold 20px ${CARD_FONT}`; ctx.fillText('YOUR POINTS', 225, 95);
  ctx.fillStyle = '#ffffff'; ctx.shadowColor = '#4aa3ff'; ctx.shadowBlur = 18; ctx.font = `bold 78px ${CARD_FONT}`; ctx.fillText(fmtNum(profile.points), 222, 170); ctx.shadowBlur = 0;
  ctx.fillStyle = '#ffb347'; ctx.font = `bold 20px ${CARD_FONT}`; ctx.fillText(`LEVEL ${level}`, 225, 210);
  return canvas.toBuffer('image/png');
}

function shopGridPage(cat, page) {
  const list = shopItemsForCategory(cat);
  const pages = Math.max(1, Math.ceil(list.length / SHOP_PAGE));
  page = Math.min(Math.max(0, page), pages - 1);
  return { list, pages, page, items: list.slice(page * SHOP_PAGE, page * SHOP_PAGE + SHOP_PAGE) };
}
async function shopHomeMessage(userId, lang) {
  const p = getGameProfile(userId);
  const en = lang === 'en';
  const buf = await generateShopHomeImage(p);
  const m = embedWithImage(en ? 'Choose a section from the menu below. Pick any item to preview it on your profile card before you buy.' : 'اختر قسم من القائمة تحت. اختر أي عنصر وتشوف معاينته على بطاقتك قبل ما تشتريه.', { title: `${E('shop')} ${en ? 'Games Shop' : 'متجر الألعاب'}` }, buf, 'shop.png');
  const opts = SHOP_CATEGORIES.map(c => ({ label: en ? c.labelEn : c.label, value: c.id, description: c.desc, emoji: c.emoji }));
  opts.push({ label: en ? 'Bundles' : 'الحزم (خصم)', value: 'bundles', description: en ? 'Sets with a discount' : 'مجموعات بسعر أقل', emoji: '🎁' });
  m.components = [new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId('shop_cat').setPlaceholder(en ? 'Choose a section' : 'اختر القسم').addOptions(opts)), promoRow(lang)];
  return m;
}
async function shopGridMessage(userId, cat, page, lang, notice) {
  const en = lang === 'en';
  const p = getGameProfile(userId);
  const g = shopGridPage(cat, page);
  if (!g.items.length) { const m = embedMsg(en ? 'ℹ️ Nothing available in this category yet.' : 'ℹ️ ما فيه عناصر بهذا القسم للحين.'); m.components = [new ActionRowBuilder().addComponents(shopHomeRow(lang))]; return m; }
  const buf = await generateShopGridImage(cat, g.items, g.page, g.pages, p, g.page * SHOP_PAGE + 1);
  const cinfo = SHOP_CATEGORIES.find(c => c.id === cat);
  const lines = g.items.map((it, i) => {
    const st = itemState(p, it), rar = rarityOf(it.price);
    const state = st.equipped ? ` — ✅ ${en ? 'equipped' : 'مجهّز'}` : st.owned ? ` — ${E('owned')} ${en ? 'owned' : 'مملوك'}` : st.count ? ` — ${en ? 'you have' : 'عندك'} ${st.count}` : '';
    return `**${g.page * SHOP_PAGE + i + 1}.** ${itemEmoji(it) || ''} **${it.name}** — ${it.price} ${E('points')} • ${en ? rar.key : rar.ar}${state}`;
  });
  const m = embedWithImage((notice ? notice + '\n\n' : '') + lines.join('\n') + `\n\n${en ? 'Pick an item from the menu' : 'اختر عنصر من القائمة'}${cat === 'roulette' ? (en ? ' to buy it.' : ' لشرائه.') : (en ? ' to preview and buy it.' : ' للمعاينة والشراء.')}`,
    { title: `${cinfo ? cinfo.emoji : ''} ${cinfo ? (en ? cinfo.labelEn : cinfo.label) : cat}`.trim(), footer: `${g.page + 1}/${g.pages}` }, buf, 'shop.png');
  const sel = new StringSelectMenuBuilder().setCustomId(`shop_pick:${cat}:${g.page}`).setPlaceholder(en ? 'Choose an item' : 'اختر عنصر')
    .addOptions(g.items.map((it, i) => { const st = itemState(p, it); const o = { label: `${g.page * SHOP_PAGE + i + 1}. ${it.name}`.slice(0, 100), value: it.id, description: `${it.price} • ${st.equipped ? (en ? 'Equipped' : 'مجهّز') : st.owned ? (en ? 'Owned' : 'مملوك') : rarityOf(it.price).key}`.slice(0, 100) }; const em = itemEmoji(it); if (em) o.emoji = em; return o; }));
  const nav = new ActionRowBuilder().addComponents(
    gbtn(`shop_page:${cat}:${g.page - 1}`, en ? 'Previous' : 'السابق', ButtonStyle.Primary, 'prev').setDisabled(g.page <= 0),
    new ButtonBuilder().setCustomId('shop_noop').setLabel(`${g.page + 1} / ${g.pages}`).setStyle(ButtonStyle.Secondary).setDisabled(true),
    gbtn(`shop_page:${cat}:${g.page + 1}`, en ? 'Next' : 'التالي', ButtonStyle.Primary, 'next').setDisabled(g.page >= g.pages - 1),
    shopHomeRow(lang));
  m.components = [new ActionRowBuilder().addComponents(sel), nav];
  return m;
}
async function shopBundlesMessage(userId, lang, notice) {
  const en = lang === 'en';
  const p = getGameProfile(userId);
  const buf = await generateBundlesImage(p);
  const lines = SHOP_BUNDLES.map((b, i) => {
    const info = bundleInfo(b, p);
    return `**${i + 1}.** **${en ? b.en : b.ar}** (-${b.off}%) — ${info.items.map(it => `${itemEmoji(it) || ''}${it.name}`).join('، ')}\n   ${info.unowned.length ? `${E('points')} **${info.cost}**${info.unowned.length === info.items.length ? ` ~~${info.full}~~` : ''}` : (en ? '✅ all owned' : '✅ تملكها كلها')}`;
  });
  const m = embedWithImage((notice ? notice + '\n\n' : '') + lines.join('\n\n'), { title: `🎁 ${en ? 'Bundles' : 'الحزم'}` }, buf, 'shop.png');
  const sel = new StringSelectMenuBuilder().setCustomId('shop_bsel').setPlaceholder(en ? 'Choose a bundle to buy' : 'اختر حزمة لشرائها')
    .addOptions(SHOP_BUNDLES.map((b, i) => { const info = bundleInfo(b, p); return { label: `${i + 1}. ${en ? b.en : b.ar}`.slice(0, 100), value: b.id, description: (info.unowned.length ? `${info.cost} • -${b.off}%` : (en ? 'All owned' : 'تملكها كلها')).slice(0, 100) }; }));
  m.components = [new ActionRowBuilder().addComponents(sel), new ActionRowBuilder().addComponents(shopHomeRow(lang))];
  return m;
}

async function shopItemMessage(guild, member, cat, idx, lang) {
  const en = lang === 'en';
  const list = shopItemsForCategory(cat);
  if (!list.length) {
    const m = embedMsg(en ? 'ℹ️ Nothing available in this category yet.' : 'ℹ️ ما فيه عناصر بهذا القسم للحين.');
    m.components = [new ActionRowBuilder().addComponents(shopHomeRow(lang))];
    return m;
  }
  const n = list.length;
  idx = ((idx % n) + n) % n;
  const item = list[idx];
  const p = getGameProfile(member.id);
  const owned = p.owned[ownerListKeySafe(item.type)].includes(item.id);
  const preview = { ...p, equipped: { ...p.equipped, [item.type]: item.id } };
  const r = ranksFor(guild, member.id);
  const buf = await generateProfileCard(member, preview, r.server, r.global, lang);
  const typeName = en ? SHOP_CATEGORIES.find(c => c.id === item.type).labelEn : SHOP_CATEGORIES.find(c => c.id === item.type).label;
  const desc = `${item.desc ? item.desc + '\n\n' : ''}${E('points')} **${en ? 'Price' : 'السعر'}:** ${item.price}\n${E('points')} **${en ? 'Your balance' : 'رصيدك'}:** ${p.points}` +
    (owned ? `\n${E('owned')} ${en ? 'You already own this item.' : 'أنت تملك هذا العنصر.'}` : '');
  const m = embedWithImage(desc, { title: `${itemEmoji(item) || ''} ${item.name}`.trim(), footer: `${typeName} • ${idx + 1}/${n}` }, buf, 'preview.png');
  const nav = new ActionRowBuilder().addComponents(
    gbtn(`shop_nav:${cat}:${idx - 1}`, en ? 'Previous' : 'السابق', ButtonStyle.Primary, 'prev'),
    new ButtonBuilder().setCustomId('shop_noop').setLabel(`${idx + 1} / ${n}`).setStyle(ButtonStyle.Secondary).setDisabled(true),
    gbtn(`shop_nav:${cat}:${idx + 1}`, en ? 'Next' : 'التالي', ButtonStyle.Primary, 'next')
  );
  const isEq = owned && p.equipped[item.type] === item.id;
  const buy = owned
    ? gbtn(`shop_equip:${item.id}:${cat}:${idx}`, isEq ? (en ? 'Unequip' : 'إلغاء التجهيز') : (en ? 'Equip' : 'تجهيز'), isEq ? ButtonStyle.Secondary : ButtonStyle.Primary, 'owned')
    : gbtn(`shop_buy:${cat}:${idx}:${item.id}`, en ? `Buy — ${item.price}` : `شراء — ${item.price}`, ButtonStyle.Success, 'buy');
  m.components = [nav, new ActionRowBuilder().addComponents(buy, gbtn(`shop_page:${cat}:${Math.floor(idx / SHOP_PAGE)}`, en ? 'Back to list' : 'رجوع للقائمة', ButtonStyle.Secondary, 'prev'), shopHomeRow(lang))];
  return m;
}
function ownerListKeySafe(type) { return ownedListKey(type); }
function shopRouletteMessage(userId, lang, notice) {
  const en = lang === 'en';
  const p = getGameProfile(userId);
  const items = shopItemsForCategory('roulette');
  let desc = (notice ? notice + '\n\n' : '') + `${E('points')} **${en ? 'Your balance' : 'رصيدك'}:** ${p.points}\n\n`;
  for (const it of items) {
    const have = it.type === 'consumable' ? (p.inventory[it.id] || 0) : (p.owned.abilities.includes(it.id) ? 1 : 0);
    desc += `${it.emoji} **${it.name}** — ${it.price} ${E('points')}${have ? ` (${en ? 'you have' : 'عندك'} ${have})` : ''}\n_${it.desc}_\n\n`;
  }
  const select = new StringSelectMenuBuilder().setCustomId('shop_rsel').setPlaceholder(en ? 'Choose an item to buy' : 'اختر عنصر لشرائه')
    .addOptions(items.map(it => { const o = { label: `${it.name} — ${it.price}`.slice(0, 100), value: it.id }; const em = itemEmoji(it); if (em) o.emoji = em; return o; }));
  const m = embedMsg(desc.slice(0, 4000), { title: `${E('roulette')} ${en ? 'Roulette Items' : 'أدوات الروليت'}` });
  m.components = [new ActionRowBuilder().addComponents(select), new ActionRowBuilder().addComponents(shopHomeRow(lang))];
  return m;
}
function purchaseItem(userId, item) {
  const p = getGameProfile(userId);
  const listKey = item.type === 'consumable' ? null : ownedListKey(item.type);
  if (listKey && p.owned[listKey].includes(item.id)) return { ok: false, reason: 'owned' };
  if (item.forSale === false || !(item.price > 0)) return { ok: false, reason: 'notforsale' };
  if (p.points < item.price) return { ok: false, reason: 'poor', have: p.points };
  addPoints(userId, -item.price, 'shop');
  if (!listKey) addInventory(userId, item.id, 1);
  else { p.owned[listKey].push(item.id); saveDatabase(db); }
  return { ok: true };
}

// ---------- لوحة إعدادات الألعاب (ضمن /settings) ----------
function getGamesEmbed(settings) {
  return new EmbedBuilder()
    .setTitle(`🎮 الألعاب — الإعدادات`)
    .setDescription(
      `**روم الأوامر المسموحة:** ${settings.gamesChannelId ? `<#${settings.gamesChannelId}>` : 'غير محدد'}\n` +
      `ℹ️ داخل هذا الروم تشتغل الاختصارات النصية: **p** بروفايل • **i** مخزون • **b** رصيد • **t** توب • **l** سجل النقاط.\n` +
      `⚠️ رسائل الاختصارات النصية ما تقدر تكون "خفية" (حدود ديسكورد) — أوامر السلاش / تكون خفية دائماً.\n\n` +
      `**نقاط الفوز بالروليت:** ${settings.rouletteWinPoints}\n` +
      `**نقاط الخسارة بالروليت:** ${settings.rouletteLosePoints}\n` +
      `**مكافأة الفوز النهائي:** ${settings.rouletteFinalBonus}\n` +
      `**أقصى عدد لاعبين بالجولة:** ${settings.rouletteMaxPlayers}`
    )
    .setColor(EMBED_COLOR);
}
function getGamesComponents() {
  const S = ButtonStyle;
  const row1 = new ActionRowBuilder().addComponents(
    gbtn('gm_profilechannel', 'تحديد روم الأوامر', S.Secondary, 'chan'),
    gbtn('gm_rouletteconfig', 'إعدادات الروليت', S.Secondary, 'roulette')
  );
  const row2 = new ActionRowBuilder().addComponents(
    gbtn('gm_open_roulette', 'بدء روليت', S.Success, 'rl_join'),
    gbtn('gm_open_shop', 'المتجر', S.Primary, 'shop'),
    gbtn('gm_open_profile', 'بروفايلي', S.Secondary, 'profile'),
    gbtn('gm_open_balance', 'رصيدي', S.Secondary, 'points'),
    gbtn('gm_open_inventory', 'مخزوني', S.Secondary, 'inventory')
  );
  const row3 = new ActionRowBuilder().addComponents(
    gbtn('gm_open_top', 'التوب 15', S.Secondary, 'top'),
    gbtn('gm_open_edit', 'تعديل بروفايلي', S.Secondary, 'edit'),
    gbtn('gm_open_history', 'سجل المباريات', S.Secondary, 'history'),
    gbtn('gm_open_log', 'سجل النقاط', S.Secondary, 'log')
  );
  const row4 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('settings_back').setLabel('رجوع للقائمة الرئيسية').setStyle(S.Danger).setEmoji('⬅️')
  );
  return [row1, row2, row3, row4];
}

// ---------- تشغيل أوامر الألعاب (مشترك: سلاش + أزرار الإعدادات) ----------
async function runGameCommand(interaction, cmd, opt = {}) {
  const guild = interaction.guild;
  const lang = getUserLang(guild.id);
  if (cmd === 'roulette') {
    const settings = getServerSettings(guild.id);
    if (rouletteSessions.get(interaction.channel.id)) {
      return interaction.reply({ ...embedMsg(lang === 'en' ? "⚠️ There's already a roulette match running in this channel." : '⚠️ فيه مباراة روليت شغالة بهذا الروم حالياً.'), ephemeral: true });
    }
    const session = startRouletteSession(interaction.channel.id, interaction.user.id, settings);
    await interaction.reply({ embeds: [getRouletteLobbyEmbed(session, lang)], components: getRouletteLobbyComponents(lang) });
    session.lobbyMsg = await interaction.fetchReply().catch(() => null);
    scheduleRouletteAutoStart(interaction.channel, lang);
    return;
  }
  await interaction.deferReply({ ephemeral: true });
  try {
    const uid = interaction.user.id;
    switch (cmd) {
      case 'shop': return await interaction.editReply(await shopHomeMessage(uid, lang));
      case 'profile': {
        const target = opt.user || interaction.user;
        const member = target.id === uid && interaction.member ? interaction.member : await guild.members.fetch(target.id).catch(() => null);
        if (!member) return await interaction.editReply(embedMsg(lang === 'en' ? "❌ I couldn't find this member in the server." : '❌ ما لقيت هذا العضو بالسيرفر.'));
        return await interaction.editReply(await buildProfileMessage(guild, member, lang));
      }
      case 'stats': return await interaction.editReply(buildStatsMsg(guild, opt.user || interaction.user, lang));
      case 'balance': return await interaction.editReply(await buildBalanceMsg(uid, lang));
      case 'inventory': return await interaction.editReply(buildInventoryMsg(uid, lang));
      case 'top': return await interaction.editReply(buildTopMsg(guild, opt.type || 'points', opt.scope || 'server', lang));
      case 'history': return await interaction.editReply(buildHistoryMsg(uid, lang));
      case 'log': return await interaction.editReply(buildLogMsg(uid, lang));
      case 'streak': return await interaction.editReply(await buildStreakMessage(guild, interaction.member || await guild.members.fetch(uid), lang));
      case 'edit': {
        const member = interaction.member || await guild.members.fetch(uid);
        return await interaction.editReply(await buildEditMessage(guild, member, lang));
      }
    }
  } catch (e) {
    console.error(`فشل تنفيذ الأمر ${cmd}:`, e);
    await interaction.editReply(embedMsg(lang === 'en' ? '❌ Something went wrong, please try again.' : '❌ صار خطأ، حاول مرة ثانية.')).catch(() => {});
  }
}

// ==========================================
// 🎡 الروليت
// ==========================================
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const yieldLoop = () => new Promise(r => setImmediate(r));
const ROUND_GAP_MS = 7000; // ⏳ مدة الراحة بين كل راوند والثاني
const isLive = (session) => rouletteSessions.get(session.channelId) === session;

function pushNote(session, text) {
  session.notes = session.notes || [];
  session.notes.push(text);
  while (session.notes.length > 6) session.notes.shift();
}
function remainingLine(session, lang) {
  const alive = session.players.map(p => `<@${p.id}>`).join(' • ');
  return lang === 'en' ? `**Remaining (${session.players.length}):** ${alive}` : `**المتبقين (${session.players.length}):** ${alive}`;
}
function notesBlock(session, lang) {
  const list = (session.notes || []).slice(-3);
  if (!list.length) return '';
  return `${lang === 'en' ? '📜 **Recent events:**' : '📜 **آخر الأحداث:**'}\n${list.map(t => `• ${String(t).split('\n')[0]}`).join('\n')}\n\n`;
}
// يعدّل رسالة الدور الحالية: يشيل الأزرار ويكتب الحدث (بدون رسائل إضافية)
async function settleTurn(session, lang, text, opts = {}) {
  const en = lang === 'en';
  if (opts.note !== false) pushNote(session, text);
  if (!session.turnMsg) return;
  const body = `${text}\n\n${remainingLine(session, lang)}` + (opts.gap === false ? '' : `\n⏳ ${en ? 'Next round in 7 seconds...' : 'الجولة الجاية بعد 7 ثواني...'}`);
  try { await session.turnMsg.edit({ content: body.slice(0, 1990), components: [], allowedMentions: { parse: [] } }); }
  catch (e) { console.error('تعذر تعديل رسالة الدور:', e.message); }
}

// ---------- رسم العجلة ----------
function drawSpinFrame(ctx, W, H, players, rot, hiIdx, hiColor, avatarImg, pop) {
  const cx = W / 2, cy = 184, R = 150, n = players.length, slice = (Math.PI * 2) / n;
  ctx.fillStyle = '#120403'; ctx.fillRect(0, 0, W, H);
  ctx.beginPath(); ctx.arc(cx, cy, R + 10, 0, Math.PI * 2); ctx.fillStyle = '#000000'; ctx.fill();
  const cols = ['#8b0000', '#ff7518'];
  const hr = 52;
  const maxW = R - 14 - (hr + 12);
  ctx.save(); ctx.translate(cx, cy); ctx.rotate(rot);
  for (let i = 0; i < n; i++) {
    const a0 = i * slice - Math.PI / 2, a1 = a0 + slice, mid = a0 + slice / 2;
    ctx.beginPath(); ctx.moveTo(0, 0); ctx.arc(0, 0, R, a0, a1); ctx.closePath();
    ctx.fillStyle = (i === hiIdx && pop > 0) ? hiColor : cols[i % 2]; ctx.fill();
    ctx.strokeStyle = '#ff9d42'; ctx.lineWidth = 3; ctx.stroke();
    // اسم الشريحة: دايماً مقروء (نقلبه 180° لما يصير مقلوب) ويصغر عشان يناسب
    const label = String(players[i].label || '?');
    ctx.save(); ctx.rotate(mid);
    let fs = n <= 8 ? 17 : n <= 14 ? 14 : 12;
    ctx.font = `bold ${fs}px ${CARD_FONT}`;
    let tw = ctx.measureText(label).width;
    while (tw > maxW && fs > 8) { fs -= 1; ctx.font = `bold ${fs}px ${CARD_FONT}`; tw = ctx.measureText(label).width; }
    ctx.textBaseline = 'middle'; ctx.lineJoin = 'round'; ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(0,0,0,0.55)'; ctx.fillStyle = '#ffffff';
    if (Math.cos(mid + rot) < 0) { ctx.rotate(Math.PI); ctx.textAlign = 'left'; ctx.strokeText(label, -(R - 14), 0); ctx.fillText(label, -(R - 14), 0); }
    else { ctx.textAlign = 'right'; ctx.strokeText(label, R - 14, 0); ctx.fillText(label, R - 14, 0); }
    ctx.restore();
  }
  ctx.restore();
  ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2); ctx.lineWidth = 7; ctx.strokeStyle = '#ff9d42'; ctx.stroke();
  // مركز العجلة: علامة استفهام أثناء الدوران، وصورة الفائز تنبثق عند التوقف
  ctx.beginPath(); ctx.arc(cx, cy, hr + 6, 0, Math.PI * 2); ctx.fillStyle = '#140402'; ctx.fill();
  if (pop > 0) {
    const r = Math.max(8, hr * (0.45 + 0.55 * Math.min(1, pop)));
    if (avatarImg) {
      ctx.save(); ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.clip(); ctx.drawImage(avatarImg, cx - r, cy - r, r * 2, r * 2); ctx.restore();
    } else {
      ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.fillStyle = '#2a0a06'; ctx.fill();
      ctx.fillStyle = '#ffb347'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.font = `bold ${Math.round(r * 0.9)}px ${CARD_FONT}`;
      ctx.fillText(String((players[hiIdx] && players[hiIdx].label) || '?')[0].toUpperCase(), cx, cy + 2);
    }
    ctx.beginPath(); ctx.arc(cx, cy, r + 3, 0, Math.PI * 2); ctx.lineWidth = 6; ctx.strokeStyle = hiColor; ctx.stroke();
  } else {
    ctx.beginPath(); ctx.arc(cx, cy, hr, 0, Math.PI * 2); ctx.fillStyle = '#2a0a06'; ctx.fill();
    ctx.lineWidth = 4; ctx.strokeStyle = '#ff9d42'; ctx.stroke();
    ctx.fillStyle = '#ffb347'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.font = `bold 46px ${CARD_FONT}`;
    ctx.fillText('?', cx, cy + 3);
  }
  // المؤشر
  ctx.beginPath(); ctx.moveTo(cx - 20, 6); ctx.lineTo(cx + 20, 6); ctx.lineTo(cx, 48); ctx.closePath();
  ctx.fillStyle = '#ffb347'; ctx.fill(); ctx.strokeStyle = '#140402'; ctx.lineWidth = 3; ctx.stroke();
}

// صورة ثابتة للعجلة وهي واقفة على الشخص (تنرسل كرسالة جديدة تحت)
async function buildResultImage(players, resultId, mode) {
  const LW = 340, LH = 350, TWO_PI = Math.PI * 2;
  const wheel = players.map((p, i) => ({ ...p, label: safeName(p.name, `P${i + 1}`).slice(0, 14) }));
  const idx = Math.max(0, wheel.findIndex(p => p.id === resultId));
  const slice = TWO_PI / wheel.length;
  let avatarImg = null;
  try { avatarImg = await getAvatarImage(wheel[idx].avatar); } catch (e) { avatarImg = null; }
  const hiColor = mode === 'win' ? '#ffd700' : '#ff1f1f';
  const rot = TWO_PI * 2 + (TWO_PI - (idx + 0.5) * slice) + (Math.random() - 0.5) * slice * 0.4;
  const canvas = createCanvas(LW, LH); const ctx = canvas.getContext('2d');
  drawSpinFrame(ctx, LW, LH, wheel, rot, idx, hiColor, avatarImg, 1);
  return canvas.toBuffer('image/png');
}
// صورة صاحب الدور (أفتاره + اسمه)
async function buildTurnImage(actor) {
  const W = 320, H = 350;
  const canvas = createCanvas(W, H); const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#120403'; ctx.fillRect(0, 0, W, H);
  const cx = W / 2, cy = 150, r = 112;
  ctx.beginPath(); ctx.arc(cx, cy, r + 12, 0, Math.PI * 2); ctx.fillStyle = '#000000'; ctx.fill();
  let img = null;
  try { img = await getAvatarImage(actor.avatar); } catch (e) { img = null; }
  const nm = safeName(actor.name, 'Player');
  if (img) { ctx.save(); ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.clip(); ctx.drawImage(img, cx - r, cy - r, r * 2, r * 2); ctx.restore(); }
  else { ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.fillStyle = '#2a0a06'; ctx.fill(); ctx.fillStyle = '#ffb347'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.font = `bold 90px ${CARD_FONT}`; ctx.fillText(nm[0].toUpperCase(), cx, cy + 4); }
  ctx.beginPath(); ctx.arc(cx, cy, r + 5, 0, Math.PI * 2); ctx.lineWidth = 8; ctx.strokeStyle = '#ff9d42'; ctx.stroke();
  let fs = 30; ctx.font = `bold ${fs}px ${CARD_FONT}`;
  while (ctx.measureText(nm).width > W - 30 && fs > 14) { fs -= 2; ctx.font = `bold ${fs}px ${CARD_FONT}`; }
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillStyle = '#ffffff';
  ctx.fillText(nm, cx, 308);
  return canvas.toBuffer('image/png');
}
// يرسل صورة العجلة كرسالة جديدة (إمبيد أسود) مع منشن صاحب النتيجة
async function sendWheelResult(channel, session, lang, players, resultId, mode, text, extra = {}) {
  const en = lang === 'en';
  const masked = players.map((p, i) => ({ p, fb: `P${i + 1}` })).filter(x => safeName(x.p.name, x.fb) === x.fb);
  const legend = masked.length ? '\n\n' + masked.map(x => `\`${x.fb}\` = <@${x.p.id}>`).join(' • ') : '';
  const emb = new EmbedBuilder().setColor(EMBED_COLOR)
    .setTitle(extra.title || `${E(mode === 'win' ? 'win' : 'out')} ${en ? 'Result' : 'النتيجة'}`)
    .setDescription((text + legend).slice(0, 4000));
  if (extra.footer) emb.setFooter({ text: extra.footer });
  const body = { content: `<@${resultId}>`, embeds: [emb], components: extra.components || [], allowedMentions: { users: [resultId] } };
  try {
    const buf = await buildResultImage(players, resultId, mode);
    emb.setImage('attachment://result.png'); body.files = [{ attachment: buf, name: 'result.png' }];
  } catch (e) { console.error('فشل رسم صورة العجلة:', e); }
  return channel.send(body).catch(e => { console.error('فشل إرسال نتيجة الروليت:', e); return null; });
}

// ---------- اللوبي ----------
function getRouletteLobbyEmbed(session, lang) {
  const en = lang === 'en';
  const list = session.players.map((p, i) => `**${i + 1}.** <@${p.id}>`).join('\n') || (en ? '_No one joined yet_' : '_محد انضم للحين_');
  const until = session.startAt ? `<t:${session.startAt}:R>` : '';
  return new EmbedBuilder()
    .setTitle(`${E('roulette')} ${en ? 'New Roulette' : 'روليت جديد'}`)
    .setDescription(en
      ? `Press **Join** to enter the round.\n⏳ The match starts automatically ${until} (at least 2 players needed).\n\n**Players (${session.players.length}/${session.maxPlayers}):**\n${list}`
      : `اضغط **انضمام** للدخول بالجولة.\n⏳ تبدأ المباراة تلقائياً ${until} (تحتاج لاعبين على الأقل).\n\n**اللاعبين (${session.players.length}/${session.maxPlayers}):**\n${list}`)
    .setColor(EMBED_COLOR)
    .setFooter({ text: 'Nw Roulette' });
}
function getRouletteLobbyComponents(lang = 'ar') {
  const en = lang === 'en';
  return [new ActionRowBuilder().addComponents(
    gbtn('rl_join', en ? 'Join' : 'انضمام', ButtonStyle.Success, 'rl_join'),
    gbtn('rl_leave', en ? 'Leave' : 'انسحاب', ButtonStyle.Secondary, 'rl_leave')
  )];
}
function startRouletteSession(channelId, hostId, settings) {
  const session = { channelId, hostId, settings, phase: 'lobby', players: [], eliminated: [], allPlayers: [], round: 0, maxPlayers: settings.rouletteMaxPlayers, turnToken: 0, lobbyTimer: null, turnTimer: null, lobbyMsg: null, turnMsg: null, notes: [], busy: false, protUsed: {}, passUsed: {}, protectedNow: {}, dkArmed: null, soulLinks: {}, turnDeadline: 0, timeoutNote: null, startAt: Math.floor(Date.now() / 1000) + 45 };
  rouletteSessions.set(channelId, session);
  return session;
}
function clearSessionTimers(s) {
  if (s.lobbyTimer) clearTimeout(s.lobbyTimer);
  if (s.turnTimer) clearTimeout(s.turnTimer);
  s.lobbyTimer = null; s.turnTimer = null;
}
function endRouletteSession(s) {
  clearSessionTimers(s);
  s.turnToken += 1;
  if (rouletteSessions.get(s.channelId) === s) rouletteSessions.delete(s.channelId);
}
async function editLobby(session, payload) {
  if (!session.lobbyMsg) return;
  try { session.lobbyMsg = await session.lobbyMsg.edit(payload); } catch (e) { console.error('تعذر تعديل رسالة اللوبي:', e.message); }
}
// يفتح لوبي من رسالة نصية (اختصار -روليت)
async function openRouletteLobbyFromChannel(channel, hostId, settings, lang) {
  if (rouletteSessions.get(channel.id)) return null;
  const session = startRouletteSession(channel.id, hostId, settings);
  session.lobbyMsg = await channel.send({ embeds: [getRouletteLobbyEmbed(session, lang)], components: getRouletteLobbyComponents(lang) }).catch(e => { console.error(e); return null; });
  if (!session.lobbyMsg) { endRouletteSession(session); return null; }
  scheduleRouletteAutoStart(channel, lang);
  return session;
}
function scheduleRouletteAutoStart(channel, lang) {
  const session = rouletteSessions.get(channel.id);
  if (!session) return;
  session.lobbyTimer = setTimeout(async () => {
    try {
      if (rouletteSessions.get(channel.id) !== session || session.phase !== 'lobby') return;
      if (session.players.length >= 2) {
        await beginRouletteMatch(channel, session, lang);
      } else {
        await editLobby(session, { ...embedMsg(lang === 'en' ? '❌ Not enough players joined, the match was cancelled.' : '❌ ما انضم عدد كافٍ من اللاعبين، تم إلغاء المباراة.'), components: [] });
        endRouletteSession(session);
      }
    } catch (e) { console.error('فشل البدء التلقائي للروليت:', e); endRouletteSession(session); }
  }, 45000);
}
async function beginRouletteMatch(channel, session, lang) {
  if (session.phase !== 'lobby') return;
  if (session.lobbyTimer) { clearTimeout(session.lobbyTimer); session.lobbyTimer = null; }
  session.phase = 'running';
  session.allPlayers = session.players.map(p => p.id);
  for (const p of session.players) getGameProfile(p.id).roulettePlays += 1;
  saveDatabase(db);
  const en = lang === 'en';
  await editLobby(session, { embeds: [new EmbedBuilder().setColor(EMBED_COLOR).setTitle(`${E('roulette')} ${en ? 'The match has started!' : 'بدأت المباراة!'}`).setDescription(session.players.map((p, i) => `**${i + 1}.** <@${p.id}>`).join('\n')).setFooter({ text: 'Nw Roulette' })], components: [] });
  session.busy = true;
  try { await runRouletteRound(channel, session, lang); } finally { session.busy = false; }
}
// إلغاء المباراة (من الاختصار -الغاء أو زر الإيقاف)
async function cancelRouletteSession(channel, session, lang, byId) {
  const en = lang === 'en';
  const wasLobby = session.phase === 'lobby';
  endRouletteSession(session);
  const text = en ? `${E('rl_stop')} The match was cancelled by <@${byId}>.` : `${E('rl_stop')} <@${byId}> ألغى المباراة.`;
  if (wasLobby) await editLobby(session, { ...embedMsg(text), components: [] });
  else {
    if (session.turnMsg) await session.turnMsg.edit({ components: [] }).catch(() => {});
    await channel.send({ ...embedMsg(text), allowedMentions: { parse: [] } }).catch(() => {});
  }
}
function pickRandomOtherIndex(len, excludeIdx) {
  if (len <= 1) return -1;
  let idx;
  do { idx = Math.floor(Math.random() * len); } while (idx === excludeIdx);
  return idx;
}

// ---------- رسالة الدور (عادية، مو إمبيد): منشن + صورة + أزرار الأشخاص ----------
function turnComponents(session, actorId, lang, second) {
  const en = lang === 'en';
  const prof = getGameProfile(actorId);
  const others = session.players.filter(p => p.id !== actorId);
  const rows = [];
  if (others.length <= 20) {
    for (let i = 0; i < others.length; i += 5) {
      rows.push(new ActionRowBuilder().addComponents(others.slice(i, i + 5).map(p =>
        new ButtonBuilder().setCustomId(`rl_kick:${p.id}`).setLabel(String(p.name || '?').slice(0, 60) || '?').setStyle(ButtonStyle.Danger))));
    }
  } else {
    rows.push(new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId('rl_target_select').setPlaceholder(en ? 'Kick a player' : 'اختر لاعب تطرده')
      .addOptions(others.slice(0, 25).map(p => ({ label: String(p.name || '?').slice(0, 100) || '?', value: p.id })))));
  }
  const btns = [gbtn('rl_random', en ? 'Random kick' : 'طرد عشوائي', ButtonStyle.Primary, 'luck')];
  if (!second) {
    btns.push(gbtn('rl_protect', en ? 'Protect me' : 'حماية نفسي', ButtonStyle.Secondary, 'shield').setDisabled(!!session.protUsed[actorId]));
    btns.push(gbtn('rl_pass', en ? 'Pass' : 'تمرير', ButtonStyle.Secondary, 'next').setDisabled(!!session.passUsed[actorId]));
    const dkCount = prof.inventory.double_kick || 0;
    if ((dkCount > 0 || session.dkArmed === actorId) && session.players.length >= 3) {
      const armed = session.dkArmed === actorId;
      btns.push(gbtn('rl_dk', armed ? (en ? 'Double kick ✔' : 'طرد مرتين ✔') : (en ? `Double kick (${dkCount})` : `طرد مرتين (${dkCount})`), armed ? ButtonStyle.Success : ButtonStyle.Secondary, 'kick'));
    }
  }
  btns.push(gbtn('rl_stop', en ? 'Stop' : 'إيقاف', ButtonStyle.Danger, 'rl_stop'));
  rows.push(new ActionRowBuilder().addComponents(btns));
  return rows;
}
function turnText(session, actorId, lang, extra, second) {
  const en = lang === 'en';
  const until = session.turnDeadline ? `<t:${session.turnDeadline}:R>` : '';
  const head = second
    ? (en ? `<@${actorId}> ${E('kick')} **Double Kick** — pick your **second** target! Time ends ${until}` : `<@${actorId}> ${E('kick')} **طرد مرتين** — اختر هدفك **الثاني**! ينتهي الوقت ${until}`)
    : (en ? `<@${actorId}> 🎯 **Your turn!** Pick who to kick — time ends ${until}\n_(or: random kick • protect me • pass • double kick)_` : `<@${actorId}> 🎯 **دورك!** اختر مين تطرد — ينتهي الوقت ${until}\n_(أو: طرد عشوائي • حماية نفسي • تمرير • طرد مرتين)_`);
  return `${head}\n\n${extra ? extra + '\n\n' : ''}${notesBlock(session, lang)}${remainingLine(session, lang)}`.slice(0, 1990);
}
async function sendTurnMessage(channel, session, lang, actorId, second) {
  const actor = session.players.find(p => p.id === actorId);
  if (!actor) return;
  session.currentActorId = actorId;
  session.turnDeadline = Math.floor(Date.now() / 1000) + 30;
  const body = { content: turnText(session, actorId, lang, null, second), components: turnComponents(session, actorId, lang, second), allowedMentions: { users: [actorId] } };
  try { body.files = [{ attachment: await buildTurnImage(actor), name: 'turn.png' }]; } catch (e) { console.error('فشل رسم صورة الدور:', e); }
  const m = await channel.send(body).catch(e => { console.error('فشل إرسال رسالة الدور:', e); return null; });
  if (m) { session.turnMsg = m; if (isLive(session)) armTurnTimer(channel, session, lang, actorId); }
}
function armTurnTimer(channel, session, lang, actorId) {
  if (session.turnTimer) clearTimeout(session.turnTimer);
  const token = ++session.turnToken;
  session.turnTimer = setTimeout(async () => {
    try {
      if (!isLive(session) || session.turnToken !== token || session.busy) return;
      const candidates = session.players.filter(p => p.id !== actorId);
      if (!candidates.length) return;
      const pick = candidates[Math.floor(Math.random() * candidates.length)];
      session.turnToken += 1;
      session.timeoutNote = lang === 'en' ? `⏰ <@${actorId}> didn't choose in time — a random target was picked.` : `⏰ <@${actorId}> ما اختار بالوقت — تم اختيار هدف عشوائي.`;
      await resolveRouletteTarget({ channel, user: { id: actorId } }, session, pick.id, lang);
    } catch (e) { console.error('فشل اختيار الهدف العشوائي بالروليت:', e); }
  }, 30000);
}
async function runRouletteRound(channel, session, lang, excludeActorId) {
  if (!isLive(session)) return;
  if (session.round > 0) { await sleep(session.players.length <= 1 ? 4000 : ROUND_GAP_MS); if (!isLive(session)) return; } // ⏳ راحة بين كل راوند والثاني
  if (session.players.length <= 2) return finishRouletteFinal(channel, session, lang);
  session.round += 1;
  session.dkArmed = null; session.timeoutNote = null;
  const pool = session.players.filter(p => p.id !== excludeActorId);
  const actor = (pool.length ? pool : session.players)[Math.floor(Math.random() * (pool.length ? pool.length : session.players.length))];
  await sendTurnMessage(channel, session, lang, actor.id, false);
}
// ---- إجراءات اللاعب بدوره (أزرار) ----
async function rouletteTurnAction(interaction, session, kind, lang) {
  const en = lang === 'en';
  const actorId = interaction.user.id;
  const eph = (t) => interaction.reply({ ...embedMsg(t), ephemeral: true });
  if (session.phase !== 'running' || session.busy) return eph(en ? '⏳ Please wait a moment.' : '⏳ انتظر لحظة.');
  if (actorId !== session.currentActorId) return eph(en ? "❌ It's not your turn." : '❌ مو دورك الحين.');
  const channel = interaction.channel;
  if (kind === 'dk') {
    if (session.dkArmed === actorId) return eph(en ? '✅ Already armed.' : '✅ مفعّلة مسبقاً.');
    if (!(getGameProfile(actorId).inventory.double_kick > 0)) return eph(en ? "❌ You don't own Double Kick." : '❌ ما تملك طرد مرتين.');
    if (session.players.length < 3) return eph(en ? '❌ Double Kick needs at least 3 players.' : '❌ طرد مرتين يحتاج 3 لاعبين على الأقل.');
    session.dkArmed = actorId;
    return interaction.update({ content: turnText(session, actorId, lang, en ? `${E('kick')} Double Kick armed — your next kick eliminates two players.` : `${E('kick')} تفعّل طرد مرتين — طردتك الجاية تطرد لاعبين.`), components: turnComponents(session, actorId, lang), allowedMentions: { parse: [] } });
  }
  session.busy = true;
  try {
    session.turnToken += 1;
    if (session.turnTimer) { clearTimeout(session.turnTimer); session.turnTimer = null; }
    await interaction.deferUpdate().catch(() => {});
    if (kind === 'protect') {
      session.protUsed[actorId] = true; session.protectedNow[actorId] = true;
      await settleTurn(session, lang, en ? `${E('shield')} <@${actorId}> protected themselves — the next kick on them is blocked.` : `${E('shield')} <@${actorId}> حمى نفسه — أول طرد عليه ينلغي.`);
      return await runRouletteRound(channel, session, lang, actorId);
    }
    if (kind === 'pass') {
      session.passUsed[actorId] = true;
      await settleTurn(session, lang, en ? `⏭️ <@${actorId}> passed the turn.` : `⏭️ <@${actorId}> مرّر دوره.`);
      return await runRouletteRound(channel, session, lang, actorId);
    }
    // random
    const cand = session.players.filter(p => p.id !== actorId);
    if (!cand.length) return;
    const pick = cand[Math.floor(Math.random() * cand.length)];
    await resolveRouletteInner(channel, session, pick.id, lang, actorId);
  } catch (e) { console.error('فشل إجراء الروليت:', e); }
  finally { session.busy = false; }
}
// اختيار هدف من أزرار الأشخاص أو القائمة
async function rouletteKickPick(interaction, session, targetId, lang) {
  const en = lang === 'en';
  const eph = (t) => interaction.reply({ ...embedMsg(t), ephemeral: true });
  if (!session) return eph(en ? '❌ This match has ended.' : '❌ هذي المباراة انتهت.');
  if (interaction.user.id !== session.currentActorId) return eph(en ? "❌ It's not your turn." : '❌ مو دورك الحين.');
  if (session.busy || session.phase !== 'running') return eph(en ? '⏳ Please wait a moment.' : '⏳ انتظر لحظة.');
  if (targetId === interaction.user.id || !session.players.some(p => p.id === targetId)) return eph(en ? '❌ Invalid target.' : '❌ هدف غير صالح.');
  session.turnToken += 1;
  if (session.turnTimer) { clearTimeout(session.turnTimer); session.turnTimer = null; }
  await interaction.deferUpdate().catch(() => {});
  await resolveRouletteTarget(interaction, session, targetId, lang);
}
async function resolveRouletteTarget(interaction, session, targetId, lang) {
  if (!isLive(session) || session.busy) return;
  session.busy = true;
  try { await resolveRouletteInner(interaction.channel, session, targetId, lang, interaction.user.id); }
  catch (e) { console.error('خطأ بالروليت:', e); }
  finally { session.busy = false; }
}
async function resolveRouletteInner(channel, session, targetId, lang, actorId) {
  if (!isLive(session)) return;
  const en = lang === 'en';
  const targetIdx = session.players.findIndex(p => p.id === targetId);
  if (targetIdx === -1) return runRouletteRound(channel, session, lang);
  const target = session.players[targetIdx];
  const tp = getGameProfile(target.id);
  const saved = async (text) => {
    getGameProfile(target.id).savesGiven += 1; saveDatabase(db);
    if (session.dkArmed && session.dkArmed === actorId) text += en ? `\n${E('kick')} Double Kick was not used.` : `\n${E('kick')} طرد مرتين ما انصرف.`;
    await settleTurn(session, lang, text);
  };

  if (session.protectedNow[target.id]) {
    delete session.protectedNow[target.id];
    await saved(en ? `${E('shield')} <@${target.id}>'s protection blocked the kick!` : `${E('shield')} حماية <@${target.id}> منعت الطرد!`);
    return runRouletteRound(channel, session, lang);
  }
  if ((tp.inventory.shield || 0) > 0) {
    consumeInventory(target.id, 'shield');
    await saved(en ? `${E('shield')} <@${target.id}> used a **Survival Shield** and survived!` : `${E('shield')} <@${target.id}> استخدم **درع النجاة** ونجا!`);
    return runRouletteRound(channel, session, lang);
  }
  if ((tp.inventory.ability_doubleluck || 0) > 0 && Math.random() < 0.20) {
    consumeInventory(target.id, 'ability_doubleluck');
    await saved(en ? `${E('doubleluck')} <@${target.id}> used **"Lucky Lucky"** — survived with an extra slot!` : `${E('doubleluck')} <@${target.id}> استخدم **"حظك وحظك"** — نجا بمحاولة إضافية!`);
    return runRouletteRound(channel, session, lang);
  }
  if ((tp.inventory.ability_luck || 0) > 0 && Math.random() < 0.40) {
    consumeInventory(target.id, 'ability_luck');
    const otherIdx = pickRandomOtherIndex(session.players.length, targetIdx);
    if (otherIdx !== -1) {
      const other = session.players[otherIdx];
      session.soulLinks[target.id] = other.id;
      await saved(en ? `${E('luck')} <@${target.id}> used **"You and Your Luck"** — survived, but their soul is now bound to <@${other.id}>!` : `${E('luck')} <@${target.id}> استخدم **"أنت وحظك"** — نجا، بس انربطت روحه بـ <@${other.id}>!`);
    } else await saved(en ? `${E('luck')} <@${target.id}> used **"You and Your Luck"** — survived!` : `${E('luck')} <@${target.id}> استخدم **"أنت وحظك"** — نجا!`);
    return runRouletteRound(channel, session, lang);
  }
  await eliminateRoulettePlayer(channel, session, target.id, lang, actorId);
}
async function eliminateRoulettePlayer(channel, session, playerId, lang, actorId) {
  const en = lang === 'en';
  const idx = session.players.findIndex(p => p.id === playerId);
  if (idx === -1) return;
  const settings = session.settings;
  const before = session.players.map(p => ({ ...p }));
  const removed = session.players[idx];
  // ✂️ طرد مرتين: تُستهلك عند أول طرد فعلي بعد التفعيل
  let doubleKick = false;
  if (actorId && session.dkArmed === actorId && consumeInventory(actorId, 'double_kick')) doubleKick = true;
  session.dkArmed = null;
  if (actorId) { getGameProfile(actorId).kicksGiven += 1; saveDatabase(db); }

  // 🔗 رابط الأرواح: نحسب الضحية الثانية قبل الكشف عشان تظهر بنفس الرسالة
  let linkedId = null;
  const lk = session.soulLinks && session.soulLinks[removed.id];
  if (lk && lk !== removed.id && session.players.some(p => p.id === lk)) linkedId = lk;
  const ownsRevive = (getGameProfile(removed.id).inventory.ability_revive || 0) > 0 && !session.reviveUsedThisMatch;
  const pre = session.timeoutNote ? session.timeoutNote + '\n' : ''; session.timeoutNote = null;

  // العجلة "تدور" على رسالة الدور (نص فقط) ثم تنرسل صورتها كرسالة جديدة تحت
  await settleTurn(session, lang, pre + (en ? '🎡 The wheel is spinning... who will be eliminated?' : '🎡 العجلة تدور... مين راح يطلع؟'), { note: false, gap: false });
  await sleep(3000);
  if (!isLive(session)) return;

  const losers = [removed.id];
  session.players = session.players.filter(p => p.id !== removed.id);
  session.eliminated.push(removed.id);
  let text = actorId && actorId !== removed.id
    ? (en ? `${E('out')} <@${actorId}> kicked <@${removed.id}> out of the round!` : `${E('out')} <@${actorId}> طرد <@${removed.id}> من الجولة!`)
    : (en ? `${E('out')} <@${removed.id}> has been eliminated from the round!` : `${E('out')} تم طرد <@${removed.id}> من الجولة!`);
  if (linkedId) {
    session.players = session.players.filter(p => p.id !== linkedId);
    session.eliminated.push(linkedId); losers.push(linkedId);
    text += en ? `\n🔗 The soul link activated — <@${linkedId}> died too!` : `\n🔗 تفعّل رابط الأرواح — <@${linkedId}> مات معه أيضاً!`;
  }
  delete session.soulLinks[removed.id];
  for (const k of Object.keys(session.soulLinks)) if (!session.players.some(p => p.id === k) || !session.players.some(p => p.id === session.soulLinks[k])) delete session.soulLinks[k];
  pushNote(session, text.split('\n')[0]);

  let components = [], offered = false;
  if (ownsRevive && session.players.length >= 1) {
    offered = true;
    components = [new ActionRowBuilder().addComponents(gbtn(`rl_revive_${removed.id}`, en ? 'Use Revival' : 'استخدام إعادة الإحياء', ButtonStyle.Success, 'rl_revive'))];
    text += en ? `\n\n<@${removed.id}> owns **Revival** — 15 seconds to use it.` : `\n\n<@${removed.id}> يملك **إعادة الإحياء** — عنده 15 ثانية يستخدمها.`;
  } else if (doubleKick && session.players.some(p => p.id === actorId) && session.players.length >= 2) {
    text += en ? `\n${E('kick')} **Double Kick** — the second kick is coming...` : `\n${E('kick')} **طرد مرتين** — الطرد الثاني بعد لحظات...`;
  } else {
    text += `\n\n${remainingLine(session, lang)}`;
  }
  const resMsg = await sendWheelResult(channel, session, lang, before, removed.id, 'out', text, { components, footer: (!offered && !doubleKick && session.players.length > 1) ? (en ? 'Next round in 7 seconds...' : 'الجولة الجاية بعد 7 ثواني...') : undefined });
  if (!isLive(session)) return;

  // 💖 إعادة الإحياء (أداة استخدام مرة) — الزر تحت صورة العجلة
  let revived = false;
  if (offered && resMsg) {
    revived = await new Promise(resolve => {
      const collector = resMsg.createMessageComponentCollector({ time: 15000, filter: i => i.customId === `rl_revive_${removed.id}` && i.user.id === removed.id });
      collector.on('collect', async i => {
        let res = false;
        try {
          await i.deferUpdate().catch(() => {});
          if (isLive(session) && consumeInventory(removed.id, 'ability_revive')) {
            session.reviveUsedThisMatch = true;
            session.players.push(removed);
            session.eliminated = session.eliminated.filter(id => id !== removed.id);
            res = true;
          }
        } catch (e) { console.error(e); }
        collector.stop('done'); resolve(res);
      });
      collector.on('end', () => resolve(false));
    });
    try {
      const emb = EmbedBuilder.from(resMsg.embeds[0]);
      if (revived) emb.setDescription(`${emb.data.description || ''}\n\n${E('rl_revive')} ${en ? `<@${removed.id}> is back in the round!` : `<@${removed.id}> رجع للجولة!`}`.slice(0, 4000));
      await resMsg.edit({ embeds: [emb], components: [] });
    } catch (e) { console.error(e); }
    if (revived) pushNote(session, en ? `${E('rl_revive')} <@${removed.id}> is back!` : `${E('rl_revive')} <@${removed.id}> رجع للجولة!`);
    if (!isLive(session)) return;
  }

  for (const lid of losers) {
    if (lid === removed.id && revived) continue;
    addPoints(lid, settings.rouletteLosePoints, 'roulette_out');
    getGameProfile(lid).losses += 1; saveDatabase(db);
    pushMatchHistory(lid, { result: 'eliminated', date: Date.now() });
  }

  // ✂️ الطرد الثاني (طرد مرتين) — يشتغل حتى لو باقي 3 لاعبين
  if (doubleKick && actorId && session.players.some(p => p.id === actorId)) {
    const others = session.players.filter(p => p.id !== actorId);
    if (others.length === 1) { // باقي واحد بس: يُطرد تلقائياً والفائز اللي طرد
      await sleep(4500); if (!isLive(session)) return;
      return resolveRouletteInner(channel, session, others[0].id, lang, actorId);
    }
    if (others.length > 1) {
      await sleep(4500); if (!isLive(session)) return;
      return sendTurnMessage(channel, session, lang, actorId, true);
    }
  }
  return runRouletteRound(channel, session, lang);
}
async function finishRouletteFinal(channel, session, lang) {
  const en = lang === 'en';
  const settings = session.settings;
  clearSessionTimers(session);
  session.turnToken += 1;
  let winner, loser = null, pointsWon;
  const two = session.players.length === 2 ? session.players.map(p => ({ ...p })) : null;
  if (session.players.length === 1) { winner = session.players[0]; pointsWon = settings.rouletteFinalBonus; }
  else if (two) { winner = two[Math.floor(Math.random() * 2)]; loser = two.find(p => p.id !== winner.id); pointsWon = settings.rouletteWinPoints + settings.rouletteFinalBonus; }
  else { await channel.send(embedMsg(en ? '❌ The match ended without a winner.' : '❌ انتهت المباراة بدون فائز.')).catch(() => {}); endRouletteSession(session); return; }

  addPoints(winner.id, pointsWon, two ? 'roulette_win' : 'roulette_final');
  if (loser) {
    addPoints(loser.id, settings.rouletteLosePoints, 'roulette_out');
    getGameProfile(loser.id).losses += 1;
    pushMatchHistory(loser.id, { result: 'eliminated', date: Date.now() });
  }
  const wp = getGameProfile(winner.id); wp.wins += 1; wp.matchWins += 1; saveDatabase(db);
  pushMatchHistory(winner.id, { result: 'win', date: Date.now() });
  const notes = [];
  for (const uid of new Set(session.allPlayers)) {
    const r = grantXp(uid, uid === winner.id ? 60 : 15);
    if (r.leveledUp) notes.push(en ? `🎉 <@${uid}> reached **Level ${r.level}** (+${r.bonus} points)` : `🎉 <@${uid}> وصل **المستوى ${r.level}** (+${r.bonus} نقطة)`);
  }
  const text = `${E('win')} ${en ? `<@${winner.id}> is the winner! Awarded **${pointsWon}** points.` : `<@${winner.id}> هو الفائز! حصل على **${pointsWon}** نقطة.`}\n\n` +
    (en ? 'The match is over. Thanks for playing!' : 'انتهت المباراة. شكراً للعب!') + (notes.length ? '\n\n' + notes.join('\n') : '');
  const title = `${E('levelup')} ${en ? 'Match Over' : 'انتهت المباراة'}`;
  if (two) {
    // 🎡 الدورة النهائية: صورة العجلة واقفة على الفائز وبالنص صورته (رسالة جديدة)
    await sendWheelResult(channel, session, lang, two, winner.id, 'win', (en ? `Final spin between <@${two[0].id}> and <@${two[1].id}>!\n\n` : `الدورة النهائية بين <@${two[0].id}> و <@${two[1].id}>!\n\n`) + text, { title });
  } else {
    await channel.send({ content: `<@${winner.id}>`, embeds: [new EmbedBuilder().setColor(EMBED_COLOR).setTitle(title).setDescription(text)], allowedMentions: { users: [winner.id] } }).catch(() => {});
  }
  endRouletteSession(session);
}

// ==========================================
// 🌟 PREMIUM + 🔥 STREAK
// ==========================================
function isGuildPremium(gid) {
  const e = db.premium && db.premium.guilds && db.premium.guilds[gid];
  return !!(e && (e.lifetime || (e.until && e.until > Date.now())));
}
function premiumStatusText(gid, lang) {
  const e = db.premium && db.premium.guilds && db.premium.guilds[gid];
  if (!isGuildPremium(gid)) return lang === 'en' ? 'Not active ❌' : 'غير مفعّل ❌';
  if (e.lifetime) return lang === 'en' ? 'Lifetime ♾️' : 'مدى الحياة ♾️';
  return (lang === 'en' ? 'Active until ' : 'مفعّل حتى ') + `<t:${Math.floor(e.until / 1000)}:D> (<t:${Math.floor(e.until / 1000)}:R>)`;
}
function addMonthsTs(ts, n) { const d = new Date(ts); d.setUTCMonth(d.getUTCMonth() + n); return d.getTime(); }
function grantPremium(gid, months) {
  if (!db.premium) db.premium = { guilds: {} };
  if (!db.premium.guilds) db.premium.guilds = {};
  const cur = db.premium.guilds[gid];
  if (months === 'life') db.premium.guilds[gid] = { lifetime: true, until: null, grantedAt: Date.now() };
  else if (!(cur && cur.lifetime)) {
    const base = cur && cur.until > Date.now() ? cur.until : Date.now();
    db.premium.guilds[gid] = { lifetime: false, until: addMonthsTs(base, months), grantedAt: Date.now() };
  }
  saveDatabase(db);
}
function revokePremium(gid) { if (db.premium && db.premium.guilds) delete db.premium.guilds[gid]; saveDatabase(db); }

function getPremiumEmbed(guild, settings) {
  const lang = getUserLang(guild.id);
  const on = isGuildPremium(guild.id);
  const desc = `**${lang === 'en' ? 'Status' : 'الحالة'}:** ${premiumStatusText(guild.id, lang)}\n\n` +
    (on
      ? `${E('streak')} **Streak:** ${settings.streakChannelId ? `<#${settings.streakChannelId}>` : (lang === 'en' ? 'no channel set' : 'ما تم تحديد روم')}\n` +
        `${E('premium')} ${lang === 'en' ? 'Send a sticker or a GIF in the streak channel once a day to keep your streak. It resets at midnight (Saudi time, UTC+3).' : 'ارسل ستيكر أو GIF بروم الستريك مرة باليوم عشان يزيد ستريكك. يتصفّر عند منتصف الليل بتوقيت السعودية (UTC+3).'}\n` +
        `🤖 ${lang === 'en' ? 'You can set a custom bot avatar for this server only.' : 'تقدر تغيّر صورة البوت لهذا السيرفر فقط.'}`
      : (lang === 'en' ? 'Premium unlocks: **Streak v1** and a **per-server bot avatar**.\nPremium is granted by the bot owner.' : 'البريميوم يفتح لك: **نظام الستريك v1** و **صورة بوت خاصة بسيرفرك**.\nالبريميوم يمنحه مالك البوت.'));
  return new EmbedBuilder().setTitle(`${E('premium')} Premium`).setDescription(desc).setColor(EMBED_COLOR);
}
function getPremiumComponents(guild) {
  const lang = getUserLang(guild.id);
  const S = ButtonStyle;
  const back = new ButtonBuilder().setCustomId('settings_back').setLabel('رجوع').setStyle(S.Secondary).setEmoji('⬅️');
  if (!isGuildPremium(guild.id)) return [promoRow(lang), new ActionRowBuilder().addComponents(back)];
  return [
    new ActionRowBuilder().addComponents(
      gbtn('pm_streakchannel', lang === 'en' ? 'Streak channel' : 'روم الستريك', S.Primary, 'streak'),
      gbtn('pm_streakclear', lang === 'en' ? 'Clear streak channel' : 'إلغاء روم الستريك', S.Secondary, 'out'),
      new ButtonBuilder().setCustomId('pm_avatar').setLabel(lang === 'en' ? 'Set bot avatar' : 'صورة البوت').setStyle(S.Primary).setEmoji('🤖'),
      new ButtonBuilder().setCustomId('pm_avatar_reset').setLabel(lang === 'en' ? 'Reset avatar' : 'إرجاع الصورة الأصلية').setStyle(S.Secondary).setEmoji('♻️')
    ),
    new ActionRowBuilder().addComponents(back)
  ];
}
async function setGuildBotAvatar(guildId, url) {
  let dataUri = null;
  if (url) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 12000);
    let resp;
    try { resp = await fetch(url, { signal: ctrl.signal }); } finally { clearTimeout(timer); }
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    const ct = (resp.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    if (!/^image\/(png|jpeg|gif|webp)$/.test(ct)) throw new Error('bad content-type ' + ct);
    const buf = Buffer.from(await resp.arrayBuffer());
    if (buf.length > 8 * 1024 * 1024) throw new Error('too large');
    dataUri = `data:${ct};base64,${buf.toString('base64')}`;
  }
  await client.rest.patch(Routes.guildMember(guildId, '@me'), { body: { avatar: dataUri } });
}
async function handlePremiumComponent(interaction, settings) {
  const cid = interaction.customId;
  const guild = interaction.guild;
  const view = (notice) => ({ embeds: [getPremiumEmbed(guild, settings)], components: getPremiumComponents(guild), ...(notice ? {} : {}) });
  if (cid === 'pm_back') { await interaction.update(view()); return true; }
  if (!isGuildPremium(guild.id)) { await interaction.update(view()); return true; }
  if (cid === 'pm_streakchannel') {
    await interaction.update({ ...embedMsg(bi(interaction, 'اختر روم الستريك:', 'Choose the streak channel:')), components: [new ActionRowBuilder().addComponents(new ChannelSelectMenuBuilder().setCustomId('pm_streakchannel_pick').setPlaceholder('اختر الروم').setChannelTypes(ChannelType.GuildText)), backRow('pm_back')] });
    return true;
  }
  if (cid === 'pm_streakchannel_pick') {
    settings.streakChannelId = interaction.values[0]; saveDatabase(db);
    await interaction.update(view()); return true;
  }
  if (cid === 'pm_streakclear') { settings.streakChannelId = null; saveDatabase(db); await interaction.update(view()); return true; }
  if (cid === 'pm_avatar') {
    const modal = new ModalBuilder().setCustomId('modal_pm_avatar').setTitle('صورة البوت لهذا السيرفر');
    modal.addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('input_url').setLabel('رابط مباشر للصورة (PNG/JPG/GIF)').setStyle(TextInputStyle.Short).setRequired(true)));
    await interaction.showModal(modal); return true;
  }
  if (cid === 'pm_avatar_reset') {
    await interaction.deferUpdate();
    try { await setGuildBotAvatar(guild.id, null); await interaction.editReply({ ...embedMsg(bi(interaction, '✅ رجعت صورة البوت الأصلية.', '✅ Bot avatar reset.')), components: [backRow('pm_back')] }); }
    catch (e) { console.error('فشل إرجاع صورة البوت:', e); await interaction.editReply({ ...embedMsg(bi(interaction, '❌ تعذر التغيير (تأكد من صلاحيات البوت).', '❌ Could not change it (check bot permissions).')), components: [backRow('pm_back')] }); }
    return true;
  }
  return false;
}
async function handlePremiumModal(interaction) {
  if (interaction.customId !== 'modal_pm_avatar') return false;
  if (!interaction.member.permissions.has(PermissionFlagsBits.Administrator)) { await interaction.reply({ ...embedMsg('❌ للمسؤولين فقط.'), ephemeral: true }); return true; }
  if (!isGuildPremium(interaction.guild.id)) { await interaction.reply({ ...embedMsg('❌ السيرفر غير مفعّل عليه بريميوم.'), ephemeral: true }); return true; }
  const url = interaction.fields.getTextInputValue('input_url').trim();
  if (!isValidImageUrl(url)) { await interaction.reply({ ...embedMsg(bi(interaction, '❌ رابط غير صالح.', '❌ Invalid link.')), ephemeral: true }); return true; }
  await interaction.deferUpdate();
  try {
    await setGuildBotAvatar(interaction.guild.id, url);
    await interaction.editReply({ ...embedMsg(bi(interaction, '✅ تم تغيير صورة البوت لهذا السيرفر فقط.', '✅ Bot avatar changed for this server only.')), components: [backRow('pm_back')] });
  } catch (e) {
    console.error('فشل تغيير صورة البوت:', e);
    await interaction.editReply({ ...embedMsg(bi(interaction, '❌ فشل تغيير الصورة — تأكد أن الرابط صورة مباشرة (أقل من 8MB) وأن للبوت الصلاحيات، وديسكورد يحدد عدد مرات التغيير.', "❌ Failed — make sure it's a direct image link (<8MB), the bot has permissions, and mind Discord's rate limit.")), components: [backRow('pm_back')] });
  }
  return true;
}

// ---- الستريك ----
function ksaDayKey(ts = Date.now()) { return new Date(ts + 3 * 3600 * 1000).toISOString().slice(0, 10); }
function isStreakMessage(m) {
  if (m.stickers && m.stickers.size > 0) return true;
  if (m.attachments && m.attachments.some(a => (a.contentType || '').includes('gif') || /\.gif(\?|$)/i.test(a.url || a.name || ''))) return true;
  if (m.embeds && m.embeds.some(e => e.type === 'gifv' || (e.url && /(tenor\.com|giphy\.com|\.gif)/i.test(e.url)))) return true;
  return /(tenor\.com\/view|giphy\.com\/(gifs|media)|\.gif(\?|\s|$))/i.test(m.content || '');
}
function effectiveStreak(u) {
  if (!u || !u.last) return 0;
  return (u.last === ksaDayKey() || u.last === ksaDayKey(Date.now() - 86400000)) ? u.count : 0;
}

// 🎁 جوائز الستريك: يوم 10 / 25 / 50 / 75 / 100. بعضها يحدده مالك البوت من owner-server.
// الجائزة اللي تحتاج إعداد من المالك (صورة/أيقونة/لقب) تتأجل لين يضبطها، وبعدها تنمنح تلقائياً بأول نشاط للعضو.
function streakCfg() { if (!db.streakCfg) db.streakCfg = {}; return db.streakCfg; }
function streakItemName(id, fallback) { const it = id ? getShopItem(id) : null; return it ? it.name : fallback; }
function streakRewardList() {
  const cfg = streakCfg();
  const has25 = !!getShopItem('streak_banner_25');
  const has50i = !!getShopItem('streak_icon_50');
  const t50 = cfg.title50 && cfg.title50.itemId && getShopItem(cfg.title50.itemId) ? cfg.title50.itemId : null;
  return [
    { day: 10, points: 100, give: [], ready: true, ar: '100 نقطة', en: '100 points' },
    { day: 25, points: 300, give: ['streak_banner_25'], ready: has25,
      ar: `300 نقطة + صورة البروفايل «${streakItemName('streak_banner_25', 'يحددها المالك')}»`, en: `300 points + profile picture "${streakItemName('streak_banner_25', 'set by the owner')}"` },
    { day: 50, points: 500, give: ['streak_icon_50', t50], ready: has50i && !!t50,
      ar: `500 نقطة + أيقونة «${streakItemName('streak_icon_50', 'يحددها المالك')}» + لقب محدود «${streakItemName(t50, 'يحدده المالك')}»`,
      en: `500 points + icon "${streakItemName('streak_icon_50', 'set by the owner')}" + limited title "${streakItemName(t50, 'set by the owner')}"` },
    { day: 75, points: 0, give: ['badge_streak_violet'], ready: true, ar: 'بادج بنفسجي للبروفايل 🟣', en: 'a violet profile badge 🟣' },
    { day: 100, points: 2000, give: ['title_streak100'], items: { shield: 2, double_kick: 1, ability_revive: 1 }, ready: true,
      ar: '2000 نقطة + اللقب الأسطوري «لهب البنفسج» + درعين + طرد مرتين + إعادة إحياء', en: '2000 points + the legendary title "Violet Flame" + 2 shields + a Double Kick + a Revival' }
  ];
}
function grantOwnedItem(userId, itemId) {
  const it = itemId ? getShopItem(itemId) : null;
  if (!it) return;
  const p = getGameProfile(userId);
  const key = ownedListKey(it.type);
  if (it.type === 'consumable' || key === 'abilities') { addInventory(userId, itemId, 1); return; }
  if (!p.owned[key].includes(itemId)) p.owned[key].push(itemId);
}
function claimStreakRewards(userId, count) {
  const p = getGameProfile(userId);
  if (!Array.isArray(p.streakClaimedV2)) p.streakClaimedV2 = [];
  const got = [];
  for (const r of streakRewardList()) {
    if (count < r.day || p.streakClaimedV2.includes(r.day) || !r.ready) continue;
    p.streakClaimedV2.push(r.day);
    if (r.points) addPoints(userId, r.points, 'streak_reward');
    for (const id of r.give) grantOwnedItem(userId, id);
    for (const [id, q] of Object.entries(r.items || {})) addInventory(userId, id, q);
    got.push(r);
  }
  if (got.length) saveDatabase(db);
  return got;
}
function nextStreakReward(count) { return streakRewardList().find(r => r.day > count) || null; }

// ---------- رسم بطاقة الستريك ----------
function seededRng(seed) {
  let a = (seed >>> 0) || 1;
  return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
function star4(ctx, x, y, r) {
  ctx.beginPath();
  for (let i = 0; i < 8; i++) { const a = (Math.PI / 4) * i - Math.PI / 2, rr = i % 2 === 0 ? r : r * 0.22; ctx[i ? 'lineTo' : 'moveTo'](x + Math.cos(a) * rr, y + Math.sin(a) * rr); }
  ctx.closePath();
}
function flamePath(ctx, w, h) {
  const c = (x1, y1, x2, y2, x3, y3) => ctx.bezierCurveTo(x1 * w, y1 * h, x2 * w, y2 * h, x3 * w, y3 * h);
  ctx.beginPath(); ctx.moveTo(0, 0);
  c(-0.46, 0, -0.74, -0.18, -0.58, -0.44);
  c(-0.50, -0.54, -0.56, -0.68, -0.42, -0.80);
  c(-0.40, -0.66, -0.28, -0.62, -0.22, -0.52);
  c(-0.12, -0.68, -0.08, -0.86, 0.06, -1.0);
  c(0.12, -0.82, 0.24, -0.74, 0.26, -0.58);
  c(0.38, -0.66, 0.50, -0.58, 0.48, -0.42);
  c(0.70, -0.22, 0.52, 0, 0, 0);
  ctx.closePath();
}
// 🔥 شعار: نار بنفسجية بلمعة زرقاء وشرارات
function drawPurpleFlame(ctx, cx, baseY, h, seed, sparks = true) {
  const w = h * 0.72;
  ctx.save(); ctx.translate(cx, baseY);
  // وهج أزرق خلف النار
  const glow = ctx.createRadialGradient(0, -h * 0.4, h * 0.05, 0, -h * 0.4, h * 0.85);
  glow.addColorStop(0, 'rgba(90,150,255,0.35)'); glow.addColorStop(0.5, 'rgba(120,50,255,0.18)'); glow.addColorStop(1, 'rgba(120,50,255,0)');
  ctx.fillStyle = glow; ctx.fillRect(-h, -h * 1.4, h * 2, h * 1.6);
  // الجسم البنفسجي
  const g1 = ctx.createLinearGradient(0, 0, 0, -h);
  g1.addColorStop(0, '#2b0b86'); g1.addColorStop(0.45, '#7b2cff'); g1.addColorStop(0.8, '#b86bff'); g1.addColorStop(1, '#ecc6ff');
  ctx.shadowColor = 'rgba(70,160,255,0.95)'; ctx.shadowBlur = h * 0.18;
  flamePath(ctx, w, h); ctx.fillStyle = g1; ctx.fill();
  ctx.shadowBlur = 0; ctx.shadowColor = 'transparent';
  ctx.lineWidth = Math.max(2, h * 0.014); ctx.strokeStyle = 'rgba(130,200,255,0.9)'; flamePath(ctx, w, h); ctx.stroke();
  // القلب الأزرق المضيء
  ctx.save(); ctx.translate(0, -h * 0.03); ctx.scale(0.56, 0.6);
  const g2 = ctx.createLinearGradient(0, 0, 0, -h);
  g2.addColorStop(0, '#1d4fff'); g2.addColorStop(0.5, '#4cc9ff'); g2.addColorStop(1, '#f4fcff');
  ctx.shadowColor = 'rgba(120,220,255,0.95)'; ctx.shadowBlur = h * 0.14;
  flamePath(ctx, w, h); ctx.fillStyle = g2; ctx.fill();
  ctx.restore(); ctx.shadowBlur = 0; ctx.shadowColor = 'transparent';
  // لمعة زرقاء على الجنب
  ctx.save(); ctx.rotate(-0.22); ctx.beginPath(); ctx.ellipse(-0.3 * w, -0.5 * h, 0.05 * w, 0.2 * h, 0, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(160,220,255,0.38)'; ctx.fill(); ctx.restore();
  ctx.fillStyle = '#e8f6ff'; ctx.shadowColor = '#4cc9ff'; ctx.shadowBlur = h * 0.08; star4(ctx, 0.14 * w, -0.74 * h, h * 0.075); ctx.fill();
  // الشرارات
  if (sparks) {
    const rnd = seededRng(seed);
    const cols = ['#ffffff', '#9ad4ff', '#c77dff', '#8a6bff', '#4cc9ff'];
    for (let i = 0; i < 26; i++) {
      const x = (rnd() - 0.5) * w * 1.9, y = -h * (0.05 + rnd() * 1.3), r = 1.4 + rnd() * 3.6, c = cols[Math.floor(rnd() * cols.length)];
      ctx.fillStyle = c; ctx.shadowColor = c; ctx.shadowBlur = 8;
      if (rnd() < 0.3) { star4(ctx, x, y, r * 2.2); ctx.fill(); }
      else { ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill(); }
    }
    ctx.shadowBlur = 0; ctx.lineCap = 'round';
    for (let i = 0; i < 7; i++) { // خطوط شرار صاعدة
      const x = (rnd() - 0.5) * w * 1.4, y = -h * (0.4 + rnd() * 0.9), l = 8 + rnd() * 14;
      ctx.strokeStyle = 'rgba(190,150,255,0.8)'; ctx.lineWidth = 1.6; ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + (rnd() - 0.5) * 6, y - l); ctx.stroke();
    }
  }
  ctx.restore();
}
async function generateStreakCard(info) {
  // info: { name, avatarUrl, count, best, total, rank, hist:Set, claimed:[days] }
  const W = 1000, H = 520, SC = 0.72; // بنر مصغّر
  const canvas = createCanvas(Math.round(W * SC), Math.round(H * SC)); const ctx = canvas.getContext('2d'); ctx.scale(SC, SC);
  rrect(ctx, 0, 0, W, H, 30); ctx.save(); ctx.clip();
  ctx.fillStyle = '#07040f'; ctx.fillRect(0, 0, W, H);
  // صورة الخلفية (يحددها مالك البوت من owner-server)
  if (db.streakImage) {
    try {
      const bg = await getAvatarImage(db.streakImage);
      if (bg) { const sc = Math.max(W / bg.width, H / bg.height); const bw = bg.width * sc, bh = bg.height * sc; ctx.drawImage(bg, (W - bw) / 2, (H - bh) / 2, bw, bh); }
    } catch (e) { /* نتجاهل ونرسم الخلفية العادية */ }
  }
  const ov = ctx.createLinearGradient(0, 0, W, H);
  ov.addColorStop(0, db.streakImage ? 'rgba(8,4,20,0.82)' : 'rgba(26,8,60,0.95)'); ov.addColorStop(1, db.streakImage ? 'rgba(30,10,70,0.7)' : 'rgba(7,4,15,1)');
  ctx.fillStyle = ov; ctx.fillRect(0, 0, W, H);
  const vg = ctx.createRadialGradient(190, 330, 20, 190, 330, 420); vg.addColorStop(0, 'rgba(110,60,255,0.30)'); vg.addColorStop(1, 'rgba(110,60,255,0)');
  ctx.fillStyle = vg; ctx.fillRect(0, 0, W, H);
  ctx.restore();
  // إطار متوهج
  const bd = ctx.createLinearGradient(0, 0, W, H); bd.addColorStop(0, '#7b2cff'); bd.addColorStop(0.5, '#4cc9ff'); bd.addColorStop(1, '#b86bff');
  ctx.save(); ctx.shadowColor = '#7b2cff'; ctx.shadowBlur = 18; ctx.lineWidth = 4; ctx.strokeStyle = bd; rrect(ctx, 3, 3, W - 6, H - 6, 28); ctx.stroke(); ctx.restore();

  // الشعار + عدد الأيام
  let seed = 7; for (const ch of String(info.name)) seed = (seed * 31 + ch.charCodeAt(0)) >>> 0;
  drawPurpleFlame(ctx, 175, 335, 250, seed + info.count);
  ctx.textBaseline = 'alphabetic'; ctx.textAlign = 'left';
  const numStr = String(info.count);
  ctx.font = `bold 150px ${CARD_FONT}`;
  const nw = ctx.measureText(numStr).width;
  ctx.save(); ctx.shadowColor = '#7b2cff'; ctx.shadowBlur = 28; ctx.fillStyle = '#ffffff'; ctx.fillText(numStr, 335, 200); ctx.restore();
  ctx.font = `bold 40px ${CARD_FONT}`; ctx.fillStyle = '#c9a4ff'; ctx.fillText('DAY STREAK', 335 + nw + 18, 200);
  ctx.font = `bold 20px ${CARD_FONT}`; ctx.fillStyle = '#8fd2ff';
  const nr = nextStreakReward(info.count);
  ctx.fillText(nr ? `NEXT REWARD IN ${nr.day - info.count} DAY${nr.day - info.count === 1 ? '' : 'S'}  •  DAY ${nr.day}` : 'ALL REWARDS COMPLETED  ★', 338, 238);

  // الصورة الشخصية + الاسم
  const ax = 928, ay = 62, ar = 38;
  ctx.save(); ctx.shadowColor = '#4cc9ff'; ctx.shadowBlur = 16; ctx.beginPath(); ctx.arc(ax, ay, ar + 4, 0, Math.PI * 2); ctx.fillStyle = bd; ctx.fill(); ctx.restore();
  let av = null; try { av = await getAvatarImage(info.avatarUrl); } catch (e) { av = null; }
  ctx.save(); ctx.beginPath(); ctx.arc(ax, ay, ar, 0, Math.PI * 2); ctx.clip();
  if (av) ctx.drawImage(av, ax - ar, ay - ar, ar * 2, ar * 2); else { ctx.fillStyle = '#2a1260'; ctx.fillRect(ax - ar, ay - ar, ar * 2, ar * 2); }
  ctx.restore();
  const nm = safeName(info.name, 'Player');
  let fs = 26; ctx.font = `bold ${fs}px ${CARD_FONT}`;
  while (ctx.measureText(nm).width > 330 && fs > 14) { fs -= 2; ctx.font = `bold ${fs}px ${CARD_FONT}`; }
  ctx.textAlign = 'right'; ctx.fillStyle = '#ffffff'; ctx.fillText(nm, ax - ar - 18, ay + 9);

  // مربعات الإحصائيات
  const tiles = [['BEST', String(info.best)], ['TOTAL DAYS', String(info.total)], ['RANK', info.rank ? `#${info.rank}` : '-'], ['REWARDS', `${info.claimed.length}/5`]];
  tiles.forEach(([lab, val], i) => {
    const x = 335 + i * 160, y = 262, w = 148, h = 84;
    rrect(ctx, x, y, w, h, 16); ctx.fillStyle = 'rgba(20,10,50,0.78)'; ctx.fill(); ctx.lineWidth = 2; ctx.strokeStyle = 'rgba(140,100,255,0.65)'; ctx.stroke();
    ctx.textAlign = 'center'; ctx.fillStyle = '#9d86d6'; ctx.font = `bold 16px ${CARD_FONT}`; ctx.fillText(lab, x + w / 2, y + 28);
    ctx.fillStyle = '#ffffff'; ctx.font = `bold 38px ${CARD_FONT}`; ctx.fillText(val, x + w / 2, y + 68);
  });

  // آخر 21 يوم
  ctx.textAlign = 'left'; ctx.fillStyle = '#9d86d6'; ctx.font = `bold 16px ${CARD_FONT}`; ctx.fillText('LAST 21 DAYS', 60, 378);
  for (let i = 0; i < 21; i++) {
    const daysAgo = 20 - i, key = ksaDayKey(Date.now() - daysAgo * 86400000), on = info.hist.has(key);
    const x = 78 + i * 42, y = 408;
    if (on) { ctx.save(); ctx.translate(0, 0); drawPurpleFlame(ctx, x, y + 15, 32, i + 3, false); ctx.restore(); }
    else { ctx.beginPath(); ctx.arc(x, y, 8, 0, Math.PI * 2); ctx.fillStyle = 'rgba(80,60,130,0.45)'; ctx.fill(); }
    if (daysAgo === 0) { ctx.beginPath(); ctx.arc(x, y, 19, 0, Math.PI * 2); ctx.lineWidth = 2; ctx.strokeStyle = '#4cc9ff'; ctx.stroke(); }
  }
  // شريط الجوائز حتى 100 يوم
  const bx0 = 80, bx1 = 920, by = 478;
  ctx.lineCap = 'round'; ctx.lineWidth = 10; ctx.strokeStyle = 'rgba(80,60,130,0.55)'; ctx.beginPath(); ctx.moveTo(bx0, by); ctx.lineTo(bx1, by); ctx.stroke();
  const frac = Math.min(1, info.count / 100);
  if (frac > 0) { const pg = ctx.createLinearGradient(bx0, 0, bx1, 0); pg.addColorStop(0, '#7b2cff'); pg.addColorStop(1, '#4cc9ff'); ctx.strokeStyle = pg; ctx.shadowColor = '#7b2cff'; ctx.shadowBlur = 10; ctx.beginPath(); ctx.moveTo(bx0, by); ctx.lineTo(bx0 + (bx1 - bx0) * frac, by); ctx.stroke(); ctx.shadowBlur = 0; }
  for (const r of streakRewardList()) {
    const x = bx0 + (bx1 - bx0) * (r.day / 100), done = info.count >= r.day;
    ctx.beginPath(); ctx.arc(x, by, 17, 0, Math.PI * 2);
    if (done) { ctx.save(); ctx.shadowColor = '#7b2cff'; ctx.shadowBlur = 14; const ng = ctx.createLinearGradient(x - 17, by - 17, x + 17, by + 17); ng.addColorStop(0, '#9b5cff'); ng.addColorStop(1, '#4cc9ff'); ctx.fillStyle = ng; ctx.fill(); ctx.restore(); }
    else { ctx.fillStyle = '#150a30'; ctx.fill(); ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(140,100,255,0.7)'; ctx.stroke(); }
    ctx.textAlign = 'center'; ctx.font = `bold 15px ${CARD_FONT}`; ctx.fillStyle = done ? '#ffffff' : '#b8a6e8'; ctx.fillText(String(r.day), x, by + 5);
  }
  return canvas.toBuffer('image/png');
}

function streakHistFor(u) { return new Set((u && Array.isArray(u.hist)) ? u.hist : []); }
async function streakCardFor(guild, userObj, displayName, u) {
  const g = (db.streaks && db.streaks[guild.id]) || {};
  const count = effectiveStreak(u);
  const ranked = Object.entries(g).map(([id, x]) => [id, effectiveStreak(x)]).filter(([, c]) => c > 0).sort((a, b) => b[1] - a[1]);
  const ri = ranked.findIndex(([id]) => id === userObj.id);
  const p = getGameProfile(userObj.id);
  return generateStreakCard({
    name: displayName, avatarUrl: userObj.displayAvatarURL({ extension: 'png', size: 256, forceStatic: true }),
    count, best: (u && u.best) || 0, total: (u && u.total) || (u && u.hist ? u.hist.length : 0) || 0,
    rank: ri >= 0 ? ri + 1 : null, hist: streakHistFor(u), claimed: p.streakClaimedV2 || []
  });
}
function rewardsText(lang, count) {
  return streakRewardList().map(r => `${count >= r.day ? (r.ready ? '✅' : '⏳') : '🔒'} **${r.day}** ${lang === 'en' ? 'days' : 'يوم'} — ${lang === 'en' ? r.en : r.ar}`).join('\n');
}
async function recordStreak(message) {
  const gid = message.guild.id;
  if (!db.streaks) db.streaks = {};
  if (!db.streaks[gid]) db.streaks[gid] = {};
  const u = db.streaks[gid][message.author.id] || (db.streaks[gid][message.author.id] = { count: 0, best: 0, last: null, total: 0, hist: [] });
  const today = ksaDayKey();
  if (u.last === today) return;
  u.count = u.last === ksaDayKey(Date.now() - 86400000) ? u.count + 1 : 1;
  u.last = today; u.best = Math.max(u.best || 0, u.count);
  u.total = (u.total || 0) + 1;
  if (!Array.isArray(u.hist)) u.hist = [];
  u.hist.push(today); if (u.hist.length > 120) u.hist = u.hist.slice(-120);
  saveDatabase(db);
  const lang = getUserLang(gid);
  const en = lang === 'en';
  const got = claimStreakRewards(message.author.id, u.count);
  const member = message.member || await message.guild.members.fetch(message.author.id).catch(() => null);
  const name = (member && member.displayName) || message.author.username;
  let text = en ? `<@${message.author.id}> is on a **${u.count}-day** streak! (best: ${u.best})` : `<@${message.author.id}> ستريكه **${u.count}** يوم! (أعلى ستريك: ${u.best})`;
  if (got.length) text += '\n\n' + got.map(r => `🎁 ${en ? `**Reward unlocked (day ${r.day}):** ${r.en}` : `**جائزة جديدة (يوم ${r.day}):** ${r.ar}`}`).join('\n');
  const nr = nextStreakReward(u.count);
  text += nr ? (en ? `\n\n⏭️ Next reward at day **${nr.day}**.` : `\n\n⏭️ الجائزة الجاية عند اليوم **${nr.day}**.`) : (en ? '\n\n🏆 You completed every streak reward!' : '\n\n🏆 كملت كل جوائز الستريك!');
  let msg;
  try {
    const buf = await streakCardFor(message.guild, member ? member.user : message.author, name, u);
    msg = embedWithImage(text, { title: `${E('streak')} ${en ? 'Streak' : 'ستريك'}`, footer: en ? 'Resets at midnight (Saudi time)' : 'يتصفّر منتصف الليل بتوقيت السعودية' }, buf, 'streak.png');
  } catch (e) {
    console.error('فشل رسم بطاقة الستريك:', e);
    msg = embedMsg(text, { title: `${E('streak')} ${en ? 'Streak' : 'ستريك'}` });
  }
  await message.reply({ ...msg, allowedMentions: { repliedUser: false } }).catch(() => {});
}
function streakBoardRow(lang, active) {
  const en = lang === 'en';
  const mk = (id, ar, e, emoji) => new ButtonBuilder().setCustomId(id).setLabel(en ? e : ar).setStyle(active === id ? ButtonStyle.Primary : ButtonStyle.Secondary).setEmoji(emoji);
  return new ActionRowBuilder().addComponents(
    mk('st_board:current', 'الستريك الحالي', 'Current', '🔥'), mk('st_board:best', 'أعلى ستريك', 'Highest', '🏆'),
    mk('st_board:total', 'إجمالي الأيام', 'Total days', '📅'), mk('st_card', 'بطاقتي', 'My card', '🪪'));
}
// 🏆 ليدربورد الستريك: الحالي / الأعلى على الإطلاق / إجمالي الأيام
function buildStreakBoard(guild, type, lang) {
  const en = lang === 'en';
  const g = (db.streaks && db.streaks[guild.id]) || {};
  const val = (u) => type === 'best' ? (u.best || 0) : type === 'total' ? (u.total || (u.hist ? u.hist.length : 0) || 0) : effectiveStreak(u);
  const rows = Object.entries(g).map(([uid, u]) => [uid, val(u)]).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]).slice(0, 15);
  const medals = ['🥇', '🥈', '🥉'];
  const lines = rows.map(([uid, v], i) => `${medals[i] || `**#${i + 1}**`} <@${uid}> — ${E('streak')} **${v}**`).join('\n') || (en ? '_No data yet_' : '_ما فيه بيانات للحين_');
  const title = { current: en ? 'Current streaks' : 'أعلى الستريكات الحالية', best: en ? 'Highest streaks ever' : 'أعلى ستريك على الإطلاق', total: en ? 'Most active days' : 'أكثر أيام نشاط' }[type] || '';
  const m = embedMsg(lines, { title: `🏆 ${title}` });
  m.components = [streakBoardRow(lang, `st_board:${type}`)];
  return m;
}
async function buildStreakMessage(guild, member, lang) {
  const en = lang === 'en';
  if (!isGuildPremium(guild.id)) return embedMsg(en ? '🌟 Streak is a Premium feature — this server is not premium.' : '🌟 الستريك ميزة بريميوم — هذا السيرفر غير مفعّل عليه بريميوم.');
  const g = (db.streaks && db.streaks[guild.id]) || {};
  const userId = member.id;
  const mine = effectiveStreak(g[userId]);
  // جوائز تأجّلت لأن المالك ما كان ضابطها: تنمنح هنا إذا صارت جاهزة
  const got = mine > 0 ? claimStreakRewards(userId, mine) : [];
  let text = `${en ? '**Rewards:**' : '**الجوائز:**'}\n${rewardsText(lang, mine)}`;
  if (got.length) text = got.map(r => `🎁 ${en ? `**Reward unlocked (day ${r.day}):** ${r.en}` : `**جائزة جديدة (يوم ${r.day}):** ${r.ar}`}`).join('\n') + '\n\n' + text;
  text += en ? '\n\n⏳ = waiting for the owner to set it up' : '\n\n⏳ = بانتظار ضبط المالك لها';
  try {
    const buf = await streakCardFor(guild, member.user || member, member.displayName || member.username, g[userId]);
    const m = embedWithImage(text, { title: `${E('streak')} ${en ? 'Streak' : 'الستريك'}` }, buf, 'streak.png');
    m.components = [streakBoardRow(lang, 'st_card')];
    return m;
  } catch (e) {
    console.error('فشل رسم بطاقة الستريك:', e);
    const m = embedMsg((en ? `Your streak: **${mine}** day(s)\n\n` : `ستريكك: **${mine}** يوم\n\n`) + text, { title: `${E('streak')} ${en ? 'Streaks' : 'الستريك'}` });
    m.components = [streakBoardRow(lang, 'st_card')];
    return m;
  }
}
async function ownerServersView() {
  const guilds = [...client.guilds.cache.values()];
  if (!guilds.length) return { ...embedMsg('ℹ️ البوت مو موجود بأي سيرفر حالياً.'), components: [ownerHomeRow()] };
  const shown = guilds.slice(0, 25);
  const embeds = [];
  for (let i = 0; i < shown.length; i += 10) {
    const embed = new EmbedBuilder().setTitle(`🌐 سيرفرات البوت (${guilds.length})`).setColor(EMBED_COLOR);
    for (const guild of shown.slice(i, i + 10)) {
      let inviteUrl = 'تعذر إنشاء رابط دعوة';
      try {
        const me = guild.members.me;
        const ch = guild.channels.cache.find(c => c.type === ChannelType.GuildText && me && c.permissionsFor(me)?.has(PermissionFlagsBits.CreateInstantInvite));
        if (ch) inviteUrl = (await ch.createInvite({ maxAge: 0, maxUses: 0 })).url;
      } catch (e) { console.error(`فشل إنشاء دعوة للسيرفر ${guild.name}:`, e); }
      embed.addFields({ name: `${guild.name} (${guild.memberCount} عضو) ${isGuildPremium(guild.id) ? '🌟' : ''}`.slice(0, 256), value: `آيدي: \`${guild.id}\`\nرابط: ${inviteUrl}` });
    }
    embeds.push(embed);
  }
  if (guilds.length > 25) embeds[embeds.length - 1].setFooter({ text: `يعرض أول 25 من ${guilds.length} سيرفر` });
  const leaveRow = new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId('owner_leave_select').setPlaceholder('🚪 اختر سيرفر يطلع منه البوت')
    .addOptions(shown.map(g => ({ label: g.name.slice(0, 100), value: g.id, description: `${g.memberCount} عضو`.slice(0, 100) }))));
  return { embeds, components: [leaveRow, ownerHomeRow()], files: [] };
}
function ownerPremiumListView() {
  const guilds = [...client.guilds.cache.values()].slice(0, 25);
  const embed = new EmbedBuilder().setTitle('🌟 إدارة البريميوم').setColor(EMBED_COLOR)
    .setDescription('اختر سيرفر من القائمة، أو اضغط "بالآيدي" لإدخال آيدي سيرفر.\n\n' + (guilds.map(g => `• **${g.name}** — ${premiumStatusText(g.id, 'ar')}`).join('\n') || '—').slice(0, 3500));
  const comps = [];
  if (guilds.length) comps.push(new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId('ow_pm_guild').setPlaceholder('اختر السيرفر')
    .addOptions(guilds.map(g => ({ label: g.name.slice(0, 100), value: g.id, description: (isGuildPremium(g.id) ? 'بريميوم ✅' : 'عادي').slice(0, 100) })))));
  comps.push(new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('ow_pm_byid').setLabel('بالآيدي').setStyle(ButtonStyle.Primary).setEmoji('🔢'), ownerHomeBtn()));
  return { embeds: [embed], components: comps, files: [] };
}
function ownerPremiumGuildView(gid, notice) {
  const g = client.guilds.cache.get(gid);
  const embed = new EmbedBuilder().setTitle(`🌟 ${g ? g.name : gid}`).setColor(EMBED_COLOR)
    .setDescription((notice ? notice + '\n\n' : '') + `**الآيدي:** \`${gid}\`${g ? '' : '\n⚠️ البوت ليس بهذا السيرفر حالياً (يمكن منحه مسبقاً).'}\n**الحالة:** ${premiumStatusText(gid, 'ar')}\n\nاختر المدة لإضافتها (تُضاف فوق المدة الحالية):`);
  const sel = new StringSelectMenuBuilder().setCustomId(`ow_pm_dur:${gid}`).setPlaceholder('اختر المدة').addOptions(
    ...[1, 2, 3, 6, 9, 12].map(m => ({ label: m === 12 ? 'سنة كاملة (12 شهر)' : `${m} ${m <= 2 ? 'شهر' : 'أشهر'}`, value: `m${m}`, emoji: '🗓️' })),
    { label: 'مدى الحياة', value: 'life', emoji: '♾️' }, { label: 'إلغاء البريميوم', value: 'revoke', emoji: '🚫' });
  return { embeds: [embed], components: [new ActionRowBuilder().addComponents(sel), new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('ow_premium').setLabel('رجوع').setStyle(ButtonStyle.Secondary).setEmoji('⬅️'), ownerHomeBtn())], files: [] };
}
function ownerPickUserView(action) {
  const titles = { badges: '🏅 الشارات الخاصة', grant: '🎁 منح/سحب عناصر', points: '💰 النقاط' };
  const embed = new EmbedBuilder().setTitle(titles[action]).setColor(EMBED_COLOR).setDescription('اختر الشخص من القائمة، أو اضغط "بالآيدي".');
  return { embeds: [embed], components: [
    new ActionRowBuilder().addComponents(new UserSelectMenuBuilder().setCustomId(`ow_user:${action}`).setPlaceholder('اختر الشخص')),
    new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`ow_userid:${action}`).setLabel('بالآيدي').setStyle(ButtonStyle.Primary).setEmoji('🔢'), ownerHomeBtn())
  ], files: [] };
}
function ownerPickBack(action) { return new ButtonBuilder().setCustomId(`ow_${action}`).setLabel('شخص آخر').setStyle(ButtonStyle.Secondary).setEmoji('⬅️'); }
function ownerUserView(action, uid, notice) {
  const p = getGameProfile(uid);
  const head = (notice ? notice + '\n\n' : '') + `**الشخص:** <@${uid}>\n`;
  if (action === 'badges') {
    const embed = new EmbedBuilder().setTitle('🏅 الشارات الخاصة').setColor(EMBED_COLOR)
      .setDescription(head + 'اختر شارة للتبديل (✅ = عنده، الاختيار يضيفها أو يزيلها):');
    const sel = new StringSelectMenuBuilder().setCustomId(`ow_bd_toggle:${uid}`).setPlaceholder('اختر الشارة').addOptions(
      specialKeys().slice(0, 25).map(k => { const b = specialBadge(k); const o = { label: `${p.special.includes(k) ? '✅ ' : ''}${b.name}`.slice(0, 100), value: k }; const em = itemEmoji({ emoji: b.emoji }); if (em) o.emoji = em; return o; }));
    return { embeds: [embed], components: [new ActionRowBuilder().addComponents(sel), new ActionRowBuilder().addComponents(ownerPickBack('badges'), ownerHomeBtn())], files: [] };
  }
  if (action === 'points') {
    const embed = new EmbedBuilder().setTitle('💰 النقاط').setColor(EMBED_COLOR).setDescription(head + `**الرصيد:** ${p.points}\n**المستوى:** ${p.level}`);
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`ow_pts_add:${uid}`).setLabel('إعطاء نقاط').setStyle(ButtonStyle.Success).setEmoji('➕'),
      new ButtonBuilder().setCustomId(`ow_pts_sub:${uid}`).setLabel('خصم نقاط').setStyle(ButtonStyle.Danger).setEmoji('➖'),
      new ButtonBuilder().setCustomId(`ow_pts_log:${uid}`).setLabel('سجل النقاط').setStyle(ButtonStyle.Secondary).setEmoji('🧾'));
    return { embeds: [embed], components: [row, new ActionRowBuilder().addComponents(ownerPickBack('points'), ownerHomeBtn())], files: [] };
  }
  const embed = new EmbedBuilder().setTitle('🎁 منح/سحب عناصر').setColor(EMBED_COLOR).setDescription(head + 'اختر نوع العنصر:');
  const sel = new StringSelectMenuBuilder().setCustomId(`ow_gtype:${uid}`).setPlaceholder('نوع العنصر').addOptions(
    Object.entries(OW_TYPES).map(([k, v]) => ({ label: v, value: k })));
  return { embeds: [embed], components: [new ActionRowBuilder().addComponents(sel), new ActionRowBuilder().addComponents(ownerPickBack('grant'), ownerHomeBtn())], files: [] };
}
function ownedHas(p, it) {
  if (it.type === 'consumable') return (p.inventory[it.id] || 0) > 0;
  return p.owned[ownedListKey(it.type)].includes(it.id);
}
function ownerGrantItemsView(uid, type, notice) {
  const p = getGameProfile(uid);
  const items = (type === 'roulette' ? getAllShopItems().filter(i => i.type === 'consumable') : getAllShopItems().filter(i => i.type === type)).slice(0, 25);
  const embed = new EmbedBuilder().setTitle(`🎁 ${OW_TYPES[type]}`).setColor(EMBED_COLOR)
    .setDescription((notice ? notice + '\n\n' : '') + `**الشخص:** <@${uid}>\nاختر عنصر: لو ما يملكه يتمنح، ولو يملكه يتسحب (درع النجاة يزيد +1 بالمنح).` + (items.length ? '' : '\n\n_ما فيه عناصر بهذا النوع._'));
  const comps = [];
  if (items.length) comps.push(new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId(`ow_gitem:${uid}:${type}`).setPlaceholder('اختر العنصر')
    .addOptions(items.map(i => { const o = { label: `${ownedHas(p, i) ? '✅ ' : ''}${i.name}`.slice(0, 100), value: i.id, description: (i.price > 0 ? `${i.price} نقطة` : 'للمنح فقط').slice(0, 100) }; const em = itemEmoji(i); if (em) o.emoji = em; return o; }))));
  comps.push(new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`ow_uv:grant:${uid}`).setLabel('رجوع').setStyle(ButtonStyle.Secondary).setEmoji('⬅️'), ownerHomeBtn()));
  return { embeds: [embed], components: comps, files: [] };
}
const CAT_TYPES = { banner: 'البانرات', badge: 'الشارات (المتجر)', title: 'الألقاب', frame: 'الإطارات', decoration: 'الديكورات', roulette: 'أدوات الروليت', special: 'الشارات الخاصة (جنب الاسم)' };
const CAT_ICONS = { banner: '🖼️', badge: '🏅', title: '🏷️', frame: '🔲', decoration: '✨', roulette: '🎡', special: '💠' };
const CAT_PAGE = 24;
function ownerCatalogView(notice) {
  const embed = new EmbedBuilder().setTitle('🖼️ الكتالوج وتعديل العناصر (عالمي)').setColor(EMBED_COLOR)
    .setDescription((notice ? notice + '\n\n' : '') +
      'اختر النوع، وبعدها تقدر:\n• **تعديل** أي عنصر (الاسم، السعر، الصورة، اللقب، اللون...) سواء من عناصر البوت أو اللي أضفتها\n• **إضافة** عناصر جديدة (بانرات، شارات، ألقاب، إطارات، ديكورات، شارات خاصة)\n• **إخفاء** عنصر من المتجر أو **حذف** اللي أضفته\n\n' +
      `السعر **${MIN_SHOP_PRICE}** فأكثر، أو **0** = للمنح فقط (مثل صور المشرفين والإداريين: ما تنباع، تعطيها من "منح/سحب عناصر").`);
  const sel = new StringSelectMenuBuilder().setCustomId('ow_cat_type').setPlaceholder('اختر النوع')
    .addOptions(Object.entries(CAT_TYPES).map(([k, v]) => ({ label: v, value: k, emoji: CAT_ICONS[k] })));
  return { embeds: [embed], components: [new ActionRowBuilder().addComponents(sel), ownerHomeRow()], files: [] };
}
function catListFor(type) {
  if (type === 'special') {
    return specialKeys().map(k => { const b = specialBadge(k); return { id: k, name: b.name, emoji: b.emoji, price: 0, custom: !SPECIAL_BADGES[k], edited: !!(getCatalog().specialOv[k]), special: true }; });
  }
  const all = getAllShopItems().filter(i => type === 'roulette' ? i.type === 'consumable' : i.type === type);
  return all.map(i => ({ ...i, edited: !!getCatalog().overrides[i.id] }));
}
function ownerCatalogListView(type, page, notice) {
  const list = catListFor(type);
  const pages = Math.max(1, Math.ceil(list.length / CAT_PAGE));
  page = Math.min(Math.max(0, page), pages - 1);
  const slice = list.slice(page * CAT_PAGE, page * CAT_PAGE + CAT_PAGE);
  const line = (i) => `${itemEmoji(i) || '•'} **${i.name}** — ${i.special ? 'شارة خاصة' : (i.price > 0 ? i.price + ' نقطة' : 'للمنح فقط')}${i.hidden ? ' 🙈' : ''}${i.custom ? ' ⭐' : ''}${i.edited ? ' ✏️' : ''}`;
  const embed = new EmbedBuilder().setTitle(`${CAT_ICONS[type]} ${CAT_TYPES[type]} (${list.length})`).setColor(EMBED_COLOR)
    .setDescription((notice ? notice + '\n\n' : '') + (slice.map(line).join('\n') || '_ما فيه عناصر_') + `\n\n⭐ أضفته أنت • ✏️ معدّل • 🙈 مخفي من المتجر${pages > 1 ? `\nصفحة ${page + 1}/${pages}` : ''}`.slice(0, 600));
  const comps = [];
  if (slice.length) comps.push(new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId(`ow_cat_item:${type}`).setPlaceholder('اختر عنصر لتعديله')
    .addOptions(slice.map(i => { const o = { label: i.name.slice(0, 100), value: i.id, description: (i.special ? 'شارة خاصة' : (i.price > 0 ? i.price + ' نقطة' : 'للمنح فقط')).slice(0, 100) }; const em = itemEmoji(i); if (em) o.emoji = em; return o; }))));
  const btns = [
    new ButtonBuilder().setCustomId(`ow_cat_list:${type}:${page - 1}`).setLabel('السابق').setStyle(ButtonStyle.Secondary).setEmoji('◀️').setDisabled(page === 0),
    new ButtonBuilder().setCustomId(`ow_cat_list:${type}:${page + 1}`).setLabel('التالي').setStyle(ButtonStyle.Secondary).setEmoji('▶️').setDisabled(page >= pages - 1)
  ];
  if (type !== 'roulette') btns.push(new ButtonBuilder().setCustomId(`ow_cat_add:${type}`).setLabel('إضافة').setStyle(ButtonStyle.Success).setEmoji('➕'));
  btns.push(new ButtonBuilder().setCustomId('ow_catalog').setLabel('الأنواع').setStyle(ButtonStyle.Secondary).setEmoji('⬅️'), ownerHomeBtn());
  comps.push(new ActionRowBuilder().addComponents(btns));
  return { embeds: [embed], components: comps, files: [] };
}
function catFind(type, id) {
  if (type === 'special') { const b = specialBadge(id); return b ? { ...b, id, special: true, custom: !SPECIAL_BADGES[id], price: 0, type: 'special' } : null; }
  return getShopItem(id);
}
function ownerCatalogItemView(type, id, notice) {
  const it = catFind(type, id);
  if (!it) return ownerCatalogListView(type, 0, '❌ العنصر غير موجود.');
  const isCustom = type === 'special' ? it.custom : !!it.custom;
  const hasOv = type === 'special' ? !!getCatalog().specialOv[id] : !!getCatalog().overrides[id];
  const lines = [`**الاسم:** ${it.name}`, `**النوع:** ${CAT_TYPES[type]}`, `**الآيدي:** \`${id}\``, `**المصدر:** ${isCustom ? 'أضفته أنت ⭐' : 'عنصر البوت الأساسي'}${hasOv ? ' (معدّل ✏️)' : ''}`];
  if (type !== 'special') lines.push(`**السعر:** ${it.price > 0 ? it.price : 'للمنح فقط'}${it.hidden ? ' • 🙈 مخفي من المتجر' : ''}`);
  if (it.text) lines.push(`**النص:** ${it.text}`);
  if (it.color) lines.push(`**اللون:** ${it.color}`);
  if (it.kind) lines.push(`**الشكل:** ${it.kind}`);
  if (it.glyph) lines.push(`**الرمز:** ${it.glyph}`);
  if (it.imageUrl) lines.push(`**الصورة:** ${it.imageUrl}`);
  const embed = new EmbedBuilder().setTitle(`${itemEmoji(it) || ''} ${it.name}`.trim()).setColor(EMBED_COLOR).setDescription((notice ? notice + '\n\n' : '') + lines.join('\n').slice(0, 3800));
  if (it.imageUrl && isValidImageUrl(it.imageUrl)) embed.setImage(it.imageUrl);
  const btns = [new ButtonBuilder().setCustomId(`ow_cat_edit:${type}:${id}`).setLabel('تعديل').setStyle(ButtonStyle.Primary).setEmoji('✏️')];
  if (isCustom) btns.push(new ButtonBuilder().setCustomId(`ow_cat_del:${type}:${id}`).setLabel('حذف').setStyle(ButtonStyle.Danger).setEmoji('🗑️'));
  else if (type !== 'special') btns.push(new ButtonBuilder().setCustomId(`ow_cat_hide:${type}:${id}`).setLabel(it.hidden ? 'إظهار بالمتجر' : 'إخفاء من المتجر').setStyle(ButtonStyle.Secondary).setEmoji(it.hidden ? '👁️' : '🙈'));
  if (!isCustom && hasOv) btns.push(new ButtonBuilder().setCustomId(`ow_cat_reset:${type}:${id}`).setLabel('إرجاع الأصلي').setStyle(ButtonStyle.Secondary).setEmoji('♻️'));
  btns.push(new ButtonBuilder().setCustomId(`ow_cat_list:${type}:0`).setLabel('رجوع').setStyle(ButtonStyle.Secondary).setEmoji('⬅️'));
  return { embeds: [embed], components: [new ActionRowBuilder().addComponents(btns)], files: [] };
}
function catModal(mode, type, it) {
  const id = it ? it.id : '-';
  const modal = new ModalBuilder().setCustomId(`modal_ow_item:${mode}:${type}:${id}`).setTitle(`${mode === 'add' ? 'إضافة' : 'تعديل'}: ${CAT_TYPES[type]}`.slice(0, 45));
  const inp = (cid, label, req, val, style) => { const t = new TextInputBuilder().setCustomId(cid).setLabel(label.slice(0, 45)).setStyle(style || TextInputStyle.Short).setRequired(req); if (val !== undefined && val !== null && String(val) !== '') t.setValue(String(val).slice(0, 400)); return new ActionRowBuilder().addComponents(t); };
  const rows = [inp('input_name', 'الاسم', true, it && it.name)];
  if (type !== 'special') rows.push(inp('input_price', `السعر (${MIN_SHOP_PRICE}+ أو 0 = للمنح فقط)`, true, it ? it.price : ''));
  if (type === 'banner') rows.push(inp('input_image', 'رابط الصورة المباشر', mode === 'add', it && it.imageUrl));
  if (type === 'badge') rows.push(inp('input_image', 'رابط صورة الشارة (اختياري)', false, it && it.imageUrl), inp('input_kind', 'الشكل بدون صورة: ' + Object.keys(BADGE_KINDS).join(' ').slice(0, 24), false, it && it.kind));
  if (type === 'decoration') rows.push(inp('input_image', 'رابط صورة PNG شفافة (الديكور)', mode === 'add' && !(it && it.kind), it && it.imageUrl));
  if (type === 'title') rows.push(inp('input_text', 'نص اللقب (يفضّل إنجليزي)', true, it && it.text));
  if (type === 'frame') rows.push(inp('input_color', 'لون الإطار Hex مثل #ff0000', true, it && it.color));
  if (type === 'special') rows.push(inp('input_image', 'رابط صورة الشارة (اختياري)', false, it && it.imageUrl), inp('input_glyph', 'الرمز بدون صورة: star heart diamond bolt check crown shield', false, it && it.glyph), inp('input_emoji', 'إيموجي للقوائم (اختياري)', false, it && it.emoji));
  modal.addComponents(...rows);
  return modal;
}
function ownerPurgeItem(id, isSpecial) {
  for (const p of Object.values(db.gameProfiles || {})) {
    if (isSpecial) { p.special = (p.special || []).filter(x => x !== id); continue; }
    for (const k of Object.keys(p.owned || {})) if (Array.isArray(p.owned[k])) p.owned[k] = p.owned[k].filter(x => x !== id);
    if (p.inventory && p.inventory[id]) delete p.inventory[id];
    if (p.equipped) for (const f of Object.keys(p.equipped)) if (p.equipped[f] === id) p.equipped[f] = null;
  }
}

function ownerEmojiView(notice) {
  const embed = new EmbedBuilder().setTitle('😀 إيموجيات البوت (عالمية)').setColor(EMBED_COLOR)
    .setDescription((notice ? notice + '\n\n' : '') + GAME_EMOJI_KEYS.map(k => `${E(k.key)} ${k.name}`).join('\n') +
      '\n\nاختر عنصر لتغيير إيموجيه. تقدر تستخدم إيموجي عادي أو مخصص (`<:اسم:آيدي>`) بشرط أن البوت موجود بالسيرفر اللي فيه الإيموجي.');
  const half = Math.ceil(GAME_EMOJI_KEYS.length / 2);
  const mkSel = (id, list) => new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId(id).setPlaceholder('اختر عنصر لتغيير إيموجيه')
    .addOptions(list.map(k => { const o = { label: k.name.slice(0, 100), value: k.key }; const em = safeEmoji(E(k.key)); if (em) o.emoji = em; return o; })));
  return { embeds: [embed], components: [mkSel('ow_em_pick:0', GAME_EMOJI_KEYS.slice(0, half)), mkSel('ow_em_pick:1', GAME_EMOJI_KEYS.slice(half)),
    new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('ow_em_reset').setLabel('إرجاع الكل للافتراضي').setStyle(ButtonStyle.Danger).setEmoji('♻️'), ownerHomeBtn())], files: [] };
}
function ownerStreakView(notice) {
  const cfg = streakCfg();
  const nm = (id, d) => { const it = id ? getShopItem(id) : null; return it ? `**${it.name}**` : d; };
  const t50 = cfg.title50 && cfg.title50.itemId;
  const embed = new EmbedBuilder().setTitle('🔥 جوائز وصورة الستريك').setColor(EMBED_COLOR)
    .setDescription((notice ? notice + '\n\n' : '') +
      `**يوم 10:** 100 نقطة\n` +
      `**يوم 25:** 300 نقطة + صورة بروفايل (بانر): ${nm('streak_banner_25', '_ما انضبطت — الجائزة متأجلة_')}\n` +
      `**يوم 50:** 500 نقطة + أيقونة: ${nm('streak_icon_50', '_ما انضبطت_')} + لقب محدود: ${nm(t50, '_ما انضبط_')}\n` +
      `**يوم 75:** بادج بنفسجي للبروفايل\n` +
      `**يوم 100:** 2000 نقطة + لقب «لهب البنفسج» + درعين + طرد مرتين + إعادة إحياء\n\n` +
      `🖼️ **خلفية بطاقة الستريك:** ${db.streakImage ? 'محددة (تظهر أسفل)' : 'الافتراضية البنفسجية'}\n\n` +
      `• الجوائز اللي ما انضبطت تتأجل، وتنمنح تلقائياً بأول نشاط للعضو بعد ما تضبطها.\n` +
      `• تغيير **اللقب المحدود** ينشئ لقب جديد للي يوصلون يوم 50 من بعدها؛ اللي استلموا اللقب القديم يحتفظون فيه.\n` +
      `• تغيير صورة اليوم 25 أو أيقونة اليوم 50 يحدّث الصورة عند الكل (نفس العنصر).`);
  if (db.streakImage) embed.setImage(db.streakImage);
  return { embeds: [embed], components: [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('ow_stk_25').setLabel('صورة يوم 25').setStyle(ButtonStyle.Primary).setEmoji('🖼️'),
      new ButtonBuilder().setCustomId('ow_stk_50i').setLabel('أيقونة يوم 50').setStyle(ButtonStyle.Primary).setEmoji('🔰'),
      new ButtonBuilder().setCustomId('ow_stk_50t').setLabel('لقب يوم 50 (محدود)').setStyle(ButtonStyle.Primary).setEmoji('🏷️')),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('ow_streak_set').setLabel('خلفية البطاقة').setStyle(ButtonStyle.Secondary).setEmoji('🎨'),
      new ButtonBuilder().setCustomId('ow_streak_clear').setLabel('إزالة الخلفية').setStyle(ButtonStyle.Danger).setEmoji('🗑️'),
      ownerHomeBtn())], files: [] };
}
function ownerRender(kind) {
  if (kind === 'premium') return ownerPremiumListView();
  if (kind === 'catalog') return ownerCatalogView();
  if (kind === 'emojis') return ownerEmojiView();
  if (kind === 'streak') return ownerStreakView();
  if (kind === 'badges' || kind === 'grant' || kind === 'points') return ownerPickUserView(kind);
  return ownerHomeMessage();
}
async function ownerPanelEntry(interaction) {
  if (!isBotOwner(interaction.user.id)) {
    return interaction.reply({ ...embedMsg('❌ هذا الأمر خاص بمالك البوت فقط.'), ephemeral: true });
  }
  return interaction.reply({ ...ownerHomeMessage(), ephemeral: true });
}
async function handleOwnerComponent(interaction) {
  if (!isBotOwner(interaction.user.id)) { await interaction.reply({ ...embedMsg('❌ هذا خاص بمالك البوت فقط.'), ephemeral: true }); return; }
  const cid = interaction.customId;
  const [head, a1, a2] = cid.split(':');
  const upd = (v) => interaction.update(v);
  if (cid === 'ow_home') return upd(ownerHomeMessage());
  if (cid === 'ow_main') {
    const v = interaction.values[0];
    if (v === 'servers') { await interaction.deferUpdate(); return interaction.editReply(await ownerServersView()); }
    return upd(ownerRender(v));
  }
  if (['ow_premium', 'ow_catalog', 'ow_emojis', 'ow_badges', 'ow_grant', 'ow_points', 'ow_streak'].includes(cid)) return upd(ownerRender(cid.slice(3)));
  if (cid === 'ow_streak_set') {
    const modal = new ModalBuilder().setCustomId('modal_ow_streakimg').setTitle('صورة بطاقة الستريك');
    modal.addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('input_url').setLabel('رابط الصورة المباشر').setStyle(TextInputStyle.Short).setRequired(true)));
    return interaction.showModal(modal);
  }
  if (cid === 'ow_stk_25' || cid === 'ow_stk_50i') {
    const is25 = cid === 'ow_stk_25';
    const modal = new ModalBuilder().setCustomId(is25 ? 'modal_ow_stk25' : 'modal_ow_stk50i').setTitle(is25 ? 'صورة جائزة اليوم 25' : 'أيقونة جائزة اليوم 50');
    modal.addComponents(
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('input_url').setLabel('رابط الصورة المباشر').setStyle(TextInputStyle.Short).setRequired(true)),
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('input_name').setLabel('الاسم').setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(40)));
    return interaction.showModal(modal);
  }
  if (cid === 'ow_stk_50t') {
    const modal = new ModalBuilder().setCustomId('modal_ow_stk50t').setTitle('لقب اليوم 50 (محدود)');
    modal.addComponents(
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('input_name').setLabel('اسم اللقب').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(40)),
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('input_text').setLabel('النص على البطاقة (إنجليزي)').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(28)));
    return interaction.showModal(modal);
  }
  if (cid === 'ow_streak_clear') { db.streakImage = null; saveDatabase(db); return upd(ownerStreakView('🗑️ تمت إزالة الصورة.')); }

  // ---- بريميوم ----
  if (cid === 'ow_pm_guild') return upd(ownerPremiumGuildView(interaction.values[0]));
  if (cid === 'ow_pm_byid') {
    const modal = new ModalBuilder().setCustomId('modal_ow_pmid').setTitle('آيدي السيرفر');
    modal.addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('input_id').setLabel('آيدي السيرفر').setStyle(TextInputStyle.Short).setRequired(true)));
    return interaction.showModal(modal);
  }
  if (head === 'ow_pm_dur') {
    const v = interaction.values[0];
    let notice;
    if (v === 'revoke') { revokePremium(a1); notice = '🚫 تم إلغاء البريميوم.'; }
    else if (v === 'life') { grantPremium(a1, 'life'); notice = '✅ تم منح البريميوم مدى الحياة.'; }
    else { grantPremium(a1, parseInt(v.slice(1), 10)); notice = `✅ تمت إضافة ${v.slice(1)} شهر.`; }
    return upd(ownerPremiumGuildView(a1, notice));
  }

  // ---- اختيار شخص ----
  if (head === 'ow_user') return upd(ownerUserView(a1, interaction.values[0]));
  if (head === 'ow_userid') {
    const modal = new ModalBuilder().setCustomId(`modal_ow_uid:${a1}`).setTitle('آيدي الشخص');
    modal.addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('input_id').setLabel('آيدي المستخدم').setStyle(TextInputStyle.Short).setRequired(true)));
    return interaction.showModal(modal);
  }
  if (head === 'ow_uv') return upd(ownerUserView(a1, a2));

  // ---- شارات خاصة ----
  if (head === 'ow_bd_toggle') {
    const p = getGameProfile(a1); const k = interaction.values[0];
    let notice;
    if (p.special.includes(k)) { p.special = p.special.filter(x => x !== k); notice = `➖ أُزيلت شارة **${(specialBadge(k) || {}).name}**.`; }
    else { p.special.push(k); notice = `✅ أُضيفت شارة **${(specialBadge(k) || {}).name}**.`; }
    saveDatabase(db);
    return upd(ownerUserView('badges', a1, notice));
  }

  // ---- نقاط ----
  if (head === 'ow_pts_add' || head === 'ow_pts_sub') {
    const modal = new ModalBuilder().setCustomId(`modal_ow_pts:${head === 'ow_pts_add' ? 'add' : 'sub'}:${a1}`).setTitle(head === 'ow_pts_add' ? 'إعطاء نقاط' : 'خصم نقاط');
    modal.addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('input_amount').setLabel('العدد').setStyle(TextInputStyle.Short).setRequired(true)));
    return interaction.showModal(modal);
  }
  if (head === 'ow_pts_log') {
    const m = buildLogMsg(a1, 'ar');
    m.embeds[0].setTitle(`🧾 سجل نقاط`).setFooter({ text: a1 });
    return upd({ ...m, components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`ow_uv:points:${a1}`).setLabel('رجوع').setStyle(ButtonStyle.Secondary).setEmoji('⬅️'), ownerHomeBtn())], files: [] });
  }

  // ---- منح عناصر ----
  if (head === 'ow_gtype') return upd(ownerGrantItemsView(a1, interaction.values[0]));
  if (head === 'ow_gitem') {
    const it = getShopItem(interaction.values[0]);
    if (!it) return upd(ownerGrantItemsView(a1, a2, '❌ عنصر غير موجود.'));
    const p = getGameProfile(a1);
    let notice;
    if (it.type === 'consumable') { addInventory(a1, it.id, 1); notice = `✅ مُنح **${it.name}** (+1).`; }
    else {
      const key = ownedListKey(it.type);
      if (p.owned[key].includes(it.id)) {
        p.owned[key] = p.owned[key].filter(x => x !== it.id);
        for (const f of Object.keys(p.equipped)) if (p.equipped[f] === it.id) p.equipped[f] = null;
        notice = `➖ سُحب **${it.name}**.`;
      } else { p.owned[key].push(it.id); notice = `✅ مُنح **${it.name}**.`; }
      saveDatabase(db);
    }
    return upd(ownerGrantItemsView(a1, a2, notice));
  }

  // ---- كتالوج وتعديل العناصر ----
  if (cid === 'ow_cat_type') return upd(ownerCatalogListView(interaction.values[0], 0));
  if (head === 'ow_cat_list') return upd(ownerCatalogListView(a1, parseInt(a2, 10) || 0));
  if (head === 'ow_cat_item') return upd(ownerCatalogItemView(a1, interaction.values[0]));
  if (head === 'ow_cat_add') return interaction.showModal(catModal('add', a1, null));
  if (head === 'ow_cat_edit') {
    const it = catFind(a1, a2);
    if (!it) return upd(ownerCatalogListView(a1, 0, '❌ العنصر غير موجود.'));
    return interaction.showModal(catModal('edit', a1, it));
  }
  if (head === 'ow_cat_hide') {
    const it = getShopItem(a2);
    if (!it) return upd(ownerCatalogListView(a1, 0, '❌ العنصر غير موجود.'));
    const ov = getCatalog().overrides[a2] || (getCatalog().overrides[a2] = {});
    ov.hidden = !it.hidden; saveDatabase(db);
    return upd(ownerCatalogItemView(a1, a2, ov.hidden ? '🙈 انخفى من المتجر (تقدر تمنحه).' : '👁️ رجع يظهر بالمتجر.'));
  }
  if (head === 'ow_cat_reset') {
    if (a1 === 'special') delete getCatalog().specialOv[a2]; else delete getCatalog().overrides[a2];
    saveDatabase(db);
    return upd(ownerCatalogItemView(a1, a2, '♻️ رجع العنصر للأصلي.'));
  }
  if (head === 'ow_cat_del') {
    const it = catFind(a1, a2);
    if (a1 === 'special') { delete getCatalog().specials[a2]; delete getCatalog().specialOv[a2]; }
    else delete getCatalog().items[a2];
    ownerPurgeItem(a2, a1 === 'special'); saveDatabase(db);
    return upd(ownerCatalogListView(a1, 0, `🗑️ حُذف **${it ? it.name : a2}** (وانسحب من كل المستخدمين).`));
  }

  // ---- إيموجيات ----
  if (head === 'ow_em_pick') {
    const key = interaction.values[0];
    const info = GAME_EMOJI_KEYS.find(k => k.key === key);
    const modal = new ModalBuilder().setCustomId(`modal_ow_em:${key}`).setTitle(`إيموجي: ${info.name}`.slice(0, 45));
    modal.addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('input_emoji').setLabel('الإيموجي الجديد (فاضي = افتراضي)').setStyle(TextInputStyle.Short).setRequired(false)));
    return interaction.showModal(modal);
  }
  if (cid === 'ow_em_reset') { db.globalEmojis = {}; saveDatabase(db); return upd(ownerEmojiView('♻️ رجعت كل الإيموجيات للافتراضي.')); }
}
async function handleOwnerModal(interaction) {
  if (!isBotOwner(interaction.user.id)) { await interaction.reply({ ...embedMsg('❌ هذا خاص بمالك البوت فقط.'), ephemeral: true }); return; }
  const [head, a1, a2] = interaction.customId.split(':');
  const val = (id) => { try { return interaction.fields.getTextInputValue(id).trim(); } catch (e) { return ''; } };
  const bad = (txt) => interaction.reply({ ...embedMsg('❌ ' + txt), ephemeral: true });

  if (head === 'modal_ow_stk25' || head === 'modal_ow_stk50i') {
    const url = val('input_url');
    if (!isValidImageUrl(url)) return bad('رابط غير صالح.');
    await interaction.deferUpdate();
    try { await loadRemoteImage(url); }
    catch (e) { return interaction.editReply(ownerStreakView('❌ ما قدرت أحمّل الصورة — تأكد أن الرابط صورة مباشرة.')); }
    const is25 = head === 'modal_ow_stk25';
    const id = is25 ? 'streak_banner_25' : 'streak_icon_50';
    const name = (val('input_name') || (is25 ? 'صورة الستريك' : 'أيقونة الستريك')).slice(0, 40);
    const item = { id, name, type: is25 ? 'banner' : 'badge', price: 0, forSale: false, emoji: is25 ? '🖼️' : '🔰', custom: true, imageUrl: url,
      desc: is25 ? 'صورة بروفايل جائزة ستريك 25 يوم.' : 'أيقونة جائزة ستريك 50 يوم.' };
    if (is25) item.colors = ['#0b0b0f', '#3b0a0a', '#120505']; else item.kind = 'star';
    getCatalog().items[id] = item; saveDatabase(db);
    return interaction.editReply(ownerStreakView(`✅ تم ضبط ${is25 ? 'صورة اليوم 25' : 'أيقونة اليوم 50'}: **${name}**`));
  }
  if (head === 'modal_ow_stk50t') {
    const name = val('input_name').slice(0, 40), text = val('input_text').slice(0, 28);
    if (!name || !text) return bad('الاسم والنص مطلوبين.');
    const id = `streak_title_50_${Date.now().toString(36)}`;
    getCatalog().items[id] = { id, name, type: 'title', price: 0, forSale: false, emoji: '🏷️', custom: true, text, desc: 'لقب محدود لجائزة ستريك 50 يوم.' };
    streakCfg().title50 = { itemId: id, setAt: Date.now() }; saveDatabase(db);
    return interaction.update(ownerStreakView(`✅ اللقب المحدود الحالي (يوم 50): **${name}** — اللي يوصلون يوم 50 من الحين ياخذونه.`));
  }
  if (head === 'modal_ow_streakimg') {
    const url = val('input_url');
    if (!isValidImageUrl(url)) return bad('رابط غير صالح.');
    await interaction.deferUpdate();
    try { await loadRemoteImage(url); }
    catch (e) { return interaction.editReply(ownerStreakView('❌ ما قدرت أحمّل الصورة — تأكد أن الرابط صورة مباشرة.')); }
    db.streakImage = url; saveDatabase(db);
    return interaction.editReply(ownerStreakView('✅ تم تحديد صورة الستريك.'));
  }
  if (head === 'modal_ow_pmid') {
    const gid = val('input_id');
    if (!/^\d{15,25}$/.test(gid)) return bad('آيدي غير صالح.');
    return interaction.update(ownerPremiumGuildView(gid));
  }
  if (head === 'modal_ow_uid') {
    const uid = val('input_id');
    if (!/^\d{15,25}$/.test(uid)) return bad('آيدي غير صالح.');
    const u = await client.users.fetch(uid).catch(() => null);
    if (!u) return bad('ما لقيت هذا المستخدم.');
    return interaction.update(ownerUserView(a1, uid));
  }
  if (head === 'modal_ow_pts') {
    const n = parseInt(val('input_amount'), 10);
    if (isNaN(n) || n <= 0 || n > 100000000) return bad('أدخل رقم صحيح أكبر من 0.');
    addPoints(a2, a1 === 'add' ? n : -n, 'owner');
    return interaction.update(ownerUserView('points', a2, a1 === 'add' ? `✅ أُعطي ${n} نقطة.` : `✅ خُصم ${n} نقطة.`));
  }
  if (head === 'modal_ow_em') {
    const v = val('input_emoji');
    if (!db.globalEmojis) db.globalEmojis = {};
    if (!v) { delete db.globalEmojis[a1]; saveDatabase(db); return interaction.update(ownerEmojiView('♻️ رجع الإيموجي للافتراضي.')); }
    if (!validEmojiInput(v)) return bad('هذا مو إيموجي صالح. استخدم إيموجي عادي أو `<:اسم:آيدي>` (✚ مثلاً مو إيموجي).');
    const cm = v.match(/^<a?:\w+:(\d+)>$/);
    if (cm && !client.emojis.cache.has(cm[1])) return bad('البوت ما يشوف هذا الإيموجي — لازم يكون بسيرفر البوت موجود فيه.');
    db.globalEmojis[a1] = v; saveDatabase(db);
    return interaction.update(ownerEmojiView(`✅ تم: ${v}`));
  }
  if (head === 'modal_ow_item') {
    const mode = a1, [type, id] = [interaction.customId.split(':')[2], interaction.customId.split(':')[3]];
    const name = val('input_name').slice(0, 40);
    if (!name) return bad('الاسم مطلوب.');
    const cat = getCatalog();
    let price = 0, url = '', kind = '', text = '', color = '', glyph = '', emoji = '';
    if (type !== 'special') {
      price = parseInt(val('input_price'), 10);
      if (isNaN(price) || (price !== 0 && price < MIN_SHOP_PRICE)) return bad(`السعر لازم ${MIN_SHOP_PRICE} فأكثر أو 0 (للمنح فقط).`);
    }
    url = val('input_image'); kind = val('input_kind').toLowerCase(); text = val('input_text'); color = val('input_color'); glyph = val('input_glyph').toLowerCase(); emoji = val('input_emoji');
    if (type === 'banner' && mode === 'add' && !url) return bad('البانر يحتاج رابط صورة.');
    if (type === 'decoration' && mode === 'add' && !url) return bad('الديكور المضاف يحتاج رابط صورة PNG شفافة.');
    if (url && !isValidImageUrl(url)) return bad('رابط الصورة غير صالح (لازم يبدأ بـ http/https).');
    if (type === 'title' && !text) return bad('نص اللقب مطلوب.');
    if (type === 'frame' && !/^#[0-9a-fA-F]{6}$/.test(color)) return bad('لون الإطار لازم Hex مثل #ff0000.');
    if (emoji && !validEmojiInput(emoji)) return bad('الإيموجي غير صالح.');
    await interaction.deferUpdate();
    const prev = mode === 'edit' ? catFind(type, id) : null;
    if (url && (!prev || prev.imageUrl !== url)) {
      try { await loadRemoteImage(url); }
      catch (e) { return interaction.followUp({ ...embedMsg('❌ ما قدرت أحمّل الصورة من الرابط — تأكد أنه رابط مباشر للصورة (PNG/JPG).'), ephemeral: true }); }
    }
    const defEmoji = { banner: '🖼️', badge: '🏅', title: '🏷️', frame: '🔲', decoration: '✨', special: '🏅' }[type];
    if (mode === 'add') {
      if (type === 'special') {
        const key = 'x' + Date.now().toString(36);
        cat.specials[key] = { name, nameEn: name, emoji: emoji || defEmoji, imageUrl: url || null, glyph: ['star', 'heart', 'diamond', 'bolt', 'check', 'crown', 'shield'].includes(glyph) ? glyph : 'star', c1: '#8b5cf6', c2: '#4c1d95' };
        saveDatabase(db);
        return interaction.editReply(ownerCatalogListView('special', 999, `✅ أُضيفت الشارة الخاصة **${name}** — امنحها من "الشارات الخاصة".`));
      }
      const nid = 'c' + Date.now().toString(36);
      const item = { id: nid, name, type, price, forSale: price > 0, emoji: defEmoji, custom: true, desc: { banner: 'بانر لبطاقتك الشخصية.', badge: 'شارة تظهر جنب اسمك.', title: 'لقب يظهر تحت اسمك.', frame: 'إطار حول صورتك.', decoration: 'ديكور فوق صورتك.' }[type], imageUrl: url || null };
      if (type === 'banner') item.colors = ['#0b0b0f', '#3b0a0a', '#120505'];
      if (type === 'badge') item.kind = BADGE_KINDS[kind] ? kind : 'star';
      if (type === 'title') item.text = text.slice(0, 28);
      if (type === 'frame') item.color = color;
      cat.items[nid] = item; saveDatabase(db);
      return interaction.editReply(ownerCatalogListView(type, 999, `✅ أُضيف **${name}**${price > 0 ? ' للمتجر' : ' (للمنح فقط)'}.`));
    }
    // ---- تعديل ----
    if (type === 'special') {
      if (!SPECIAL_BADGES[id] && cat.specials[id]) Object.assign(cat.specials[id], { name, nameEn: name, imageUrl: url || null, emoji: emoji || cat.specials[id].emoji, glyph: glyph || cat.specials[id].glyph });
      else cat.specialOv[id] = { ...(cat.specialOv[id] || {}), name, nameEn: name, imageUrl: url || null, ...(emoji ? { emoji } : {}), ...(glyph ? { glyph } : {}) };
      saveDatabase(db);
      return interaction.editReply(ownerCatalogItemView('special', id, `✅ تم تعديل **${name}**.`));
    }
    const custom = cat.items[id];
    const target = custom || (cat.overrides[id] || (cat.overrides[id] = {}));
    target.name = name; target.price = price; if (custom) custom.forSale = price > 0;
    if (type === 'banner' || type === 'badge' || type === 'decoration') target.imageUrl = url || null;
    if (type === 'badge') target.kind = BADGE_KINDS[kind] ? kind : (prev && prev.kind) || 'star';
    if (type === 'title') target.text = text.slice(0, 28);
    if (type === 'frame') { target.color = color; target.colors = null; }
    saveDatabase(db);
    return interaction.editReply(ownerCatalogItemView(type, id, `✅ تم تعديل **${name}**.`));
  }
}

// ==========================================
// 🎮 مكونات الألعاب (روليت / شوب / تعديل / درع)
// ==========================================
async function handleGamesComponent(interaction) {
  const cid = interaction.customId;
  const known = cid.startsWith('rl_') || cid.startsWith('st_') || cid.startsWith('shop_') || cid.startsWith('ed_') || cid === 'claim_shield';
  if (!known) return false;
  const guild = interaction.guild;
  const lang = getUserLang(guild.id);
  const en = lang === 'en';
  const eph = (text) => interaction.reply({ ...embedMsg(text), ephemeral: true });

  if (cid === 'claim_shield') {
    const sg = process.env.SUPPORT_GUILD_ID;
    const p = getGameProfile(interaction.user.id);
    if (!sg) { await eph(en ? '❌ Shield claiming is not configured.' : '❌ استلام الدرع غير مفعّل حالياً.'); return true; }
    if (p.shieldClaimed) { await eph(en ? '⚠️ You already claimed your shield.' : '⚠️ استلمت درعك مسبقاً.'); return true; }
    const sgd = client.guilds.cache.get(sg);
    const m = sgd ? await sgd.members.fetch(interaction.user.id).catch(() => null) : null;
    if (!m) { await eph(en ? `❌ I couldn't find you in our Discord. Join first: ${SUPPORT_INVITE}` : `❌ ما لقيتك بسيرفرنا. انضم أول: ${SUPPORT_INVITE}`); return true; }
    addInventory(interaction.user.id, 'shield', 1); p.shieldClaimed = true; saveDatabase(db);
    await eph(en ? `${E('shield')} You received a **Survival Shield**!` : `${E('shield')} استلمت **درع نجاة**!`);
    return true;
  }

  // ---- الروليت ----
  if (cid.startsWith('rl_revive_')) {
    if (!cid.endsWith(interaction.user.id)) await eph(en ? '❌ This is not your button.' : '❌ هذا الزر مو لك.');
    return true;
  }
  if (cid.startsWith('rl_')) {
    const session = rouletteSessions.get(interaction.channel.id);
    const isAdmin = interaction.member && interaction.member.permissions.has(PermissionFlagsBits.Administrator);
    if (cid === 'rl_join') {
      if (!session || session.phase !== 'lobby') { await eph(en ? '❌ No active roulette lobby right now.' : '❌ ما فيه لوبي روليت نشط حالياً.'); return true; }
      if (session.players.find(p => p.id === interaction.user.id)) { await eph(en ? '⚠️ You already joined.' : '⚠️ أنت منضم مسبقاً.'); return true; }
      if (session.players.length >= session.maxPlayers) { await eph(en ? '❌ Max players reached.' : '❌ اكتمل العدد الأقصى للاعبين.'); return true; }
      session.players.push({ id: interaction.user.id, name: interaction.member.displayName, avatar: interaction.member.displayAvatarURL({ extension: 'png', size: 128, forceStatic: true }) });
      if (!session.lobbyMsg) session.lobbyMsg = interaction.message;
      await interaction.update({ embeds: [getRouletteLobbyEmbed(session, lang)], components: getRouletteLobbyComponents(lang) });
      if (session.players.length >= session.maxPlayers) await beginRouletteMatch(interaction.channel, session, lang); // اكتمل العدد: يبدأ فوراً
      return true;
    }
    if (cid === 'rl_leave') {
      if (!session || session.phase !== 'lobby') { await eph(en ? '❌ No active lobby.' : '❌ ما فيه لوبي نشط.'); return true; }
      if (!session.players.find(p => p.id === interaction.user.id)) { await eph(en ? '⚠️ You are not in the lobby.' : '⚠️ أنت مو منضم.'); return true; }
      session.players = session.players.filter(p => p.id !== interaction.user.id);
      if (!session.lobbyMsg) session.lobbyMsg = interaction.message;
      await interaction.update({ embeds: [getRouletteLobbyEmbed(session, lang)], components: getRouletteLobbyComponents(lang) });
      return true;
    }
    if (cid === 'rl_stop') {
      if (!session) { await eph(en ? '❌ This match has ended.' : '❌ هذي المباراة انتهت.'); return true; }
      if (interaction.user.id !== session.hostId && !isAdmin) { await eph(en ? '❌ Only the host or an admin can stop the match.' : '❌ بس صاحب الأمر أو الإدارة يقدر يوقف المباراة.'); return true; }
      await interaction.deferUpdate().catch(() => {});
      await cancelRouletteSession(interaction.channel, session, lang, interaction.user.id);
      return true;
    }
    if (cid.startsWith('rl_kick:')) { await rouletteKickPick(interaction, session, cid.slice(8), lang); return true; }
    if (['rl_random', 'rl_protect', 'rl_pass', 'rl_dk'].includes(cid)) {
      if (!session) { await eph(en ? '❌ This match has ended.' : '❌ هذي المباراة انتهت.'); return true; }
      await rouletteTurnAction(interaction, session, cid.slice(3), lang);
      return true;
    }
    if (cid === 'rl_target_select') { await rouletteKickPick(interaction, session, interaction.values[0], lang); return true; }
    return true;
  }

  // ---- المتجر ----
  if (cid === 'shop_noop') { await interaction.deferUpdate(); return true; }
  const uid = interaction.user.id;
  const member = interaction.member || await guild.members.fetch(uid);

  if (cid.startsWith('st_')) {
    await interaction.deferUpdate();
    if (cid === 'st_card') return await interaction.editReply({ ...(await buildStreakMessage(guild, member, lang)), attachments: [] }), true;
    if (cid.startsWith('st_board:')) return await interaction.editReply({ ...buildStreakBoard(guild, cid.slice(9), lang), files: [], attachments: [] }), true;
    return true;
  }
  if (cid === 'shop_home') { await interaction.deferUpdate(); await interaction.editReply({ ...(await shopHomeMessage(uid, lang)), attachments: [] }); return true; }
  if (cid === 'shop_cat') {
    await interaction.deferUpdate();
    const cat = interaction.values[0];
    if (cat === 'bundles') await interaction.editReply({ ...(await shopBundlesMessage(uid, lang)), attachments: [] });
    else await interaction.editReply({ ...(await shopGridMessage(uid, cat, 0, lang)), attachments: [] });
    return true;
  }
  if (cid.startsWith('shop_page:')) {
    const [, cat, pg] = cid.split(':');
    await interaction.deferUpdate();
    await interaction.editReply({ ...(await shopGridMessage(uid, cat, parseInt(pg, 10) || 0, lang)), attachments: [] });
    return true;
  }
  if (cid.startsWith('shop_pick:')) {
    const [, cat, pg] = cid.split(':');
    const item = getShopItem(interaction.values[0]);
    await interaction.deferUpdate();
    if (cat === 'roulette') {
      const res = item ? purchaseItem(uid, item) : { ok: false, reason: 'missing' };
      const notice = res.ok ? (en ? `✅ Purchased **${item.name}**!` : `✅ تم شراء **${item.name}**!`)
        : res.reason === 'poor' ? (en ? '❌ Not enough points.' : '❌ نقاطك غير كافية.') : (en ? '❌ Unknown item.' : '❌ عنصر غير معروف.');
      await interaction.editReply({ ...(await shopGridMessage(uid, cat, parseInt(pg, 10) || 0, lang, notice)), attachments: [] });
      return true;
    }
    const idx = shopItemsForCategory(cat).findIndex(i => item && i.id === item.id);
    await interaction.editReply({ ...(await shopItemMessage(guild, member, cat, Math.max(0, idx), lang)), attachments: [] });
    return true;
  }
  if (cid === 'shop_bsel') {
    const b = SHOP_BUNDLES.find(x => x.id === interaction.values[0]);
    await interaction.deferUpdate();
    const res = b ? purchaseBundle(uid, b) : { ok: false, reason: 'missing' };
    const notice = res.ok ? (en ? `✅ Bundle purchased (${res.count} items, ${res.cost} points)!` : `✅ تم شراء الحزمة (${res.count} عناصر بـ ${res.cost} نقطة)!`)
      : res.reason === 'owned' ? (en ? '⚠️ You already own everything in this bundle.' : '⚠️ تملك كل عناصر هذي الحزمة.')
      : res.reason === 'poor' ? (en ? `❌ Not enough points (needs ${res.cost}).` : `❌ نقاطك غير كافية (تحتاج ${res.cost}).`) : (en ? '❌ Unknown bundle.' : '❌ حزمة غير معروفة.');
    await interaction.editReply({ ...(await shopBundlesMessage(uid, lang, notice)), attachments: [] });
    return true;
  }
  if (cid.startsWith('shop_equip:')) {
    const [, itemId, cat, idxS] = cid.split(':');
    const item = getShopItem(itemId);
    await interaction.deferUpdate();
    const p = getGameProfile(uid);
    if (item && p.owned[ownedListKey(item.type)].includes(item.id)) { p.equipped[item.type] = p.equipped[item.type] === item.id ? null : item.id; saveDatabase(db); }
    await interaction.editReply({ ...(await shopItemMessage(guild, member, cat, parseInt(idxS, 10) || 0, lang)), attachments: [] });
    return true;
  }
  if (cid.startsWith('shop_nav:')) {
    const [, cat, idx] = cid.split(':');
    await interaction.deferUpdate();
    await interaction.editReply({ ...(await shopItemMessage(guild, member, cat, parseInt(idx, 10), lang)), attachments: [] });
    return true;
  }
  if (cid.startsWith('shop_buy:')) {
    const [, cat, idxS, itemId] = cid.split(':');
    const item = getShopItem(itemId);
    await interaction.deferUpdate();
    const res = item ? purchaseItem(uid, item) : { ok: false, reason: 'missing' };
    const idx = parseInt(idxS, 10);
    const list = shopItemsForCategory(cat);
    const fi = list.findIndex(i => i.id === itemId); const realIdx = fi >= 0 ? fi : idx;
    await interaction.editReply({ ...(await shopItemMessage(guild, member, cat, realIdx, lang)), attachments: [] });
    const msgs = {
      ok: en ? `✅ Purchased **${item && item.name}**! Equip it with /edit.` : `✅ تم شراء **${item && item.name}**! البسه من /edit.`,
      owned: en ? '⚠️ You already own this item.' : '⚠️ أنت تملك هذا العنصر مسبقاً.',
      poor: en ? '❌ Not enough points.' : '❌ نقاطك غير كافية.',
      notforsale: en ? '❌ This item is not for sale.' : '❌ هذا العنصر غير معروض للبيع.',
      missing: en ? '❌ Unknown item.' : '❌ عنصر غير معروف.'
    };
    await interaction.followUp({ ...embedMsg(msgs[res.ok ? 'ok' : res.reason]), ephemeral: true });
    return true;
  }
  if (cid === 'shop_rsel') {
    const item = getShopItem(interaction.values[0]);
    await interaction.deferUpdate();
    const res = item ? purchaseItem(uid, item) : { ok: false, reason: 'missing' };
    const notice = res.ok ? (en ? `✅ Purchased **${item.name}**!` : `✅ تم شراء **${item.name}**!`)
      : res.reason === 'owned' ? (en ? '⚠️ You already own this item.' : '⚠️ تملك هذا العنصر مسبقاً.')
      : res.reason === 'poor' ? (en ? '❌ Not enough points.' : '❌ نقاطك غير كافية.') : (en ? '❌ Unknown item.' : '❌ عنصر غير معروف.');
    await interaction.editReply({ ...shopRouletteMessage(uid, lang, notice), files: [], attachments: [] });
    return true;
  }

  // ---- /edit ----
  if (cid.startsWith('ed_')) {
    const field = { ed_banner: 'banner', ed_badge: 'badge', ed_decoration: 'decoration', ed_frame: 'frame', ed_title: 'title' }[cid];
    if (!field) return true;
    const p = getGameProfile(uid);
    const val = interaction.values[0];
    if (val !== 'none' && !p.owned[ownedListKey(field)].includes(val)) { await eph(en ? "❌ You don't own this item." : '❌ ما تملك هذا العنصر.'); return true; }
    p.equipped[field] = val === 'none' ? null : val; saveDatabase(db);
    await interaction.deferUpdate();
    await interaction.editReply({ ...(await buildEditMessage(guild, member, lang)), attachments: [] });
    return true;
  }
  return true;
}

// ==========================================
// MAIN INTERACTION CONTROLLER
// ==========================================
async function handleInteraction(interaction) {
  // ==========================================
  // SLASH COMMANDS
  // ==========================================
  if (interaction.isChatInputCommand()) {
    if (interaction.commandName === 'owner-server') return ownerPanelEntry(interaction);

    if (interaction.commandName === 'help') {
      const embed = new EmbedBuilder()
        .setTitle('📖 دليل استخدام البوت')
        .setDescription(
          `هذا البوت يقدم لك نظامين رئيسيين بالسيرفر: **رتب مخصصة** و **رومات صوتية خاصة**، بالإضافة لأدوات إدارية كاملة.\n\n` +
          `**🎭 نظام الرتب المخصصة**\nكل عضو يقدر يسوي رتبة خاصة فيه بلون (صلب أو تدرج حقيقي بلونين) وأيقونة/إيموجي، يجربها قبل ما يحفظها، وتقدر تعدلها بأي وقت بدون ما تتكرر.\n\n` +
          `**🔊 نظام الرومات الصوتية**\nادخل روم الإنشاء المخصص وينشئ لك البوت روم خاص فيك تلقائياً وينقلك له، مع لوحة تحكم كاملة داخل الروم (تغيير الاسم، قفل/فتح، طرد، حظر، ثقة، نقل ملكية، غرفة انتظار، وأكثر) وقائمة شرح لكل زر.\n\n` +
          `**😀 /addemote**\nحط رسالة فيها إيموجي واحد أو أكثر (منسوخة من ديسكورد) ويضيفهم كلهم للسيرفر تلقائياً.\n\n` +
          `**🌐 /language** (للمسؤولين) — تغيير لغة البوت لكامل السيرفر (عربي/إنجليزي).\n\n` +
          `**🎃 نظام الألعاب (روليت هالوين + متجر + بروفايل)**\n` +
          `• /roulette — مباراة جماعية: بدورك تطرد لاعب أو طرد عشوائي أو حماية نفسك أو تمرير، والعجلة تدور GIF 5 ثواني قبل ما تنكشف النتيجة، وأدوات الشوب استخدام مرة وحدة.\n` +
          `• /shop — شراء دروع، قدرات (أنت وحظك 🎲 / حظك وحظك 🍀 / إعادة الإحياء 💖 / طرد مرتين ✂️)، بانرات، شارات، ديكورات، إطارات، وألقاب.\n` +
          `• /profile — بطاقة بروفايل (خفية). بروم الأوامر اكتب: **p** بروفايل • **i** مخزون • **b** رصيد • **t** توب • **l** سجل نقاط.\n` +
          `• /balance، /inventory، /edit (تعديل بروفايلك من مشترياتك)، /history، /log — كلها خفية.\n` +
          `• /top و /leaderboard — توب 15 بالسيرفر أو عالمي.\n` +
          `• 🌟 بريميوم: صورة خاصة للبوت بسيرفرك + /streak (ستريك ستيكر/GIF يومي) — يفعّله مالك البوت.\n\n` +
          `**⚙️ /settings** (للمسؤولين فقط)\nلوحة إعدادات شاملة بقائمة منسدلة:\n` +
          `• 🎭 صانع الرتب — رتبة الأساس، الكاتيجوري، قناة السجلات، صورة الإمبيد، الإيموجيات، إرسال اللوحة.\n` +
          `• 🔊 صانع الفويس — روم الإنشاء، كاتيجوري الرومات، قناة السجلات، الإيموجيات، إرسال اللوحة.\n` +
          `• 🛡️ تحذير الإدارة — رتبة تتمنشن تلقائياً عند أي بلاغ بروم صوتي.\n` +
          `• 🛠️ الإدارة — قفل/فتح رومات، حذف رسائل، تحذير الأعضاء، ولائحة تحذيرات أي عضو.\n` +
          `• 🎮 الألعاب — تحديد روم الأوامر (لأمر **p**) وإعدادات نقاط الروليت.\n\n` +
          `**🗑️ /deleterole** (للمسؤولين) — حذف رتبة عضو معين.\n\n` +
          `**🌐 الموقع الرسمي:** [nw-n.netlify.app](https://nw-n.netlify.app/)`
        )
        .setColor(EMBED_COLOR)
        .setFooter({ text: 'Nw Community Bot' });
      return interaction.reply({ embeds: [embed], components: [promoRow(getUserLang(interaction.guild ? interaction.guild.id : null))], ephemeral: true });
    }

    if (interaction.commandName === 'language') {
      if (!interaction.member.permissions.has(PermissionFlagsBits.Administrator)) {
        return interaction.reply({ ...embedMsg(bi(interaction, '❌ للمسؤولين فقط.', "❌ Administrators only.")), ephemeral: true });
      }
      const lang = interaction.options.getString('language');
      if (!db.guildLanguage) db.guildLanguage = {};
      db.guildLanguage[interaction.guild.id] = lang; saveDatabase(db);
      const msg = lang === 'ar' ? '✅ تم تغيير لغة البوت لكامل السيرفر إلى العربية.' : '✅ The bot language for the whole server has been set to English.';
      return interaction.reply({ ...embedMsg(msg), ephemeral: true });
    }

    if (interaction.commandName === 'addemote') {
      if (!interaction.member.permissions.has(PermissionFlagsBits.ManageEmojisAndStickers) && !interaction.member.permissions.has(PermissionFlagsBits.Administrator)) {
        return interaction.reply({ ...embedMsg(bi(interaction, '❌ تحتاج صلاحية Manage Emojis and Stickers لاستخدام هذا الأمر.', "❌ You need the Manage Emojis and Stickers permission to use this command.")), ephemeral: true });
      }
      await interaction.deferReply({ ephemeral: true });
      const text = interaction.options.getString('emotes');
      const matches = [...text.matchAll(/<(a?):(\w+):(\d+)>/g)];
      if (matches.length === 0) return interaction.editReply(embedMsg(bi(interaction, '❌ ما لقيت أي إيموجي مخصص بالرسالة.', "❌ I couldn't find any custom emoji in the message.")));

      const results = [];
      for (const match of matches) {
        const [, animatedFlag, name, id] = match;
        const ext = animatedFlag === 'a' ? 'gif' : 'png';
        const url = `https://cdn.discordapp.com/emojis/${id}.${ext}`;
        try {
          const created = await interaction.guild.emojis.create({ attachment: url, name: name.slice(0, 32) });
          results.push(`✅ ${created} — تمت إضافة **${name}** بنجاح`);
        } catch (err) {
          console.error(`فشل إضافة الإيموجي ${name}:`, err);
          results.push(`❌ فشل إضافة **${name}**`);
        }
      }
      return interaction.editReply(embedMsg(results.join('\n'), { title: bi(interaction, '😀 نتيجة إضافة الإيموجيات', '😀 Emoji Addition Results') }));
    }

    if (interaction.commandName === 'deleterole') {
      const targetUser = interaction.options.getUser('user');
      const entry = getRoleEntry(targetUser.id);
      if (!entry) return interaction.reply({ ...embedMsg(bi(interaction, '❌ هذا العضو ليس لديه رتبة مسجلة.', "❌ This member doesn't have a registered role.")), ephemeral: true });
      const role = interaction.guild.roles.cache.get(entry.roleId);
      if (role) await role.delete().catch(() => {});
      delete db.userCustomRoles[targetUser.id]; saveDatabase(db);
      return interaction.reply({ ...embedMsg(bi(interaction, '🗑️ تم حذف رتبة العضو بنجاح.', "🗑️ The member's role was deleted successfully.")), ephemeral: true });
    }

    if (interaction.commandName === 'settings') {
      if (!interaction.member.permissions.has(PermissionFlagsBits.Administrator)) {
        return interaction.reply({ ...embedMsg(bi(interaction, '❌ للمسؤولين فقط.', "❌ Administrators only.")), ephemeral: true });
      }
      return interaction.reply({ embeds: [getSettingsMainEmbed()], components: getSettingsMainComponents(), ephemeral: true });
    }

    // ==========================================
    // 🎮 أوامر الألعاب (روليت / متجر / بروفايل / تصنيفات)
    // ==========================================
    if (interaction.commandName === 'activity') {
      try { await client.rest.post(Routes.interactionCallback(interaction.id, interaction.token), { body: { type: 12 } }); }
      catch (e) { console.error('activity launch:', e.message); try { await interaction.reply({ content: 'تعذر فتح التطبيق. تأكد أن الـ Activities مفعّلة بـ Developer Portal وأن الـ URL Mapping مضبوط.', ephemeral: true }); } catch (e2) {} }
      return;
    }
    if (interaction.commandName === 'roulette') return runGameCommand(interaction, 'roulette');
    if (['shop', 'balance', 'inventory', 'history', 'log', 'streak', 'edit'].includes(interaction.commandName)) return runGameCommand(interaction, interaction.commandName);
    if (interaction.commandName === 'profile' || interaction.commandName === 'stats') return runGameCommand(interaction, interaction.commandName, { user: interaction.options.getUser('user') });
    if (interaction.commandName === 'top') return runGameCommand(interaction, 'top', { type: interaction.options.getString('type'), scope: interaction.options.getString('scope') });
    if (interaction.commandName === 'leaderboard') return runGameCommand(interaction, 'top', { type: 'wins', scope: 'server' });
  }

  // ==========================================
  // 🚪 OWNER: LEAVE-SERVER FLOW
  // ==========================================
  if ((interaction.isButton() || interaction.isStringSelectMenu()) &&
      (interaction.customId === 'owner_leave_select' || interaction.customId.startsWith('owner_leave_confirm_') || interaction.customId === 'owner_leave_cancel')) {
    if (!CONFIG.OWNER_IDS.includes(interaction.user.id)) {
      return interaction.reply({ ...embedMsg(bi(interaction, '❌ هذا خاص بمالك البوت فقط.', "❌ This is for the bot owner only.")), ephemeral: true });
    }

    if (interaction.customId === 'owner_leave_select') {
      const guildId = interaction.values[0];
      const guild = client.guilds.cache.get(guildId);
      if (!guild) return interaction.update({ ...embedMsg(bi(interaction, '❌ ما لقيت هذا السيرفر (ربما البوت طلع منه أصلاً).', "❌ I couldn't find this server (the bot may have already left it).")), components: [] });
      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`owner_leave_confirm_${guildId}`).setLabel('تأكيد المغادرة').setStyle(ButtonStyle.Danger).setEmoji('🚪'),
        new ButtonBuilder().setCustomId('owner_leave_cancel').setLabel('إلغاء').setStyle(ButtonStyle.Secondary).setEmoji('❌')
      );
      return interaction.update({ ...embedMsg(bi(interaction, `⚠️ متأكد تبي تطلع البوت من **${guild.name}**؟ هذا الإجراء لا يمكن التراجع عنه (لازم أحد يعيد دعوة البوت مرة ثانية).`, `⚠️ Are you sure you want the bot to leave **${guild.name}**? This action cannot be undone (someone would need to re-invite the bot).`)), components: [row] });
    }

    if (interaction.customId.startsWith('owner_leave_confirm_')) {
      const guildId = interaction.customId.replace('owner_leave_confirm_', '');
      const guild = client.guilds.cache.get(guildId);
      if (!guild) return interaction.update({ ...embedMsg(bi(interaction, '❌ ما لقيت هذا السيرفر.', "❌ I couldn't find this server.")), components: [] });
      const name = guild.name;
      try {
        await guild.leave();
        return interaction.update({ ...embedMsg(bi(interaction, `✅ طلع البوت من **${name}** بنجاح.`, `✅ The bot left **${name}** successfully.`)), components: [] });
      } catch (e) {
        console.error('فشل الخروج من السيرفر:', e);
        return interaction.update({ ...embedMsg(bi(interaction, '❌ حدث خطأ أثناء محاولة المغادرة.', "❌ An error occurred while trying to leave.")), components: [] });
      }
    }

    if (interaction.customId === 'owner_leave_cancel') {
      return interaction.update({ ...embedMsg(bi(interaction, '❌ تم إلغاء المغادرة.', "❌ Leave cancelled.")), components: [] });
    }
  }

  if ((interaction.isButton() || interaction.isAnySelectMenu()) && interaction.customId.startsWith('ow_')) return handleOwnerComponent(interaction);

  // ==========================================
  // ⚙️ SETTINGS UI: BUTTONS / STRING-SELECT / ROLE-SELECT / CHANNEL-SELECT / USER-SELECT
  // ==========================================
  const isSettingsComponent = interaction.isButton() || interaction.isStringSelectMenu() || interaction.isRoleSelectMenu() || interaction.isChannelSelectMenu() || interaction.isUserSelectMenu();
  if (isSettingsComponent) {
    const cid = interaction.customId;
    const looksLikeSettings = cid === 'settings_main' || cid === 'settings_back' || cid.startsWith('rm_') || cid.startsWith('vm_') || cid.startsWith('sw_') || cid.startsWith('adm_') || cid.startsWith('gm_') || cid.startsWith('pm_');
    if (looksLikeSettings) {
      if (!interaction.member.permissions.has(PermissionFlagsBits.Administrator)) {
        return interaction.reply({ ...embedMsg(bi(interaction, '❌ للمسؤولين فقط.', "❌ Administrators only.")), ephemeral: true });
      }
      const settings = getServerSettings(interaction.guild.id);

      // ---- تنقّل رئيسي ----
      if (cid === 'settings_main') {
        const choice = interaction.values[0];
        if (choice === 'rolemaker') return interaction.update({ embeds: [getRoleMakerEmbed(settings)], components: getRoleMakerComponents() });
        if (choice === 'voicemaker') return interaction.update({ embeds: [getVoiceMakerEmbed(settings)], components: getVoiceMakerComponents() });
        if (choice === 'staffwarn') return interaction.update({ embeds: [getStaffWarnEmbed(settings)], components: getStaffWarnComponents() });
        if (choice === 'admin') return interaction.update({ embeds: [getAdminEmbed(settings)], components: getAdminComponents(settings) });
        if (choice === 'games') return interaction.update({ embeds: [getGamesEmbed(settings)], components: getGamesComponents() });
        if (choice === 'premium') return interaction.update({ embeds: [getPremiumEmbed(interaction.guild, settings)], components: getPremiumComponents(interaction.guild) });
      }
      if (cid === 'settings_back') {
        return interaction.update({ embeds: [getSettingsMainEmbed()], components: getSettingsMainComponents() });
      }

      // ---- 🎭 رول ميكر ----
      if (cid === 'rm_backpanel') return interaction.update({ embeds: [getRoleMakerEmbed(settings)], components: getRoleMakerComponents() });

      if (cid === 'rm_baserole') {
        return interaction.update({
          ...embedMsg(bi(interaction, 'اختر رتبة الأساس الجديدة:', "Choose the new base role:")),
          components: [new ActionRowBuilder().addComponents(new RoleSelectMenuBuilder().setCustomId('rm_baserole_pick').setPlaceholder('اختر الرتبة')), backRow('rm_backpanel')]
        });
      }
      if (cid === 'rm_baserole_pick') {
        settings.baseRoleId = interaction.values[0]; saveDatabase(db);
        return interaction.update({ ...embedMsg(bi(interaction, `✅ تم تعيين رتبة الأساس: <@&${settings.baseRoleId}>`, `✅ Base role set: <@&${settings.baseRoleId}>`)), components: [backRow('rm_backpanel')] });
      }

      if (cid === 'rm_category') {
        return interaction.update({
          ...embedMsg(bi(interaction, 'اختر الكاتيجوري:', "Choose the category:")),
          components: [new ActionRowBuilder().addComponents(new ChannelSelectMenuBuilder().setCustomId('rm_category_pick').setPlaceholder('اختر الكاتيجوري').setChannelTypes(ChannelType.GuildCategory)), backRow('rm_backpanel')]
        });
      }
      if (cid === 'rm_category_pick') {
        settings.categoryId = interaction.values[0]; saveDatabase(db);
        return interaction.update({ ...embedMsg(bi(interaction, `✅ تم تعيين الكاتيجوري: <#${settings.categoryId}>`, `✅ Category set: <#${settings.categoryId}>`)), components: [backRow('rm_backpanel')] });
      }

      if (cid === 'rm_logchannel') {
        return interaction.update({
          ...embedMsg(bi(interaction, 'اختر قناة السجلات:', "Choose the log channel:")),
          components: [new ActionRowBuilder().addComponents(new ChannelSelectMenuBuilder().setCustomId('rm_logchannel_pick').setPlaceholder('اختر القناة').setChannelTypes(ChannelType.GuildText)), backRow('rm_backpanel')]
        });
      }
      if (cid === 'rm_logchannel_pick') {
        settings.logChannelId = interaction.values[0]; saveDatabase(db);
        return interaction.update({ ...embedMsg(bi(interaction, `✅ تم تعيين قناة السجلات: <#${settings.logChannelId}>`, `✅ Log channel set: <#${settings.logChannelId}>`)), components: [backRow('rm_backpanel')] });
      }

      if (cid === 'rm_allowedrole') {
        return interaction.update({
          ...embedMsg(bi(interaction, 'اختر الرتبة المسموحة باستخدام النظام:', "Choose the role allowed to use the system:")),
          components: [new ActionRowBuilder().addComponents(new RoleSelectMenuBuilder().setCustomId('rm_allowedrole_pick').setPlaceholder('اختر الرتبة')), backRow('rm_backpanel')]
        });
      }
      if (cid === 'rm_allowedrole_pick') {
        settings.allowedRoleId = interaction.values[0]; saveDatabase(db);
        return interaction.update({ ...embedMsg(bi(interaction, `✅ تم تحديد الرتبة المسموحة: <@&${settings.allowedRoleId}>`, `✅ Allowed role set: <@&${settings.allowedRoleId}>`)), components: [backRow('rm_backpanel')] });
      }

      if (cid === 'rm_embedimage') {
        const modal = new ModalBuilder().setCustomId('modal_rm_embedimage').setTitle('صورة إمبيد لوحة الرتب');
        modal.addComponents(new ActionRowBuilder().addComponents(
          new TextInputBuilder().setCustomId('input_url').setLabel('رابط الصورة (يبدأ بـ http:// أو https://)').setStyle(TextInputStyle.Short).setRequired(true)
        ));
        return interaction.showModal(modal);
      }

      if (cid === 'rm_sendpanel') {
        return interaction.update({
          ...embedMsg(bi(interaction, 'اختر القناة اللي تبي ترسل فيها لوحة الرتب:', "Choose the channel to send the roles panel to:")),
          components: [new ActionRowBuilder().addComponents(new ChannelSelectMenuBuilder().setCustomId('rm_sendpanel_pick').setPlaceholder('اختر القناة').setChannelTypes(ChannelType.GuildText)), backRow('rm_backpanel')]
        });
      }
      if (cid === 'rm_sendpanel_pick') {
        const targetChannel = interaction.guild.channels.cache.get(interaction.values[0]);
        let usedFallback = false;
        try {
          usedFallback = await sendRolePanel(targetChannel, settings);
        } catch (e) {
          console.error('فشل إرسال لوحة الرتب:', e);
          return interaction.update({ ...embedMsg(bi(interaction, '❌ حدث خطأ أثناء إرسال اللوحة.', "❌ An error occurred while sending the panel.")), components: [backRow('rm_backpanel')] });
        }
        let msg = `✅ تم إرسال لوحة الرتب في ${targetChannel}.`;
        if (usedFallback) msg += `\n⚠️ رابط صورة الإمبيد المحفوظ كان غير صالح، فاستخدمت الصورة الافتراضية وحذفت الرابط الغلط — حط رابط صحيح من زر "صورة الإمبيد".`;
        return interaction.update({ ...embedMsg(msg), components: [backRow('rm_backpanel')] });
      }

      if (cid === 'rm_emoji_select') {
        const target = interaction.values[0];
        const info = ROLE_EMOJI_TARGETS.find(t => t.value === target);
        const modal = new ModalBuilder().setCustomId(`modal_rm_emoji_${target}`).setTitle(`إيموجي: ${info ? info.name : ''}`);
        modal.addComponents(new ActionRowBuilder().addComponents(
          new TextInputBuilder().setCustomId('input_emoji').setLabel('الإيموجي الجديد').setStyle(TextInputStyle.Short).setRequired(true)
        ));
        return interaction.showModal(modal);
      }

      if (cid === 'rm_toggle_gradient') {
        settings.allowGradient = !settings.allowGradient; saveDatabase(db);
        return interaction.update({ embeds: [getRoleMakerEmbed(settings)], components: getRoleMakerComponents() });
      }
      if (cid === 'rm_toggle_images') {
        settings.allowImages = !settings.allowImages; saveDatabase(db);
        return interaction.update({ embeds: [getRoleMakerEmbed(settings)], components: getRoleMakerComponents() });
      }

      // ---- 🔊 فويس ميكر ----
      if (cid === 'vm_backpanel') return interaction.update({ embeds: [getVoiceMakerEmbed(settings)], components: getVoiceMakerComponents() });

      if (cid === 'vm_joinchannel') {
        return interaction.update({
          ...embedMsg(bi(interaction, 'اختر روم الإنشاء الصوتي (الهب):', "Choose the voice creation channel (hub):")),
          components: [new ActionRowBuilder().addComponents(new ChannelSelectMenuBuilder().setCustomId('vm_joinchannel_pick').setPlaceholder('اختر الروم الصوتي').setChannelTypes(ChannelType.GuildVoice)), backRow('vm_backpanel')]
        });
      }
      if (cid === 'vm_joinchannel_pick') {
        settings.voiceHubChannelId = interaction.values[0]; saveDatabase(db);
        return interaction.update({ ...embedMsg(bi(interaction, `✅ تم تعيين روم الإنشاء: <#${settings.voiceHubChannelId}>`, `✅ Creation channel set: <#${settings.voiceHubChannelId}>`)), components: [backRow('vm_backpanel')] });
      }

      if (cid === 'vm_category') {
        return interaction.update({
          ...embedMsg(bi(interaction, 'اختر كاتيجوري الرومات المؤقتة:', "Choose the category for temporary rooms:")),
          components: [new ActionRowBuilder().addComponents(new ChannelSelectMenuBuilder().setCustomId('vm_category_pick').setPlaceholder('اختر الكاتيجوري').setChannelTypes(ChannelType.GuildCategory)), backRow('vm_backpanel')]
        });
      }
      if (cid === 'vm_category_pick') {
        settings.voiceCategoryId = interaction.values[0]; saveDatabase(db);
        return interaction.update({ ...embedMsg(bi(interaction, `✅ تم تعيين كاتيجوري الرومات: <#${settings.voiceCategoryId}>`, `✅ Rooms category set: <#${settings.voiceCategoryId}>`)), components: [backRow('vm_backpanel')] });
      }

      if (cid === 'vm_logchannel') {
        return interaction.update({
          ...embedMsg(bi(interaction, 'اختر قناة سجلات الفويس:', "Choose the voice log channel:")),
          components: [new ActionRowBuilder().addComponents(new ChannelSelectMenuBuilder().setCustomId('vm_logchannel_pick').setPlaceholder('اختر القناة').setChannelTypes(ChannelType.GuildText)), backRow('vm_backpanel')]
        });
      }
      if (cid === 'vm_logchannel_pick') {
        settings.voiceLogChannelId = interaction.values[0]; saveDatabase(db);
        return interaction.update({ ...embedMsg(bi(interaction, `✅ تم تعيين قناة سجلات الفويس: <#${settings.voiceLogChannelId}>`, `✅ Voice log channel set: <#${settings.voiceLogChannelId}>`)), components: [backRow('vm_backpanel')] });
      }

      if (cid === 'vm_sendpanel') {
        return interaction.update({
          ...embedMsg(bi(interaction, 'اختر القناة اللي تبي ترسل فيها لوحة معلومات الفويس:', "Choose the channel to send the voice info panel to:")),
          components: [new ActionRowBuilder().addComponents(new ChannelSelectMenuBuilder().setCustomId('vm_sendpanel_pick').setPlaceholder('اختر القناة').setChannelTypes(ChannelType.GuildText)), backRow('vm_backpanel')]
        });
      }
      if (cid === 'vm_sendpanel_pick') {
        const targetChannel = interaction.guild.channels.cache.get(interaction.values[0]);
        settings.voicePanelChannelId = targetChannel.id; saveDatabase(db);
        try {
          await sendVoicePanel(targetChannel, settings);
        } catch (e) {
          console.error('فشل إرسال لوحة الفويس:', e);
          return interaction.update({ ...embedMsg(bi(interaction, '❌ حدث خطأ أثناء إرسال اللوحة.', "❌ An error occurred while sending the panel.")), components: [backRow('vm_backpanel')] });
        }
        return interaction.update({ ...embedMsg(bi(interaction, `✅ تم إرسال لوحة معلومات الفويس في ${targetChannel}.`, `✅ The voice info panel was sent to ${targetChannel}.`)), components: [backRow('vm_backpanel')] });
      }

      if (cid === 'vm_emoji_select') {
        const target = interaction.values[0];
        const info = VC_EMOJI_TARGETS.find(t => t.value === target);
        const modal = new ModalBuilder().setCustomId(`modal_vm_emoji_${target}`).setTitle(`إيموجي: ${info ? info.name : ''}`);
        modal.addComponents(new ActionRowBuilder().addComponents(
          new TextInputBuilder().setCustomId('input_emoji').setLabel('الإيموجي الجديد').setStyle(TextInputStyle.Short).setRequired(true)
        ));
        return interaction.showModal(modal);
      }

      // ---- 🛡️ تحذير الإدارة ----
      if (cid === 'sw_backpanel') return interaction.update({ embeds: [getStaffWarnEmbed(settings)], components: getStaffWarnComponents() });

      if (cid === 'sw_setrole') {
        return interaction.update({
          ...embedMsg(bi(interaction, 'اختر رتبة الستاف:', "Choose the staff role:")),
          components: [new ActionRowBuilder().addComponents(new RoleSelectMenuBuilder().setCustomId('sw_setrole_pick').setPlaceholder('اختر الرتبة')), backRow('sw_backpanel')]
        });
      }
      if (cid === 'sw_setrole_pick') {
        settings.staffRoleId = interaction.values[0]; saveDatabase(db);
        return interaction.update({ ...embedMsg(bi(interaction, `✅ تم تحديد رتبة الستاف: <@&${settings.staffRoleId}>`, `✅ Staff role set: <@&${settings.staffRoleId}>`)), components: [backRow('sw_backpanel')] });
      }
      if (cid === 'sw_removerole') {
        settings.staffRoleId = null; saveDatabase(db);
        return interaction.update({ embeds: [getStaffWarnEmbed(settings)], components: getStaffWarnComponents() });
      }

      // ---- 🛠️ الإدارة ----
      if (cid === 'adm_backpanel') return interaction.update({ embeds: [getAdminEmbed(settings)], components: getAdminComponents(settings) });

      if (cid === 'adm_rlshortcut') {
        if (settings.rlShortcutOn) {
          settings.rlShortcutOn = false; saveDatabase(db);
          return interaction.update({ embeds: [getAdminEmbed(settings)], components: getAdminComponents(settings) });
        }
        return interaction.update({
          ...embedMsg(bi(interaction, 'اختر الروم اللي يشتغل فيه الاختصار: كتابة **-روليت** فيه تبدأ روليت، و**-الغاء** تلغيها.', 'Choose the channel for the shortcut: typing **-روليت** starts a roulette and **-الغاء** cancels it.')),
          components: [new ActionRowBuilder().addComponents(new ChannelSelectMenuBuilder().setCustomId('adm_rlshortcut_pick').setPlaceholder('اختر الروم').setChannelTypes(ChannelType.GuildText)), backRow('adm_backpanel')]
        });
      }
      if (cid === 'adm_rlshortcut_pick') {
        settings.rlShortcutChannelId = interaction.values[0]; settings.rlShortcutOn = true; saveDatabase(db);
        return interaction.update({ embeds: [getAdminEmbed(settings)], components: getAdminComponents(settings) });
      }

      if (cid === 'adm_lock') {
        return interaction.update({
          ...embedMsg(bi(interaction, 'اختر الروم اللي تبي تقفله (يمنع الكل من الكتابة فيه):', "Choose the channel you want to lock (prevents everyone from sending messages in it):")),
          components: [new ActionRowBuilder().addComponents(new ChannelSelectMenuBuilder().setCustomId('adm_lock_pick').setPlaceholder('اختر الروم').setChannelTypes(ChannelType.GuildText)), backRow('adm_backpanel')]
        });
      }
      if (cid === 'adm_lock_pick') {
        const channel = interaction.guild.channels.cache.get(interaction.values[0]);
        try {
          await channel.permissionOverwrites.edit(interaction.guild.roles.everyone.id, { SendMessages: false });
          return interaction.update({ ...embedMsg(bi(interaction, `🔒 تم قفل ${channel} بنجاح.`, `🔒 ${channel} was locked successfully.`)), components: [backRow('adm_backpanel')] });
        } catch (e) {
          console.error('فشل قفل الروم:', e);
          return interaction.update({ ...embedMsg(bi(interaction, '❌ ما قدرت أقفل الروم (تأكد من صلاحيات البوت).', "❌ I couldn't lock the room (check the bot's permissions).")), components: [backRow('adm_backpanel')] });
        }
      }

      if (cid === 'adm_unlock') {
        return interaction.update({
          ...embedMsg(bi(interaction, 'اختر الروم اللي تبي تفتحه:', "Choose the channel you want to unlock:")),
          components: [new ActionRowBuilder().addComponents(new ChannelSelectMenuBuilder().setCustomId('adm_unlock_pick').setPlaceholder('اختر الروم').setChannelTypes(ChannelType.GuildText)), backRow('adm_backpanel')]
        });
      }
      if (cid === 'adm_unlock_pick') {
        const channel = interaction.guild.channels.cache.get(interaction.values[0]);
        try {
          await channel.permissionOverwrites.edit(interaction.guild.roles.everyone.id, { SendMessages: null });
          return interaction.update({ ...embedMsg(bi(interaction, `🔓 تم فتح ${channel} بنجاح.`, `🔓 ${channel} was unlocked successfully.`)), components: [backRow('adm_backpanel')] });
        } catch (e) {
          console.error('فشل فتح الروم:', e);
          return interaction.update({ ...embedMsg(bi(interaction, '❌ ما قدرت أفتح الروم.', "❌ I couldn't unlock the room.")), components: [backRow('adm_backpanel')] });
        }
      }

      if (cid === 'adm_purge') {
        return interaction.update({
          ...embedMsg(bi(interaction, 'اختر الروم اللي تبي تحذف منه رسائل:', "Choose the channel you want to delete messages from:")),
          components: [new ActionRowBuilder().addComponents(new ChannelSelectMenuBuilder().setCustomId('adm_purge_pick').setPlaceholder('اختر الروم').setChannelTypes(ChannelType.GuildText)), backRow('adm_backpanel')]
        });
      }
      if (cid === 'adm_purge_pick') {
        const channelId = interaction.values[0];
        const modal = new ModalBuilder().setCustomId(`modal_adm_purge_${channelId}`).setTitle('حذف رسائل');
        modal.addComponents(new ActionRowBuilder().addComponents(
          new TextInputBuilder().setCustomId('input_count').setLabel('عدد الرسائل (1-100)').setStyle(TextInputStyle.Short).setRequired(true)
        ));
        return interaction.showModal(modal);
      }

      if (cid === 'adm_warn') {
        return interaction.update({
          ...embedMsg(bi(interaction, 'اختر العضو اللي تبي تحذره:', "Choose the member you want to warn:")),
          components: [new ActionRowBuilder().addComponents(new UserSelectMenuBuilder().setCustomId('adm_warn_pick').setPlaceholder('اختر العضو')), backRow('adm_backpanel')]
        });
      }
      if (cid === 'adm_warn_pick') {
        const userId = interaction.values[0];
        const modal = new ModalBuilder().setCustomId(`modal_adm_warn_${userId}`).setTitle('سبب التحذير');
        modal.addComponents(new ActionRowBuilder().addComponents(
          new TextInputBuilder().setCustomId('input_reason').setLabel('سبب التحذير').setStyle(TextInputStyle.Paragraph).setRequired(true)
        ));
        return interaction.showModal(modal);
      }

      if (cid === 'adm_warnlist') {
        return interaction.update({
          ...embedMsg(bi(interaction, 'اختر العضو اللي تبي تشوف تحذيراته:', "Choose the member whose warnings you want to view:")),
          components: [new ActionRowBuilder().addComponents(new UserSelectMenuBuilder().setCustomId('adm_warnlist_pick').setPlaceholder('اختر العضو')), backRow('adm_backpanel')]
        });
      }
      if (cid === 'adm_warnlist_pick') {
        const userId = interaction.values[0];
        const warnings = (db.userWarnings && db.userWarnings[userId]) || [];
        if (warnings.length === 0) {
          return interaction.update({ ...embedMsg(bi(interaction, `ℹ️ العضو <@${userId}> ما عليه أي تحذيرات.`, `ℹ️ Member <@${userId}> has no warnings.`)), components: [backRow('adm_backpanel')] });
        }
        const lang = getUserLang(interaction.guild.id);
        const list = warnings.map((w, i) => lang === 'en'
          ? `**#${i + 1}** — ${w.reason}\nBy: <@${w.moderatorId}> — <t:${Math.floor(w.timestamp / 1000)}:R>`
          : `**#${i + 1}** — ${w.reason}\nمن: <@${w.moderatorId}> — <t:${Math.floor(w.timestamp / 1000)}:R>`
        ).join('\n\n');
        const warnTitle = bi(interaction, `⚠️ تحذيرات <@${userId}> (${warnings.length})`, `⚠️ Warnings for <@${userId}> (${warnings.length})`);
        return interaction.update({ ...embedMsg(list, { title: warnTitle }), components: [backRow('adm_backpanel')] });
      }

      // ---- 🎮 الألعاب ----
      if (cid === 'gm_backpanel') return interaction.update({ embeds: [getGamesEmbed(settings)], components: getGamesComponents() });

      if (cid === 'gm_profilechannel') {
        return interaction.update({
          ...embedMsg(bi(interaction, 'اختر روم الأوامر — كتابة p فيه ترسل بطاقة البروفايل:', "Choose the commands channel — typing p in it sends the profile card:")),
          components: [new ActionRowBuilder().addComponents(new ChannelSelectMenuBuilder().setCustomId('gm_profilechannel_pick').setPlaceholder('اختر الروم').setChannelTypes(ChannelType.GuildText)), backRow('gm_backpanel')]
        });
      }
      if (cid === 'gm_profilechannel_pick') {
        settings.gamesChannelId = interaction.values[0]; saveDatabase(db);
        return interaction.update({ ...embedMsg(bi(interaction, `✅ تم تحديد روم الأوامر: <#${settings.gamesChannelId}>`, `✅ Commands channel set: <#${settings.gamesChannelId}>`)), components: [backRow('gm_backpanel')] });
      }

      if (cid === 'gm_rouletteconfig') {
        const modal = new ModalBuilder().setCustomId('modal_gm_rouletteconfig').setTitle('إعدادات الروليت');
        modal.addComponents(
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('input_win').setLabel('نقاط الفوز بكل جولة').setStyle(TextInputStyle.Short).setRequired(true).setValue(String(settings.rouletteWinPoints))),
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('input_lose').setLabel('نقاط الخسارة/الطرد').setStyle(TextInputStyle.Short).setRequired(true).setValue(String(settings.rouletteLosePoints))),
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('input_bonus').setLabel('مكافأة الفوز النهائي').setStyle(TextInputStyle.Short).setRequired(true).setValue(String(settings.rouletteFinalBonus))),
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('input_max').setLabel('أقصى عدد لاعبين (2-25)').setStyle(TextInputStyle.Short).setRequired(true).setValue(String(settings.rouletteMaxPlayers)))
        );
        return interaction.showModal(modal);
      }

      // ---- 🎮 تشغيل أوامر الألعاب مباشرة من لوحة الإعدادات ----
      if (cid.startsWith('gm_open_')) return runGameCommand(interaction, cid.replace('gm_open_', ''));

      // ---- 🌟 بريميوم ----
      if (cid.startsWith('pm_')) { await handlePremiumComponent(interaction, settings); return; }

      return; // أي customId إعدادات غير متوقع يتجاهل بأمان
    }
  }

  // ==========================================
  // 🎮 الألعاب: روليت / متجر / تعديل / درع
  // ==========================================
  if ((interaction.isButton() || interaction.isStringSelectMenu()) && interaction.guild) {
    if (await handleGamesComponent(interaction)) return;
  }

  // ==========================================
  // BUTTONS & STRING-SELECT: النظام الصوتي / نظام الرتب (كما كان)
  // ==========================================
  if (interaction.isButton() || interaction.isStringSelectMenu()) {
    const settings = getServerSettings(interaction.guild.id);

    if (interaction.customId.startsWith('vc_approve_') || interaction.customId.startsWith('vc_deny_')) {
      const room = db.voiceRooms[interaction.channel.id];
      if (!room) return interaction.reply({ ...embedMsg(bi(interaction, '❌ هذا الروم غير مسجل بالنظام.', "❌ This room isn't registered in the system.")), ephemeral: true });
      if (interaction.user.id !== room.ownerId) return interaction.reply({ ...embedMsg(bi(interaction, '❌ بس صاحب الروم يقدر يوافق أو يرفض.', "❌ Only the room owner can approve or deny.")), ephemeral: true });

      const isApprove = interaction.customId.startsWith('vc_approve_');
      const targetId = interaction.customId.replace(isApprove ? 'vc_approve_' : 'vc_deny_', '');
      const targetMember = await interaction.guild.members.fetch(targetId).catch(() => null);

      if (isApprove) {
        await interaction.channel.permissionOverwrites.edit(targetId, { ViewChannel: true, Connect: true }).catch(() => {});
        if (targetMember && room.waitingRoomChannelId && targetMember.voice.channelId === room.waitingRoomChannelId) {
          await targetMember.voice.setChannel(interaction.channel).catch(() => {});
        }
        return interaction.update({ ...embedMsg(bi(interaction, `✅ تم قبول <@${targetId}> بالروم.`, `✅ <@${targetId}> was accepted into the room.`)), components: [] });
      } else {
        if (targetMember && targetMember.voice.channelId) await targetMember.voice.disconnect().catch(() => {});
        return interaction.update({ ...embedMsg(bi(interaction, `❌ تم رفض طلب <@${targetId}>.`, `❌ <@${targetId}>'s request was denied.`)), components: [] });
      }
    }

    if (interaction.customId.startsWith('vc_')) {
      const room = db.voiceRooms[interaction.channel.id];
      if (!room) return interaction.reply({ ...embedMsg(bi(interaction, '❌ هذا الروم غير مسجل بالنظام (قد يكون قديم).', "❌ This room isn't registered in the system (it may be outdated).")), ephemeral: true });
      const id = interaction.customId;

      if (id === 'vc_help') {
        return interaction.reply({ ...embedMsg(bi(interaction, '📖 اختر الزر اللي تبي تعرف وظيفته:', "📖 Choose the button you want to know about:")), components: [getVoiceHelpSelectRow(settings)], ephemeral: true });
      }
      if (id === 'vc_help_select') {
        const chosen = interaction.values[0];
        {
          const entry = VC_HELP_TEXTS[chosen];
          const lang = getUserLang(interaction.guild.id);
          const helpText = entry ? (lang === 'en' ? entry.en : entry.ar) : bi(interaction, 'ما فيه شرح متوفر لهذا الزر حالياً.', "No help text is available for this button yet.");
          return interaction.reply({ ...embedMsg(helpText), ephemeral: true });
        }
      }

      if (id === 'vc_rename') {
        if (!isRoomOwner(room, interaction.user.id)) return interaction.reply({ ...embedMsg(t(interaction.guild.id, 'notOwner')), ephemeral: true });
        const modal = new ModalBuilder().setCustomId('modal_vc_rename').setTitle('تغيير اسم الروم');
        modal.addComponents(new ActionRowBuilder().addComponents(
          new TextInputBuilder().setCustomId('input_name').setLabel('الاسم الجديد').setStyle(TextInputStyle.Short).setRequired(true).setValue(room.name || '')
        ));
        return interaction.showModal(modal);
      }

      if (id === 'vc_limit') {
        if (!isRoomOwner(room, interaction.user.id)) return interaction.reply({ ...embedMsg(t(interaction.guild.id, 'notOwner')), ephemeral: true });
        const modal = new ModalBuilder().setCustomId('modal_vc_limit').setTitle('حد الأعضاء');
        modal.addComponents(new ActionRowBuilder().addComponents(
          new TextInputBuilder().setCustomId('input_limit').setLabel('العدد الأقصى (0 = بدون حد)').setStyle(TextInputStyle.Short).setRequired(true)
        ));
        return interaction.showModal(modal);
      }

      if (id === 'vc_privacy') {
        if (!isRoomOwner(room, interaction.user.id)) return interaction.reply({ ...embedMsg(t(interaction.guild.id, 'notOwner')), ephemeral: true });
        room.locked = !room.locked; saveDatabase(db);
        await interaction.channel.permissionOverwrites.edit(interaction.guild.roles.everyone.id, { Connect: !room.locked }).catch(() => {});
        return interaction.reply({ ...embedMsg(bi(interaction, `🔒 الروم الآن: ${room.locked ? 'مقفل 🔒' : 'مفتوح 🔓'}`, `🔒 The room is now: ${room.locked ? 'locked 🔒' : 'open 🔓'}`)), ephemeral: true });
      }

      if (id === 'vc_joinrequest') {
        if (interaction.user.id === room.ownerId) {
          room.requireApproval = !room.requireApproval; saveDatabase(db);
          return interaction.reply({ ...embedMsg(bi(interaction, `🔔 نظام طلب الانضمام الآن: ${room.requireApproval ? 'مفعّل ✅' : 'معطّل ❌'}`, `🔔 Join-request system is now: ${room.requireApproval ? 'enabled ✅' : 'disabled ❌'}`)), ephemeral: true });
        }
        if (!room.requireApproval) return interaction.reply({ ...embedMsg(bi(interaction, 'ℹ️ نظام طلب الانضمام غير مفعّل حالياً.', "ℹ️ The join-request system isn't enabled right now.")), ephemeral: true });

        await interaction.reply({ ...embedMsg(bi(interaction, '📨 تم إرسال طلبك لصاحب الروم، انتظر الموافقة.', "📨 Your request was sent to the room owner, wait for approval.")), ephemeral: true });
        if (room.waitingRoomEnabled && interaction.member.voice.channelId) {
          const waitingChannel = await ensureWaitingRoomChannel(interaction.guild, room, interaction.channel);
          await interaction.member.voice.setChannel(waitingChannel).catch(() => {});
        }
        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(`vc_approve_${interaction.user.id}`).setLabel('قبول').setStyle(ButtonStyle.Success).setEmoji('✅'),
          new ButtonBuilder().setCustomId(`vc_deny_${interaction.user.id}`).setLabel('رفض').setStyle(ButtonStyle.Danger).setEmoji('❌')
        );
        await interaction.channel.send({ ...embedMsg(bi(interaction, `🔔 <@${room.ownerId}> — العضو <@${interaction.user.id}> يطلب الانضمام.`, `🔔 <@${room.ownerId}> — member <@${interaction.user.id}> is requesting to join.`)), components: [row] });
        return;
      }

      if (id === 'vc_trust' || id === 'vc_untrust' || id === 'vc_kick' || id === 'vc_ban' || id === 'vc_unban' || id === 'vc_transfer') {
        if (!isRoomOwner(room, interaction.user.id)) return interaction.reply({ ...embedMsg(t(interaction.guild.id, 'notOwner')), ephemeral: true });
        const prompts = {
          vc_trust: '👤 منشن العضو اللي تبي تعطيه ثقة (خلال 30 ثانية).',
          vc_untrust: '👤 منشن العضو اللي تبي تسحب منه الثقة (خلال 30 ثانية).',
          vc_kick: '👤 منشن العضو اللي تبي تطرده من الروم (خلال 30 ثانية).',
          vc_ban: '👤 منشن العضو اللي تبي تحظره (خلال 30 ثانية).',
          vc_unban: '👤 منشن العضو اللي تبي ترفع عنه الحظر (خلال 30 ثانية).',
          vc_transfer: '👤 منشن العضو اللي تبي تنقل له ملكية الروم (خلال 30 ثانية).'
        };
        const target = await collectMentionedMember(interaction, prompts[id]);
        if (!target) return interaction.followUp({ ...embedMsg(bi(interaction, '⌛ انتهى الوقت ولا تم تحديد عضو.', "⌛ Time's up, no member was selected.")), ephemeral: true });

        if (id === 'vc_trust') {
          if (!room.trustedUsers.includes(target.id)) room.trustedUsers.push(target.id);
          saveDatabase(db);
          await interaction.channel.permissionOverwrites.edit(target.id, { ViewChannel: true, Connect: true }).catch(() => {});
          return interaction.followUp({ ...embedMsg(bi(interaction, `✅ تم منح الثقة لـ ${target}.`, `✅ Trust was granted to ${target}.`)), ephemeral: true });
        }
        if (id === 'vc_untrust') {
          room.trustedUsers = room.trustedUsers.filter(uid => uid !== target.id);
          saveDatabase(db);
          await interaction.channel.permissionOverwrites.delete(target.id).catch(() => {});
          return interaction.followUp({ ...embedMsg(bi(interaction, `➖ تم سحب الثقة من ${target}.`, `➖ Trust was revoked from ${target}.`)), ephemeral: true });
        }
        if (id === 'vc_kick') {
          if (target.voice.channelId !== interaction.channel.id) return interaction.followUp({ ...embedMsg(bi(interaction, '❌ هذا العضو مو موجود بالروم.', "❌ This member isn't in the room.")), ephemeral: true });
          await target.voice.disconnect().catch(() => {});
          return interaction.followUp({ ...embedMsg(bi(interaction, `✂️ تم طرد ${target} من الروم.`, `✂️ ${target} was kicked from the room.`)), ephemeral: true });
        }
        if (id === 'vc_ban') {
          if (!room.bannedUsers.includes(target.id)) room.bannedUsers.push(target.id);
          saveDatabase(db);
          await interaction.channel.permissionOverwrites.edit(target.id, { ViewChannel: true, Connect: false }).catch(() => {});
          if (target.voice.channelId === interaction.channel.id) await target.voice.disconnect().catch(() => {});
          return interaction.followUp({ ...embedMsg(bi(interaction, `🚫 تم حظر ${target} من هذا الروم.`, `🚫 ${target} was banned from this room.`)), ephemeral: true });
        }
        if (id === 'vc_unban') {
          room.bannedUsers = room.bannedUsers.filter(uid => uid !== target.id);
          saveDatabase(db);
          await interaction.channel.permissionOverwrites.delete(target.id).catch(() => {});
          return interaction.followUp({ ...embedMsg(bi(interaction, `✅ تم رفع الحظر عن ${target}.`, `✅ ${target} has been unbanned.`)), ephemeral: true });
        }
        if (id === 'vc_transfer') {
          const oldOwnerId = room.ownerId;
          room.ownerId = target.id;
          if (!room.trustedUsers.includes(target.id)) room.trustedUsers.push(target.id);
          saveDatabase(db);
          await interaction.channel.permissionOverwrites.edit(target.id, {
            ViewChannel: true, Connect: true, ManageChannels: true, MoveMembers: true, MuteMembers: true, DeafenMembers: true
          }).catch(() => {});
          return interaction.followUp({ ...embedMsg(bi(interaction, `🔁 تم نقل ملكية الروم من <@${oldOwnerId}> إلى ${target}.`, `🔁 Room ownership was transferred from <@${oldOwnerId}> to ${target}.`)), ephemeral: true });
        }
      }

      if (id === 'vc_trustedlist') {
        if (room.trustedUsers.length === 0) return interaction.reply({ ...embedMsg(bi(interaction, 'ℹ️ ما فيه أعضاء موثوقين حالياً بهذا الروم.', "ℹ️ There are no trusted members in this room right now.")), ephemeral: true });
        {
          const trustedList = room.trustedUsers.map(uid => `<@${uid}>`).join('\n');
          const trustedMsg = bi(interaction, `📋 الموثوقين الحاليين:\n${trustedList}`, `📋 Current trusted members:\n${trustedList}`);
          return interaction.reply({ ...embedMsg(trustedMsg), ephemeral: true });
        }
      }

      if (id === 'vc_status') {
        if (!isRoomOwner(room, interaction.user.id)) return interaction.reply({ ...embedMsg(t(interaction.guild.id, 'notOwner')), ephemeral: true });
        const modal = new ModalBuilder().setCustomId('modal_vc_status').setTitle('حالة الروم');
        modal.addComponents(new ActionRowBuilder().addComponents(
          new TextInputBuilder().setCustomId('input_status').setLabel('اكتب حالة الروم').setStyle(TextInputStyle.Short).setRequired(true)
        ));
        return interaction.showModal(modal);
      }

      if (id === 'vc_invite') {
        try {
          const invite = await interaction.channel.createInvite({ maxAge: 3600, maxUses: 5 });
          return interaction.reply({ ...embedMsg(bi(interaction, `🔗 رابط الدعوة (صالح ساعة، حتى 5 استخدامات): ${invite.url}`, `🔗 Invite link (valid for 1 hour, up to 5 uses): ${invite.url}`)), ephemeral: true });
        } catch (e) {
          return interaction.reply({ ...embedMsg(bi(interaction, '❌ ما قدرت أسوي رابط دعوة.', "❌ I couldn't create an invite link.")), ephemeral: true });
        }
      }

      if (id === 'vc_waitingroom') {
        if (!isRoomOwner(room, interaction.user.id)) return interaction.reply({ ...embedMsg(t(interaction.guild.id, 'notOwner')), ephemeral: true });
        room.waitingRoomEnabled = !room.waitingRoomEnabled; saveDatabase(db);
        return interaction.reply({ ...embedMsg(bi(interaction, `🕐 غرفة الانتظار الآن: ${room.waitingRoomEnabled ? 'مفعّلة ✅' : 'معطّلة ❌'}`, `🕐 Waiting room is now: ${room.waitingRoomEnabled ? 'enabled ✅' : 'disabled ❌'}`)), ephemeral: true });
      }

      if (id === 'vc_claim') {
        const ownerStillHere = interaction.channel.members.has(room.ownerId);
        if (ownerStillHere) return interaction.reply({ ...embedMsg(bi(interaction, '❌ صاحب الروم لسا موجود.', "❌ The room owner is still here.")), ephemeral: true });
        if (interaction.member.voice.channelId !== interaction.channel.id) return interaction.reply({ ...embedMsg(bi(interaction, '❌ لازم تكون داخل هذا الروم.', "❌ You need to be inside this room.")), ephemeral: true });
        room.ownerId = interaction.user.id;
        if (!room.trustedUsers.includes(interaction.user.id)) room.trustedUsers.push(interaction.user.id);
        saveDatabase(db);
        await interaction.channel.permissionOverwrites.edit(interaction.user.id, {
          ViewChannel: true, Connect: true, ManageChannels: true, MoveMembers: true, MuteMembers: true, DeafenMembers: true
        }).catch(() => {});
        return interaction.reply({ ...embedMsg(bi(interaction, '👑 مبروك! صرت مالك هذا الروم.', "👑 Congratulations! You're now the owner of this room.")), ephemeral: true });
      }

      if (id === 'vc_stats') {
        const stats = db.userVoiceStats[interaction.user.id] || { roomsCreated: 0 };
        const embed = new EmbedBuilder()
          .setTitle('📊 إحصائياتك الصوتية')
          .setDescription(`**عدد الرومات اللي أنشأتها:** ${stats.roomsCreated}\n**عدد أعضاء هذا الروم حالياً:** ${interaction.channel.members.size}\n**تاريخ إنشاء هذا الروم:** <t:${Math.floor(room.createdAt / 1000)}:R>`)
          .setColor(EMBED_COLOR);
        return interaction.reply({ embeds: [embed], ephemeral: true });
      }

      if (id === 'vc_mute' || id === 'vc_deafen') {
        if (!isOwnerOrTrusted(room, interaction.user.id)) return interaction.reply({ ...embedMsg(bi(interaction, '❌ بس صاحب الروم أو الموثوقين.', "❌ Only the room owner or trusted members can do this.")), ephemeral: true });
        const target = await collectMentionedMember(interaction, `👤 منشن العضو اللي تبي ${id === 'vc_mute' ? 'تكتمه' : 'تصمّمه'} (خلال 30 ثانية).`);
        if (!target) return interaction.followUp({ ...embedMsg(bi(interaction, '⌛ انتهى الوقت.', "⌛ Time's up.")), ephemeral: true });
        if (target.voice.channelId !== interaction.channel.id) return interaction.followUp({ ...embedMsg(bi(interaction, '❌ هذا العضو مو موجود بالروم.', "❌ This member isn't in the room.")), ephemeral: true });

        if (id === 'vc_mute') {
          const newState = !target.voice.serverMute;
          await target.voice.setMute(newState).catch(() => {});
          return interaction.followUp({ ...embedMsg(bi(interaction, `🔇 تم ${newState ? 'كتم' : 'إلغاء كتم'} ${target}.`, `🔇 ${target} has been ${newState ? 'muted' : 'unmuted'}.`)), ephemeral: true });
        } else {
          const newState = !target.voice.serverDeaf;
          await target.voice.setDeaf(newState).catch(() => {});
          return interaction.followUp({ ...embedMsg(bi(interaction, `🔕 تم ${newState ? 'إصمام' : 'إلغاء إصمام'} ${target}.`, `🔕 ${target} has been ${newState ? 'deafened' : 'undeafened'}.`)), ephemeral: true });
        }
      }

      if (id === 'vc_report') {
        const modal = new ModalBuilder().setCustomId('modal_vc_report').setTitle('إبلاغ عن مشكلة بالروم');
        modal.addComponents(new ActionRowBuilder().addComponents(
          new TextInputBuilder().setCustomId('input_reason').setLabel('اكتب المشكلة/البلاغ').setStyle(TextInputStyle.Paragraph).setRequired(true)
        ));
        return interaction.showModal(modal);
      }

      if (id === 'vc_delete') {
        if (!isRoomOwner(room, interaction.user.id)) return interaction.reply({ ...embedMsg(t(interaction.guild.id, 'notOwner')), ephemeral: true });
        await interaction.reply({ ...embedMsg(bi(interaction, '🗑️ جاري حذف الروم...', "🗑️ Deleting the room...")), ephemeral: true });
        delete db.voiceRooms[interaction.channel.id]; saveDatabase(db);
        setTimeout(() => interaction.channel.delete().catch(() => {}), 1500);
        return;
      }
      return;
    }

    // ---------- نظام الرتب ----------
    if (!checkMemberPermission(interaction)) {
      return interaction.reply({ ...embedMsg(bi(interaction, '❌ عذراً، لا تمتلك الصلاحية لاستخدام النظام.', "❌ Sorry, you don't have permission to use this system.")), ephemeral: true });
    }

    if (interaction.customId === 'open_lexa_setup') {
      await interaction.deferReply({ ephemeral: true });
      try {
        const channelName = `role-setup-${interaction.user.username.toLowerCase().replace(/[^a-z0-9]/g, '')}`;
        const channelOptions = {
          name: channelName,
          type: ChannelType.GuildText,
          permissionOverwrites: [
            { id: interaction.guild.id, deny: [PermissionsBitField.Flags.ViewChannel] },
            { id: interaction.user.id, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ReadMessageHistory] },
            { id: client.user.id, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ManageChannels] }
          ]
        };
        if (settings.categoryId) channelOptions.parent = settings.categoryId;
        const customChannel = await interaction.guild.channels.create(channelOptions);

        const entry = getRoleEntry(interaction.user.id);
        const existingRole = entry ? interaction.guild.roles.cache.get(entry.roleId) : null;
        const session = {
          userId: interaction.user.id,
          isEditing: !!existingRole,
          name: existingRole ? (entry.name || existingRole.name) : interaction.member.displayName,
          type: existingRole ? (entry.type || 'صلب') : 'صلب',
          primary: existingRole ? (entry.primary || existingRole.hexColor || '#3B0000') : '#3B0000',
          secondary: existingRole ? (entry.secondary || '#8B0000') : '#8B0000',
          iconType: existingRole ? (entry.iconType || 'none') : 'none',
          iconValue: existingRole ? (entry.iconValue || null) : null,
          uploadedEmojiUrl: existingRole ? (entry.uploadedEmojiUrl || null) : null,
          icon: existingRole && entry.iconType && entry.iconType !== 'none' ? 'محفوظ مسبقاً ✅' : 'بدون'
        };
        activeSetups.set(interaction.user.id, session);

        await customChannel.send({ embeds: [getLexaSetupEmbed(session, settings)], components: getLexaComponents(settings) });

        const timeoutObj = setTimeout(async () => {
          if (activeSetups.has(interaction.user.id)) { activeSetups.delete(interaction.user.id); await customChannel.delete().catch(() => {}); }
        }, 5 * 60 * 1000);
        session.timeoutObj = timeoutObj;

        return interaction.editReply(embedMsg(bi(interaction, `✅ تم إنشاء روم الإعدادات الخاص بك بنجاح: ${customChannel}`, `✅ Your setup room was created successfully: ${customChannel}`)));
      } catch (err) {
        console.error(err);
        return interaction.editReply(embedMsg(bi(interaction, '❌ حدث خطأ أثناء فتح الروم.', "❌ An error occurred while opening the room.")));
      }
    }

    const session = activeSetups.get(interaction.user.id);
    if (!session && interaction.customId !== 'my_role_info' && interaction.customId !== 'delete_my_role') {
      return interaction.reply({ ...embedMsg(bi(interaction, '❌ انتهت الجلسة أو تم إغلاق الروم.', "❌ The session has expired or the room was closed.")), ephemeral: true });
    }

    if (interaction.customId === 'lexa_set_name') {
      const modal = new ModalBuilder().setCustomId('modal_lexa_name').setTitle('اسم الرتبة');
      modal.addComponents(new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId('input_name').setLabel('اسم الرتبة').setStyle(TextInputStyle.Short).setRequired(true).setValue(session.name || '')
      ));
      return interaction.showModal(modal);
    }

    if (interaction.customId === 'lexa_select_type') {
      session.type = interaction.values[0] === 'gradient' ? 'متدرج' : 'صلب';
      await interaction.update({ embeds: [getLexaSetupEmbed(session, settings)], components: getLexaComponents(settings) });
    }

    if (interaction.customId === 'lexa_set_primary') {
      const modal = new ModalBuilder().setCustomId('modal_lexa_primary').setTitle('اللون الأساسي');
      modal.addComponents(new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId('input_primary').setLabel('كود اللون Hex (مثال: FFFFFF أو #FFFFFF)').setStyle(TextInputStyle.Short).setRequired(true).setValue(session.primary || '')
      ));
      return interaction.showModal(modal);
    }

    if (interaction.customId === 'lexa_set_secondary') {
      const modal = new ModalBuilder().setCustomId('modal_lexa_secondary').setTitle('اللون الثانوي');
      modal.addComponents(new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId('input_secondary').setLabel('كود اللون Hex (مثال: 00FF00 أو #00FF00)').setStyle(TextInputStyle.Short).setRequired(true).setValue(session.secondary || '')
      ));
      return interaction.showModal(modal);
    }

    if (interaction.customId === 'lexa_select_icon_mode') {
      const mode = interaction.values[0];
      if (mode === 'none') {
        session.icon = 'بدون'; session.iconType = 'none'; session.iconValue = null; session.uploadedEmojiUrl = null;
        return interaction.update({ embeds: [getLexaSetupEmbed(session, settings)], components: getLexaComponents(settings) });
      }
      if (mode === 'image') {
        const modal = new ModalBuilder().setCustomId('modal_lexa_image').setTitle('رفع ملصق/إيموجي للسيرفر');
        modal.addComponents(new ActionRowBuilder().addComponents(
          new TextInputBuilder().setCustomId('input_image').setLabel('رابط صورة الإيموجي المباشر (PNG/JPG)').setStyle(TextInputStyle.Short).setRequired(true)
        ));
        return interaction.showModal(modal);
      }
      if (mode === 'emoji') {
        await interaction.reply({ ...embedMsg(bi(interaction, '⌨️ **أرسل إيموجي أو ملصق (Sticker) في هذا الشات الآن (خلال 30 ثانية).**', "⌨️ **Send an emoji or sticker in this chat now (within 30 seconds).**")), ephemeral: true });
        const filter = m => m.author.id === interaction.user.id;
        const collector = interaction.channel.createMessageCollector({ filter, time: 30000, max: 1 });

        collector.on('collect', async m => {
          try {
            if (m.stickers && m.stickers.size > 0) {
              const sticker = m.stickers.first();
              const supportedFormat = sticker.format === StickerFormatType.PNG || sticker.format === StickerFormatType.APNG || sticker.format === StickerFormatType.GIF;
              if (!supportedFormat) {
                session.icon = '❌ هذا الملصق نوعه Lottie غير مدعوم'; session.iconType = 'none'; session.uploadedEmojiUrl = null;
              } else if (settings.allowImages) {
                try {
                  const rawName = `role_${interaction.user.username}`.replace(/[^a-zA-Z0-9_]/g, '');
                  const emojiName = (rawName || 'role_sticker').slice(0, 32);
                  const createdStickerEmoji = await interaction.guild.emojis.create({ attachment: sticker.url, name: emojiName });
                  session.icon = `ملصق مرفوع كإيموجي: ${createdStickerEmoji}`; session.iconType = 'upload'; session.uploadedEmojiUrl = sticker.url;
                } catch (stickerErr) {
                  console.error('فشل تحويل الملصق إلى إيموجي:', stickerErr);
                  session.icon = `ملصق: ${sticker.name}`; session.iconType = 'upload'; session.uploadedEmojiUrl = sticker.url;
                }
              } else {
                session.icon = `ملصق: ${sticker.name}`; session.iconType = 'upload'; session.uploadedEmojiUrl = sticker.url;
              }
            } else if (m.content && m.content.trim().length > 0) {
              const raw = m.content.trim();
              const customMatch = raw.match(/^<a?:[a-zA-Z0-9_]+:(\d+)>$/);
              if (customMatch) { session.iconType = 'custom'; session.iconValue = customMatch[1]; session.icon = raw; }
              else { session.iconType = 'unicode'; session.iconValue = raw; session.icon = raw; }
            }
          } finally {
            await m.delete().catch(() => {});
            await interaction.message.edit({ embeds: [getLexaSetupEmbed(session, settings)], components: getLexaComponents(settings) }).catch(() => {});
          }
        });
        return;
      }
    }

    if (interaction.customId === 'lexa_cancel_role') {
      if (session.timeoutObj) clearTimeout(session.timeoutObj);
      activeSetups.delete(interaction.user.id);
      await interaction.reply({ ...embedMsg(bi(interaction, `${settings.emojiFarewell || '👋'} تم الإلغاء وتدمير الروم.`, `${settings.emojiFarewell || '👋'} Cancelled, the room has been destroyed.`)), ephemeral: true });
      setTimeout(() => interaction.channel.delete().catch(() => {}), 1000);
    }

    if (interaction.customId === 'lexa_try_role') {
      if (processingRoleUsers.has(interaction.user.id)) {
        return interaction.reply({ ...embedMsg(bi(interaction, '⏳ في عملية جارية على رتبتك حالياً، انتظر لحظة وحاول مرة ثانية (عشان ما تتكرر الرتبة).', "⏳ There's already an operation running on your role, wait a moment and try again (to avoid duplicate roles).")), ephemeral: true });
      }
      processingRoleUsers.add(interaction.user.id);
      await interaction.deferReply({ ephemeral: true });
      try {
        const { role, warnings } = await createOrUpdateCustomRole(interaction.guild, interaction.member, session, settings);
        session.isEditing = true;
        let msg = `👀 جرب الآن! تم تطبيق رتبتك (**${role.name}**) على حسابك، تفقد اسمك بقائمة الأعضاء.`;
        if (warnings.includes('gradient')) msg += `\n⚠️ استخدمت دمج اللونين بدل التدرج الحقيقي.`;
        if (warnings.includes('icon')) msg += `\n⚠️ ما قدرنا نضيف الأيقونة/الإيموجي حالياً.`;
        if (warnings.includes('position')) msg += `\n⚠️ ما قدرنا نحط الرتبة بموضعها الصحيح فوق رتبة الأساس — تأكد إن رتبة البوت أعلى من رتبة الأساس بإعدادات السيرفر.`;
        await interaction.editReply(embedMsg(msg));
        await interaction.message.edit({ embeds: [getLexaSetupEmbed(session, settings)], components: getLexaComponents(settings) }).catch(() => {});
      } catch (err) {
        console.error(err);
        await interaction.editReply(embedMsg(bi(interaction, '❌ حدث خطأ أثناء تجربة الرتبة.', "❌ An error occurred while trying the role.")));
      } finally {
        processingRoleUsers.delete(interaction.user.id);
      }
    }

    if (interaction.customId === 'lexa_submit_role') {
      if (processingRoleUsers.has(interaction.user.id)) {
        return interaction.reply({ ...embedMsg(bi(interaction, '⏳ في عملية جارية على رتبتك حالياً، انتظر لحظة وحاول مرة ثانية.', "⏳ There's already an operation running on your role, wait a moment and try again.")), ephemeral: true });
      }
      processingRoleUsers.add(interaction.user.id);
      await interaction.deferReply({ ephemeral: true });
      if (session.timeoutObj) clearTimeout(session.timeoutObj);
      try {
        const { role, finalColorInt, warnings } = await createOrUpdateCustomRole(interaction.guild, interaction.member, session, settings);
        if (settings.logChannelId) {
          const logChannel = interaction.guild.channels.cache.get(settings.logChannelId);
          if (logChannel) {
            await logChannel.send({ embeds: [new EmbedBuilder().setTitle('🛠️ | سجل الرتب المخصصة').setDescription(`**العضو:** ${interaction.member}\n**الرتبة:** \`${role.name}\`\n**النمط:** ${session.type}`).setColor(finalColorInt).setTimestamp()] });
          }
        }
        let msg = `✅ تم حفظ رتبتك (**${session.name}**) بنجاح!`;
        if (warnings.includes('gradient')) msg += `\n⚠️ تم استخدام دمج اللونين بدل التدرج الحقيقي.`;
        if (warnings.includes('icon')) msg += `\n⚠️ تعذر تطبيق الأيقونة/الإيموجي.`;
        if (warnings.includes('position')) msg += `\n⚠️ ما قدرنا نحط الرتبة بموضعها الصحيح فوق رتبة الأساس — تأكد إن رتبة البوت أعلى من رتبة الأساس بإعدادات السيرفر.`;
        await interaction.editReply(embedMsg(msg));
        setTimeout(() => { activeSetups.delete(interaction.user.id); interaction.channel.delete().catch(() => {}); }, 3000);
      } catch (err) {
        console.error(err);
        await interaction.editReply(embedMsg(bi(interaction, '❌ حدث خطأ أثناء إنشاء/تعديل الرتبة.', "❌ An error occurred while creating/editing the role.")));
      } finally {
        processingRoleUsers.delete(interaction.user.id);
      }
    }

    if (interaction.customId === 'my_role_info') {
      const entry = getRoleEntry(interaction.user.id);
      const role = entry && interaction.guild.roles.cache.get(entry.roleId);
      if (!role) return interaction.reply({ ...embedMsg(bi(interaction, '❌ ليس لديك رتبة مخصصة مسجلة.', "❌ You don't have a custom role registered.")), ephemeral: true });
      const embed = new EmbedBuilder().setTitle('✨ رتبتك الحالية').setDescription(`**اسم الرتبة:** ${role.name}\n**اللون:** \`${role.hexColor}\``).setColor(role.color);
      const row = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('delete_my_role').setLabel('حذف رتبتي').setStyle(ButtonStyle.Danger).setEmoji('🗑️'));
      return interaction.reply({ embeds: [embed], components: [row], ephemeral: true });
    }

    if (interaction.customId === 'delete_my_role') {
      const entry = getRoleEntry(interaction.user.id);
      const role = entry && interaction.guild.roles.cache.get(entry.roleId);
      if (role) await role.delete().catch(() => {});
      delete db.userCustomRoles[interaction.user.id]; saveDatabase(db);
      return interaction.update({ ...embedMsg(bi(interaction, '🗑️ تم حذف رتبتك بنجاح.', "🗑️ Your role was deleted successfully.")), components: [] });
    }
  }

  // ==========================================
  // MODAL SUBMISSIONS
  // ==========================================
  if (interaction.isModalSubmit()) {
    if (interaction.customId.startsWith('modal_ow_')) return handleOwnerModal(interaction);
    if (interaction.customId.startsWith('modal_pm_') && await handlePremiumModal(interaction)) return;
    // ---- مودالات إعدادات الرتب/الفويس الجديدة ----
    if (interaction.customId === 'modal_rm_embedimage') {
      const settings = getServerSettings(interaction.guild.id);
      const url = interaction.fields.getTextInputValue('input_url').trim();
      if (!isValidImageUrl(url)) {
        return interaction.reply({ ...embedMsg(bi(interaction, '❌ الرابط غير صالح. لازم يبدأ بـ http:// أو https:// وبدون مسافات.', "❌ Invalid link. It must start with http:// or https:// and contain no spaces.")), ephemeral: true });
      }
      settings.embedImage = url; saveDatabase(db);
      return interaction.update({ ...embedMsg(bi(interaction, '✅ تم تحديث صورة الإمبيد بنجاح.', "✅ The embed image was updated successfully.")), components: [backRow('rm_backpanel')] });
    }
    if (interaction.customId.startsWith('modal_rm_emoji_')) {
      const target = interaction.customId.replace('modal_rm_emoji_', '');
      const field = ROLE_EMOJI_FIELD_MAP[target];
      if (!field) return interaction.reply({ ...embedMsg(bi(interaction, '❌ عنصر غير معروف.', "❌ Unknown item.")), ephemeral: true });
      const settings = getServerSettings(interaction.guild.id);
      settings[field] = interaction.fields.getTextInputValue('input_emoji'); saveDatabase(db);
      return interaction.update({ ...embedMsg(bi(interaction, `✅ تم تحديث الإيموجي بنجاح: ${settings[field]}`, `✅ Emoji updated successfully: ${settings[field]}`)), components: [backRow('rm_backpanel')] });
    }
    if (interaction.customId.startsWith('modal_vm_emoji_')) {
      const target = interaction.customId.replace('modal_vm_emoji_', '');
      const field = VC_EMOJI_FIELD_MAP[target];
      if (!field) return interaction.reply({ ...embedMsg(bi(interaction, '❌ عنصر غير معروف.', "❌ Unknown item.")), ephemeral: true });
      const settings = getServerSettings(interaction.guild.id);
      settings[field] = interaction.fields.getTextInputValue('input_emoji'); saveDatabase(db);
      return interaction.update({ ...embedMsg(bi(interaction, `✅ تم تحديث الإيموجي بنجاح: ${settings[field]}\nℹ️ يبان على لوحات التحكم للرومات الجديدة.`, `✅ Emoji updated successfully: ${settings[field]}\nℹ️ This will show on control panels for new rooms.`)), components: [backRow('vm_backpanel')] });
    }

    if (interaction.customId.startsWith('modal_adm_purge_')) {
      const channelId = interaction.customId.replace('modal_adm_purge_', '');
      const channel = interaction.guild.channels.cache.get(channelId);
      const count = parseInt(interaction.fields.getTextInputValue('input_count'), 10);
      if (!channel) return interaction.reply({ ...embedMsg(bi(interaction, '❌ ما لقيت هذا الروم.', "❌ I couldn't find this room.")), ephemeral: true });
      if (isNaN(count) || count < 1 || count > 100) {
        return interaction.reply({ ...embedMsg(bi(interaction, '❌ أدخل رقم صحيح بين 1 و 100.', "❌ Enter a valid number between 1 and 100.")), ephemeral: true });
      }
      try {
        const deleted = await channel.bulkDelete(count, true);
        return interaction.update({ ...embedMsg(bi(interaction, `🧹 تم حذف ${deleted.size} رسالة من ${channel}.`, `🧹 Deleted ${deleted.size} messages from ${channel}.`)), components: [backRow('adm_backpanel')] });
      } catch (e) {
        console.error('فشل حذف الرسائل:', e);
        return interaction.reply({ ...embedMsg(bi(interaction, '❌ فشل الحذف (الرسائل الأقدم من 14 يوم ما تنحذف جماعي، أو ناقص صلاحية Manage Messages).', "❌ Delete failed (messages older than 14 days can't be bulk-deleted, or the bot is missing the Manage Messages permission).")), ephemeral: true });
      }
    }

    if (interaction.customId.startsWith('modal_adm_warn_')) {
      const userId = interaction.customId.replace('modal_adm_warn_', '');
      const reason = interaction.fields.getTextInputValue('input_reason');
      if (!db.userWarnings) db.userWarnings = {};
      if (!db.userWarnings[userId]) db.userWarnings[userId] = [];
      db.userWarnings[userId].push({ reason, moderatorId: interaction.user.id, timestamp: Date.now() });
      saveDatabase(db);
      return interaction.update({ ...embedMsg(bi(interaction, `⚠️ تم تحذير <@${userId}> بنجاح.\n**السبب:** ${reason}`, `⚠️ <@${userId}> has been warned successfully.\n**Reason:** ${reason}`)), components: [backRow('adm_backpanel')] });
    }

    if (interaction.customId === 'modal_gm_rouletteconfig') {
      const settings = getServerSettings(interaction.guild.id);
      const win = parseInt(interaction.fields.getTextInputValue('input_win'), 10);
      const lose = parseInt(interaction.fields.getTextInputValue('input_lose'), 10);
      const bonus = parseInt(interaction.fields.getTextInputValue('input_bonus'), 10);
      const max = parseInt(interaction.fields.getTextInputValue('input_max'), 10);
      if ([win, lose, bonus].some(n => isNaN(n) || n < 0) || isNaN(max) || max < 2 || max > 25) {
        return interaction.reply({ ...embedMsg(bi(interaction, '❌ أدخل أرقام صحيحة (العدد الأقصى للاعبين بين 2 و 25).', "❌ Enter valid numbers (max players between 2 and 25).")), ephemeral: true });
      }
      settings.rouletteWinPoints = win; settings.rouletteLosePoints = lose; settings.rouletteFinalBonus = bonus; settings.rouletteMaxPlayers = max;
      saveDatabase(db);
      return interaction.update({ embeds: [getGamesEmbed(settings)], components: getGamesComponents() });
    }

    // ---- مودالات النظام الصوتي (كما كانت) ----
    if (interaction.customId.startsWith('modal_vc_')) {
      const room = db.voiceRooms[interaction.channel.id];
      if (!room) return interaction.reply({ ...embedMsg(bi(interaction, '❌ هذا الروم غير مسجل بالنظام.', "❌ This room isn't registered in the system.")), ephemeral: true });

      if (interaction.customId === 'modal_vc_rename') {
        const newName = interaction.fields.getTextInputValue('input_name').slice(0, 100);
        await interaction.channel.setName(newName).catch(() => {});
        room.name = newName; saveDatabase(db);
        return interaction.reply({ ...embedMsg(bi(interaction, `✏️ تم تغيير اسم الروم إلى: ${newName}`, `✏️ The room's name was changed to: ${newName}`)), ephemeral: true });
      }
      if (interaction.customId === 'modal_vc_limit') {
        const num = parseInt(interaction.fields.getTextInputValue('input_limit'), 10);
        if (isNaN(num) || num < 0 || num > 99) return interaction.reply({ ...embedMsg(bi(interaction, '❌ أدخل رقم صحيح بين 0 و 99.', "❌ Enter a valid number between 0 and 99.")), ephemeral: true });
        await interaction.channel.setUserLimit(num).catch(() => {});
        return interaction.reply({ ...embedMsg(bi(interaction, `👥 تم تحديد حد الأعضاء: ${num === 0 ? 'بدون حد' : num}`, `👥 Member limit set: ${num === 0 ? 'no limit' : num}`)), ephemeral: true });
      }
      if (interaction.customId === 'modal_vc_status') {
        const status = interaction.fields.getTextInputValue('input_status').slice(0, 500);
        try {
          if (typeof interaction.channel.setStatus === 'function') {
            await interaction.channel.setStatus(status);
            return interaction.reply({ ...embedMsg(bi(interaction, `💬 تم تحديث حالة الروم: ${status}`, `💬 Room status updated: ${status}`)), ephemeral: true });
          }
          return interaction.reply({ ...embedMsg(bi(interaction, '⚠️ نسخة discord.js عندك لا تدعم تحديث حالة الروم.', "⚠️ Your discord.js version doesn't support updating the room status.")), ephemeral: true });
        } catch (e) {
          console.error(e);
          return interaction.reply({ ...embedMsg(bi(interaction, '❌ ما قدرت أحدث حالة الروم.', "❌ I couldn't update the room status.")), ephemeral: true });
        }
      }
      if (interaction.customId === 'modal_vc_report') {
        const reason = interaction.fields.getTextInputValue('input_reason');
        const settings = getServerSettings(interaction.guild.id);
        if (settings.voiceLogChannelId) {
          const logChannel = interaction.guild.channels.cache.get(settings.voiceLogChannelId);
          if (logChannel) {
            const reportEmbed = new EmbedBuilder()
              .setTitle('🚩 بلاغ جديد عن روم صوتي')
              .setDescription(`**من:** ${interaction.user}\n**الروم:** ${interaction.channel}\n**صاحب الروم:** <@${room.ownerId}>\n**التفاصيل:**\n${reason}`)
              .setColor(EMBED_COLOR);
            const payload = { embeds: [reportEmbed] };
            // ⚠️ المنشن هنا بالمحتوى النصي عمداً — ديسكورد ما يرسل تنبيه فعلي لمنشن داخل وصف الإمبيد
            if (settings.staffRoleId) payload.content = `<@&${settings.staffRoleId}>`;
            await logChannel.send(payload).catch(() => {});
          }
        }
        return interaction.reply({ ...embedMsg(bi(interaction, '🚩 تم إرسال بلاغك للإدارة، شكراً لك.', "🚩 Your report was sent to the staff, thank you.")), ephemeral: true });
      }
      return;
    }

    // ---- مودالات نظام الرتب (كما كانت) ----
    const session = activeSetups.get(interaction.user.id);
    if (!session) return interaction.reply({ ...embedMsg(bi(interaction, '❌ انتهت الجلسة.', "❌ The session has expired.")), ephemeral: true });
    const settings = getServerSettings(interaction.guild.id);

    if (interaction.customId === 'modal_lexa_name') {
      session.name = interaction.fields.getTextInputValue('input_name');
    } else if (interaction.customId === 'modal_lexa_primary') {
      const normalized = normalizeHexColor(interaction.fields.getTextInputValue('input_primary'));
      if (!normalized) return interaction.reply({ ...embedMsg(bi(interaction, '❌ كود اللون غير صحيح. أدخل كود Hex مثل `FFFFFF` أو `#FFFFFF`.', "❌ Invalid color code. Enter a Hex code like `FFFFFF` or `#FFFFFF`.")), ephemeral: true });
      session.primary = normalized;
    } else if (interaction.customId === 'modal_lexa_secondary') {
      const normalized = normalizeHexColor(interaction.fields.getTextInputValue('input_secondary'));
      if (!normalized) return interaction.reply({ ...embedMsg(bi(interaction, '❌ كود اللون غير صحيح. أدخل كود Hex مثل `00FF00` أو `#00FF00`.', "❌ Invalid color code. Enter a Hex code like `00FF00` or `#00FF00`.")), ephemeral: true });
      session.secondary = normalized;
    } else if (interaction.customId === 'modal_lexa_image') {
      session.iconType = 'upload';
      session.uploadedEmojiUrl = interaction.fields.getTextInputValue('input_image');
      session.icon = 'إيموجي/صورة مخصصة 🖼️';
    }

    await interaction.reply({ ...embedMsg(bi(interaction, '✅ تم التحديث والتجهيز بنجاح!', "✅ Updated and ready!")), ephemeral: true });
    try {
      const messages = await interaction.channel.messages.fetch({ limit: 5 });
      const setupMsg = messages.find(m => m.embeds.length > 0 && m.author.id === client.user.id);
      if (setupMsg) await setupMsg.edit({ embeds: [getLexaSetupEmbed(session, settings)], components: getLexaComponents(settings) });
    } catch (e) { console.error(e); }
  }
}
client.on('interactionCreate', interaction => {
  handleInteraction(interaction).catch(async e => {
    console.error('خطأ أثناء معالجة تفاعل:', e);
    try {
      const m = { ...embedMsg('❌ صار خطأ غير متوقع، حاول مرة ثانية.'), ephemeral: true };
      if (interaction.deferred || interaction.replied) await interaction.followUp(m);
      else await interaction.reply(m);
    } catch (_) {}
  });
});
process.on('unhandledRejection', e => console.error('unhandledRejection:', e));
process.on('uncaughtException', e => console.error('uncaughtException:', e));

// ==========================================
// VOICE STATE UPDATE
// ==========================================
client.on('voiceStateUpdate', async (oldState, newState) => {
  const guild = newState.guild || oldState.guild;
  if (!guild) return;
  const settings = getServerSettings(guild.id);

  // ---- 🎙️ احتساب وقت التواجد الصوتي (لبطاقة البروفايل) ----
  const memberId = (newState.member || oldState.member)?.id;
  if (memberId) {
    const wasInVoice = !!oldState.channelId;
    const isInVoice = !!newState.channelId;
    if (!wasInVoice && isInVoice) {
      voiceJoinTimestamps.set(memberId, Date.now());
    } else if (wasInVoice && !isInVoice) {
      const joinedAt = voiceJoinTimestamps.get(memberId);
      if (joinedAt) {
        const elapsed = Date.now() - joinedAt;
        const p = getGameProfile(memberId);
        p.voiceMs += elapsed;
        saveDatabase(db);
        voiceJoinTimestamps.delete(memberId);
      }
    }
  }

  if (newState.channelId && newState.channelId === settings.voiceHubChannelId) {
    try {
      const newChannel = await createVoiceRoom(guild, newState.member, settings);
      await newState.member.voice.setChannel(newChannel).catch(() => {});
    } catch (e) {
      console.error('فشل إنشاء الروم الصوتي تلقائياً:', e);
    }
  }

  if (oldState.channelId && oldState.channelId !== newState.channelId) {
    const oldChannel = guild.channels.cache.get(oldState.channelId);
    const room = db.voiceRooms[oldState.channelId];

    if (room && oldState.member && oldState.member.id === room.ownerId && oldChannel && oldChannel.members.size > 0) {
      const ownerLang = getUserLang(guild.id);
      const leftDesc = ownerLang === 'en' ? "Anyone inside the room can claim ownership using the **Claim Ownership** button above." : 'أي شخص بالداخل يقدر ياخذ الملكية من زر **أخذ الملكية** بالأعلى.';
      const leftTitle = ownerLang === 'en' ? '👑 The Owner Left the Room' : '👑 الملك طلع من الروم';
      await oldChannel.send(embedMsg(leftDesc, { title: leftTitle })).catch(() => {});
    }

    if (room && oldChannel && oldChannel.members.size === 0) {
      if (room.waitingRoomChannelId) {
        const waitingChannel = guild.channels.cache.get(room.waitingRoomChannelId);
        if (waitingChannel) await waitingChannel.delete().catch(() => {});
      }
      delete db.voiceRooms[oldState.channelId]; saveDatabase(db);
      await oldChannel.delete().catch(() => {});
    }

    for (const [roomChannelId, r] of Object.entries(db.voiceRooms)) {
      if (r.waitingRoomChannelId === oldState.channelId) {
        const waitingChannel = guild.channels.cache.get(oldState.channelId);
        if (waitingChannel && waitingChannel.members.size === 0) {
          r.waitingRoomChannelId = null; saveDatabase(db);
          await waitingChannel.delete().catch(() => {});
        }
      }
    }
  }
});

// ==========================================
// MESSAGE CREATE — زر "p" للبروفايل + خبرة التفاعل
// ==========================================
client.on('messageCreate', async message => {
  try {
    if (message.author.bot || !message.guild) return;
    const settings = getServerSettings(message.guild.id);
    const lang = getUserLang(message.guild.id);
    const text = (message.content || '').trim().toLowerCase();

    // ---- 🔥 الستريك (بريميوم): ستيكر أو GIF بالروم المحدد ----
    if (settings.streakChannelId && message.channel.id === settings.streakChannelId && isGuildPremium(message.guild.id) && isStreakMessage(message)) {
      await recordStreak(message);
    }

    // ---- 🎡 اختصار الروليت: -روليت / -الغاء (بالروم اللي حدده الأدمن) ----
    if (settings.rlShortcutOn && settings.rlShortcutChannelId === message.channel.id && (text === '-روليت' || text === '-الغاء')) {
      const lastCmd = shortcutCooldown.get(message.author.id) || 0;
      if (Date.now() - lastCmd < 3000) return;
      shortcutCooldown.set(message.author.id, Date.now());
      const en = lang === 'en';
      const reply = (t) => message.reply({ ...embedMsg(t), allowedMentions: { repliedUser: false, parse: [] } }).catch(() => {});
      const existing = rouletteSessions.get(message.channel.id);
      if (text === '-روليت') {
        if (existing) return void await reply(en ? '⚠️ There is already a roulette match in this channel.' : '⚠️ فيه مباراة روليت شغالة بهذا الروم.');
        await openRouletteLobbyFromChannel(message.channel, message.author.id, settings, lang);
      } else {
        if (!existing) return void await reply(en ? '❌ No roulette match to cancel.' : '❌ ما فيه روليت تنلغي.');
        const isAdm = message.member && message.member.permissions.has(PermissionFlagsBits.Administrator);
        if (message.author.id !== existing.hostId && !isAdm) return void await reply(en ? '❌ Only the host or an admin can cancel.' : '❌ بس اللي بدأها أو الإدارة يقدر يلغيها.');
        await cancelRouletteSession(message.channel, existing, lang, message.author.id);
      }
      return;
    }

    // ---- اختصارات نصية بروم الأوامر: p / i / b / t / l ----
    if (settings.gamesChannelId && message.channel.id === settings.gamesChannelId && ['p', 'i', 'b', 't', 'l'].includes(text)) {
      const lastCmd = shortcutCooldown.get(message.author.id) || 0;
      if (Date.now() - lastCmd < 3000) return;
      shortcutCooldown.set(message.author.id, Date.now());
      try {
        let payload;
        if (text === 'p') {
          const member = message.member || await message.guild.members.fetch(message.author.id);
          payload = await buildProfileMessage(message.guild, member, lang);
        } else if (text === 'i') payload = buildInventoryMsg(message.author.id, lang);
        else if (text === 'b') payload = await buildBalanceMsg(message.author.id, lang);
        else if (text === 't') payload = buildTopMsg(message.guild, 'points', 'server', lang);
        else payload = buildLogMsg(message.author.id, lang);
        await message.reply({ ...payload, allowedMentions: { repliedUser: false, parse: [] } });
      } catch (e) { console.error('فشل اختصار نصي:', e); }
      return;
    }

    // ---- خبرة التفاعل (مرة كل 60 ثانية لكل عضو) ----
    const last = lastXpMessageAt.get(message.author.id) || 0;
    if (Date.now() - last > 60000) {
      lastXpMessageAt.set(message.author.id, Date.now());
      const r = grantXp(message.author.id, 5 + Math.floor(Math.random() * 10));
      if (r.leveledUp) {
        await message.channel.send(embedMsg(lang === 'en'
          ? `${E('levelup')} <@${message.author.id}> leveled up to **Level ${r.level}**! (+${r.bonus} ${E('points')} bonus points)`
          : `${E('levelup')} <@${message.author.id}> وصل **المستوى ${r.level}**! (+${r.bonus} ${E('points')} نقطة مكافأة)`)).catch(() => {});
      }
    }
  } catch (e) { console.error('خطأ messageCreate:', e); }
});

client.login(CONFIG.TOKEN);
