#!/usr/bin/env node
// scripts/seed_playtest_accounts.js — cria um LOTE de contas de playtest já em
// estado de late game, para juntar gente e testar o fim do jogo sem farmar.
//
// É irmão do seed_test_account.js: mesmo caminho de escrita (loadOrCreate →
// _flush → setPassword), que é o único já validado para montar uma ficha
// inteira do zero. A diferença é que este cria N contas de uma vez e recebe os
// valores de moeda/XP por fora, em vez do 999999999 em tudo.
//
// Uso:
//   node scripts/seed_playtest_accounts.js           # DRY RUN (não grava nada)
//   node scripts/seed_playtest_accounts.js --yes     # grava de verdade
//
// Configurável por ambiente (os defaults são os do playtest de 05/09):
//   PLAYTEST_PREFIX=prom  PLAYTEST_COUNT=10  PLAYTEST_PASSWORD=123456
//   PLAYTEST_GOLD=10000000  PLAYTEST_DOBROES=1000000  PLAYTEST_XP=1000000
//
// ⚠️  ESCREVE NO BANCO QUE O .env APONTAR. Hoje o .env é a produção (Railway),
//     então rodar com --yes cria conta em prod. O dry run não grava e nem roda
//     migração — só faz SELECT para dizer quais nomes já existem.
//
// ⚠️  NENHUMA DAS CONTAS PODE ESTAR LOGADA. O servidor mantém o jogador em
//     memória e regrava tudo a cada 15s (batchSave); com a conta conectada a
//     gravação do servidor sobrescreve o que este script escreveu, e some sem
//     erro nenhum aparecer. Para CRIAR do zero tanto faz — ninguém está logado
//     numa conta que ainda não existe —, mas para RECARREGAR saldo no meio do
//     playtest, o tester tem que deslogar antes.
//
// Sobre o XP: `mapXp` não é gasto em lugar nenhum. É um acumulador que serve de
// PATAMAR para duas coisas — avançar de mapa e liberar a próxima compra de
// talento (utils/talent-logic.js, calcXpRequired). Por isso 1.000.000 não é
// "um milhão de XP para gastar": é o gate que libera 155 compras de talento.
// Quem paga as compras é o ouro (as 155 primeiras somam 8.015.000), e é por
// isso que 10M de ouro casa com 1M de XP. Dobrão só entra na compra nº 201 em
// diante, então o 1M de dobrões aqui é para loja/navio/canhão, não para árvore.
//
// A árvore vai VAZIA de propósito: o interessante do teste é cada um montar a
// própria build com os 155 pontos que o XP libera.

'use strict';
require('dotenv').config();

const db = require('../managers/db-manager');
const { RELIC_DEFS, SHIP_DEFS } = require('../constants');
const { hashPassword } = require('../utils/password');

const PREFIXO = process.env.PLAYTEST_PREFIX   || 'prom';
const QTD     = Number(process.env.PLAYTEST_COUNT    || 10);
const SENHA   = process.env.PLAYTEST_PASSWORD || '123456';
const OURO    = Number(process.env.PLAYTEST_GOLD     || 10000000);
const DOBROES = Number(process.env.PLAYTEST_DOBROES  || 1000000);
const XP      = Number(process.env.PLAYTEST_XP       || 1000000);

const APLICAR = process.argv.includes('--yes');

// Recursos que não são a moeda pedida — vão fartos, igual à conta adm.
const FARTO = 999999999;

// players.gold e players.dobroes são INT (DEFAULT 100 / 0) no schema.
const TETO_INT = 2147483647;

/** A ficha de late game de uma conta. Espelha seed_test_account.js, exceto
 *  moeda/XP (parametrizados) e a árvore de talentos (vazia). */
