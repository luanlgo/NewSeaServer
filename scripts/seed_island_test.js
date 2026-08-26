#!/usr/bin/env node
// scripts/seed_island_test.js — Monta o cenário para testar a CONQUISTA de uma
// ilha de guilda e o EVENTO DA COLETA sem esperar uma semana de jogo.
//
// ── O que ele resolve ────────────────────────────────────────────────────────
// Testar a ilha de ponta a ponta pede, na ordem: uma conta com ouro, uma guilda
// fundada, o barco NO mapa da ilha (que fica a cinco travessias do mapa
// inicial), as cinco torres de pé, um cofre com o que pagar a primeira torre
// dentro dos 10 minutos de graça, e — para a coleta — imposto acumulado na
// praça. Fazer isso à mão é meia hora de navegação antes do primeiro tiro.
//
// ── DESLIGUE O SERVIDOR ANTES ────────────────────────────────────────────────
// O IslandManager e o GuildManager carregam ilha e guilda UMA vez, no boot, e
// dali em diante o banco é só o espelho do que eles têm na memória. Rodar isto
// com o servidor de pé não dá erro nenhum: a primeira torre que cair reescreve
// a linha da ilha com o estado antigo, e parece que o script não funcionou.
//
//   1. pare o servidor
//   2. node scripts/seed_island_test.js adm --modo=conquista
//   3. suba o servidor e entre no jogo
//
// ── Uso ──────────────────────────────────────────────────────────────────────
//   node scripts/seed_island_test.js [conta] [--ilha=1|2|3] [--modo=...] [--pot=N]
//
//   --modo=conquista  (padrao) a ilha volta a ser NEUTRA, com as cinco torres
//                     de pé, e você nasce no mapa dela. É o caminho inteiro:
//                     derrubar as cinco -> disputa -> 10 min de graça -> erguer
//                     a primeira torre -> domínio.
//   --modo=dominio    a ilha já é da sua guilda, com as torres erguidas e o
//                     imposto no bolo. Você nasce na PRAÇA de onde o barco
//                     zarpa. É o caminho curto para testar só a coleta: abra a
//                     Guilda -> aba Coleta -> "Fazer a coleta zarpar agora".
//   --pot=N           quanto imposto deixar acumulado (padrão 250.000).
//
// NÃO usar em produção: cria uma guilda com o cofre cheio e reescreve o estado
// de uma ilha por cima do que estiver lá.
'use strict';
require('dotenv').config();

