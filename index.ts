import {
  Client,
  GatewayIntentBits,
  EmbedBuilder
} from 'discord.js';

import fs from 'fs';
import path from 'path';

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers
  ]
});

const TOKEN = process.env.DISCORD_TOKEN;
const OWNER_ID = process.env.OWNER_ID;

if (!TOKEN) throw new Error('DISCORD_TOKEN obrigatório');

const DB_PATH = path.resolve('ghostcoins.json');

interface UserData {
  coins: number;
  daily: number;
  weekly: number;
  monthly: number;
  betWins: number;
  betLosses: number;
  betProfit: number;
  banned?: boolean;
}

let db: Record<string, UserData> = {};

if (fs.existsSync(DB_PATH)) {
  db = JSON.parse(fs.readFileSync(DB_PATH, 'utf-8'));
}

function saveDB() {
  fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2));
}

function createUser(id: string) {
  if (!db[id]) {
    db[id] = {
      coins: 500,
      daily: 0,
      weekly: 0,
      monthly: 0,
      betWins: 0,
      betLosses: 0,
      betProfit: 0
    };
  }
}

function checkCooldown(last: number, duration: number) {
  return Date.now() - last >= duration;
}

function getRank() {
  return Object.entries(db)
    .sort((a, b) => b[1].coins - a[1].coins)
    .map(([id, data], i) =>
      `${i + 1}. <@${id}> — ${data.coins.toLocaleString()} GC`
    );
}

const mutedUsers = new Map<string, number>();

function parseDuration(str: string): number | null {
  const match = str.match(/^(\d+)(s|m|h)$/i);
  if (!match) return null;

  const n = parseInt(match[1]);

  switch (match[2]) {
    case 's': return n * 1000;
    case 'm': return n * 60000;
    case 'h': return n * 3600000;
    default: return null;
  }
}

client.once('clientReady', () => {
  console.log(`✅ ${client.user?.tag} online`);
  client.user?.setPresence({
    status: 'dnd',
    activities: [{ name: '👻 Ghost Face Economy' }]
  });
});

client.on('messageCreate', async (message) => {
  if (message.author.bot) return;

  const id = message.author.id;
  createUser(id);

  const muteExpiry = mutedUsers.get(id);
  if (muteExpiry && Date.now() < muteExpiry) return;

  const args = message.content.split(' ');
  const now = Date.now();

  if (!message.content.startsWith('!')) {
    if (/https?:\/\/\S+/i.test(message.content)) {
      await message.delete().catch(() => null);
      return message.channel.send(`<@${id}> vou enfiar esse link no teu bolso 😹`);
    }
  }

  if (message.content === '!saldo') {
    return message.reply(`🪙 Ghost Coins: **${db[id].coins.toLocaleString()} GC**`);
  }

  if (message.content === '!daily') {
    if (!checkCooldown(db[id].daily, 86400000)) {
      return message.reply('⏳ Daily já usado');
    }

    db[id].coins += 250;
    db[id].daily = now;
    saveDB();

    return message.reply('🎁 +250 Ghost Coins');
  }

  if (message.content === '!weekly') {
    if (!checkCooldown(db[id].weekly, 604800000)) {
      return message.reply('⏳ Weekly já usado');
    }

    db[id].coins += 1500;
    db[id].weekly = now;
    saveDB();

    return message.reply('📦 +1500 Ghost Coins');
  }

  if (message.content === '!monthly') {
    if (!checkCooldown(db[id].monthly, 2592000000)) {
      return message.reply('⏳ Monthly já usado');
    }

    db[id].coins += 5000;
    db[id].monthly = now;
    saveDB();

    return message.reply('💎 +5000 Ghost Coins');
  }

  if (message.content.startsWith('!pay')) {
    const user = message.mentions.users.first();
    const amount = parseInt(args[2]);

    if (!user || !amount) {
      return message.reply('❌ Uso: !pay @user quantidade');
    }

    createUser(user.id);

    if (amount > db[id].coins) {
      return message.reply('❌ Saldo insuficiente');
    }

    db[id].coins -= amount;
    db[user.id].coins += amount;

    saveDB();

    return message.reply(`✅ Transferido ${amount} GC para <@${user.id}>`);
  }

  if (message.content === '!rank') {
    const embed = new EmbedBuilder()
      .setTitle('💰 Ranking Ghost Coins')
      .setDescription(getRank().slice(0, 10).join('\n'))
      .setColor('Purple');

    return message.reply({ embeds: [embed] });
  }

  if (message.content.startsWith('!addcoins')) {
    if (message.author.id !== OWNER_ID) {
      return message.reply('❌ Só dono');
    }

    const user = message.mentions.users.first() ?? message.author;
    const amount = parseInt(args[2] || args[1]);

    if (!amount) return message.reply('❌ Valor inválido');

    createUser(user.id);
    db[user.id].coins += amount;

    saveDB();

    return message.reply(`✅ ${amount} GC adicionados`);
  }

  if (message.content.startsWith('!mutebot')) {
    if (message.author.id !== OWNER_ID) {
      return message.reply('❌ Só dono');
    }

    const user = message.mentions.users.first();
    const timeArg = args[2];

    if (!user || !timeArg) {
      return message.reply('❌ Uso: !mutebot @user 10m');
    }

    const ms = parseDuration(timeArg);

    if (!ms) {
      return message.reply('❌ Tempo inválido');
    }

    mutedUsers.set(user.id, Date.now() + ms);

    return message.reply(`🔇 <@${user.id}> mutado por ${timeArg}`);
  }

  if (message.content === '!apostar') {
    const amount = parseInt(args[1]);

    if (!amount || amount > db[id].coins) {
      return message.reply('❌ valor inválido');
    }

    const ganhou = Math.random() < 0.5;

    if (ganhou) {
      db[id].coins += amount;
      db[id].betWins += 1;
      db[id].betProfit += amount;
      saveDB();
      return message.reply(`🎉 ganhou ${amount} GC`);
    } else {
      db[id].coins -= amount;
      db[id].betLosses += 1;
      db[id].betProfit -= amount;
      saveDB();
      return message.reply(`💀 perdeu ${amount} GC`);
    }
  }
});

client.login(TOKEN);me.sport} — ${game.team1} vs ${game.team2}`)
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
