import {
  Client,
  GatewayIntentBits,
  EmbedBuilder,
  ActionRowBuilder,
  StringSelectMenuBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
} from 'discord.js';
import {
  joinVoiceChannel,
  getVoiceConnection,
  createAudioPlayer,
  createAudioResource,
  AudioPlayerStatus,
  StreamType,
} from '@discordjs/voice';
import play from 'play-dl';
import fs from 'fs';
import path from 'path';

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildVoiceStates,
  ],
});

const TOKEN = process.env.DISCORD_TOKEN;
const OWNER_ID = process.env.OWNER_ID;

if (!TOKEN) throw new Error('DISCORD_TOKEN environment variable is required');

// ─── Persistence ────────────────────────────────────────────────────────────

const DB_PATH     = path.resolve('ghostcoins.json');
const GAMES_PATH  = path.resolve('games.json');
const CONFIG_PATH = path.resolve('config.json');

interface UserData {
  coins: number;
  daily: number;
  weekly: number;
  monthly: number;
  lastRob?: number;
  lastHeist?: number;
  lastWork?: number;
  lastCrime?: number;
  betWins?: number;
  betLosses?: number;
  betProfit?: number;
  banned?: boolean;
}

interface Game {
  id: string;
  sport: string;
  team1: string;
  team2: string;
  createdAt: number;
  status: 'upcoming' | 'finished';
  score?: string;
}

interface ScoreBet {
  userId: string;
  gameId: string;
  score: string;
  amount: number;
}

interface Config { announcementChannelId?: string; botAdmins?: string[]; }

let db: Record<string, UserData> = {};
let games: Game[] = [];
let scoreBets: ScoreBet[] = [];
let config: Config = {};

if (fs.existsSync(DB_PATH))     db                        = JSON.parse(fs.readFileSync(DB_PATH,     'utf-8'));
if (fs.existsSync(GAMES_PATH)) ({ games, scoreBets }      = JSON.parse(fs.readFileSync(GAMES_PATH,  'utf-8')));
if (fs.existsSync(CONFIG_PATH)) config                    = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
if (!games)     games     = [];
if (!scoreBets) scoreBets = [];

function saveDB()     { fs.writeFileSync(DB_PATH,     JSON.stringify(db,                   null, 2)); }
function saveGames()  { fs.writeFileSync(GAMES_PATH,  JSON.stringify({ games, scoreBets }, null, 2)); }
function saveConfig() { fs.writeFileSync(CONFIG_PATH, JSON.stringify(config,               null, 2)); }

function createUser(id: string) {
  if (!db[id]) db[id] = { coins: 500, daily: 0, weekly: 0, monthly: 0, betWins: 0, betLosses: 0, betProfit: 0 };
  if (db[id].betWins   == null) db[id].betWins   = 0;
  if (db[id].betLosses == null) db[id].betLosses = 0;
  if (db[id].betProfit == null) db[id].betProfit = 0;
}

function checkCooldown(last: number, duration: number) { return Date.now() - last >= duration; }

function getRank() {
  return Object.entries(db)
    .sort((a, b) => b[1].coins - a[1].coins)
    .map(([id, data], i) => `${i + 1}. <@${id}> — ${data.coins.toLocaleString()} GC`);
}

function getBetRank() {
  return Object.entries(db)
    .filter(([, d]) => (d.betWins ?? 0) + (d.betLosses ?? 0) > 0)
    .sort((a, b) => (b[1].betProfit ?? 0) - (a[1].betProfit ?? 0))
    .map(([id, d], i) => {
      const profit = d.betProfit ?? 0;
      const sign   = profit >= 0 ? '+' : '';
      return `${i + 1}. <@${id}> — ${sign}${profit.toLocaleString()} GC (${d.betWins}W/${d.betLosses}L)`;
    });
}

function genId() { return Math.random().toString(36).slice(2, 6).toUpperCase(); }

function pick<T>(arr: T[]): T { return arr[Math.floor(Math.random() * arr.length)]; }

// ─── Sports data ─────────────────────────────────────────────────────────────