function fichaDe(nome) {
  // O instanceId de relíquia leva o nome da conta no meio DE PROPÓSITO. As 10
  // contas vão conviver — guilda, correio, leilão — e relíquia trocada entre
  // elas carrega o instanceId junto. Com o `rl_seed_N` fixo do script original,
  // duas contas teriam ids iguais, e o deck (que é POSICIONAL — índice é a
  // tecla, utils/relic-deck.js) passaria a casar com a relíquia errada depois
  // de uma troca.
  const relics = Object.keys(RELIC_DEFS).map((relicId, i) => ({
    instanceId: `rl_${nome}_${i}`,
    relicId,
    rarity: RELIC_DEFS[relicId].rarity,
  }));

  const cannons = [
    ...Array(30).fill('c6'),
    ...Array(10).fill('c5'),
    ...Array(5).fill('c4'),
    ...Array(5).fill('c3'),
    ...Array(5).fill('c2'),
    ...Array(5).fill('c1'),
  ];
  const cannonUpgradesData = cannons.map((id, idx) => {
    if (id !== 'c6') return { as: 0, rn: 0, dm: 0 };
    if (idx < 2) return { as: 1, rn: 1, dm: 1 }; // 100% pesquisado
    if (idx < 5) return { as: 1, rn: 0, dm: 0 }; // parcial (2 pendentes)
    return { as: 0, rn: 0, dm: 0 };              // sem pesquisa
  });

  return {
    name: nome,
    gold: OURO,
    dobroes: DOBROES,
    inventory: {
      cannons,
      pirates: ['healer', 'healer_elite'],
      ammo: {
        bala_perfurante: FARTO,
        bala_gelo:       FARTO,
        bala_fogo:       FARTO,
        bala_luz:        FARTO,
        bala_sangue:     FARTO,
        bala_cura:       FARTO,
      },
      ships: Object.keys(SHIP_DEFS),
      sails: ['vela_quadrada', 'vela_estai', 'vela_latina'],
      relics,
    },
    cannons: Array(20).fill('c6'),          // equipados (MAX_CANNON_SLOTS)
    pirates: ['healer_elite'],
    equippedSails: ['vela_estai', 'vela_latina'],
    activeShip: 'queen_annes_revenge',      // maxCannons 45, maxHelic 4
    skills: {
      ataque:     { level: 50, xp: 0 },
      velocidade: { level: 50, xp: 0 },
      defesa:     { level: 50, xp: 0 },
      vida:       { level: 50, xp: 0 },
      reliquia:   { level: 50, xp: 0 },
    },
    npcKills:     999999,                   // destrava todas as dificuldades
    difficulty:   4,                        // extremo
    mapXp:        XP,
    mapLevel:     6,                        // último mapa regular (7-9 são bônus)
    mapFragments: 999999,
    relicDeck:    relics.slice(0, 4).map(r => r.instanceId),

    // Árvore VAZIA — os 155 pontos que o XP libera ficam para o tester gastar.
    talents:      { totalSpent: 0 },
    talentPoints: 0,                        // 0 livres: cada compra sai em ouro

    shipIslandUpgrades: { hp: 5, defense: 5, damage: 5 },
    cannonUpgradesData,
    ironPlates: 999999,
    goldDust:   999999,
    gunpowder:  999999,
    bonusMapsUnlocked: ['bonus_map_1', 'bonus_map_2', 'bonus_map_3'],
    hp: 999999,                             // o servidor reajusta no login
    currentAmmo: 'bala_ferro',
    bankGold: 0,                            // o pedido foi 10M em mão, não no banco
    bankUnlocked: true,
    tutorialState: 2,                       // já passou (é o mesmo estado que o
                                            // grandfathering de >=20 kills daria)
  };
}

function valida() {
  const erros = [];
  if (!(QTD > 0 && QTD <= 200)) erros.push(`PLAYTEST_COUNT invalido: ${QTD}`);
  if (!SENHA)                   erros.push('PLAYTEST_PASSWORD vazia');
  for (const [rot, v] of [['GOLD', OURO], ['DOBROES', DOBROES], ['XP', XP]]) {
    if (!Number.isFinite(v) || v < 0) erros.push(`PLAYTEST_${rot} invalido: ${v}`);
  }
  // Acima do teto de INT o MySQL satura no maximo (ou erra em strict mode) —
  // em vez de descobrir isso depois, com a conta ja gravada errada.
  if (OURO    > TETO_INT) erros.push(`ouro ${OURO} passa do teto INT (${TETO_INT})`);
  if (DOBROES > TETO_INT) erros.push(`dobroes ${DOBROES} passa do teto INT (${TETO_INT})`);
  return erros;
}

async function main() {
  const erros = valida();
  if (erros.length) {
    console.error('❌ Configuracao invalida:');
    for (const e of erros) console.error('   - ' + e);
    process.exit(1);
  }

  const nomes = Array.from({ length: QTD }, (_, i) => `${PREFIXO}${i + 1}`);
  let alvo = '(nao consegui ler do .env)';
  try {
    alvo = new URL(process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL || '').host;
  } catch (_) { /* deixa o texto padrao */ }

  console.log('');
  console.log('  contas : ' + nomes[0] + ' .. ' + nomes[nomes.length - 1] + '  (' + QTD + ')');
  console.log('  banco  : ' + alvo);
  console.log('  ouro   : ' + OURO.toLocaleString('pt-BR'));
  console.log('  dobroes: ' + DOBROES.toLocaleString('pt-BR'));
  console.log('  xp     : ' + XP.toLocaleString('pt-BR') + '  (gate de talento, nao e saldo gastavel)');
  console.log('  arvore : vazia');
  console.log('');

  if (!APLICAR) {
    console.log('-- DRY RUN --  nada sera gravado, so SELECT de existencia.');
    console.log('');
    let jaExistem = 0;
    for (const nome of nomes) {
      const existe = await db.playerExists(nome);
      if (existe) jaExistem++;
      console.log('   ' + (existe ? 'JA EXISTE (seria SOBRESCRITA)' : 'livre                       ') + '  ' + nome);
    }
    console.log('');
    if (jaExistem) {
      console.log('ATENCAO: ' + jaExistem + ' conta(s) ja existem. Rodar com --yes SOBRESCREVE a');
      console.log('ficha delas (inventario, talentos, moeda) e troca a senha.');
      console.log('');
    }
    console.log('Para gravar de verdade:');
    console.log('   node scripts/seed_playtest_accounts.js --yes');
    console.log('');
    process.exit(0);
  }

  console.log('-- APLICANDO --');
  await db.init();   // garante tabela e colunas

  for (const nome of nomes) {
    await db.loadOrCreate(nome);          // garante a linha antes do UPDATE
    await db._flush(fichaDe(nome));
    await db.setPassword(nome, await hashPassword(SENHA));
    console.log('   ok  ' + nome);
  }

  console.log('');
  console.log('Pronto: ' + nomes.length + ' conta(s). Senha: "' + SENHA + '".');
  console.log('Navio ativo queen_annes_revenge, 20x c6, todas as reliquias,');
  console.log('mapa 6, dificuldade extremo, arvore de talentos zerada.');
  console.log('');
  process.exit(0);
}

main().catch(err => {
  console.error('❌ Erro ao popular contas de playtest:', err);
  process.exit(1);
});
