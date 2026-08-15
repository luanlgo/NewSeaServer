// constants/maps.js — MAP_DEFS: progressão, dificuldade e visual por mapa
// Para adicionar um mapa: copie um bloco existente e ajuste os valores.
//
// pvpZone — regra de combate jogador×jogador do mapa:
//   'green'  → PVE puro: dano PvP desabilitado (projétil atravessa)
//   'yellow' → PvP liberado: matar jogador transfere 5% de XP/kills da vítima
//   'red'    → yellow + qualquer morte dropa ruína saqueável com 10% do ouro
//              da vítima (ver managers/wreck-manager.js)

const { MAP_SIZE } = require('./engine');

const MAP_DEFS = {};

// ── Mapa 1: Mar dos Corsários ─────────────────────────────────────────────────
MAP_DEFS[1] = {
  name:        'Mar dos Corsários',
  weather:     'clear',   // clima INICIAL/tema do mapa (clear|fog|rain|storm); o servidor
                          // cicla dinamicamente a partir daqui e sincroniza (weather-manager.js)
  pvpZone:     'green',
  hasShop:     true,
  xpRequired:  0,
  xpToAdvance: 1800,
  size:         MAP_SIZE,
  sideMap: [{norte: 2}],
  npc: {
    // Mapa de tutorial: o bicho não é hostil. Passar perto não inicia nada —
    // ele só revida depois de levar dano, e volta a dormir quando o agressor
    // morre. Mesma regra que o boss deste mapa já usava.
    retaliateOnly: true,
    count:        6,
    baseHp:       100,
    baseDamage:   8,
    fireInterval: 3000,
    names:        'Abyssal Stalker',
    hullColor:    0x3a1a0a,
    sailColor:    0xcc3333,
    flagColor:    0xcc2222,
    xpPerKill:    12,
    goldMin:      60,
    goldMax:      80,
    dobraoChance: 0,
    dobraoMin:    0,
    dobraoMax:    0,
    model:        '/models/monster/carangueijo.glb',
    scale: 20,
    yOffset: -5.4,
    rotOffset: 0,
    hitRadius: 8,
    relicDropChance: 0.01, // 1%
    attacks: ['crab_claw_slam', 'crab_putrid_spray', 'crab_burrow_rush', 'crab_tidal_frenzy'],
    ammoTiers: [
      { minKills: 0,   ammo: 'bala_ferro' },
      { minKills: 100, ammo: 'bala_gelo'  },
    ],
  },
  boss: {
    name:        'Giant Crab Octopus',
    // Mapa de tutorial: o boss só revida. Passar perto não inicia o combate —
    // ele só ataca depois de levar dano do jogador.
    retaliateOnly: true,
    baseHp:      5000,
    baseDamage:  200,
    regenPerSec:   50,
    regenDelay:    20000,
    killsToSpawn: 50,
    xpPerKill:    200,
    dobraoMin:   50,
    dobraoMax:   100,
    hullColor:   0x1a0505,
    sailColor:   0x220000,
    model:       '/models/monster/carangueijo_boss.glb',
    scale: 40,
    yOffset: -20,
    rotOffset: 0,
    hitRadius: 12,
    attacks: ['crab_boss_barrage', 'crab_boss_mortar', 'crab_boss_tentacles', 'crab_boss_roar'],
    rarities: [
      { id: 'normal',   label: 'Normal',   hpMult: 1.0, rewardMult: 1.0,  chance: 0.40, color: '#888', bg: 'rgba(40,40,40,0.92)' },
      { id: 'raro',     label: 'Raro',     hpMult: 1.5, rewardMult: 1.5,  chance: 0.30, color: '#44f', bg: 'rgba(10,20,60,0.92)' },
      { id: 'especial', label: 'Especial', hpMult: 2.0, rewardMult: 2.0,  chance: 0.20, color: '#a4f', bg: 'rgba(40,10,60,0.92)' },
      { id: 'infernal', label: 'Infernal', hpMult: 3.0, rewardMult: 3.0,  chance: 0.10, color: '#f80', bg: 'rgba(60,15,0,0.92)' },
    ],
  },
  visual: {
    bgColor:          0x2f476a,
    fogColor:         0x6d82a2,
    fogDensity:       0,
    ambientColor:     0xfbff00,
    ambientIntensity: 0.15,
    sunColor:         0xffd080,
    sunIntensity:     2.6,
    ocean1:           0xffffff,
    ocean2:           0xffffff,
    hasMoon:          true,
    hasDenseNebula:   false,
  },
  // Zonas de cura — geradas automaticamente nos naufrágios (broken_pirate_shipwreck)
  healingZones: [
    { x:  415, z:   47, radius: 80, healPct: 0.10 },  // broken_pirate_shipwreck #1
    { x: -437, z: -167, radius: 80, healPct: 0.10 },  // broken_pirate_shipwreck #2
  ],
};

// ── Mapa 2: Baía das Sombras ──────────────────────────────────────────────────
MAP_DEFS[2] = {
  name:        'Baía das Sombras',
  weather:     'fog',
  pvpZone:     'green',
  hasShop:     true,
  xpRequired:  1800,
  xpToAdvance: 8000,
  size:         MAP_SIZE * 2,
  sideMap: [{sul: 1, norte: 3}],
  npc: {
    // Tutorial (ver mapa 1): só revida, e esquece o agressor quando ele morre.
    retaliateOnly: true,
    count:        9,
    baseHp:       1500,
    baseDamage:   300,
    fireInterval: 3000,
    names:        'Dreadfin Leviathan',
    hullColor:    0x0a0a1a,
    sailColor:    0x553399,
    flagColor:    0x442288,
    xpPerKill:    22,
    goldMin:      200,
    goldMax:      300,
    dobraoChance: 1,
    dobraoMin:    1,
    dobraoMax:    2,
    model:       '/models/monster/cobra.glb',
    scale: 19,
    yOffset: 2,
    rotOffset: 0,
    hitRadius: 8,
    relicDropChance: 0.03, // 3%
    attacks: ['drake_chain_arc', 'drake_hunter_orb', 'drake_static_field', 'drake_lightning_web'],
    ammoTiers: [
      { minKills: 200, ammo: 'bala_gelo' },
      { minKills: 400, ammo: 'bala_bala_fogo' },
    ],
  },
  boss: {
    name:        'Abyssal Sovereign',
    // Mapa de tutorial: o boss só revida (ver mapa 1).
    retaliateOnly: true,
    baseHp:      20000,
    baseDamage:  800,
    regenPerSec:   80,
    regenDelay:    20000,
    killsToSpawn: 50,
    xpPerKill:    300,
    dobraoMin:   150,
    dobraoMax:   200,
    hullColor:   0x050510,
    sailColor:   0x330033,
    model:       '/models/monster/cobra_boss.glb',
    scale: 13,
    yOffset: 3.5,
    rotOffset: 0,
    hitRadius: 12,
    attacks: ['drake_boss_creeping_barrage', 'drake_boss_sonar_rings', 'drake_boss_coral_communion', 'drake_boss_core_overload'],
    rarities: [
      { id: 'normal',   label: 'Normal',   hpMult: 1.0, rewardMult: 1.0,  chance: 0.40, color: '#888', bg: 'rgba(40,40,40,0.92)' },
      { id: 'raro',     label: 'Raro',     hpMult: 1.5, rewardMult: 1.5,  chance: 0.30, color: '#44f', bg: 'rgba(10,20,60,0.92)' },
      { id: 'especial', label: 'Especial', hpMult: 2.0, rewardMult: 2.0,  chance: 0.20, color: '#a4f', bg: 'rgba(40,10,60,0.92)' },
      { id: 'infernal', label: 'Infernal', hpMult: 3.0, rewardMult: 3.0,  chance: 0.10, color: '#f80', bg: 'rgba(60,15,0,0.92)' },
    ],
  },
  visual: {
    bgColor:          0x223768,
    fogColor:         0x1b2722,
    fogDensity:       0.0025,
    ambientColor:     0x1e2207,
    ambientIntensity: 1,
    sunColor:         0xffe0b0,
    sunIntensity:     1.8,
    ocean1:           0x206f5e,
    ocean2:           0x063830,
    hasMoon:          false,
    hasDenseNebula:   true,
  },
  healingZones: [],  // sem naufrágios neste mapa
};

