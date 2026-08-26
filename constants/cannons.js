// constants/cannons.js — Canhões, munições, velas e custos de pesquisa

// ── CANNON_DEFS ───────────────────────────────────────────────────────────────
const CANNON_DEFS = {
  c1: { name: 'Canhão enferrujado',                  price: 59,   currency: 'gold',   damage: 10, range: 80,  cooldown: 5000, lifesteal: 0,   doubleShot: false },
  c2: { name: 'Canhão do marinheiro',                price: 150,  currency: 'gold',   damage: 14, range: 100, cooldown: 4500, lifesteal: 0,   doubleShot: false },
  c3: { name: 'Canhão da tempestade de ferro',       price: 500,  currency: 'gold',   damage: 18, range: 120, cooldown: 4000, lifesteal: 0,   doubleShot: false },
  c4: { name: 'Quebrador de Leviatãs',               price: 1000, currency: 'gold',   damage: 20, range: 120, cooldown: 3200, lifesteal: 0.1, doubleShot: false },
  // Elite — vendidos apenas na Ilha do Comércio (Mapa 3).
  // `doubleShot` foi desligado nos dois: ele dobrava os PROJÉTEIS da salva, mas
  // o cliente só desenha 10 por dono a cada 200 ms, então num casco de 40
  // canhões o segundo tiro nunca aparecia na tela — só na conta do dano e no
  // consumo de munição. O dano subiu junto para compensar em parte a metade de
  // projéteis que deixou de sair (não compensa por inteiro: ver o histórico).
  c5: { name: 'Canhão de fogo abissal', price: 300,  currency: 'dobrao', damage: 30, range: 120, cooldown: 3000, lifesteal: 0.2, doubleShot: false, isElite: true },
  c6: { name: 'Ruína dos Sete Mares',   price: 2000, currency: 'dobrao', damage: 40, range: 120, cooldown: 3000, lifesteal: 0.3, doubleShot: false, isElite: true },
};

// ── AMMO_DEFS ─────────────────────────────────────────────────────────────────
// UNIDADES, porque duas já se confundiram aqui e as duas passaram em silêncio:
//
//   slow        FRAÇÃO (0.40 = −40% de velocidade)
//   slowDur     MILISSEGUNDOS
//   dotPct      PORCENTAGEM do golpe que aplicou o efeito (5 = 5% por tique).
//               Era `dotDmg`, um número FIXO: 2 de dano por tique é decisivo no
//               mapa 1 e invisível no 11, onde o golpe passa dos milhares.
//   dotTick     INTERVALO entre tiques, em MILISSEGUNDOS (500 = dois por segundo).
//               NÃO é dano. Trocar este número por um valor pequeno faz o DoT
//               tiquetar a cada quadro e durar `dotDur / dotTick` tiques.
//   dotDur      MILISSEGUNDOS de duração total
//   stunChance  FRAÇÃO (0.30 = 30%). É comparada direto com Math.random(), então
//               qualquer valor ≥ 1 atordoa SEMPRE — foi o que aconteceu com o 3.
//   stunDur     MILISSEGUNDOS
const AMMO_DEFS = {
  bala_ferro:      { damage: 5,  slow: 0,    slowDur: 0,    dotPct: 0, dotTick: 0,   dotDur: 0,    stunChance: 0,   stunDur: 0 },
  bala_perfurante: { damage: 8,  slow: 0,    slowDur: 0,    dotPct: 0, dotTick: 0,   dotDur: 0,    stunChance: 0,   stunDur: 0, piercing: true },
  bala_gelo:       { damage: 12, slow: 0.40, slowDur: 2000, dotPct: 0, dotTick: 0,   dotDur: 0,    stunChance: 0,   stunDur: 0 },
  bala_fogo:       { damage: 15, slow: 0,    slowDur: 0,    dotPct: 2, dotTick: 500, dotDur: 3000, stunChance: 0,   stunDur: 0 },
  bala_luz:        { damage: 15, slow: 0,    slowDur: 0,    dotPct: 0, dotTick: 0,   dotDur: 0,    stunChance: 0.3, stunDur: 3000 },
  bala_sangue:     { damage: 17, slow: 0,    slowDur: 0,    dotPct: 5, dotTick: 500, dotDur: 3000, stunChance: 0,   stunDur: 0 },
  bala_cura:       { damage: 0,  slow: 0,    slowDur: 0,    dotPct: 0, dotTick: 0,   dotDur: 0,    stunChance: 0,   stunDur: 0, isHeal: true, healAmount: 5, healMult: 3 },
};

// ── SAIL_DEFS ─────────────────────────────────────────────────────────────────
// speedBonus derrubado de 10/20/30% para 3/5/7%: com até 3 velas equipadas, o
// valor antigo somava +90% de velocidade só de pano, mais que qualquer outra
// fonte do jogo junta. O teto do tier de ouro é 5% e o do tier de dobrão, 7%.
const SAIL_DEFS = {
  vela_quadrada: { name: 'Vela Quadrada', price: 200,  currency: 'gold',   speedBonus: 0.03, accelBonus: 0.005 },
  vela_estai:    { name: 'Vela de Estai', price: 400,  currency: 'gold',   speedBonus: 0.05, accelBonus: 0.010 },
  vela_latina:   { name: 'Vela Latina',   price: 150,  currency: 'dobrao', speedBonus: 0.07, accelBonus: 0.015 },
};

// ── CANNON_RESEARCH_COSTS — custo por nível de pesquisa ──────────────────────
const CANNON_RESEARCH_COSTS = [
  { ironPlates:  50, gold:    100000 }, // nível 1
  { ironPlates: 100, dobroes:   5000 }, // nível 2
  { ironPlates: 150, dobroes:  10000 }, // nível 3
];

module.exports = { CANNON_DEFS, AMMO_DEFS, SAIL_DEFS, CANNON_RESEARCH_COSTS };
