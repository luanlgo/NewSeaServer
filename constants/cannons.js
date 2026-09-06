// constants/cannons.js — Canhões, munições, velas e custos de pesquisa

// ── Precisão do canhão ────────────────────────────────────────────────────────
// `accuracy` é FRAÇÃO (0.65 = 65% de chance de a salva acertar), e o teto que
// qualquer combinação de canhão + pesquisa pode alcançar é o CANNON_ACCURACY_MAX.
//
// ── O que este campo era, e por que deixou de ser ────────────────────────────
// Era `lifesteal`: cada projétil curava o atirante numa fração do dano que
// causou (c6 em 30%). O problema não era a frequência, era a cura ser uma
// FRAÇÃO DO DANO — quanto mais dano o jogador construía, mais ele se curava, e
// sem teto. No fim de jogo uma salva crítica de 100 mil devolvia ~40 mil de
// vida, e nenhum ajuste de porcentagem conserta isso: a conta escala junto com
// o eixo que ela deveria custar.
//
// Roubo de vida saiu do jogo. As duas curas que sobram são as que EXIGEM uma
// escolha: o curandeiro embarcado (ocupa peso no porão) e a bala_cura (ocupa o
// slot de munição e é comprada em dobrão). Curar deixou de ser uma consequência
// automática de bater forte.
//
// A precisão ocupa a mesma vaga na ficha do canhão e é o oposto disso: um teto
// no que o canhão entrega, não um bônus que cresce com o dano.
//
// ⚠️ Ela NÃO é a única perda de tiro do jogo. A dispersão da salva já derruba
//    parte dos projéteis por geometria (spreadRadius no projectile-manager, ~31%
//    a 120 unidades), e as duas se multiplicam. Antes de mexer nestes números,
//    conte as duas.
const CANNON_ACCURACY_MAX = 0.70;

// ── CANNON_DEFS ───────────────────────────────────────────────────────────────
const CANNON_DEFS = {
  c1: { name: 'Canhão enferrujado',                  price: 59,   currency: 'gold',   damage: 10, range: 80,  cooldown: 5000, accuracy: 0.50, doubleShot: false },
  c2: { name: 'Canhão do marinheiro',                price: 150,  currency: 'gold',   damage: 14, range: 100, cooldown: 4500, accuracy: 0.52, doubleShot: false },
  c3: { name: 'Canhão da tempestade de ferro',       price: 500,  currency: 'gold',   damage: 18, range: 120, cooldown: 4000, accuracy: 0.55, doubleShot: false },
  c4: { name: 'Quebrador de Leviatãs',               price: 1000, currency: 'gold',   damage: 20, range: 120, cooldown: 3200, accuracy: 0.58, doubleShot: false },
  // Elite — vendidos apenas na Ilha do Comércio (Mapa 3).
  // `doubleShot` foi desligado nos dois: ele dobrava os PROJÉTEIS da salva, mas
  // o cliente só desenha 10 por dono a cada 200 ms, então num casco de 40
  // canhões o segundo tiro nunca aparecia na tela — só na conta do dano e no
  // consumo de munição. O dano subiu junto para compensar em parte a metade de
  // projéteis que deixou de sair (não compensa por inteiro: ver o histórico).
  //
  // O c6 para em 0.65 de propósito: os 0.05 que faltam para o teto são a
  // pesquisa `cannon_accuracy_upgrade` (constants/maps.js). Um canhão que já
  // nascesse no máximo tornaria a pesquisa dinheiro jogado fora — o mesmo
  // cuidado que o crítico e o dano tomam.
  c5: { name: 'Canhão de fogo abissal', price: 300,  currency: 'dobrao', damage: 30, range: 120, cooldown: 3000, accuracy: 0.62, doubleShot: false, isElite: true },
  c6: { name: 'Ruína dos Sete Mares',   price: 2000, currency: 'dobrao', damage: 40, range: 120, cooldown: 3000, accuracy: 0.65, doubleShot: false, isElite: true },
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

module.exports = { CANNON_DEFS, CANNON_ACCURACY_MAX, AMMO_DEFS, SAIL_DEFS, CANNON_RESEARCH_COSTS };
