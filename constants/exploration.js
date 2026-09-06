// constants/exploration.js — Fragmentos, recompensas de exploração, mapas bônus e boss mundial

// ── Fragmentos de mapa ────────────────────────────────────────────────────────
const FRAGMENT_DROP_NPC  = 1;       // fragmentos por NPC morto
const FRAGMENT_DROP_BOSS = {        // fragmentos por boss morto (por raridade)
  normal:   3,
  raro:     6,
  especial: 12,
  infernal: 25,
};
const FRAGMENT_EXPLORE_COST          = 1;   // fragmentos gastos por exploração
const FRAGMENT_EXPLORE_FALLBACK_COST = 100; // dobrões gastos se sem fragmentos

// ── EXPLORATION_REWARDS — tabela de recompensas da Mesa de Exploração ─────────
// type: 'ammo'     → id = chave de AMMO_DEFS, qty = quantidade
// type: 'resource' → id = campo do jogador (ironPlates, goldDust, gunpowder, mapFragments)
// weight: peso relativo (maior = mais frequente)
const EXPLORATION_REWARDS = [
  // Munições
  { type: 'ammo',     id: 'bala_perfurante', qty: 10,  weight: 22 },
  { type: 'ammo',     id: 'bala_gelo',       qty: 10,  weight: 22 },
  { type: 'ammo',     id: 'bala_fogo',       qty: 10,  weight: 16 },
  { type: 'ammo',     id: 'bala_cura',       qty: 10,  weight: 16 },
  { type: 'ammo',     id: 'bala_luz',        qty: 10,  weight: 10 },
  { type: 'ammo',     id: 'bala_sangue',     qty: 10,  weight: 6  },
  { type: 'ammo',     id: 'bala_fogo',       qty: 500, weight: 1  }, // jackpot raro
  // Recursos
  { type: 'resource', id: 'ironPlates',      qty: 5,   weight: 12 },
  { type: 'resource', id: 'goldDust',        qty: 3,   weight: 8  },
  { type: 'resource', id: 'gunpowder',       qty: 8,   weight: 11 },
  { type: 'resource', id: 'mapFragments',    qty: 2,   weight: 5  },
  // Peças de Masmorra Bônus — acumulam em player.mapPieces (separado de mapFragments!)
  // Pesos: 4/120 ≈ 3.3% | 2/120 ≈ 1.7% | 1/120 ≈ 0.8%
  { type: 'mapPiece', id: 'mapa_naufrago',   qty: 1,   weight: 4  }, // Baía dos Naufragados  (30 peças, ~3%)
  { type: 'mapPiece', id: 'mapa_fortaleza',  qty: 1,   weight: 2  }, // Fortaleza do Esquecimento (40 peças, ~2%)
  { type: 'mapPiece', id: 'mapa_abismo',     qty: 1,   weight: 1  }, // Abismo dos Afundados  (50 peças, ~1%)
];

// ── BONUS_MAPS — mapas bônus desbloqueáveis via fragmentos ────────────────────
const BONUS_MAPS = [
  { id: 'bonus_map_1', name: 'Baía dos Naufragados',      icon: '🏴‍☠️', pieceId: 'mapa_naufrago',  requiredPieces: 30 },
  { id: 'bonus_map_2', name: 'Fortaleza do Esquecimento', icon: '🏰',  pieceId: 'mapa_fortaleza', requiredPieces: 40 },
  { id: 'bonus_map_3', name: 'Abismo dos Afundados',      icon: '🌊',  pieceId: 'mapa_abismo',    requiredPieces: 50 },
];

