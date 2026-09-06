// constants/missions.js — Missões diárias (Barco de Missões)
//
// ── Revisão de 2026-09-06 ───────────────────────────────────────────────────
// O pool anterior foi escrito quando o jogo terminava por volta do mapa 4, e
// envelheceu em três frentes ao mesmo tempo:
//
//   1. ALVOS que o jogo passou por cima. "Absorver 200.000 de dano" era um
//      número grande em 2026-07; hoje um NPC do Mar dos Renegados bate 40.000
//      por golpe — cinco pancadas fechavam a missão do dia.
//   2. RECOMPENSAS que viraram troco. 15.000 de ouro é menos de meio abate no
//      mapa 11 (40.000–60.000 por NPC). A missão custava mais tempo do que
//      pagava, e o jogador que mais tinha o que fazer era o que menos ganhava.
//   3. SISTEMAS INTEIROS sem representação. Bestiário, pets, masmorras bônus,
//      Zona Vermelha e naufrágios nasceram depois deste arquivo, e nenhuma
//      missão os enxergava: o "dia a dia" que o jogo propunha era o de 2026-07.
//
// E uma missão estava QUEBRADA desde sempre: 'world_boss' pedia 200.000 de dano
// no boss mundial, que tem 25.000 de vida. Ela nunca pôde ser concluída por
// ninguém — e não deu erro nenhum, porque missão impossível é indistinguível de
// missão difícil. O alvo agora é medido contra a vida real dele.
//
// ── Saíram ──────────────────────────────────────────────────────────────────
//   • 'reef_hunter'  — só progredia em três NPCs nomeados do começo do jogo
//   • 'market_guard' — só progredia perto da ilha do mapa 3
//     As duas eram diárias COMPARTILHADAS que metade do servidor não podia
//     fazer: quem já passou do mapa 3 não tem por que voltar lá um dia inteiro.
//
// ── Entraram ────────────────────────────────────────────────────────────────
//   • 'relic_hunter' / 'relic_master' — o bestiário, que é o coração do jogo
//   • 'beast_tamer'                   — pets
//   • 'dungeon_diver'                 — masmorras bônus (mapas 7/8/9)
//   • 'scavenger' / 'corsair'         — Zona Vermelha (saque e PvP)
//   • 'elite_hunter'                  — usa `eliteKills`, que o servidor já
//                                       rastreava e nenhuma missão lia
//
// Campos: { id, icon, label, stat, target, reward:{gold?|dobrao?} }
// O stat é progredido por progressDailyMission(player, stat, n) no server.js.
//
// ⚠️ Ao mexer neste arquivo: o pool GRAVADO do jogador é que manda no resto do
// dia (ver o cabeçalho de utils/daily-missions.js). Tirar uma missão daqui NÃO
// devolve recompensa já paga — a marca de coletada sobrevive à poda —, mas quem
// estiver com ela em andamento perde o progresso do dia. Prefira trocar o pool
// perto da virada do dia (21h de Brasília, que é a meia-noite UTC).

const DAILY_MISSION_COUNT = 3;    // 3 missões/dia sorteadas do pool (seed pela data → mesmas o
                                  // dia todo; progresso/concluído persistem por jogador no DB)