// ── Mapa 3: Ilha do Comércio ──────────────────────────────────────────────────
MAP_DEFS[3] = {
  name:        'Ilha do Comércio',
  weather:     'clear',
  pvpZone:     'yellow',
  proximityIsland: { x: 0, z: 0, radius: 250 },
  xpRequired:  13000,
  xpToAdvance: 20000,
  size:         MAP_SIZE * 3,
  sideMap: [{sul: 2, left: 4, norte: 10}],
  npc: {
    count:        15,
    baseHp:       10000,
    baseDamage:   1200,
    fireInterval: 3200,
    names:        'Gilded Reef Manta',
    hullColor:    0x2a5a3a,
    sailColor:    0x88cc66,
    flagColor:    0x66aa44,
    xpPerKill:    30,
    goldMin:      400,
    goldMax:      600,
    dobraoChance: 1,
    dobraoMin:    2,
    dobraoMax:    5,
    model:       '/models/monster/tartaruga.glb',
    scale: 13,
    yOffset: 0,
    rotOffset: 0,
    hitRadius: 8,
    relicDropChance: 0.05, // 5%
    attacks: ['leviathan_neck_beam', 'leviathan_tide_wall', 'leviathan_shell_bulwark'],
  },
  boss: {
    name:        'Harbor Warden The Coinbreaker',
    baseHp:      100000,
    baseDamage:  2000,
    regenPerSec:   120,
    regenDelay:    20000,
    killsToSpawn:  100,
    xpPerKill:     1000,
    dobraoMin:     500,
    dobraoMax:     700,
    hullColor:     0x553311,
    sailColor:     0x996633,
    model:       '/models/monster/tartaruga_boss.glb',
    scale: 8.5,
    yOffset: 3.5,
    rotOffset: 0,
    hitRadius: 12,
    attacks: ['turtle_boss_wreck_field', 'turtle_boss_gorge_drain', 'turtle_boss_broadside'],
    rarities: [
      { id: 'normal',   label: 'Normal',   hpMult: 1.0, rewardMult: 1.0,  chance: 0.40, color: '#888', bg: 'rgba(40,40,40,0.92)' },
      { id: 'raro',     label: 'Raro',     hpMult: 1.5, rewardMult: 1.5,  chance: 0.30, color: '#44f', bg: 'rgba(10,20,60,0.92)' },
      { id: 'especial', label: 'Especial', hpMult: 2.0, rewardMult: 2.0,  chance: 0.20, color: '#a4f', bg: 'rgba(40,10,60,0.92)' },
      { id: 'infernal', label: 'Infernal', hpMult: 3.0, rewardMult: 3.0,  chance: 0.10, color: '#f80', bg: 'rgba(60,15,0,0.92)' },
    ],
  },
  visual: {
    bgColor:          0x083020,
    fogColor:         0x000000,
    fogDensity:       0.0029,
    ambientColor:     0x97752b,
    ambientIntensity: 1,
    sunColor:         0xffe0b0,
    sunIntensity:     1.8,
    ocean1:           0x083020,
    ocean2:           0x083020,
    hasMoon:          false,
    hasDenseNebula:   true,
  },
  market: {
    center: { x: 0, z: 0 },
    islandRadius: 190,
    detectionRadius: 250,
    securyRadius: 300,
    model: '/models/new_places/comercio.glb',
    scale: 250,
    yOffset: 101,
    rotOffset: 0,
    colliders: [
      { shape: 'box', x:   20, z:  0, hw: 170, hh: 50, rot: 0    },
      { shape: 'box', x: -185, z: 40, hw:  15, hh: 40, rot: 1.31 },
    ],
    items: [
      {
        shipUpgrades: [
          {
            id: 'ship_hp_upgrade',
            name: 'Vida do Navio',
            description: '+1000 HP',
            icon: '❤️',
            hpBonus: 1000,
            price: 5000,
            currency: 'dobrao',
            maxLevel: 5
          },
          {
            id: 'ship_defense_upgrade',
            name: 'Defesa do Navio',
            description: '+5% Defesa',
            icon: '🛡️',
            defenseBonus: 0.05,
            price: 10000,
            currency: 'dobrao',
            maxLevel: 5
          },
        ],
        cannonUpgrades: [
          {
            id: 'cannon_attack_speed_upgrade',
            name: 'Velocidade de Ataque',
            description: '-1s Cooldown',
            icon: '⚡',
            field: 'as',
            attackSpeedBonus: -1000,
            price: 100000, currency: 'gold',
            ironPlatesPrice: 500,
          },
          // ── Era "+30 de Alcance" (campo `rn`) ────────────────────────────
          // O alcance se sabotava: a dispersão do tiro cresce com a distância
          // (spreadRadius = min(12, max(3, dist×0.08)) no projectile-manager) e
          // o raio de acerto é 8. A 120 un a salva já perde ~31% dos tiros; a
          // 150 un, que era o alcance comprado, o teto de dispersão (12) derruba
          // isso para ~44% de acerto. Pagava-se caro para atirar pior.
          //
          // No lugar, o crítico — que existia inteiro no motor e NUNCA
          // acontecia: `isCrit` só era sorteado dentro do bloco de homing, cuja
          // única fonte é `PIRATE_DEFS[].critChance`, e os dois piratas do jogo
          // são healers com 0.
          //
          // ── Por que ×1,5 e não ×2 ────────────────────────────────────────
          // O dobro era demais para um golpe que acontece com 20% de chance de
          // saída e sobe daí com os talentos de chance. Somado aos dois nós de
          // dano crítico (que valiam +80% juntos), o crítico deixava de ser um
          // pico e virava a construção inteira.
          //
          // O efeito colateral aceito: em ×1,5 a média deste upgrade (+10%)
          // EMPATA com a do upgrade de Dano, que custa o mesmo. O desempate
          // vem do investimento — chance de crítico e dano crítico têm nós na
          // árvore, dano de canhão bruto tem menos. Quem constrói para crítico
          // passa dos +10%; quem não constrói compra o Dano e está certo.
          {
            id: 'cannon_crit_upgrade',
            name: 'Pontaria Mortal',
            description: '20% de crítico (×1,5)',
            icon: '💢',
            field: 'cr',
            critChance: 0.20,
            critMult: 1.5,
            price: 12000, currency: 'dobrao',
            ironPlatesPrice: 1500,
          },
          {
            id: 'cannon_damage_upgrade',
            name: 'Dano',
            description: '+10% Dano',
            icon: '💥',
            field: 'dm',
            damageBonus: 0.10,
            price: 10000, currency: 'dobrao',
            ironPlatesPrice: 1500,
          },
        ],
      }
    ]
  },
  healingZones: [],  // sem naufrágios neste mapa
};

