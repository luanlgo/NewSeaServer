// constants/attacks.js — Catálogo global de ataques reutilizáveis por NPCs e bosses
//
// Campos:
//   id          string   — chave única
//   rangeMin/Max number  — distância válida para usar o ataque
//   castTime    number   — ms entre o telegraph e o dano real
//   cooldown    number   — ms de cooldown após uso
//   damageMult  number   — multiplicador sobre cannonDmg do NPC
//   shape       string   — 'projectile' | 'circle' | 'cone' | 'line' | 'aura' | 'targeted_aoe'
//   count/spread         — para 'projectile': qtd de projéteis e abertura do cone
//   radius               — para 'circle': raio do AoE
//   angle                — para 'cone': abertura em radianos
//   length               — para 'cone'/'line': alcance máximo
//   width                — para 'line': largura perpendicular
//   weight      number   — peso na seleção aleatória ponderada
//   telegraph   object   — { color: 0xRRGGBB } cor do indicador visual
//
// Ordenação: fáceis de desviar → difíceis de desviar
//   Critérios: castTime longo = mais tempo p/ reagir; área pequena = fácil sair;
//              projétil único < linha estreita < cone estreito < círculo < cone largo
//              < círculo grande < targeted_aoe < aura (indesviável)

const ATTACK_DEFS = {

  // ════════════════════════════════════════════════════════════════════════════
  // 🟢 FÁCEIS DE DESVIAR — projétil único / área pequena / cast longo
  // ════════════════════════════════════════════════════════════════════════════

  // Projétil único, castTime=500ms, spread quase zero — mais fácil do jogo
  cannon_shot: {
    id: 'cannon_shot',
    name: 'Tiro de Canhão',
    rangeMin: 20,
    rangeMax: 150,
    castTime: 500,
    cooldown: 2500,
    damageMult: 3,
    shape: 'projectile',
    count: null,
    spread: 0.05,
    weight: 10,
    telegraph: { color: 0xff6600 },
  },

  // Projétil único, spread=0 (perfeitamente mirado), castTime=800ms
  poison_spit: {
    id: 'poison_spit',
    name: 'Poison Spit',
    rangeMin: 120,
    rangeMax: 420,
    castTime: 800,
    cooldown: 2600,
    damageMult: 0.9,
    shape: 'projectile',
    count: 1,
    spread: 0,
    weight: 12,
    telegraph: { color: 0x66ff66 },
  },

  // Linha mais estreita do jogo (width=18), castTime=1000ms
  impale_line: {
    id: 'impale_line',
    name: 'Empalamento',
    rangeMin: 60,
    rangeMax: 220,
    castTime: 1000,
    cooldown: 12000,
    damageMult: 3.0,
    shape: 'line', width: 18,
    weight: 4,
    telegraph: { color: 0x22ff88 },
  },

  // Linha estreita (width=20), castTime=700ms
  deep_surge: {
    id: 'deep_surge',
    name: 'Investida Abissal',
    rangeMin: 70,
    rangeMax: 220,
    castTime: 700,
    cooldown: 14000,
    damageMult: 3.0,
    shape: 'line', width: 20,
    weight: 3,
    telegraph: { color: 0x0055ff },
  },

  // Linha estreita (width=25), castTime=700ms
  charge_line: {
    id: 'charge_line',
    name: 'Investida',
    rangeMin: 40,
    rangeMax: 180,
    castTime: 700,
    cooldown: 8000,
    damageMult: 2.5,
    shape: 'line', width: 25,
    weight: 5,
    telegraph: { color: 0x88ff44 },
  },

  // 3 projéteis, castTime=600ms, spread moderado
  forked_shot: {
    id: 'forked_shot',
    name: 'Tiro Bifurcado',
    rangeMin: 30,
    rangeMax: 160,
    castTime: 600,
    cooldown: 4000,
    damageMult: 0.8,
    shape: 'projectile',
    count: 3,
    spread: 0.35,
    weight: 7,
    telegraph: { color: 0xaaff22 },
  },

  // Círculo pequeno (radius=40), castTime=1000ms — fácil sair andando
  tentacle_slam: {
    id: 'tentacle_slam',
    name: 'Pancada de Tentáculo',
    rangeMin: 0,
    rangeMax: 50,
    castTime: 1000,
    cooldown: 9000,
    damageMult: 2.5,
    shape: 'circle', radius: 40,
    weight: 7,
    telegraph: { color: 0xff0033 },
  },

  // ════════════════════════════════════════════════════════════════════════════
  // 🟡 MODERADOS — área média ou cast curto demais para reagir bem
  // ════════════════════════════════════════════════════════════════════════════

  // 3 projéteis, castTime=1100ms, spread=0.22π — mais lento mas espalhado
  triple_spit: {
    id: 'triple_spit',
    name: 'Triple Spit',
    rangeMin: 140,
    rangeMax: 450,
    castTime: 1100,
    cooldown: 4200,
    damageMult: 0.75,
    shape: 'projectile',
    count: 3,
    spread: Math.PI * 0.22,
    weight: 7,
    telegraph: { color: 0x55ff99 },
  },

  // Círculo (radius=50), castTime=1000ms
  bite: {
    id: 'bite',
    name: 'Mordida',
    rangeMin: 0,
    rangeMax: 60,
    castTime: 1000,
    cooldown: 3000,
    damageMult: 1.8,
    shape: 'circle', radius: 50,
    weight: 8,
    telegraph: { color: 0x44ff44 },
  },

  // Cone 60°, castTime=700ms — cone estreito mas cast rápido
  ink_blast: {
    id: 'ink_blast',
    name: 'Jato de Tinta',
    rangeMin: 0,
    rangeMax: 90,
    castTime: 700,
    cooldown: 6000,
    damageMult: 1.4,
    shape: 'cone', angle: 1.047, length: 90,   // 60°
    weight: 6,
    telegraph: { color: 0x6600aa },
  },

  // Círculo (radius=55), castTime=1100ms
  venom_pool: {
    id: 'venom_pool',
    name: 'Poça de Veneno',
    rangeMin: 0,
    rangeMax: 80,
    castTime: 1100,
    cooldown: 10000,
    damageMult: 0.8,
    shape: 'circle', radius: 55,
    weight: 4,
    telegraph: { color: 0x44aa00 },
  },

  // Círculo (radius=60), castTime=1100ms
  claw_slam: {
    id: 'claw_slam',
    name: 'Investida das Garras',
    rangeMin: 0,
    rangeMax: 80,
    castTime: 1100,
    cooldown: 12000,
    damageMult: 4.0,
    shape: 'circle', radius: 60,
    weight: 4,
    telegraph: { color: 0xff0000 },
  },

  // Linha (width=30), castTime=1500ms — longo mas longo alcance (rangeMax=700)
  sniper_shot: {
    id: 'sniper_shot',
    name: 'Sniper Shot',
    rangeMin: 260,
    rangeMax: 700,
    castTime: 1500,
    cooldown: 5200,
    damageMult: 1.8,
    shape: 'line', length: 700, width: 30,
    weight: 4,
    telegraph: { color: 0xffff66 },
  },

  // Linha (width=42), castTime=500ms — cast MUITO rápido, compensa a largura
  piercing_beam: {
    id: 'piercing_beam',
    name: 'Piercing Beam',
    rangeMin: 220,
    rangeMax: 650,
    castTime: 500,
    cooldown: 6500,
    damageMult: 1.9,
    shape: 'line', length: 650, width: 42,
    weight: 3,
    telegraph: { color: 0x00ffff },
  },

  // Linha (width=45), castTime=1000ms — mais larga
  cross_blast: {
    id: 'cross_blast',
    name: 'Cross Blast',
    rangeMin: 80,
    rangeMax: 280,
    castTime: 1000,
    cooldown: 6000,
    damageMult: 1.25,
    shape: 'line', length: 280, width: 45,
    weight: 5,
    telegraph: { color: 0xcc66ff },
  },

  // 5 projéteis, castTime=1500ms, spread=0.40 — muitos projéteis mas cast longo
  cannon_burst: {
    id: 'cannon_burst',
    name: 'Salva de Canhões',
    rangeMin: 20,
    rangeMax: 120,
    castTime: 1500,
    cooldown: 7000,
    damageMult: 0.65,
    shape: 'projectile',
    count: 5,
    spread: 0.40,
    weight: 5,
    telegraph: { color: 0xff4400 },
  },

  // Círculo (radius=90), castTime=1500ms
  shockwave: {
    id: 'shockwave',
    name: 'Onda de Choque',
    rangeMin: 0,
    rangeMax: 100,
    castTime: 1500,
    cooldown: 15000,
    damageMult: 3.5,
    shape: 'circle', radius: 90,
    weight: 3,
    telegraph: { color: 0xffff44 },
  },

  // Cone 90°, castTime=900ms — ângulo médio-alto
  tentacle_sweep: {
    id: 'tentacle_sweep',
    name: 'Varredura de Tentáculos',
    rangeMin: 0,
    rangeMax: 120,
    castTime: 900,
    cooldown: 8000,
    damageMult: 2.0,
    shape: 'cone', angle: 1.571, length: 120,  // 90°
    weight: 5,
    telegraph: { color: 0xff2200 },
  },

  // ════════════════════════════════════════════════════════════════════════════
  // 🔴 DIFÍCEIS DE DESVIAR — área grande, efeitos especiais ou cobertura ampla
  // ════════════════════════════════════════════════════════════════════════════

  // Linha com efeito de PULL — arrasta o jogador para perto do NPC
  mimic_tongue_lash: {
    id: 'mimic_tongue_lash',
    name: 'Linguada do Mímico',
    rangeMin: 60,
    rangeMax: 420,
    castTime: 1400,
    cooldown: 9000,
    damageMult: 0.7,
    shape: 'line', length: 420, width: 28,
    weight: 8,
    telegraph: { color: 0xd4a017 },
    effects: [
      { type: 'pull', pullDistance: 55 },
    ],
  },

  // Círculo (radius=95), castTime=1700ms — médio-grande, difícil escapar
  meteor_drop: {
    id: 'meteor_drop',
    name: 'Meteor Drop',
    rangeMin: 180,
    rangeMax: 500,
    castTime: 1700,
    cooldown: 7000,
    damageMult: 1.7,
    shape: 'circle', radius: 95,
    weight: 4,
    telegraph: { color: 0xffaa33 },
  },

  // 5 projéteis, spread=0.4π (~72°) — leque enorme quase impossível desviar todo
  barrage_fan: {
    id: 'barrage_fan',
    name: 'Barrage Fan',
    rangeMin: 150,
    rangeMax: 500,
    castTime: 1350,
    cooldown: 5500,
    damageMult: 0.65,
    shape: 'projectile',
    count: 5,
    spread: Math.PI * 0.4,
    weight: 6,
    telegraph: { color: 0x33ddff },
  },

  // Círculo (radius=110), castTime=1600ms
  tail_slam: {
    id: 'tail_slam',
    name: 'Tail Slam',
    rangeMin: 0,
    rangeMax: 130,
    castTime: 1600,
    cooldown: 7000,
    damageMult: 1.35,
    shape: 'circle', radius: 110,
    weight: 8,
    telegraph: { color: 0xff8844 },
  },

  // Círculo (radius=130), castTime=1900ms — grande, precisa sair correndo cedo
  heavy_stomp: {
    id: 'heavy_stomp',
    name: 'Heavy Stomp',
    rangeMin: 0,
    rangeMax: 100,
    castTime: 1900,
    cooldown: 5200,
    damageMult: 1.6,
    shape: 'circle', radius: 130,
    weight: 5,
    telegraph: { color: 0xff3355 },
  },

  // Cone 108°, castTime=1800ms — cobre mais de meia tela lateralmente
  lava_breath: {
    id: 'lava_breath',
    name: 'Lava Breath',
    rangeMin: 80,
    rangeMax: 260,
    castTime: 1800,
    cooldown: 5800,
    damageMult: 1.25,
    shape: 'cone', angle: Math.PI * 0.6, length: 260,
    weight: 5,
    telegraph: { color: 0xff5522 },
  },

  // Cone 126°, castTime=900ms — cast RÁPIDO + ângulo enorme = muito perigoso
  cleave: {
    id: 'cleave',
    name: 'Cleave',
    rangeMin: 0,
    rangeMax: 120,
    castTime: 900,
    cooldown: 2200,
    damageMult: 1.05,
    shape: 'cone', angle: Math.PI * 0.7, length: 120,
    weight: 10,
    telegraph: { color: 0xff7777 },
  },

  // Círculo (radius=145), castTime=1900ms — enorme, quase impossível sair a tempo
  whirlwind: {
    id: 'whirlwind',
    name: 'Whirlwind',
    rangeMin: 0,
    rangeMax: 100,
    castTime: 1900,
    cooldown: 5000,
    damageMult: 1.3,
    shape: 'circle', radius: 145,
    weight: 6,
    telegraph: { color: 0xdddddd },
  },

  // Cone 153°, castTime=1500ms — cobre quase todo o arco frontal
  wide_flame_cone: {
    id: 'wide_flame_cone',
    name: 'Wide Flame Cone',
    rangeMin: 70,
    rangeMax: 220,
    castTime: 1500,
    cooldown: 5000,
    damageMult: 1.1,
    shape: 'cone', angle: Math.PI * 0.85, length: 220,
    weight: 6,
    telegraph: { color: 0xff6600 },
  },

  // Círculo gigante (radius=200), castTime=2200ms — enorme mas aviso longo
  arcane_nova: {
    id: 'arcane_nova',
    name: 'Arcane Nova',
    rangeMin: 0,
    rangeMax: 200,
    castTime: 2200,
    cooldown: 8000,
    damageMult: 2.0,
    shape: 'circle', radius: 200,
    weight: 3,
    telegraph: { color: 0x8888ff },
  },

  // ════════════════════════════════════════════════════════════════════════════
  // 💀 INDESVIÁVEIS — atinge todos os jogadores em range ou é aura passiva
  // ════════════════════════════════════════════════════════════════════════════

  // Targeted AoE em TODOS os jogadores próximos simultaneamente
  ghost_soul_pillars: {
    id: 'ghost_soul_pillars',
    name: 'Pilares das Almas',
    shape: 'targeted_aoe', targetMode: 'all_players_in_range',
    rangeMin: 0,
    rangeMax: 300,
    castTime: 1600,
    cooldown: 9000,
    damageMult: 2.5,
    radius: 80, weight: 20,
    effects: [
      { type: 'speed_buff', value: -0.15, duration: 1500 },
    ],
    visualEffect: 'blood_pillar',
    telegraph: { color: 0xcc44ff },
  },

  // Aura passiva permanente — impossível desviar, aplica debuff contínuo
  ghost_dread_aura: {
    id: 'ghost_dread_aura',
    name: 'Domínio do Pavor',
    shape: 'aura', radius: 500, tickRate: 500,
    castTime: 0,
    cooldown: 0,
    damageMult: 0, weight: 100,
    effects: [
      { type: 'speed_buff',   value: -0.20, duration: 1200 },
      { type: 'defense_buff', value: -0.20, duration: 1200 },
    ],
  },
};

module.exports = { ATTACK_DEFS };