// ── Trava do banco remoto ────────────────────────────────────────────────────
// O .env de desenvolvimento deste projeto aponta para o banco HOSPEDADO, o
// mesmo em que os jogadores estão. Este script funda guilda e reescreve o
// estado de uma ilha inteira — rodá-lo sem perceber contra o banco de verdade
// tira a ilha de quem a conquistou jogando.
//
// A checagem é feita ANTES do require do db-manager, que abre a conexão já no
// topo do módulo.
{
  const url = (process.env.DATABASE_URL || process.env.MYSQL_URL
            || process.env.DATABASE_PUBLIC_URL || process.env.MYSQL_PUBLIC_URL
            || process.env.VITE_DATABASE_PUBLIC_URL || '')
    .replace(/^["']|["']$/g, '').trim();
  const host  = url ? (url.split('@')[1] || '').split(/[:/]/)[0] : '';
  const local = ['localhost', '127.0.0.1', '::1', 'host.docker.internal', ''];
  if (!local.includes(host) && !process.argv.includes('--banco-remoto')) {
    console.error('');
    console.error(`  O banco configurado NÃO é local: ${host}`);
    console.error('  Este script funda guilda e reescreve o estado de uma ilha.');
    console.error('  Se é mesmo aí que você quer testar, repita com --banco-remoto.');
    console.error('');
    process.exit(1);
  }
}

const db = require('../managers/db-manager');
const {
  ISLAND_DEFS, TOWER_SLOTS, TOWER_TYPES, rollTowerType, nextEventAt, weekKey,
} = require('../constants/islands');

// ── Argumentos ───────────────────────────────────────────────────────────────
const argv  = process.argv.slice(2);
const flags = Object.fromEntries(
  argv.filter(a => a.startsWith('--')).map(a => {
    const [k, v] = a.replace(/^--/, '').split('=');
    return [k, v === undefined ? true : v];
  })
);
const CONTA   = argv.find(a => !a.startsWith('--')) || 'adm';
const ILHA_ID = Math.max(1, Math.min(3, parseInt(flags.ilha, 10) || 1));
const MODO    = String(flags.modo || 'conquista').toLowerCase();
const TAX_POT = Number.isFinite(parseInt(flags.pot, 10)) ? parseInt(flags.pot, 10) : 250000;

// Cofre da guilda de teste. A torre mais barata custa 1 milhão de OURO e a
// forte 100 mil DOBRÕES — os dois com folga, para o prazo de graça nunca vencer
// por falta de troco.
const COFRE_OURO    = 50000000;
const COFRE_DOBROES = 500000;

if (!['conquista', 'dominio'].includes(MODO)) {
  console.error(`--modo desconhecido: "${MODO}" (use conquista ou dominio)`);
  process.exit(1);
}

/** Cinco torres de pé, com a vida que a TABELA diz hoje. */
function torresDePe(agora, built) {
  const out = [];
  for (let i = 0; i < TOWER_SLOTS; i++) {
    // A vida sai de TOWER_TYPES de propósito: o IslandManager realinha no boot
    // toda torre NEUTRA cujo maxHp não bate com a tabela (_reconciliarTorres),
    // então semear um valor "de teste" aqui seria desfeito no primeiro start.
    // Para torres mais fracas, mexa em constants/islands.js.
    const tipo = rollTowerType();
    const def  = TOWER_TYPES[tipo];
    out.push({
      slot: i, type: tipo,
      hp: def.hp, maxHp: def.hp,
      dead: false, respawnAt: 0, lastDamageAt: 0,
      built: !!built,
      _bornAt: agora,
    });
  }
  return out;
}

async function main() {
  await db.init();
  const agora = Date.now();
  const def   = ISLAND_DEFS[ILHA_ID];

  // ── 1. A conta ─────────────────────────────────────────────────────────────
  const jogador = await db.loadOrCreate(CONTA);
  if (!jogador) {
    console.error(`Conta "${CONTA}" não existe. Rode antes:`);
    console.error(`   node scripts/seed_test_account.js ${CONTA}`);
    process.exit(1);
  }
  // Onde o barco nasce. Na conquista, no mapa da ilha (senão são cinco
  // travessias até lá); no domínio, na praça de onde a coleta zarpa, que é o
  // lugar de onde dá para persegui-la.
  jogador.mapLevel = MODO === 'conquista' ? def.mapLevel : def.venueMap;
  jogador.gold     = Math.max(jogador.gold    || 0, 5000000);
  jogador.dobroes  = Math.max(jogador.dobroes || 0, 500000);
  await db._flush(jogador);

  // ── 2. A guilda ────────────────────────────────────────────────────────────
  const guildas = await db.loadGuilds();
  let guilda = [...guildas.values()].find(g => g.leaderName === CONTA);

  if (!guilda) {
    const tagBase = CONTA.replace(/[^\p{L}\p{N}]/gu, '').toUpperCase().slice(0, 4) || 'TEST';
    guilda = {
      id:         `g_teste_${CONTA.toLowerCase()}`,
      name:       `Irmandade de ${CONTA}`.slice(0, 24),
      tag:        tagBase,
      flag:       'proc:20260825',       // semente procedural (ver guild_flag.gd)
      leaderName: CONTA,
      gold: 0, dobroes: 0, level: 1, xp: 0, taxPct: 0,
      skills: {}, island: null, nextTaxAt: agora + 24 * 3600 * 1000,
      createdAt:  agora,
    };
    console.log(`Guilda nova: [${guilda.tag}] ${guilda.name}`);
  } else {
    console.log(`Guilda existente: [${guilda.tag}] ${guilda.name}`);
  }

  guilda.gold    = Math.max(guilda.gold    || 0, COFRE_OURO);
  guilda.dobroes = Math.max(guilda.dobroes || 0, COFRE_DOBROES);
  const salvou = await db.upsertGuild(guilda);
  if (!salvou) {
    console.error('Nome ou tag de guilda já em uso. Apague a antiga ou troque de conta.');
    process.exit(1);
  }
  await db.upsertGuildMember(guilda.id, CONTA, {
    role: 'leader', contribGold: 0, contribDobroes: 0, contribXp: 0, joinedAt: agora,
  });

  // ── 3. A ilha ──────────────────────────────────────────────────────────────
  const ilhas   = await db.loadIslands();
  const dominio = MODO === 'dominio';

  const ilha = {
    id:            ILHA_ID,
    mapLevel:      def.mapLevel,
    state:         dominio ? 'owned' : 'neutral',
    ownerGuildId:  dominio ? guilda.id : null,
    ownerSince:    dominio ? agora : 0,
    graceUntil:    0,
    // `null` nos dois: `conqueredWeek` é o que impede a MESMA guilda de tomar
    // outra ilha na semana, e `lastEventWeek` igual à semana corrente faria o
    // servidor RESETAR a ilha no boot (ver _checkWeeklyReset) — o domínio que
    // acabamos de semear sumiria antes do primeiro login.
    conqueredWeek: null,
    lastEventWeek: null,
    taxPot:        Math.max(0, TAX_POT),
    nextEventAt:   nextEventAt(ILHA_ID, agora),
    towers:        torresDePe(agora, dominio),
    damageRank:    {},
  };
  await db.upsertIsland(ilha);

  // A trava de "uma ilha por guilda por semana" mora nas OUTRAS ilhas também:
  // uma rodada de teste anterior pode ter deixado esta guilda marcada em outra.
  for (const outra of ilhas.values()) {
    if (outra.id === ILHA_ID) continue;
    if (outra.ownerGuildId !== guilda.id) continue;
    outra.conqueredWeek = null;
    await db.upsertIsland(outra);
    console.log(`   (limpei a marca da semana em ${ISLAND_DEFS[outra.id].name})`);
  }

  // ── 4. O roteiro ───────────────────────────────────────────────────────────
  const vidas = ilha.towers.map(
    t => `${TOWER_TYPES[t.type].name} ${t.maxHp.toLocaleString('pt-BR')}`);
  const totalHp = ilha.towers.reduce((s, t) => s + t.maxHp, 0);

  console.log('');
  console.log(`OK — ${def.name} (mapa ${def.mapLevel}), modo ${MODO}`);
  console.log(`   Conta ......... ${CONTA} (nasce no mapa ${jogador.mapLevel})`);
  console.log(`   Cofre ......... ${guilda.gold.toLocaleString('pt-BR')} de ouro + ${guilda.dobroes.toLocaleString('pt-BR')} dobroes`);
  console.log(`   Imposto ....... ${ilha.taxPot.toLocaleString('pt-BR')} de ouro na praça (${def.venueName}, mapa ${def.venueMap})`);
  console.log(`   Torres ........ ${vidas.join(' | ')}`);
  console.log(`   Vida total .... ${totalHp.toLocaleString('pt-BR')} para derrubar as cinco`);
  console.log(`   Semana ........ ${weekKey(agora)} (sem conquista nem coleta registradas)`);
  console.log('');
  if (dominio) {
    console.log('   Agora: suba o servidor, entre, abra Guilda -> aba Coleta e clique');
    console.log('   em "Fazer a coleta zarpar agora". O barco sai desta praça e segue');
    console.log(`   a rota ${def.route.join(' -> ')}. Afunde-o para ficar com o bolo, ou`);
    console.log('   deixe chegar para ver a divisão entre os membros.');
  } else {
    console.log('   Agora: suba o servidor, entre, derrube as CINCO torres. Quando a');
    console.log('   última cair, a ilha vai para quem somou mais dano e começam 10');
    console.log('   minutos de graça — encoste na ilha, abra o medalhão da ilha e');
    console.log('   erga uma torre com o ouro do cofre. Depois use a aba Coleta.');
  }
  process.exit(0);
}

main().catch(err => {
  console.error('Erro ao montar o cenário da ilha:', err);
  process.exit(1);
});