// ── Mapa 4: Ilha do Farol ─────────────────────────────────────────────────────
MAP_DEFS[4] = {
  name:         'Ilha do Farol',
  weather:      'clear',
  pvpZone:      'yellow',
  proximityFarol: { x: 0, z: 0, radius: 160 },
  sideMap: [{norte: 6, right: 3}],
  xpRequired:   20000,
  xpToAdvance:  30000,
  size:          MAP_SIZE * 2,
  npc: {
    count:        3,
    baseHp:       50000,
    baseDamage:   8000,
    fireInterval: 3200,
    names:        'Storm Wyvern',
    hullColor:    0x2a5a3a,
    sailColor:    0x88cc66,
    flagColor:    0x66aa44,
    xpPerKill:    106,
    goldMin:      2000,
    goldMax:      4000,
    dobraoChance: 1,
    dobraoMin:    300,
    dobraoMax:    400,
    model:       '/models/monster/wrim_boss.glb',
    scale: 7,
    yOffset: 50,
    rotOffset: 0,
    hitRadius: 8,
    relicDropChance: 0.11, // 11% — poucos NPCs, mapa difícil
    // Repertório COMPLETO do Verme (mob + boss). Não existe boss de verme neste
    // mapa (`boss: null`) e o próprio NPC já usa o modelo `wrim_boss.glb` —
    // sem isto os 4 ataques de boss nunca aconteciam no jogo, e o bicho lutava
    // com um conjunto e largava as relíquias do OUTRO (ver _bestiaryPool no
    // projectile-manager). As duas ⭐ (abyss_coil e reaper_spiral) seguem
    // travadas na Lua de Sangue, então fora dela ele usa 6 dos 8.
    attacks: ['wyrm_maw_lunge', 'wyrm_palp_snare', 'wyrm_pustule_burst', 'wyrm_abyss_coil',
              'wyrm_boss_spine_crown', 'wyrm_boss_maw_vortex', 'wyrm_boss_leg_cage',
              'wyrm_boss_reaper_spiral'],
  },
  boss: null,
  visual: {
    bgColor:          0x0d1b2a,
    fogColor:         0x3a5a7a,
    fogDensity:       0.0008,
    ambientColor:     0xffd080,
    ambientIntensity: 0.55,
    sunColor:         0xffb060,
    sunIntensity:     1.8,
    ocean1:           0x1a3a5a,
    ocean2:           0x0d2540,
    hasMoon:          true,
    hasDenseNebula:   false,
  },
  lighthouse: {
    center:          { x: 0, z: 0 },
    islandRadius:    80,
    detectionRadius: 160,
    model:           '/models/new_places/farol.glb',
    scale:           172,
    yOffset:         92,
    rotOffset:       0,
    colliders: [
    ],
  },
  // Missões diárias movidas para constants/missions.js (Barco de Missões,
  // mapas 1–4) — ver managers/mission-boat-manager.js.
  healingZones: [
    { x:  330, z:  250, radius: 80, healPct: 0.10 },  // broken_pirate_shipwreck
  ],
};

// ── Mapa 5: Campo de Treino AFK ───────────────────────────────────────────────
MAP_DEFS[5] = {
  name:          'Campo de Treino',
  weather:       'clear',
  pvpZone:       'green',
  isTrainingMap: true,
  sideMap:       null,
  xpRequired:  0,
  xpToAdvance: null,
  size:        400,
  npc:         null,
  boss:        null,
  visual: {
    bgColor:          0x050d1a,
    fogColor:         0x0d1a2e,
    fogDensity:       0.006,
    ambientColor:     0x1a2d45,
    ambientIntensity: 0.85,
    sunColor:         0x5577aa,
    sunIntensity:     0.9,
    ocean1:           0x0a1e35,
    ocean2:           0x06101f,
    hasMoon:          false,
    hasDenseNebula:   false,
  },
  training: {
    goldPerHour:    100000,
    maxHours:       8,
    baseDamage:     5000,
    fireInterval:   3000,
    dummy: { x: 0, z: -120 },
    collisionRadius: 18,
    // Precisa cobrir o spawn do treino (0, 50) → distância 170 da torre.
    // Com 150 a torre nunca atirava em quem entrava e ficava parado.
    detectionRadius: 250,
    model: '/models/places/massive_defensive_sea_tower.glb',
    scale: 1.5,
    yOffset: 0,
    rotOffset: 0,
  }
};