// ── A régua das recompensas ──────────────────────────────────────────────────
// O pool é ÚNICO para o servidor inteiro: o mesmo sorteio cai para quem está no
// mapa 1 e para quem está no 11. Não dá para acertar os dois, então a régua é o
// meio do jogo (mapas 4–10, onde um abate rende 4.000–20.000 de ouro e
// 300–1.000 dobrões): a missão paga como ~10 a 20 abates de lá. Fica generosa
// no começo — que é onde ela mais serve, porque é quando o jogador ainda não
// tem rota de farm — e vira um bônus honesto no fim, sem virar a fonte de renda
// de ninguém.
const DAILY_MISSIONS = [
  // ── Combate ─────────────────────────────────────────────────────────────────
  { id:'hunt_150',       icon:'⚔️',  label:'Derrotar 150 inimigos',                    stat:'npcKills',          target:150,       reward:{ gold:120000 } },
  { id:'perfect_kills',  icon:'🛡️',  label:'Derrotar 15 inimigos sem sofrer dano',     stat:'perfectKills',      target:15,        reward:{ dobrao:2500 } },
  // 2.000.000 é ~50 golpes de um NPC de fim de jogo, ou uma tarde inteira de
  // mapa médio. O número velho (200.000) cabia em cinco pancadas.
  { id:'tank',           icon:'🧱',  label:'Absorver 2.000.000 de dano',               stat:'damageBlocked',     target:2000000,   reward:{ gold:150000 } },
  { id:'elite_hunter',   icon:'🎖️',  label:'Afundar 5 navios de elite',                stat:'eliteKills',        target:5,         reward:{ dobrao:3000 } },

  // ── Bestiário ───────────────────────────────────────────────────────────────
  // As duas que faltavam: o bestiário é o sistema com mais peça no jogo (48
  // skills, 47 relíquias) e não tinha uma linha sequer no quadro de missões.
  { id:'relic_hunter',   icon:'🏺',  label:'Conquistar 2 relíquias do bestiário',      stat:'relicDrops',        target:2,         reward:{ dobrao:3500 } },
  { id:'relic_master',   icon:'✨',  label:'Lançar 40 relíquias',                      stat:'relicsUsed',        target:40,        reward:{ gold:100000 } },

  // ── Chefes ──────────────────────────────────────────────────────────────────
  { id:'boss_slayer',    icon:'💀',  label:'Derrotar 2 chefes de mapa',                stat:'bossKills',         target:2,         reward:{ dobrao:3000 } },
  { id:'boss_assist',    icon:'🤝',  label:'Participar da derrota de 3 chefes',        stat:'bossAssists',       target:3,         reward:{ dobrao:2000 } },
  // ⚠️ Medido contra a vida REAL do boss mundial (25.000). O alvo antigo era
  // 200.000 — oito vezes a vida dele, ou seja, impossível.
  { id:'world_boss',     icon:'🩸',  label:'Causar 30.000 de dano no chefe mundial',   stat:'worldBossDamage',   target:30000,     reward:{ dobrao:3500 } },

  // ── Masmorras e exploração ──────────────────────────────────────────────────
  { id:'dungeon_diver',  icon:'🗝️',  label:'Concluir 1 masmorra bônus',                stat:'bonusDungeons',     target:1,         reward:{ dobrao:4000 } },
  { id:'fragments',      icon:'📦',  label:'Abrir 30 fragmentos de mapa',              stat:'fragmentUse',       target:30,        reward:{ gold:120000 } },
  { id:'explorer',       icon:'🗺️',  label:'Visitar 5 ilhas diferentes',               stat:'islandsVisited',    target:5,         reward:{ gold:100000 } },
  { id:'navigator',      icon:'🧭',  label:'Navegar 30.000 metros',                    stat:'distanceSailed',    target:30000,     reward:{ gold:80000 } },
  { id:'visit_boat',     icon:'⛵',  label:'Encontrar o Barco de Missões',             stat:'boatVisit',         target:1,         reward:{ dobrao:1500 } },

  // ── Companhia ───────────────────────────────────────────────────────────────
  // Uma por dia é de propósito: a captura leva 3 min de círculo disputado e a
  // ruína entra em 2 h de recarga. Pedir duas seria pedir sorte, não jogo.
  { id:'beast_tamer',    icon:'🐙',  label:'Domar 1 criatura selvagem',                stat:'petCaptures',       target:1,         reward:{ dobrao:3000 } },

  // ── Zona Vermelha ───────────────────────────────────────────────────────────
  // As duas dependem de OUTRO jogador, então são as mais magras em alvo e as
  // mais gordas em recompensa: um dia sem ninguém no mar vermelho não pode
  // custar caro, e um dia com gente tem de valer a briga.
  { id:'corsair',        icon:'🏴‍☠️', label:'Afundar 2 piratas na Zona Vermelha',       stat:'pvpKills',          target:2,         reward:{ dobrao:4000 } },
  { id:'scavenger',      icon:'⚓',  label:'Saquear 3 ruínas de naufrágio',            stat:'wrecksLooted',      target:3,         reward:{ dobrao:3500 } },

  // ── Economia ────────────────────────────────────────────────────────────────
  { id:'plunder_gold',   icon:'🪙',  label:'Saquear 1.500.000 de ouro em abates',      stat:'goldEarned',        target:1500000,   reward:{ dobrao:3000 } },
  { id:'shopping',       icon:'🛒',  label:'Comprar 5 itens no mercado',               stat:'itemsBought',       target:5,         reward:{ gold:80000 } },

  // ── Meta ────────────────────────────────────────────────────────────────────
  { id:'mission_streak', icon:'📜',  label:'Completar 2 outras missões diárias',       stat:'missionsCompleted', target:2,         reward:{ dobrao:2500 } },
];

module.exports = { DAILY_MISSIONS, DAILY_MISSION_COUNT };
