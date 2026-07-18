#!/usr/bin/env node
// scripts/seed_test_account.js — Cria/atualiza uma conta de teste local com
// recursos abundantes e todas as relíquias, para testar o cliente sem precisar
// farmar. NÃO usar em produção — a conta fica sem senha (login por qualquer
// dispositivo na 1ª vez, trust-on-first-use).
//
// Uso:
//   node scripts/seed_test_account.js [nomeDaConta]
//
// Exemplo:
//   node scripts/seed_test_account.js adm
//
// Depois é só logar no cliente com esse nome — sem precisar criar personagem
// do zero. Rodar de novo a qualquer momento para "resetar" a conta ao estado
// de teste (sobrescreve tudo, exceto o secret_hash já vinculado, se houver).

'use strict';
require('dotenv').config();

const db = require('../managers/db-manager');
const { RELIC_DEFS, SHIP_DEFS } = require('../constants');

const ACCOUNT_NAME = process.argv[2] || 'adm';
const BIG           = 999999999;

async function main() {
  await db.init(); // garante que a tabela e todas as colunas existem

  // ── Relíquias: uma cópia de cada uma das 10, todas na mochila ───────────────
  const allRelics = Object.keys(RELIC_DEFS).map((relicId, i) => ({
    instanceId: `rl_seed_${i}`,
    relicId,
    rarity: RELIC_DEFS[relicId].rarity,
  }));

  // ── Canhões: bastante estoque de c6 (inclui alguns já pesquisados e outros
  //    parcialmente pesquisados, pra testar a aba de Pesquisa de Canhão) ──────
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

  const activeShip = 'queen_annes_revenge'; // maxCannons 45, maxHelic 4, maxMana 10

  const player = {
    name: ACCOUNT_NAME,
    gold: BIG,
    dobroes: BIG,
    inventory: {
      cannons,
      pirates: ['healer', 'healer_elite'],
      ammo: {
        bala_perfurante: BIG,
        bala_gelo:       BIG,
        bala_fogo:       BIG,
        bala_luz:        BIG,
        bala_sangue:     BIG,
        bala_cura:       BIG,
      },
      ships: Object.keys(SHIP_DEFS), // todos os navios compráveis, incluindo elites
      sails: ['vela_quadrada', 'vela_estai', 'vela_latina'],
      relics: allRelics,
    },
    cannons: Array(20).fill('c6'), // equipados (20 = MAX_CANNON_SLOTS)
    pirates: ['healer_elite'],
    equippedSails: ['vela_estai', 'vela_latina'],
    activeShip,
    skills: {
      ataque:     { level: 50, xp: 0 },
      velocidade: { level: 50, xp: 0 },
      defesa:     { level: 50, xp: 0 },
      vida:       { level: 50, xp: 0 },
      reliquia:   { level: 50, xp: 0 },
    },
    npcKills:     999999, // desbloqueia todas as dificuldades (extreme precisa de 1000)
    difficulty:   4,      // extreme
    mapXp:        BIG,
    mapLevel:     6,      // Mar das Lamentações — último mapa regular (7-9 são bônus)
    mapFragments: 999999,
    relicDeck: allRelics.slice(0, 4).map(r => r.instanceId), // maxHelic do navio ativo
    talents: {
      hp: 5, defesa: 5, canhoes: 5, dano: 5, dano_relic: 5,
      riqueza: 5, ganancioso: 5, mestre: 5, slot_reliquia: 1,
      totalSpent: 41,
    },
    shipIslandUpgrades: { hp: 5, defense: 5, damage: 5 },
    cannonUpgradesData,
    ironPlates: 999999,
    goldDust:   999999,
    gunpowder:  999999,
    bonusMapsUnlocked: ['bonus_map_1', 'bonus_map_2', 'bonus_map_3'],
    hp: 999999,
    currentAmmo: 'bala_ferro',
    bankGold: BIG,
    bankUnlocked: true,
  };

  await db.loadOrCreate(ACCOUNT_NAME); // garante que a linha exista antes do UPDATE
  await db._flush(player);

  // Senha da conta de teste (login novo exige senha). Sobrescreva com:
  //   TEST_ACCOUNT_PASSWORD=minhasenha node scripts/seed_test_account.js
  const { hashPassword } = require('../utils/password');
  const testPassword = process.env.TEST_ACCOUNT_PASSWORD || 'adm123';
  await db.setPassword(ACCOUNT_NAME, await hashPassword(testPassword));

  console.log(`✅ Conta de teste "${ACCOUNT_NAME}" populada com sucesso.`);
  console.log(`   Logue no cliente com nome "${ACCOUNT_NAME}" e senha "${testPassword}".`);
  process.exit(0);
}

main().catch(err => {
  console.error('❌ Erro ao popular conta de teste:', err);
  process.exit(1);
});