// ── Mapa 6: Mar das Lamentações ───────────────────────────────────────────────
MAP_DEFS[6] = {
  name:        'Mar das Lamentações',
  weather:     'storm',
  pvpZone:     'yellow',
  sideMap:     [{sul: 4, right: 10, norte: 11}],
  xpRequired:  30000,
  xpToAdvance: null,
  size:        MAP_SIZE * 2,
  npc:         null,
  boss: {
    name:        'The Drowned Widow',
    baseHp:       1000000,
    // Era 0 porque o único golpe dela era o `emerge`, que tinha dano próprio
    // hardcoded. Os ataques de ATTACK_DEFS calculam cannonDmg × damageMult, então
    // com 0 TODOS bateriam por 1 (o piso do Math.max). 60 dá a escala atual:
    // pilares (2.5×) = 150, tide_split solo (8×) = 480, rachado em 4 = 120.
    baseDamage:    12000,
    regenPerSec:   120,
    regenDelay:    20000,
    killsToSpawn:  0,
    respawnDelay:  3600000, // 1 hora em ms após ser morta
    dobraoMin:     10000,
    dobraoMax:     20000,
    hullColor:     0x553311,
    sailColor:     0x996633,
    model:       '/models/monster/leviata_boss.glb',
    scale: 220,
    yOffset: -290.0,
    rotOffset: 0,
    hitRadius: 30,
    relicDropChance: 0.25, // 25% — poucos NPCs, mapa difícil
    moveType:   'melee',   // humanóide: idle|walk|run baseado em distância
    closeRange: 200,       // dentro = walk 50%; fora = run 100%
    aggroRange: 350,       // raio de detecção de proximidade (unidades)
    aggroTime:  20,        // segundos perto para virar agressivo
    // O `emerge` (cast multi-fase preso a `animIdx: 9`) saiu junto com a troca
    // do modelo — a animação do modelo novo ainda não existe. Pra devolver, é só
    // reinserir o objeto aqui: o laço de cast do npc-manager aceita objeto e
    // string no mesmo array, então ele volta a conviver com os ids abaixo.
    //
    // Mapa 6 não tem NPC nenhum (`npc: null`) — a Viúva é a bancada isolada
    // das mecânicas novas: rachar dano, cegar e os pilares.
    attacks: ['charnel_death_mark', 'charnel_brood_hatch', 'charnel_chain_bond', 'charnel_funeral_march'],
    // Aura passiva: não entra no sorteio de ataques, ticka sozinha enquanto ela
    // viver (attack-manager.tickAuras).
    auras: ['ghost_dread_aura'],
    rarities: [
      { id: 'infernal', label: 'Infernal', hpMult: 1.0, rewardMult: 1, chance: 1, color: '#f80', bg: 'rgba(60,15,0,0.92)' },
    ],
  },
  visual: {
    bgColor:          0x0d1b2a,
    fogColor:         0x3a5a7a,
    fogDensity:       0.0008,
    ambientColor:     0xffd080,
    ambientIntensity: 0.55,
    sunColor:         0xffb060,
    sunIntensity:     1.8,
    ocean1:           0x1a3a5a,
    ocean2:           0x0d2540,
    hasMoon:          true,
    hasDenseNebula:   false,
  },
  healingZones: [],  // sem naufrágios neste mapa
};

// ── Mapas Bônus (levels 7–9, acessíveis via Mesa de Exploração) ───────────────
// bonus_map_1 → mapLevel 7 | bonus_map_2 → 8 | bonus_map_3 → 9
// isBonusMap:true   — sem bordas de transição, jogador sai via leave_bonus_map
// sideMap: null     — não tem fronteiras laterais

MAP_DEFS[7] = {
  name:        'Baía dos Naufragados',
  weather:     'rain',
  pvpZone:     'yellow',
  bonusMapId:  'bonus_map_1',
  isBonusMap:  true,
  xpRequired:  0,
  xpToAdvance: null,
  size:        MAP_SIZE,
  sideMap:     null,
  npc: {
    count:           5,
    noNpcRespawn:    true,
    baseHp:          200,
    baseDamage:      12,
    fireInterval:    3000,
    cannonCount:     2,
    cannonRange:     155,
    usesCannons:     true,
    names:           ['Corsário Náufrago'],
    hullColor:       0x3a1a0a,
    sailColor:       0x884422,
    flagColor:       0x662211,
    xpPerKill:       20,
    goldMin:         50,
    goldMax:         80,
    model:           '/models/ships/sloop.glb',
    scale:           3.3,
    yOffset:         7.8,
    rotOffset:       0,
    hitRadius:       10,
    relicDropChance: 0.02,
    ammoTiers: [
      { minKills: 0,   ammo: 'bala_ferro' },
      { minKills: 100, ammo: 'bala_gelo'  },
    ],
  },
  boss: null,
  visual: {
    bgColor:          0x0d0805,
    fogColor:         0x1a1008,
    fogDensity:       0.003,
    ambientColor:     0x883311,
    ambientIntensity: 0.4,
    sunColor:         0xaa4411,
    sunIntensity:     0.9,
    ocean1:           0x1a0d05,
    ocean2:           0x0d0603,
    hasMoon:          false,
    hasDenseNebula:   true,
  },
};

MAP_DEFS[8] = {
  name:        'Fortaleza do Esquecimento',
  weather:     'fog',
  pvpZone:     'yellow',
  bonusMapId:  'bonus_map_2',
  isBonusMap:  true,
  xpRequired:  0,
  xpToAdvance: null,
  size:        MAP_SIZE,
  sideMap:     null,
  npc: {
    count:           5,
    noNpcRespawn:    true,
    baseHp:          500,
    baseDamage:      25,
    fireInterval:    3500,
    cannonCount:     4,
    cannonRange:     165,
    usesCannons:     true,
    names:           ['Guarda da Fortaleza'],
    hullColor:       0x1a0a0a,
    sailColor:       0x220033,
    flagColor:       0x110022,
    xpPerKill:       40,
    goldMin:         100,
    goldMax:         160,
    model:           '/models/ships/brigantine.glb',
    scale:           0.5,
    yOffset:         3.7,
    rotOffset:       0,
    hitRadius:       12,
    relicDropChance: 0.03,
    ammoTiers: [
      { minKills: 0,   ammo: 'bala_ferro' },
      { minKills: 150, ammo: 'bala_fogo'  },
    ],
  },
  boss: null,
  visual: {
    bgColor:          0x0a0a14,
    fogColor:         0x1a1a33,
    fogDensity:       0.003,
    ambientColor:     0x4444cc,
    ambientIntensity: 0.5,
    sunColor:         0x8888ff,
    sunIntensity:     1.2,
    ocean1:           0x0a0a2a,
    ocean2:           0x050518,
    hasMoon:          true,
    hasDenseNebula:   true,
  },
};

MAP_DEFS[9] = {
  name:        'Abismo dos Afundados',
  weather:     'storm',
  pvpZone:     'yellow',
  bonusMapId:  'bonus_map_3',
  isBonusMap:  true,
  xpRequired:  0,
  xpToAdvance: null,
  size:        MAP_SIZE,
  sideMap:     null,
  npc: {
    count:           5,
    noNpcRespawn:    true,
    baseHp:          1200,
    baseDamage:      60,
    fireInterval:    4000,
    cannonCount:     6,
    cannonRange:     175,
    usesCannons:     true,
    names:           ['Capitão Afundado'],
    hullColor:       0x050a08,
    sailColor:       0x0a2a14,
    flagColor:       0x05150a,
    xpPerKill:       80,
    goldMin:         200,
    goldMax:         350,
    model:           '/models/ships/galleon.glb',
    scale:           2.2,
    yOffset:         4.6,
    rotOffset:       90 * Math.PI / 180,
    hitRadius:       14,
    relicDropChance: 0.05,
    ammoTiers: [
      { minKills: 0,   ammo: 'bala_ferro'     },
      { minKills: 200, ammo: 'bala_perfurante' },
    ],
  },
  boss: null,
  visual: {
    bgColor:          0x001a0a,
    fogColor:         0x003318,
    fogDensity:       0.004,
    ambientColor:     0x00cc44,
    ambientIntensity: 0.4,
    sunColor:         0x00ff66,
    sunIntensity:     0.8,
    ocean1:           0x001a08,
    ocean2:           0x000d04,
    hasMoon:          false,
    hasDenseNebula:   true,
  },
};