const SPORTS: Record<string, { label: string; emoji: string; matchups: [string, string][] }> = {
  pingpong: { label: 'Ping Pong', emoji: '🏓', matchups: [['Rafael','Lucas'],['João','Pedro'],['Carlos','André'],['Vitor','Bruno']] },
  futebol:  { label: 'Futebol',   emoji: '⚽',  matchups: [['Flamengo','Corinthians'],['Santos','Palmeiras'],['Grêmio','Internacional'],['Vasco','Botafogo']] },
  sinuca:   { label: 'Sinuca',    emoji: '🎱',  matchups: [['Marcos','Felipe'],['Diego','Rodrigo'],['Thiago','Eduardo'],['Leandro','Sandro']] },
  golf:     { label: 'Golf',      emoji: '⛳',  matchups: [['Tiger','Rory'],['Scottie','Jon'],['Viktor','Xander'],['Justin','Jordan']] },
  basquete: { label: 'Basquete',  emoji: '🏀',  matchups: [['Lakers','Warriors'],['Celtics','Heat'],['Bucks','Nets'],['Suns','Nuggets']] },
};

interface BetState { amount: number; sport: string; option1: string; option2: string; }
const pendingBets = new Map<string, BetState>();

// userId -> timestamp de quando o mute expira
const mutedUsers = new Map<string, number>();

// Rastrear mensagens recentes para !violar
const recentMessages: { userId: string; ts: number }[] = [];

// ─── Music queue ─────────────────────────────────────────────────────────────
interface Track { title: string; url: string; requester: string; }
interface MusicQueue {
  tracks: Track[];
  player: ReturnType<typeof createAudioPlayer> | null;
  textChannelId?: string;
}

const musicQueues = new Map<string, MusicQueue>();

function getQueue(guildId: string): MusicQueue {
  if (!musicQueues.has(guildId)) musicQueues.set(guildId, { tracks: [], player: null });
  return musicQueues.get(guildId)!;
}

async function playNext(guildId: string) {
  const queue = getQueue(guildId);
  const conn  = getVoiceConnection(guildId);
  if (!conn || queue.tracks.length === 0) return;

  const track = queue.tracks[0];

  async function sendToChannel(msg: string) {
    if (!queue.textChannelId) return;
    try {
      const ch = await client.channels.fetch(queue.textChannelId);
      if (ch?.isTextBased()) await (ch as any).send(msg);
    } catch {}
  }

  let stream;
  try {
    const validated = await play.validate(track.url);
    if (!validated || validated === 'search') {
      const results = await play.search(track.title, { limit: 1, source: { youtube: 'video' } });
      if (results.length > 0) track.url = results[0].url;
    }
    stream = await play.stream(track.url, { quality: 2 });
  } catch (err) {
    console.error(`[Music] Erro ao carregar "${track.title}":`, err);
    await sendToChannel(`❌ Erro ao tocar **${track.title}** — pulando`);
    queue.tracks.shift();
    return playNext(guildId);
  }

  if (!queue.player) queue.player = createAudioPlayer();
  const resource = createAudioResource(stream.stream, { inputType: stream.type as StreamType });
  conn.subscribe(queue.player);
  queue.player.play(resource);

  await sendToChannel(`▶️ Tocando agora: **${track.title}** (pedido por ${track.requester})`);

  queue.player.removeAllListeners(AudioPlayerStatus.Idle);
  queue.player.once(AudioPlayerStatus.Idle, () => {
    queue.tracks.shift();
    playNext(guildId);
  });
}

function parseDuration(str: string): number | null {
  const match = str.match(/^(\d+)(s|m|h)$/i);
  if (!match) return null;
  const n = parseInt(match[1]);
  switch (match[2].toLowerCase()) {
    case 's': return n * 1000;
    case 'm': return n * 60 * 1000;
    case 'h': return n * 60 * 60 * 1000;
    default:  return null;
  }
}

// ─── Auto game scheduler ─────────────────────────────────────────────────────

const AUTO_RESOLVE_AFTER = 20 * 60 * 1000;

function randomScore(sportKey: string): string {
  const r = () => Math.floor(Math.random() * 6);
  switch (sportKey) {
    case 'futebol':  { const [a, b] = [r(), r()]; return `${a}x${b}`; }
    case 'basquete': { const a = 70 + Math.floor(Math.random() * 51); const b = 70 + Math.floor(Math.random() * 51); return `${a}x${b}`; }
    case 'pingpong': { const a = Math.floor(Math.random() * 4); const b = Math.floor(Math.random() * 4); return `${a}x${b}`; }
    case 'sinuca':   { const a = Math.floor(Math.random() * 6); const b = Math.floor(Math.random() * 6); return `${a}x${b}`; }
    case 'golf':     { const a = Math.floor(Math.random() * 10); const b = Math.floor(Math.random() * 10); return `${a}x${b}`; }
    default:         return `${r()}x${r()}`;
  }
}

