// constants/missions.js — Missões diárias (Barco de Missões)
//
// Repaginada 2026-07: as missões saíram do Farol e agora vivem no Barco de
// Missões, um NPC que navega entre os mapas 1–4. Mudanças vs. o pool antigo:
//   • 'visit_lighthouse'  → 'visit_boat' (encontrar o barco)
//   • 'lighthouse_keeper' → 'mission_streak' (completar outras missões do dia)
//   • 'kill_with_cannons' + 'sink_ships' consolidadas em 'hunt_100'
//     (todo abate é com canhão e todo NPC é um navio — eram a mesma missão)
//   • 'reef_hunter_stalker/leviathan/manta' consolidadas em 'reef_hunter'
//     (as três progrediam o MESMO stat reefKills — rótulos enganosos)
//   • 'kill_elite' removida (só progredia em PvP contra navio elite — inviável)
//   • novas: 'boss_slayer' (bossKills) e 'plunder_gold' (goldEarned) — stats
//     que o servidor já rastreava mas nenhuma missão usava
//
// Campos: { id, icon, label, stat, target, reward:{gold?|dobrao?} }
// O stat é progredido por progressDailyMission(player, stat, n) no server.js.

const DAILY_MISSION_COUNT = 20;   // quantas missões do pool entram no dia (pool ≤ count → todas)

const DAILY_MISSIONS = [
  // ── Combate ─────────────────────────────────────────────────────────────────
  { id:'hunt_100',       icon:'⚔️', label:'Derrotar 100 inimigos',                   stat:'npcKills',          target:100,    reward:{ gold:150000 } },
  { id:'perfect_kills',  icon:'🛡️', label:'Derrotar 10 inimigos sem sofrer dano',    stat:'perfectKills',      target:10,     reward:{ dobrao:8000 } },
  { id:'reef_hunter',    icon:'🦀', label:'Caçar 80 monstros do recife',             stat:'reefKills',         target:80,     reward:{ gold:120000 } },
  { id:'market_guard',   icon:'🏝️', label:'Defender a Ilha do Comércio (30 abates)', stat:'marketDefense',     target:30,     reward:{ dobrao:10000 } },
  { id:'tank',           icon:'🧱', label:'Absorver 200.000 de dano',                stat:'damageBlocked',     target:200000, reward:{ gold:200000 } },

  // ── Bosses ──────────────────────────────────────────────────────────────────
  { id:'boss_slayer',    icon:'💀', label:'Derrotar 2 bosses de mapa',               stat:'bossKills',         target:2,      reward:{ dobrao:12000 } },
  { id:'boss_assist',    icon:'🤝', label:'Participar da derrota de 3 bosses',       stat:'bossAssists',       target:3,      reward:{ dobrao:8000 } },
  { id:'world_boss',     icon:'🩸', label:'Causar 200.000 de dano no boss mundial',  stat:'worldBossDamage',   target:200000, reward:{ dobrao:12000 } },

  // ── Exploração / economia ───────────────────────────────────────────────────
  { id:'plunder_gold',   icon:'🪙', label:'Saquear 100.000 de ouro em abates',       stat:'goldEarned',        target:100000, reward:{ dobrao:10000 } },
  { id:'explorer',       icon:'🗺️', label:'Visitar 5 ilhas diferentes',              stat:'islandsVisited',    target:5,      reward:{ gold:200000 } },
  { id:'navigator',      icon:'🧭', label:'Navegar 20.000 metros',                   stat:'distanceSailed',    target:20000,  reward:{ gold:150000 } },
  { id:'visit_boat',     icon:'⛵', label:'Encontrar o Barco de Missões',            stat:'boatVisit',         target:1,      reward:{ dobrao:3000 } },
  { id:'shopping',       icon:'🛒', label:'Comprar 3 itens no mercado',              stat:'itemsBought',       target:3,      reward:{ gold:120000 } },
  { id:'fragments',      icon:'📦', label:'Abrir 50 fragmentos de mapa',             stat:'fragmentUse',       target:50,     reward:{ gold:250000 } },

  // ── Meta ────────────────────────────────────────────────────────────────────
  { id:'mission_streak', icon:'📜', label:'Completar 2 outras missões diárias',      stat:'missionsCompleted', target:2,      reward:{ dobrao:7000 } },
];

module.exports = { DAILY_MISSIONS, DAILY_MISSION_COUNT };