// ── Mapa 10: Ilha do Banco ────────────────────────────────────────────────────
MAP_DEFS[10] = {
  name:        'Ilha do Banco',
  weather:     'clear',
  pvpZone:     'yellow',
  xpRequired:  30000,
  xpToAdvance: null,
  size:        MAP_SIZE * 4,
  sideMap:     [{sul: 3, left: 6, norte: 11}],
  goldStealRatio: 0.01,  // 8% do dano convertido em ouro roubado pelos NPCs
  banking: {
    center:      { x: 0, z: 0 },
    islandRadius: 180,
    islandShape: 'square',
    securyRadius: 220,
    model:       '/models/new_places/leilao.glb',
    scale:       230,
    yOffset:     81,
    rotOffset:   0,
    colliders: [
      { shape: 'box',    x: -115, z:  165, hw:  65, hh:  30, rot:  0    },
      { shape: 'box',    x:  125, z:  170, hw:  65, hh:  30, rot:  0    },
      { shape: 'box',    x:   -5, z:  110, hw:  20, hh:  15, rot:  0    },
      { shape: 'box',    x:  -35, z:   95, hw:  15, hh:  15, rot:  0    },
      { shape: 'box',    x: -150, z:   90, hw:  45, hh:  65, rot:  0    },
      { shape: 'box',    x:    5, z:   50, hw: 190, hh:  50, rot:  0    },
      { shape: 'circle', x:  140, z:   85, r:  35 },
      { shape: 'box',    x:  175, z:  120, hw:  20, hh:  25, rot:  0    },
      { shape: 'box',    x: -100, z:  -75, hw:  40, hh: 115, rot: -0.52 },
      { shape: 'box',    x:  165, z:  -40, hw:  30, hh:  45, rot:  0    },
      { shape: 'box',    x:  135, z: -120, hw:  35, hh:  70, rot:  0.52 },
      { shape: 'box',    x:   30, z: -140, hw: 115, hh:  50, rot:  0    },
    ],
  },
  npc: {
    count:        20,
    baseHp:       140000,
    baseDamage:   15000,
    fireInterval: 3000,
    names:        ['Mímico Guardião'],
    hullColor:    0x4a3010,
    sailColor:    0xd4a017,
    flagColor:    0xb8860b,
    xpPerKill:    500,
    goldMin:      5000,
    goldMax:      10000,
    dobraoChance: 1,
    dobraoMin:    500,
    dobraoMax:    1000,
    model:        '/models/monster/mimic_chest_monster.glb',
    scale:        8.0,
    yOffset:      0,
    rotOffset:    0,
    hitRadius:    10,
    relicDropChance: 0.15,
    // Conjunto EXCLUSIVO do bestiário, como nos mapas 1/3/4: a pool de drop de
    // relíquia sai daqui (_bestiaryPool lê npc.attacks), então misturar os
    // ataques genéricos antigos diluiria o conjunto do bicho sem dropar nada.
    attacks: ['alien_maw_engulf', 'alien_tail_sweep', 'alien_eyeless_siphon', 'alien_void_lance'],
    ammoTiers: [
      { minKills: 0,   ammo: 'bala_ferro' },
      { minKills: 200, ammo: 'bala_gelo'  },
    ],
  },

  boss: {
    name:        'Grande Mímico do Tesouro',
    baseHp:      700000,
    baseDamage:  18000,
    regenPerSec:   500,
    regenDelay:    20000,
    killsToSpawn:  100,
    dobraoMin:     5000,
    dobraoMax:     10000,
    hullColor:     0x3a2008,
    sailColor:     0xd4a017,
    model:       '/models/monster/mimic_boss_chest.glb',
    scale:       1.0,
    yOffset:     0,
    rotOffset:   0,
    hitRadius:   16,
    // Cinco — o repertório mais largo do jogo, para um chefe de penúltimo mapa
    // não ter ordem decorável. A ⭐ (Colapso do Vazio) só entra no sorteio dele
    // durante a Lua de Sangue, como todas as outras ⭐.
    attacks: ['alien_boss_face_choir', 'alien_boss_cortex_mirror', 'alien_boss_gut_drain',
              'alien_boss_spine_volley', 'alien_boss_void_collapse'],
    // Auras ficam FORA de `attacks`: não são escolhidas pelo sorteio ponderado,
    // tickam sozinhas enquanto o boss vive (attack-manager.tickAuras).
    auras: ['ghost_dread_aura'],
    rarities: [
      { id: 'normal',   label: 'Normal',   hpMult: 1.0, rewardMult: 1.0,  chance: 0.45, color: '#888', bg: 'rgba(40,40,40,0.92)' },
      { id: 'raro',     label: 'Raro',     hpMult: 1.5, rewardMult: 1.5,  chance: 0.30, color: '#44f', bg: 'rgba(10,20,60,0.92)' },
      { id: 'especial', label: 'Especial', hpMult: 2.2, rewardMult: 2.0,  chance: 0.15, color: '#d4a', bg: 'rgba(50,20,50,0.92)' },
      { id: 'lendario', label: 'Lendário', hpMult: 3.5, rewardMult: 3.0,  chance: 0.10, color: '#fd2', bg: 'rgba(60,45,0,0.92)' },
    ],
  },

  visual: {
    bgColor:          0x1a1200,
    fogColor:         0x3a2800,
    fogDensity:       0.0020,
    ambientColor:     0xd4a017,
    ambientIntensity: 0.60,
    sunColor:         0xffc030,
    sunIntensity:     2.0,
    ocean1:           0x3a2800,
    ocean2:           0x1e1400,
    hasMoon:          true,
    hasDenseNebula:   false,
  },
};