async function resolveGame(game: Game, sportKey: string) {
  if (game.status !== 'upcoming') return;

  game.status = 'finished';
  game.score  = randomScore(sportKey);

  const betsForGame = scoreBets.filter(b => b.gameId === game.id);
  const results: { userId: string; won: boolean; payout: number }[] = [];

  for (const bet of betsForGame) {
    createUser(bet.userId);
    const exact = bet.score.toLowerCase() === game.score;
    const [g1, g2] = game.score.split('x').map(Number);
    const [b1, b2] = bet.score.toLowerCase().split('x').map(Number);
    const rightWinner = (g1 > g2 && b1 > b2) || (g1 < g2 && b1 < b2) || (g1 === g2 && b1 === b2);

    let payout = 0;
    if (exact)            payout = bet.amount * 3;
    else if (rightWinner) payout = Math.floor(bet.amount * 1.5);

    if (payout > 0) {
      db[bet.userId].coins    += payout;
      db[bet.userId].betWins   = (db[bet.userId].betWins  ?? 0) + 1;
      db[bet.userId].betProfit = (db[bet.userId].betProfit ?? 0) + (payout - bet.amount);
    } else {
      db[bet.userId].coins    -= bet.amount;
      db[bet.userId].betLosses = (db[bet.userId].betLosses ?? 0) + 1;
      db[bet.userId].betProfit = (db[bet.userId].betProfit ?? 0) - bet.amount;
    }
    results.push({ userId: bet.userId, won: payout > 0, payout: payout || -bet.amount });
  }

  scoreBets = scoreBets.filter(b => b.gameId !== game.id);
  saveDB(); saveGames();

  if (!config.announcementChannelId) return;
  try {
    const channel = await client.channels.fetch(config.announcementChannelId);
    if (!channel?.isTextBased()) return;

    const winners = results.filter(r => r.won).map(r => `<@${r.userId}> **+${r.payout.toLocaleString()} GC**`).join('\n');
    const losers  = results.filter(r => !r.won).map(r => `<@${r.userId}> **${r.payout.toLocaleString()} GC**`).join('\n');

    const embed = new EmbedBuilder()
      .setTitle(`🏆 Resultado: ${game.sport} — ${game.team1} vs ${game.team2}`)
      .addFields(
        { name: '⚽ Placar Final', value: game.score!.toUpperCase(), inline: true },
        { name: '🎰 Apostas', value: `${betsForGame.length} aposta(s)`, inline: true },
      )
      .setColor('Gold');

    if (winners) embed.addFields({ name: '✅ Ganhadores', value: winners });
    if (losers)  embed.addFields({ name: '❌ Perdedores', value: losers });
    if (!betsForGame.length) embed.addFields({ name: 'ℹ️ Sem apostas', value: 'Ninguém apostou neste jogo' });

    await (channel as any).send({ embeds: [embed] });
  } catch (err) {
    console.error('Erro ao anunciar resultado:', err);
  }
}

async function generateAutoGame() {
  const sportKeys = Object.keys(SPORTS);
  const sportKey  = pick(sportKeys);
  const sport     = SPORTS[sportKey];
  const [t1, t2]  = pick(sport.matchups);
  const gameId    = genId();

  const game: Game = { id: gameId, sport: `${sport.emoji} ${sport.label}`, team1: t1, team2: t2, createdAt: Date.now(), status: 'upcoming' };
  games.push(game);
  saveGames();

  if (config.announcementChannelId) {
    try {
      const channel = await client.channels.fetch(config.announcementChannelId);
      if (channel?.isTextBased()) {
        const embed = new EmbedBuilder()
          .setTitle(`🎮 Novo Jogo Disponível!`)
          .addFields(
            { name: `${sport.emoji} ${sport.label}`, value: `**${t1}** vs **${t2}**`, inline: false },
            { name: '🆔 ID do Jogo', value: `\`${gameId}\``, inline: true },
            { name: '⏳ Encerra em', value: '20 minutos', inline: true },
            { name: '💡 Como apostar', value: `\`!apostarscore ${gameId} 2x1 500\`\nPlacar exato = **3x** | Vencedor certo = **1.5x**`, inline: false },
          )
          .setColor('Blue')
          .setFooter({ text: 'Use !jogos para ver todos os jogos abertos' });
        await (channel as any).send({ embeds: [embed] });
      }
    } catch (err) {
      console.error('Erro ao anunciar jogo:', err);
    }
  }

  setTimeout(() => resolveGame(game, sportKey), AUTO_RESOLVE_AFTER);
  console.log(`[AutoGame] Jogo gerado: ${gameId} — ${t1} vs ${t2}`);
}