// ── WORLD_BOSS_DEF — o chefe mundial, evento de servidor ──────────────────
//
// Surge depois de N chefes de zona mortos (contagem GLOBAL, não por jogador),
// é anunciado para todo mundo com 5 s de antecedência e fica no mar por
// `expireDelay` sem tomar dano antes de ir embora.
//
// ── Revisão de 2026-09-06 ────────────────────────────────────────────
// Os números aqui eram os da versão de NAVEGADOR e nunca foram tocados desde a
// migração. 25.000 de vida quando a Viúva Afogada tem 10.000.000 e um NPC do
// Mar dos Renegados tem 3.000.000 (×10 na dificuldade extrema): o "DEUS DO MAR"
// morria mais rápido que o bicho comum do mapa 4.
//
// ⚠️ A DIFICULDADE MÉDIA DOS JOGADORES ONLINE MULTIPLICA VIDA E DANO (×1 no
// fácil, ×10 no extremo — ver difficultyMult e o `spawn` do world-boss-manager).
// Os números abaixo são o PISO, não o que aparece no mar: com o servidor no
// meio da tabela (×4) esta vida vira ~32 milhões, e no extremo, 80.
//
// A régua usada: ele tem de ser o alvo mais duro do jogo (é um evento de
// servidor, todo mundo é chamado), mas tem de CABER na janela em que fica no
// mar. Daí a vida ficar abaixo da Viúva, que não tem prazo, e o `expireDelay`
// ter subido para 15 min — 10 não davam nem para atravessar o mapa e chegar.
const WORLD_BOSS_DEF = [
  {
    name:                'Legendary ghost Pirate Ship',
    icon:                '🦑',
    // 5 → 10: com três chefes de mapa em rotação, cinco abates aconteciam rápido
    // demais para uma coisa chamada DEUS DO MAR. Evento raro é evento.
    spawnAfterBossKills:  10,
    spawnChance:          1.0,
    baseHp:               8000000,
    // Contra os 90.000 de vida do maior casco do jogo: o `cannon_shot` dele tem
    // damageMult 3, então são 42.000 por tiro no piso da dificuldade — meio
    // navio. Quem entra sozinho no evento morre, e essa é a intenção.
    baseDamage:           14000,
    // 0,15% da vida por segundo. O valor antigo (250) era 1% da vida ANTIGA por
    // segundo; mantido em proporção, ele só pune raide que trava, sem virar uma
    // corrida de DPS mínimo.
    regenPerSec:          12000,
    regenDelay:           20000,
    expireDelay:          900000,
    hitRadius:            16,
    fireInterval:         4000,
    // O espolio é dividido por DANO entre todos que participaram, então o
    // número cheio só vai para quem lutou sozinho. Na escala de hoje um NPC do
    // mapa 11 larga 10.000–25.000 dobrões — o chefe mundial precisava valer
    // mais que um bicho comum, e valia menos.
    dobraoMin:            8000,
    dobraoMax:            12000,
    mapFragments:         500,
    // 5.000 era menos que quatro abates do mapa 11 (1.200 cada). 250.000 põe o
    // evento na faixa de "vale largar o que estava fazendo".
    xpPerKill:            250000,
    hullColor:            0x050505,
    sailColor:            0x220011,
    attacks:              ['cannon_shot', 'cannon_burst', 'poison_spit', 'ghost_soul_pillars'],
    // ── Onde ele nasce ─────────────────────────────────────────────
    // Era [1, 2] — os dois mapas iniciais. Duas coisas erradas de uma vez: um
    // chefe que bate 42.000 aparecia onde o jogador tem barco de 1.000 de vida,
    // e o único conteúdo de servidor do jogo ficava num lugar onde ninguém com
    // nível para lutar contra ele ainda navega.
    //
    // Agora é 4 / 6 / 10: meio e fim de jogo, todos zona AMARELA (sem PvP, para
    // o evento não virar emboscada) e todos alcançáveis. O mapa 6 é o melhor
    // palco — não tem NPC nenhum, então a briga é só contra ele.
    mapLevel:             [4, 6, 10],
    model:               '/models/ships/legendary_ghost_pirate_ship.glb',
    scale:               2.1,
    yOffset:             3,
    rotOffset:           0,
    rarity: { id: 'deus', label: 'DEUS DO MAR', hpMult: 1, rewardMult: 25, chance: 1, color: '#ff2200', bg: 'rgba(80,0,0,0.97)' },
  }
];

module.exports = {
  FRAGMENT_DROP_NPC, FRAGMENT_DROP_BOSS,
  FRAGMENT_EXPLORE_COST, FRAGMENT_EXPLORE_FALLBACK_COST,
  EXPLORATION_REWARDS,
  BONUS_MAPS, WORLD_BOSS_DEF,
};