// ── Mapa 11: Mar dos Renegados (Zona Vermelha — PVP total) ────────────────────
// Acesso livre pelo norte dos mapas 6 e 10. Borda sul dividida ao meio:
// metade oeste volta pro 6, metade leste pro 10 (sideMap com array).
// Qualquer morte aqui dropa ruína saqueável com 10% do ouro da vítima.
MAP_DEFS[11] = {
  name:        'Mar dos Renegados',
  weather:     'clear',
  pvpZone:     'red',
  hasShop:     false,
  xpRequired:  0,
  xpToAdvance: null,
  size:        MAP_SIZE * 6,
  sideMap:     [{sul: [6, 10]}],   // array = borda dividida: x<0 → 6, x≥0 → 10

  // Floresta submersa nas laterais — COLISÃO REAL (empurra barcos e NPCs, dá
  // pra desviar). Visual no cliente (RUINS_DEFS[11] em main.gd), posições
  // geradas junto. islandRadius:1 só faz o sistema considerar os colliders;
  // center 0,0 → x/z dos colliders são coordenadas absolutas do mundo.
  // Ajuste fino do raio/posição pelo editor de colisão (tecla 2).
  forest: {
    center:       { x: 0, z: 0 },
    islandRadius: 1,
    colliders: [
      { shape: 'circle', x: -950.7, z: -3242.7, r: 14 },
      { shape: 'circle', x: -1659.4, z: -3311.9, r: 16 },
      { shape: 'circle', x: -2138.2, z: -3108.6, r: 14 },
      { shape: 'circle', x: -2841.6, z: -3225.8, r: 14 },
      { shape: 'circle', x: -3271.9, z: -3046.3, r: 13 },
      { shape: 'circle', x: -1353.3, z: -2331.3, r: 17 },
      { shape: 'circle', x: -1923.2, z: -2276.8, r: 15 },
      { shape: 'circle', x: -2198.9, z: -2634.6, r: 15 },
      { shape: 'circle', x: -2820.1, z: -2630.5, r: 15 },
      { shape: 'circle', x: -3282.9, z: -2434.6, r: 15 },
      { shape: 'circle', x: -1635.7, z: -1697.6, r: 13 },
      { shape: 'circle', x: -1872.3, z: -1817.2, r: 14 },
      { shape: 'circle', x: -2472.0, z: -1856.0, r: 17 },
      { shape: 'circle', x: -2897.0, z: -1911.2, r: 13 },
      { shape: 'circle', x: -3350.3, z: -1675.2, r: 11 },
      { shape: 'circle', x: -1611.3, z: -1127.3, r: 11 },
      { shape: 'circle', x: -2153.5, z: -929.9, r: 11 },
      { shape: 'circle', x: -2665.3, z: -1037.6, r: 16 },
      { shape: 'circle', x: -3004.8, z: -1211.2, r: 17 },
      { shape: 'circle', x: -3480.0, z: -1179.8, r: 12 },
      { shape: 'circle', x: -1666.7, z: -532.5, r: 14 },
      { shape: 'circle', x: -2167.2, z: -242.6, r: 14 },
      { shape: 'circle', x: -2527.8, z: -339.5, r: 13 },
      { shape: 'circle', x: -3008.2, z: -553.2, r: 16 },
      { shape: 'circle', x: -3480.0, z: -314.1, r: 16 },
      { shape: 'circle', x: -1854.4, z: 199.8, r: 16 },
      { shape: 'circle', x: -2154.5, z: 480.3, r: 16 },
      { shape: 'circle', x: -2533.1, z: 397.4, r: 11 },
      { shape: 'circle', x: -3061.6, z: 347.1, r: 15 },
      { shape: 'circle', x: -3480.0, z: 202.1, r: 11 },
      { shape: 'circle', x: -1524.4, z: 1253.1, r: 12 },
      { shape: 'circle', x: -2219.0, z: 983.3, r: 11 },
      { shape: 'circle', x: -2581.6, z: 906.5, r: 15 },
      { shape: 'circle', x: -2932.2, z: 978.9, r: 14 },
      { shape: 'circle', x: -3424.2, z: 999.7, r: 15 },
      { shape: 'circle', x: -1589.4, z: 1777.7, r: 14 },
      { shape: 'circle', x: -1898.7, z: 1721.2, r: 14 },
      { shape: 'circle', x: -2578.4, z: 1761.5, r: 11 },
      { shape: 'circle', x: -2968.7, z: 1570.5, r: 13 },
      { shape: 'circle', x: -3284.4, z: 1731.1, r: 14 },
      { shape: 'circle', x: -1370.8, z: 2626.5, r: 15 },
      { shape: 'circle', x: -1899.3, z: 2430.9, r: 15 },
      { shape: 'circle', x: -2226.3, z: 2518.4, r: 13 },
      { shape: 'circle', x: -3034.2, z: 2563.1, r: 14 },
      { shape: 'circle', x: -3480.0, z: 2488.5, r: 14 },
      { shape: 'circle', x: -1159.4, z: 3282.5, r: 11 },
      { shape: 'circle', x: -1585.3, z: 3154.3, r: 11 },
      { shape: 'circle', x: -2331.1, z: 3337.5, r: 11 },
      { shape: 'circle', x: -2957.7, z: 2993.2, r: 14 },
      { shape: 'circle', x: -3468.6, z: 3283.4, r: 14 },
      { shape: 'circle', x: 1294.0, z: -3041.0, r: 14 },
      { shape: 'circle', x: 1778.9, z: -3262.4, r: 13 },
      { shape: 'circle', x: 2214.1, z: -3159.6, r: 12 },
      { shape: 'circle', x: 2923.0, z: -2984.7, r: 17 },
      { shape: 'circle', x: 3334.1, z: -3042.9, r: 15 },
      { shape: 'circle', x: 1177.7, z: -2550.5, r: 17 },
      { shape: 'circle', x: 1886.2, z: -2356.6, r: 15 },
      { shape: 'circle', x: 2377.3, z: -2316.0, r: 16 },
      { shape: 'circle', x: 2908.8, z: -2593.8, r: 15 },
      { shape: 'circle', x: 3400.6, z: -2472.2, r: 15 },
      { shape: 'circle', x: 1640.6, z: -1678.7, r: 12 },
      { shape: 'circle', x: 1965.2, z: -1773.0, r: 15 },
      { shape: 'circle', x: 2396.2, z: -1853.4, r: 13 },
      { shape: 'circle', x: 2997.8, z: -1585.9, r: 15 },
      { shape: 'circle', x: 3365.2, z: -1833.2, r: 13 },
      { shape: 'circle', x: 1476.2, z: -1237.5, r: 14 },
      { shape: 'circle', x: 2148.9, z: -1115.1, r: 12 },
      { shape: 'circle', x: 2642.8, z: -1058.4, r: 17 },
      { shape: 'circle', x: 3084.6, z: -844.7, r: 14 },
      { shape: 'circle', x: 3395.7, z: -949.3, r: 13 },
      { shape: 'circle', x: 1811.4, z: -542.8, r: 16 },
      { shape: 'circle', x: 2134.6, z: -484.7, r: 14 },
      { shape: 'circle', x: 2606.5, z: -542.7, r: 13 },
      { shape: 'circle', x: 2944.6, z: -451.0, r: 13 },
      { shape: 'circle', x: 3288.5, z: -254.7, r: 14 },
      { shape: 'circle', x: 1734.7, z: 463.7, r: 13 },
      { shape: 'circle', x: 2009.8, z: 481.9, r: 13 },
      { shape: 'circle', x: 2473.5, z: 554.1, r: 13 },
      { shape: 'circle', x: 2996.2, z: 469.9, r: 12 },
      { shape: 'circle', x: 3480.0, z: 268.4, r: 12 },
      { shape: 'circle', x: 1569.1, z: 871.7, r: 11 },
      { shape: 'circle', x: 2061.1, z: 1171.3, r: 14 },
      { shape: 'circle', x: 2509.0, z: 996.7, r: 15 },
      { shape: 'circle', x: 2902.8, z: 1249.3, r: 13 },
      { shape: 'circle', x: 3480.0, z: 1058.0, r: 14 },
      { shape: 'circle', x: 1501.9, z: 1864.6, r: 11 },
      { shape: 'circle', x: 1861.8, z: 1698.3, r: 12 },
      { shape: 'circle', x: 2312.6, z: 1872.2, r: 15 },
      { shape: 'circle', x: 2980.2, z: 1615.7, r: 11 },
      { shape: 'circle', x: 3299.2, z: 1608.1, r: 15 },
      { shape: 'circle', x: 1297.7, z: 2387.3, r: 11 },
      { shape: 'circle', x: 1992.7, z: 2334.7, r: 14 },
      { shape: 'circle', x: 2337.5, z: 2607.7, r: 17 },
      { shape: 'circle', x: 2738.8, z: 2331.6, r: 11 },
      { shape: 'circle', x: 3475.0, z: 2443.5, r: 12 },
      { shape: 'circle', x: 1238.1, z: 3258.9, r: 15 },
      { shape: 'circle', x: 1761.4, z: 3157.5, r: 16 },
      { shape: 'circle', x: 2353.2, z: 3181.0, r: 13 },
      { shape: 'circle', x: 2830.6, z: 3092.5, r: 15 },
      { shape: 'circle', x: 3446.5, z: 3305.9, r: 14 },
    ],
  },

  // Arena central — palco do arauto. colliders vazio = sem colisão física
  // (navios entram livremente); demarque as paredes reais com o editor tecla 2.
  arena: {
    center:       { x: 0, z: 0 },
    islandRadius: 220,
    model:        '/models/new_places/arena.glb',
    scale:        1000,
    yOffset:      166,
    rotOffset:    0,
    colliders: [
      { shape: 'box', x: 0.0, z: 655.0, hw: 65.0, hh: 35.0, rot: 0.0 },
      { shape: 'box', x: 10.0, z: 355.0, hw: 5.0, hh: 15.0, rot: 0.0 },
      { shape: 'box', x: -15.0, z: 355.0, hw: 5.0, hh: 15.0, rot: 0.0 },
      { shape: 'circle', x: 0.0, z: 15.0, r: 35.0 },
      { shape: 'circle', x: 0.0, z: -110.0, r: 140.0 },
      { shape: 'box', x: 0.0, z: -240.0, hw: 30.0, hh: 25.0, rot: 0.0 },
      { shape: 'box', x: -205.0, z: -105.0, hw: 10.0, hh: 25.0, rot: 0.0 },
      { shape: 'box', x: -220.0, z: -90.0, hw: 5.0, hh: 10.0, rot: 0.0 },
      { shape: 'box', x: -190.0, z: -90.0, hw: 5.0, hh: 5.0, rot: 0.0 },
      { shape: 'circle', x: -370.0, z: 235.0, r: 5.0 },
      { shape: 'circle', x: -355.0, z: 260.0, r: 5.0 },
      { shape: 'circle', x: 160.0, z: 460.0, r: 5.0 },
      { shape: 'circle', x: 160.0, z: 520.0, r: 5.0 },
      { shape: 'box', x: -760.0, z: 55.0, hw: 95.0, hh: 135.0, rot: 0.0 },
      { shape: 'box', x: -675.0, z: -230.0, hw: 65.0, hh: 155.0, rot: -0.26 },
      { shape: 'box', x: -500.0, z: -475.0, hw: 145.0, hh: 60.0, rot: 0.79 },
      { shape: 'box', x: -275.0, z: -610.0, hw: 135.0, hh: 50.0, rot: 0.52 },
      { shape: 'box', x: 0.0, z: -665.0, hw: 140.0, hh: 30.0, rot: 0.0 },
      { shape: 'box', x: 260.0, z: -585.0, hw: 135.0, hh: 20.0, rot: -0.52 },
      { shape: 'box', x: 465.0, z: -455.0, hw: 105.0, hh: 30.0, rot: -0.79 },
      { shape: 'box', x: 610.0, z: -290.0, hw: 125.0, hh: 30.0, rot: -1.05 },
      { shape: 'box', x: 695.0, z: -30.0, hw: 35.0, hh: 130.0, rot: 0.26 },
      { shape: 'box', x: 655.0, z: -160.0, hw: 5.0, hh: 10.0, rot: 0.0 },
      { shape: 'box', x: 710.0, z: 100.0, hw: 45.0, hh: 25.0, rot: 0.0 },
      { shape: 'box', x: 700.0, z: 200.0, hw: 50.0, hh: 70.0, rot: -0.52 },
      { shape: 'box', x: 660.0, z: 335.0, hw: 50.0, hh: 70.0, rot: -0.52 },
      { shape: 'box', x: 585.0, z: 455.0, hw: 40.0, hh: 60.0, rot: -1.05 },
      { shape: 'box', x: 470.0, z: 540.0, hw: 35.0, hh: 85.0, rot: -0.79 },
      { shape: 'box', x: 390.0, z: 660.0, hw: 50.0, hh: 50.0, rot: -1.05 },
      { shape: 'box', x: 325.0, z: 735.0, hw: 45.0, hh: 80.0, rot: 0.52 },
      { shape: 'box', x: 315.0, z: 805.0, hw: 50.0, hh: 15.0, rot: -0.52 },
      { shape: 'box', x: -335.0, z: 700.0, hw: 75.0, hh: 55.0, rot: -0.52 },
      { shape: 'circle', x: -365.0, z: 725.0, r: 85.0 },
      { shape: 'box', x: -320.0, z: 810.0, hw: 50.0, hh: 15.0, rot: -2.62 },
      { shape: 'box', x: -430.0, z: 610.0, hw: 50.0, hh: 40.0, rot: 0.26 },
      { shape: 'box', x: -455.0, z: 580.0, hw: 50.0, hh: 30.0, rot: 0.79 },
      { shape: 'box', x: -540.0, z: 515.0, hw: 75.0, hh: 50.0, rot: -0.79 },
      { shape: 'box', x: -695.0, z: 225.0, hw: 50.0, hh: 40.0, rot: 0.26 },
      { shape: 'circle', x: -645.0, z: 350.0, r: 50.0 },
      { shape: 'box', x: -695.0, z: 290.0, hw: 50.0, hh: 30.0, rot: 0.26 },
      { shape: 'box', x: -625.0, z: 445.0, hw: 50.0, hh: 35.0, rot: 0.79 },
      { shape: 'box', x: -475.0, z: 690.0, hw: 85.0, hh: 40.0, rot: -0.79 },
      { shape: 'box', x: -650.0, z: 535.0, hw: 150.0, hh: 30.0, rot: -1.05 },
      { shape: 'circle', x: -565.0, z: 650.0, r: 25.0 },
      { shape: 'box', x: -685.0, z: 375.0, hw: 50.0, hh: 50.0, rot: 0.0 },
      { shape: 'box', x: -805.0, z: 255.0, hw: 65.0, hh: 45.0, rot: 0.26 },
      { shape: 'box', x: -845.0, z: 210.0, hw: 20.0, hh: 35.0, rot: -0.26 },
      { shape: 'box', x: -820.0, z: -105.0, hw: 50.0, hh: 45.0, rot: 0.26 },
      { shape: 'box', x: -815.0, z: -155.0, hw: 50.0, hh: 35.0, rot: -0.26 },
      { shape: 'circle', x: -685.0, z: -320.0, r: 50.0 },
      { shape: 'box', x: -635.0, z: -435.0, hw: 70.0, hh: 30.0, rot: -2.09 },
      { shape: 'box', x: -535.0, z: -555.0, hw: 30.0, hh: 100.0, rot: -0.79 },
      { shape: 'circle', x: -470.0, z: -620.0, r: 30.0 },
      { shape: 'box', x: -395.0, z: -665.0, hw: 35.0, hh: 80.0, rot: -0.79 },
      { shape: 'box', x: -330.0, z: -700.0, hw: 50.0, hh: 50.0, rot: 0.52 },
      { shape: 'box', x: -200.0, z: -710.0, hw: 50.0, hh: 85.0, rot: -0.79 },
      { shape: 'box', x: -95.0, z: -775.0, hw: 40.0, hh: 120.0, rot: -0.79 },
      { shape: 'box', x: -145.0, z: -785.0, hw: 25.0, hh: 25.0, rot: 0.0 },
      { shape: 'circle', x: 15.0, z: -800.0, r: 95.0 },
      { shape: 'circle', x: 100.0, z: -690.0, r: 140.0 },
      { shape: 'box', x: 325.0, z: -705.0, hw: 45.0, hh: 50.0, rot: -0.52 },
      { shape: 'box', x: 240.0, z: -690.0, hw: 25.0, hh: 20.0, rot: -0.52 },
      { shape: 'box', x: 410.0, z: -675.0, hw: 60.0, hh: 15.0, rot: -0.79 },
      { shape: 'circle', x: 470.0, z: -595.0, r: 50.0 },
      { shape: 'box', x: 515.0, z: -545.0, hw: 50.0, hh: 50.0, rot: -0.79 },
      { shape: 'box', x: 590.0, z: -490.0, hw: 30.0, hh: 50.0, rot: 0.79 },
      { shape: 'box', x: 650.0, z: -375.0, hw: 95.0, hh: 50.0, rot: -1.05 },
      { shape: 'box', x: 690.0, z: -295.0, hw: 25.0, hh: 45.0, rot: -0.52 },
      { shape: 'box', x: 690.0, z: -230.0, hw: 45.0, hh: 75.0, rot: 0.26 },
      { shape: 'box', x: 805.0, z: -150.0, hw: 55.0, hh: 35.0, rot: 0.26 },
      { shape: 'box', x: 830.0, z: -95.0, hw: 20.0, hh: 55.0, rot: -0.52 },
      { shape: 'box', x: 800.0, z: 5.0, hw: 50.0, hh: 50.0, rot: 0.52 },
      { shape: 'box', x: 805.0, z: 100.0, hw: 50.0, hh: 70.0, rot: 0.0 },
      { shape: 'box', x: 815.0, z: 260.0, hw: 50.0, hh: 40.0, rot: -0.26 },
      { shape: 'box', x: 810.0, z: 200.0, hw: 50.0, hh: 50.0, rot: 0.26 },
      { shape: 'box', x: 715.0, z: 370.0, hw: 35.0, hh: 100.0, rot: -0.26 },
      { shape: 'box', x: 630.0, z: 520.0, hw: 85.0, hh: 50.0, rot: 1.05 },
      { shape: 'box', x: 580.0, z: 630.0, hw: 35.0, hh: 50.0, rot: -0.79 },
      { shape: 'box', x: 470.0, z: 680.0, hw: 50.0, hh: 65.0, rot: -0.79 },
      { shape: 'box', x: 415.0, z: 755.0, hw: 50.0, hh: 20.0, rot: 0.52 },
    ],
  },

  npc: {
    count:        1,               // apenas o arauto, dentro da arena
    baseHp:       3000000,
    baseDamage:   20000,
    fireInterval: 3000,
    names:        'Arauto do Abismo',
    hullColor:    0x1a0a2a,
    sailColor:    0x662288,
    flagColor:    0x441166,
    xpPerKill:    1200,
    goldMin:      20000,
    goldMax:      30000,
    dobraoChance: 1,
    dobraoMin:    10000,
    dobraoMax:    25000,
    model:        '/models/monster/arauto_abismo.glb',
    scale: 34,
    yOffset: 0,
    rotOffset: 0,
    hitRadius: 14,
    relicDropChance: 0.25,
    spawnAt:      { x: 0, z: 0, radius: 60 },  // nasce dentro da arena
    leashRange:   220,             // não sai da arena ao perseguir
    respawnDelay: 3600000,          // mini-boss: 1 h para renascer
    // Kit do Arauto do Abismo — seis, e nenhuma herdada do kraken que ele
    // substituiu: as quatro do bestiário (monster_skills.js, source 'arauto')
    // mais as duas que copiam relíquia de jogador (attacks.js).
    //
    // Ordem de leitura pretendida numa luta: os Pilares abrem espalhando todo
    // mundo, os Faróis marcam e cobram movimento, a Prisão isola um, o Meteoro
    // castiga quem se juntou de novo, a Névoa compra fôlego quando a vida cai e
    // o Abraço ⭐ (só na lua de sangue) desfaz o espalhamento de uma vez.
    attacks: [
      'abyss_judgment_pillars', 'abyss_hunter_lights', 'abyss_earth_prison',
      'abyss_lens_beam',
      'abyss_meteor_call', 'abyss_spectral_veil', 'abyss_herald_embrace',
    ],
  },
  boss: null,

  visual: {
    bgColor:          0x2a0808,
    fogColor:         0x401010,
    fogDensity:       0.0012,
    ambientColor:     0xff4433,
    ambientIntensity: 0.5,
    sunColor:         0xff7040,
    sunIntensity:     1.8,
    ocean1:           0x4a1410,
    ocean2:           0x260806,
    hasMoon:          true,
    hasDenseNebula:   false,
  },
  healingZones: [],  // zona vermelha: sem cura de graça
};

// Passagens antigas (ruína ancient_stone_arch) — pontos de teleporte entre mapas.
// x/z = posição no mundo da arcada (mesma do RUINS_DEFS do cliente em main.gd).
// Para adicionar um destino: espelhe aqui a arcada que você colocar no cliente.
// O teleporte sorteia uma passagem de OUTRO mapa (ver pickArchDestination no server).
const ARCH_PORTALS = {
  1:  [{ x:  220, z: -290 }],
  4:  [{ x: -787, z: -700 }],
  10: [{ x: -990, z:  -80 }],
};

// ID → mapLevel lookup para uso no servidor
const BONUS_MAP_LEVELS = { bonus_map_1: 7, bonus_map_2: 8, bonus_map_3: 9 };

// Zona PvP de um mapa — 'yellow' é o comportamento histórico (PvP liberado)
function getPvpZone(level) {
  return (MAP_DEFS[level] && MAP_DEFS[level].pvpZone) || 'yellow';
}

module.exports = { MAP_DEFS, BONUS_MAP_LEVELS, ARCH_PORTALS, getPvpZone };