// ─── Error handlers ───────────────────────────────────────────────────────────

client.on('error', (err) => console.error('Erro no cliente Discord:', err));
process.on('unhandledRejection', (err) => console.error('Unhandled rejection:', err));

// ─── Message handler ──────────────────────────────────────────────────────────

client.once('clientReady', () => {
  console.log(`✅ ${client.user?.tag} online`);
  client.user?.setPresence({
    status: 'dnd',
    activities: [{ name: '👻 Ghost Face Economy', type: 4 }],
  });
});

client.on('messageCreate', async (message) => {
  if (message.author.bot) return;

  recentMessages.push({ userId: message.author.id, ts: Date.now() });

  // Anti-link
  if (!message.content.startsWith('!')) {
    const discordInvite = /discord\.gg\//i;
    const anyLink       = /https?:\/\/\S+/i;
    if (discordInvite.test(message.content)) {
      await message.delete().catch(() => null);
      return message.channel.send('eu vou nem falar onde vou enfiar esse link');
    }
    if (anyLink.test(message.content)) {
      await message.delete().catch(() => null);
      return message.channel.send(`<@${message.author.id}> vou enfiar esse link no teu buraquinho de fabricar chocolate`);
    }
  }

  // Canal de intros
  if (message.channelId === '1482607902584864881' && message.attachments.size > 0) {
    return message.reply('intro paia KKKKKK');
  }

  if (
    message.channelId === '1482607902584864881' &&
    message.reference?.messageId
  ) {
    const replied = await message.channel.messages.fetch(message.reference.messageId).catch(() => null);
    if (replied?.author.id === client.user?.id) {
      return message.reply('cala boca q tua intro é paia sim.');
    }
  }

  const id  = message.author.id;
  createUser(id);
  if (db[id].banned) return;

  const muteExpiry = mutedUsers.get(id);
  if (muteExpiry) {
    if (Date.now() < muteExpiry) return;
    mutedUsers.delete(id);
  }

  const args = message.content.split(' ');
  const now  = Date.now();

  // ── Economy ────────────────────────────────────────────────────────────────

  if (message.content === '!saldo') {
    return message.reply(`🪙 Ghost Coins: **${db[id].coins.toLocaleString()} GC**`);
  }

  if (message.content === '!daily') {
    if (!checkCooldown(db[id].daily, 86400000)) return message.reply('⏳ Daily já usado');
    db[id].coins += 250; db[id].daily = now; saveDB();
    return message.reply('🎁 +250 Ghost Coins');
  }

  if (message.content === '!weekly') {
    if (!checkCooldown(db[id].weekly, 604800000)) return message.reply('⏳ Weekly já usado');
    db[id].coins += 1500; db[id].weekly = now; saveDB();
    return message.reply('📦 +1500 Ghost Coins');
  }

  if (message.content === '!monthly') {
    if (!checkCooldown(db[id].monthly, 2592000000)) return message.reply('⏳ Monthly já usado');
    db[id].coins += 5000; db[id].monthly = now; saveDB();
    return message.reply('💎 +5000 Ghost Coins');
  }

  if (message.content.startsWith('!pay')) {
    const user = message.mentions.users.first();
    const amount = parseInt(args[2]);
    if (!user || !amount) return message.reply('❌ Uso: !pay @user quantidade');
    createUser(user.id);
    if (amount > db[id].coins) return message.reply('❌ Saldo insuficiente');
    db[id].coins -= amount; db[user.id].coins += amount; saveDB();
    return message.reply(`✅ Transferido **${amount.toLocaleString()} GC** para <@${user.id}>`);
  }

  if (message.content === '!rank') {
    const embed = new EmbedBuilder()
      .setTitle('💰 Ranking Ghost Coins')
      .setDescription(getRank().slice(0, 10).join('\n') || 'Nenhum usuário ainda')
      .setColor('Purple');
    return message.reply({ embeds: [embed] });
  }

  if (message.content === '!rankbet') {
    const ranking = getBetRank().slice(0, 10).join('\n');
    const embed = new EmbedBuilder()
      .setTitle('🎰 Ranking de Apostas')
      .setDescription(ranking || 'Nenhuma aposta ainda')
      .setFooter({ text: 'Baseado no lucro líquido das apostas esportivas' })
      .setColor('Gold');
    return message.reply({ embeds: [embed] });
  }

  // ── Owner commands ─────────────────────────────────────────────────────────

  if (message.content.startsWith('!addcoins')) {
    if (message.author.id !== OWNER_ID) return message.reply('❌ Apenas o dono pode usar este comando');
    const user      = message.mentions.users.first() ?? message.author;
    const amountArg = message.mentions.users.size > 0 ? args[2] : args[1];
    const isInfinito = amountArg === 'infinito';
    const amount    = isInfinito ? 999999999 : parseInt(amountArg);
    if (!amount || isNaN(amount)) return message.reply('❌ Uso: !addcoins [@user] quantidade|infinito');
    createUser(user.id); db[user.id].coins += amount; saveDB();
    return message.reply(`✅ Adicionado ${isInfinito ? '∞' : amount.toLocaleString()} GC para <@${user.id}>`);
  }

  if (message.content.startsWith('!resetbal')) {
    if (message.author.id !== OWNER_ID) return message.reply('❌ Apenas o dono pode usar este comando');
    const user = message.mentions.users.first();
    if (!user) return message.reply('❌ Uso: !resetbal @user');
    createUser(user.id);
    db[user.id] = { ...db[user.id], coins: 500, daily: 0, weekly: 0, monthly: 0 }; saveDB();
    return message.reply(`✅ Saldo de <@${user.id}> resetado para 500 GC`);
  }

  if (message.content === '!resetall') {
    if (message.author.id !== OWNER_ID) return message.reply('❌ Apenas o dono pode usar este comando');
    const total = Object.keys(db).length;
    for (const uid of Object.keys(db)) {
      db[uid] = { ...db[uid], coins: 500, daily: 0, weekly: 0, monthly: 0, betWins: 0, betLosses: 0, betProfit: 0 };
    }
    saveDB();
    return message.reply(`✅ Saldo de **${total} usuário(s)** resetado para 500 GC`);
  }

  if (message.content.startsWith('!mutebot')) {
    const isOwner    = message.author.id === OWNER_ID;
    const isBotAdmin = config.botAdmins?.includes(message.author.id);
    if (!isOwner && !isBotAdmin) return message.reply('❌ Apenas o dono ou admins do bot podem usar este comando');

    const user     = message.mentions.users.first();
    const timeArg  = args[2];
    if (!user || !timeArg) return message.reply('❌ Uso: !mutebot @user 10m\nFormatos: s (segundos), m (minutos), h (horas)');
    if (user.id === OWNER_ID) return message.reply('❌ Não é possível mutar o dono');

    const ms = parseDuration(timeArg);
    if (!ms) return message.reply('❌ Tempo inválido. Use: 30s, 5m, 2h');

    mutedUsers.set(user.id, Date.now() + ms);

    const unit     = timeArg.slice(-1).toLowerCase();
    const val      = timeArg.slice(0, -1);
    const label    = unit === 's' ? 'segundo(s)' : unit === 'm' ? 'minuto(s)' : 'hora(s)';
    const readable = `${val} ${label}`;
    return message.reply(`🔇 <@${user.id}> foi mutado no bot por **${readable}**`);
  }

  if (message.content.startsWith('!admin')) {
    if (message.author.id !== OWNER_ID) return message.reply('❌ Apenas o dono pode usar este comando');
    const user = message.mentions.users.first();
    if (!user) return message.reply('❌ Uso: !admin @user');
    if (!config.botAdmins) config.botAdmins = [];
    const idx = config.botAdmins.indexOf(user.id);
    if (idx === -1) {
      config.botAdmins.push(user.id);
      saveConfig();
      return message.reply(`✅ <@${user.id}> agora é admin do bot e pode usar \`!criarjogo\``);
    } else {
      config.botAdmins.splice(idx, 1);
      saveConfig();
      return message.reply(`✅ <@${user.id}> removido dos admins do bot`);
    }
  }

  if (message.content === '!setcanal') {
    if (message.author.id !== OWNER_ID) return message.reply('❌ Apenas o dono pode usar este comando');
    config.announcementChannelId = message.channelId;
    saveConfig();
    return message.reply(`✅ Canal de anúncios definido para este canal!\n