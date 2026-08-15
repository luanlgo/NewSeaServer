// constants/monster_skills.js — Bestiário: os 34 ataques dos 9 bichos novos
//
// UMA tabela, DOIS consumidores:
//   • `relic` — a versão jogável (relíquia r14..r47 que o bicho dropa ao morrer)
//   • `npc`   — a versão do bicho (entrada derivada em ATTACK_DEFS)
//
// Manter os dois no mesmo lugar é o que garante que o ataque que te matou e a
// relíquia que ele dropou sejam visualmente A MESMA COISA — o campo `vfx` é a
// pasta em `res://vfx/<vfx>/` nos dois casos.
//
// ── Escala ────────────────────────────────────────────────────────────────────
// Os números do `relic` são UNIDADES DE MUNDO na escala do jogador (barco = raio
// ~14, relíquias existentes usam 20–55). Os do `npc` são maiores de propósito:
// bicho cobre arena. O VFX se adapta sozinho — as skills escalam tudo por um
// `_rf` derivado do raio, então basta sobrescrever a medida raiz.
//
// ── shape: como o servidor resolve o acerto ───────────────────────────────────
//   circle  — raio único a partir do alvo
//   ring    — anel: pega de `safeRadius` até `radius` (o miolo é SEGURO)
//   cone    — `angle` graus de abertura, `length` de alcance, na direção do alvo
//   line    — corredor reto de `length` × `width`
//   multi   — `count` círculos de `radius` espalhados em `spread`
//   chain   — pula até `count` alvos, cada pulo alcança `jumpRange`
//
// ── Modificadores opcionais ───────────────────────────────────────────────────
//   ticks   { count, intervalMs, pct }  dano repetido (o pct SUBSTITUI damagePct)
//   cc      { slowPct, slowMs, stunMs, pullTo, pushDist, rootMs }
//   special 'soak' | 'bulwark' | 'obstacles' | 'drain' | 'charge' | 'lights'
//           | 'prison' | 'swallow' | 'manaburn' | 'silence' | 'mirror' | ...
//           casos que não cabem em forma+dano puro — ver handleMonsterSkill()
//
// ── targetMode: quem a skill mira ────────────────────────────────────────────
// Ausente (o normal) = um ponto no mundo, e quem estiver na forma leva.
// 'all_players_in_range' = trava a posição de CADA inimigo no alcance no cast e
// resolve a forma uma vez sobre cada uma, até `maxTargets`. Ver os Pilares.
//
// ⭐ = o ataque forte do conjunto (telegraph longo, dano/leitura maiores).
//     Marcado no dado como `star: true` — NÃO é só enfeite de comentário:
//       • o BICHO só usa a ⭐ durante a LUA DE SANGUE;
//       • a RELÍQUIA ⭐ só entra no sorteio de drop durante a lua.
//     Fora dela o conjunto do bicho vale como se a ⭐ não existisse. Quem já
//     ganhou a relíquia usa quando quiser — o gate é de bicho e de drop, não
//     de uso. Ver _getAvailable() (attack-manager) e _rollRelicDrop()
//     (projectile-manager).

const MONSTER_SKILLS = {

  // ═══════════════════════════════════════════════════════════════════════════
  // 1. CARANGUEIJO ABISSAL — mob básico (mapa 1). Comum/incomum, barato.
  // ═══════════════════════════════════════════════════════════════════════════
  crab_claw_slam: {
    relicId: 'r14', name: 'Pinça Esmagadora', icon: '🦀', rarity: 'comum',
    vfx: 'crab_claw_slam', source: 'carangueijo', shape: 'cone',
    desc: 'Cone curto na direção do cursor. Corpo a corpo puro: pouco alcance, dano cheio.',
    relic: { manaCost: 3, length: 55, angle: 70, damagePct: 0.60, castMs: 800 },
    npc:   { rangeMin: 0, rangeMax: 80, length: 80, angle: 70, damageMult: 2.5, castTime: 800, cooldown: 9000, weight: 10 },
  },
  crab_putrid_spray: {
    relicId: 'r15', name: 'Sopro Pútrido', icon: '🤢', rarity: 'incomum',
    vfx: 'crab_putrid_spray', source: 'carangueijo', shape: 'cone',
    // follow: canalizado — o cone re-mira a cada tick. No jogador segue o
    // CURSOR (o cliente manda relic_aim); no bicho, o alvo vivo.
    follow: true,
    desc: 'Sopro canalizado: o cone segue a sua mira e corrói a cada 0,7 s por 3,5 s.',
    // A bile corrói E emperra: cada leva renova um slow de 20%. `slowMs` maior
    // que o intervalo dos ticks mantém o efeito de pé durante a canalização e
    // solta o alvo pouco depois da última leva.
    relic: { manaCost: 4, length: 70, angle: 55, castMs: 1000,
             ticks: { count: 5, intervalMs: 700, pct: 0.16 },
             cc: { slowPct: 0.20, slowMs: 1500 } },
    npc:   { rangeMin: 20, rangeMax: 110, length: 110, angle: 55, damageMult: 0.8, castTime: 1000, cooldown: 12000, weight: 8,
             ticks: { count: 5, intervalMs: 700 },
             cc: { slowPct: 0.20, slowMs: 1500 } },
  },
  crab_burrow_rush: {
    relicId: 'r16', name: 'Investida Enterrada', icon: '💨', rarity: 'incomum',
    vfx: 'crab_burrow_rush', source: 'carangueijo', shape: 'line',
    // dash: o caster VIAJA enterrado e emerge no fim do corredor — "investida"
    // de verdade, não só uma faixa de dano.
    dash: true,
    desc: 'Mergulha na areia, atravessa o corredor e irrompe do outro lado em espinhos de pedra.',
    // `eruptRadius`: a 2ª etapa, a irrupção no FIM do corredor. Sem este número
    // no dado, o desenho 2D usava o default da cena (110 un — quase o dobro do
    // corredor inteiro), a peça 3D derivava outro valor do alcance, e o
    // servidor não batia nada ali. Agora os três leem o MESMO número.
    relic: { manaCost: 4, length: 100, width: 22, eruptRadius: 34, damagePct: 0.75, castMs: 600 },
    npc:   { rangeMin: 40, rangeMax: 160, length: 160, width: 35, eruptRadius: 55, damageMult: 3.0, castTime: 600, cooldown: 15000, weight: 7 },
  },
  crab_tidal_frenzy: {
    relicId: 'r17', name: 'Fúria da Maré', icon: '🌊', rarity: 'raro', star: true, // ⭐
    vfx: 'crab_tidal_frenzy', source: 'carangueijo', shape: 'circle',
    desc: 'Três ondas concêntricas em sequência. Multi-hit: quem não sair do raio leva as três.',
    relic: { manaCost: 6, radius: 60, castMs: 2200,
             ticks: { count: 3, intervalMs: 180, pct: 0.45 } },
    npc:   { rangeMin: 0, rangeMax: 140, radius: 140, damageMult: 1.4, castTime: 2200, cooldown: 25000, weight: 4,
             ticks: { count: 3, intervalMs: 180 } },
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // 2. CARANGUEIJO BOSS — chefe de arena (mapa 1). Raro/épico.
  // ═══════════════════════════════════════════════════════════════════════════
  crab_boss_barrage: {
    relicId: 'r18', name: 'Barragem Giratória', icon: '🔫', rarity: 'raro',
    vfx: 'crab_boss_barrage', source: 'carangueijo_boss', shape: 'cone',
    // Jogador: canalizada seguindo o CURSOR (sem giro automático).
    // NPC: mantém a varredura giratória (sweepTurns), que é a leitura do boss.
    follow: true,
    desc: 'Metralhadora canalizada: o cone segue a sua mira por 3,5 s, batendo sem parar.',
    relic: { manaCost: 6, length: 60, angle: 45, castMs: 1400, sweepTurns: 1.0,
             ticks: { count: 20, intervalMs: 160, pct: 0.10 } },
    npc:   { rangeMin: 0, rangeMax: 160, length: 160, angle: 45, damageMult: 0.35, castTime: 1400, cooldown: 16000, weight: 5,
             ticks: { count: 20, intervalMs: 160 } },
  },
  crab_boss_mortar: {
    relicId: 'r19', name: 'Salva de Morteiro', icon: '💣', rarity: 'raro',
    vfx: 'crab_boss_mortar', source: 'carangueijo_boss', shape: 'multi',
    // `aimed_ring`: o 1º obus cai EM CIMA do alvo e os outros 5 fecham um anel
    // com uma brecha de 90°. Ficar parado deixou de ser o jogo seguro; a saída
    // é ler a marcação e correr para a brecha (que muda de lado a cada salva).
    pattern: 'aimed_ring', gapAngle: 90,
    desc: 'Um obus na sua cabeça e cinco fechando o cerco — só uma brecha fica aberta. Leia e corra pra ela.',
    // spread 62 é medido, não chutado: o barco anda ~45 un/s (SHIP_SPEED×30),
    // ou seja ~58 un no 1,3 s de cast. Com 5 obuses no anel a 62, o cerco fica
    // SELADO até essa distância — varrendo todas as direções, nenhuma escapa a
    // não ser a brecha (a 70 já vazava em 70% dos casos).
    relic: { manaCost: 6, count: 6, spread: 30, radius: 16, damagePct: 0.40, castMs: 1300 },
    npc:   { rangeMin: 0, rangeMax: 200, count: 6, spread: 62, radius: 38, damageMult: 2.2, castTime: 1100, cooldown: 15000, weight: 5 },
  },
  crab_boss_tentacles: {
    relicId: 'r20', name: 'Tentáculos do Abismo', icon: '🐙', rarity: 'épico',
    vfx: 'crab_boss_tentacles', source: 'carangueijo_boss', shape: 'multi',
    // Mesma leitura do morteiro: um tentáculo sobe embaixo de quem está parado
    // e os outros cercam. Um agarrão que nunca acerta não é ameaça nenhuma.
    pattern: 'aimed_ring', gapAngle: 100,
    desc: 'Um tentáculo sobe embaixo de você e os outros cercam: quem for pego fica preso 2,5 s.',
    // Só 4 tentáculos no anel (o 5º sobe embaixo de você) não FECHAM o cerco:
    // medido, sempre sobra uma linha fina entre dois braços a ~67 un (o alcance
    // de fuga em 1,5 s). A 45 o anel cobre de 13 a 77 e quem anda sem ler leva
    // em ~54-74% das vezes; quem lê o desenho escapa — pela brecha larga ou
    // costurando entre dois braços. Selar de verdade pediria um 6º tentáculo e
    // raio 36 (medido: 1% de fuga), o que muda a cara da skill.
    relic: { manaCost: 7, count: 5, spread: 24, radius: 14, damagePct: 0.30, castMs: 1500,
             cc: { rootMs: 2500 } },
    npc:   { rangeMin: 0, rangeMax: 170, count: 5, spread: 45, radius: 32, damageMult: 1.0, castTime: 1500, cooldown: 18000, weight: 4,
             cc: { rootMs: 2500 } },
  },
  crab_boss_roar: {
    relicId: 'r21', name: 'Rugido Dilacerante', icon: '📢', rarity: 'épico', star: true, // ⭐
    vfx: 'crab_boss_roar', source: 'carangueijo_boss', shape: 'ring',
    desc: 'Anel que se expande com o MIOLO SEGURO. Dodge invertido: cole no centro.',
    relic: { manaCost: 8, radius: 90, safeRadius: 20, damagePct: 1.20, castMs: 1800 },
    npc:   { rangeMin: 0, rangeMax: 260, radius: 260, safeRadius: 55, damageMult: 4.0, castTime: 1800, cooldown: 20000, weight: 3 },
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // 3. VERME ABISSAL — mob agressivo (mapa 10).
  // ═══════════════════════════════════════════════════════════════════════════
  wyrm_maw_lunge: {
    relicId: 'r22', name: 'Bote da Bocarra', icon: '🪱', rarity: 'comum',
    vfx: 'wyrm_maw_lunge', source: 'wrim', shape: 'line',
    // dash: é um BOTE — o caster avança até o fim da faixa e a mandíbula fecha lá.
    // `rangeFromCannons`: o alcance da versão de RELÍQUIA acompanha o alcance
    // máximo dos canhões do barco, em vez de um número fixo — assim o bote
    // nunca fica mais curto que o tiro normal, que leria como downgrade.
    dash: true, rangeFromCannons: true,
    desc: 'Bote reto e rápido, no alcance dos seus canhões: você avança com a bocarra e ela FECHA no fim. Desvio é para o LADO.',
    // Alcance subido (era 65/100): o bote do VERME era mais curto que a
    // Investida do caranguejo (160), num bicho bem maior e de mapa mais tarde —
    // lia como bote de bichinho. O `rangeMax` acompanha o `length`, senao o
    // bicho nunca casta da distancia em que o golpe alcanca.
    relic: { manaCost: 3, length: 110, width: 22, damagePct: 0.65, castMs: 750 },
    npc:   { rangeMin: 0, rangeMax: 180, length: 180, width: 34, damageMult: 2.8, castTime: 750, cooldown: 15000, weight: 10 },
  },
  wyrm_palp_snare: {
    relicId: 'r23', name: 'Laços dos Palpos', icon: '🪢', rarity: 'incomum',
    vfx: 'wyrm_palp_snare', source: 'wrim', shape: 'cone',
    // `rangeFromCannons`: medido — o cone de 95 fixo ERRAVA a partir de 100 un,
    // que é a distância em que o jogo inteiro acontece (o canhão alcança 80–120
    // e é de lá que se atira). Na prática a relíquia "não fazia nada": você
    // puxava de onde estava e o laço parava antes do bicho. Colado no canhão,
    // o que você consegue mirar você consegue fisgar.
    rangeFromCannons: true,
    desc: 'Laços prendem em cone largo e ARRASTAM os presos para perto de você.',
    // Alcance subido (era 60/130). Um cone que ARRASTA para perto precisa
    // pegar quem esta longe — no alcance antigo so pegava quem ja estava
    // colado, e ai o puxao nao mudava nada.
    relic: { manaCost: 5, length: 95, angle: 110, damagePct: 0.35, castMs: 1100,
             cc: { pullTo: 25, stunMs: 800 } },
    npc:   { rangeMin: 0, rangeMax: 210, length: 210, angle: 110, damageMult: 1.2, castTime: 1100, cooldown: 15000, weight: 6,
             cc: { pullTo: 35, stunMs: 800 } },
  },
  wyrm_pustule_burst: {
    relicId: 'r24', name: 'Pústulas Virulentas', icon: '🟢', rarity: 'incomum',
    vfx: 'wyrm_pustule_burst', source: 'wrim', shape: 'multi',
    // ── CERCO, nao chuvisco ────────────────────────────────────────────────
    // Eram 5 pocas sorteadas num disco: com raio 24 sobre espalhamento 140 o
    // acerto era quase nulo e nao havia decisao nenhuma. Agora as pocas formam
    // um ANEL FECHADO (`sealed_ring`) — o miolo e ABRIGO e a coroa e a parede
    // que voce paga para sair. E o inverso do morteiro: aqui ficar parado no
    // centro e o certo, e o problema e que o veneno CRESCE e o abrigo encolhe.
    //
    // `count` 12 nao e estetica: para o anel nao ter vao, count >= PI*spread/
    // radius (10,2 aqui). Com 12 ele fecha com folga.
    pattern: 'sealed_ring',
    desc: 'Um anel de veneno fecha em volta: o miolo é abrigo. Mas as poças CRESCEM — saia antes de o abrigo sumir.',
    relic: { manaCost: 5, count: 12, spread: 55, radius: 17, castMs: 1200, growth: 1.8,
             ticks: { count: 6, intervalMs: 800, pct: 0.12 } },
    npc:   { rangeMin: 0, rangeMax: 200, count: 12, spread: 110, radius: 34, damageMult: 0.6, castTime: 1200, cooldown: 30000, weight: 5,
             growth: 1.8, ticks: { count: 6, intervalMs: 800 } },
  },
  wyrm_abyss_coil: {
    relicId: 'r25', name: 'Espiral do Abismo', icon: '🌀', rarity: 'raro', star: true, // ⭐
    vfx: 'wyrm_abyss_coil', source: 'wrim', shape: 'ring',
    desc: 'O anel fecha (fique FORA), depois o centro entra em erupção (fique DENTRO). Dodge duplo.',
    relic: { manaCost: 7, radius: 95, safeRadius: 22, eruptRadius: 38, damagePct: 1.10, castMs: 2200,
             ticks: { count: 10, intervalMs: 220, pct: 0.10 } },
    npc:   { rangeMin: 0, rangeMax: 230, radius: 230, safeRadius: 60, eruptRadius: 95, damageMult: 3.2, castTime: 2200, cooldown: 20000, weight: 3,
             ticks: { count: 10, intervalMs: 220 } },
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // 4. VERME BOSS — chefe de controle.
  // ═══════════════════════════════════════════════════════════════════════════
  wyrm_boss_spine_crown: {
    relicId: 'r26', name: 'Coroa de Espinhos', icon: '👑', rarity: 'raro',
    // 'rays': N raios girando em volta do centro (o cone único de antes acertava
    // uma fatia fixa enquanto o VISUAL mostrava a coroa inteira girando).
    vfx: 'wyrm_boss_spine_crown', source: 'wrim_boss', shape: 'rays',
    desc: 'Seis raios de espinhos girando devagar. Existe brecha entre eles — acompanhe o giro.',
    relic: { manaCost: 6, length: 80, angle: 22, rayCount: 6, spinSpeed: 0.35, castMs: 1400,
             ticks: { count: 12, intervalMs: 250, pct: 0.28 } },
    npc:   { rangeMin: 0, rangeMax: 200, length: 200, angle: 22, rayCount: 6, spinSpeed: 0.35, damageMult: 0.9, castTime: 1400, cooldown: 30000, weight: 5,
             ticks: { count: 12, intervalMs: 250 } },
  },
  wyrm_boss_maw_vortex: {
    relicId: 'r27', name: 'Vórtice da Bocarra', icon: '🕳️', rarity: 'épico',
    vfx: 'wyrm_boss_maw_vortex', source: 'wrim_boss', shape: 'circle',
    desc: 'Suga tudo para o centro por 2,5 s e fecha a bocarra. Reme contra e termine longe.',
    // Dano pela METADE (balanceamento 2026-08-02): a sucção já é punição por
    // si só — segura você no raio enquanto os tiques rodam, então o pacote
    // inteiro estava batendo muito mais forte do que a leitura sugeria.
    // Cortado nos DOIS lugares: os tiques da sucção e a mordida final.
    relic: { manaCost: 7, radius: 95, biteRadius: 32, damagePct: 0.50, castMs: 1600,
             cc: { pullTo: 0, slowPct: 0.30, slowMs: 2500 },
             ticks: { count: 12, intervalMs: 200, pct: 0.03 } },
    npc:   { rangeMin: 0, rangeMax: 240, radius: 200, biteRadius: 80, damageMult: 1.0, castTime: 1600, cooldown: 30000, weight: 4,
             cc: { slowPct: 0.30, slowMs: 2500 }, ticks: { count: 12, intervalMs: 200 } },
  },
  wyrm_boss_leg_cage: {
    relicId: 'r28', name: 'Jaula de Patas', icon: '🔒', rarity: 'épico',
    vfx: 'wyrm_boss_leg_cage', source: 'wrim_boss', shape: 'circle', special: 'obstacles',
    desc: 'Ergue uma jaula de patas com UMA brecha. Bloqueio físico real por 3,5 s.',
    relic: { manaCost: 6, radius: 45, legCount: 8, gapAngle: 55, castMs: 1200, holdMs: 3500,
             obstacleRadius: 7 },
    npc:   { rangeMin: 0, rangeMax: 110, radius: 110, legCount: 8, gapAngle: 55, damageMult: 0, castTime: 1200, cooldown: 30000, weight: 3,
             holdMs: 3500, obstacleRadius: 12 },
  },
  wyrm_boss_reaper_spiral: {
    relicId: 'r29', name: 'Ceifa do Abismo', icon: '☠️', rarity: 'lendário', star: true, // ⭐
    vfx: 'wyrm_boss_reaper_spiral', source: 'wrim_boss', shape: 'circle',
    desc: 'Dois braços em espiral varrem a área e no fim tudo colapsa numa onda só.',
    relic: { manaCost: 9, radius: 100, armCount: 2, armWidth: 12, sweepTurns: 2.0, damagePct: 1.40, castMs: 2500,
             ticks: { count: 18, intervalMs: 150, pct: 0.14 } },
    npc:   { rangeMin: 0, rangeMax: 260, radius: 260, armCount: 2, armWidth: 28, sweepTurns: 2.0, damageMult: 4.5, castTime: 2500, cooldown: 30000, weight: 2,
             ticks: { count: 18, intervalMs: 150 } },
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // 5. LEVIATÃ-TARTARUGA — mob tanque (mapa 4). A 4ª do conjunto é a CURA (r1).
  // ═══════════════════════════════════════════════════════════════════════════
  leviathan_neck_beam: {
    relicId: 'r30', name: 'Jato do Pescoço', icon: '💦', rarity: 'incomum',
    vfx: 'leviathan_neck_beam', source: 'tartaruga', shape: 'line',
    // Canalizado: o feixe segue o cursor enquanto dura (ver `follow` no Sopro).
    follow: true,
    // `turnRate`: quanto o pescoco pode GIRAR por segundo, em radianos.
    //
    // Sem cap, o `follow` re-mirava instantaneamente a cada leva: o feixe
    // saltava do angulo do telegraph para cima do jogador no primeiro tick e
    // colava nele para sempre — acerto garantido, sem jogada possivel.
    //
    // 0,60 rad/s (era 0,30): o feixe varre lateralmente `turnRate x distancia`
    // un/s, e o barco navega ~45 un/s. Com 0,30 o ponto de empate ficava em 150
    // un — quase todo o alcance (190) era zona de fuga fácil e o pescoço parecia
    // travado, girando atrás do jogador sem nunca alcançar. Dobrado, o empate cai
    // para 75 un: só quem entra na guarda dele ganha do giro, que é a leitura
    // que a skill sempre prometeu.
    turnRate: 0.60,
    // Mesmo remédio do Laço, pela mesma medida: o feixe de 75 un morria antes do
    // alcance do canhão, então da distância de combate os 20 tiques caíam na
    // água. E `width` subiu de 12 para 24 (a do bicho): num corredor de 12 un o
    // centro do bicho tinha de estar a 6 un do eixo — 12 un de erro de mira já
    // zerava a skill inteira. Era o "não está dando o dano por tick".
    rangeFromCannons: true,
    desc: 'Feixe contínuo que segue a sua mira. Circule mais rápido do que o pescoço vira.',
    relic: { manaCost: 5, length: 75, width: 24, sweepArc: 80, turnSpeed: 0.9, castMs: 1200,
             ticks: { count: 20, intervalMs: 120, pct: 0.10 } },
    npc:   { rangeMin: 0, rangeMax: 190, length: 190, width: 24, sweepArc: 80, turnSpeed: 0.9, damageMult: 0.35, castTime: 1200, cooldown: 18000, weight: 6,
             ticks: { count: 20, intervalMs: 120 } },
  },
  leviathan_tide_wall: {
    relicId: 'r31', name: 'Muralha de Maré', icon: '🌊', rarity: 'raro',
    vfx: 'leviathan_tide_wall', source: 'tartaruga', shape: 'line',
    // `tidewall`: a onda VIAJA. Sem isto o `line` resolvia o corredor inteiro no
    // fim do cast — a parede aparecia longe e voce ja tinha levado. Agora a
    // frente corre de 0 ate `length` em `travelMs` e machuca quem ela alcanca,
    // uma vez so. `travelMs` tem de casar com o `travel_duration` do desenho.
    special: 'tidewall', travelMs: 1200,
    desc: 'Uma parede de água avança empurrando tudo à frente. Saia pela LATERAL.',
    // `length` DOBRADO (era 100): a onda parava antes do alcance do canhão, e
    // uma parede que avança tem de chegar em quem está longe — é o alcance que
    // faz a skill. `travelMs` fica em 1200 (a frente só corre mais rápido, 167
    // un/s contra os 217 un/s da versão do bicho) porque esse número tem de
    // continuar casando com o `travel_duration` do desenho.
    relic: { manaCost: 6, width: 80, length: 200, band: 14, damagePct: 0.70, castMs: 1300,
             cc: { pushDist: 45 } },
    npc:   { rangeMin: 0, rangeMax: 260, width: 200, length: 260, band: 30, damageMult: 2.4, castTime: 1300, cooldown: 15000, weight: 5,
             cc: { pushDist: 45 } },
  },
  leviathan_shell_bulwark: {
    relicId: 'r32', name: 'Carapaça Eriçada', icon: '🐢', rarity: 'raro',
    vfx: 'leviathan_shell_bulwark', source: 'tartaruga', shape: 'circle', special: 'bulwark',
    desc: 'Placas eriçam por 5 s: 40% menos dano recebido e 30% do que sobra volta em quem bateu.',
    relic: { manaCost: 6, radius: 22, durationMs: 5000, damageReduction: 0.40, reflectPct: 0.30, castMs: 400 },
    npc:   { rangeMin: 0, rangeMax: 90, radius: 70, durationMs: 5000, damageReduction: 0.40, reflectPct: 0.30, damageMult: 0, castTime: 400, cooldown: 20000, weight: 4 },
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // 6. TARTARUGA BOSS — chefe de terreno. A 4ª do conjunto é o ARPÃO (r13).
  // ═══════════════════════════════════════════════════════════════════════════
  turtle_boss_wreck_field: {
    relicId: 'r33', name: 'Cemitério de Naufrágios', icon: '⚓', rarity: 'épico',
    vfx: 'turtle_boss_wreck_field', source: 'tartaruga_boss', shape: 'multi', special: 'obstacles',
    // ── CHUVA, não salva ───────────────────────────────────────────────────
    // As 6 quedas de uma vez viravam sorteio: com raio 30 sobre um espalhamento
    // de 200, ficar parado quase nunca era punido e não havia decisão nenhuma.
    // Agora cai UMA de cada vez, `dropIntervalMs` entre elas, cada uma mirada
    // em ONDE VOCÊ ESTÁ naquele instante. Vira perseguição: quem para, leva; e
    // como cada destroço vira obstáculo, a arena fecha em volta de quem correu
    // em linha reta.
    //
    // `dropWarnMs` é a janela de fuga de cada queda. Sem ela a mira ao vivo
    // seria acerto garantido — o jogo deixaria de ter saída.
    dropIntervalMs: 1000, dropWarnMs: 700,
    desc: 'Seis destroços caem UM POR VEZ, cada um em cima de você, e viram obstáculos por 8 s. Não pare.',
    // A chuva mirada só existia na mão do BICHO — a relíquia largava as seis de
    // uma vez em pontos sorteados (ver _castWreckRain no monster-skill-manager).
    // Com a queda mirada, `spread` deixa de valer e o raio de impacto DOBRA
    // (12 → 24): 12 un debaixo de um destroço que cai em cima de você é uma
    // marcação que só pune quem estiver parado no pixel.
    relic: { manaCost: 7, count: 6, spread: 75, radius: 24, damagePct: 0.35, castMs: 1300,
             holdMs: 8000, obstacleRadius: 8 },
    npc:   { rangeMin: 0, rangeMax: 220, count: 6, spread: 200, radius: 30, damageMult: 1.1, castTime: 1300, cooldown: 20000, weight: 4,
             holdMs: 8000, obstacleRadius: 16 },
  },

  turtle_boss_gorge_drain: {
    relicId: 'r34', name: 'Sanguessuga do Casco', icon: '🩸', rarity: 'raro',
    vfx: 'turtle_boss_gorge_drain', source: 'tartaruga_boss', shape: 'circle', special: 'drain',
    desc: 'Dreno por 3 s: tira vida de quem está no raio e devolve metade para você.',
    relic: { manaCost: 6, radius: 70, castMs: 1500, drainHealPct: 0.50,
             ticks: { count: 8, intervalMs: 400, pct: 0.15 } },
    npc:   { rangeMin: 0, rangeMax: 190, radius: 190, damageMult: 0.5, castTime: 1500, cooldown: 18000, weight: 5,
             drainHealPct: 0.50, ticks: { count: 8, intervalMs: 400 } },
  },
  turtle_boss_broadside: {
    relicId: 'r35', name: 'Salva de Bombordo', icon: '💥', rarity: 'épico',
    vfx: 'turtle_boss_broadside', source: 'tartaruga_boss', shape: 'circle',
    // `atCaster`: a area nasce NO LANCADOR e ACOMPANHA ele a cada leva, em vez
    // de ficar plantada onde o alvo estava no cast. E o que a skill sempre
    // quis dizer — sao os canhoes do CASCO disparando em setores; centrada no
    // alvo, o boss podia sair de dentro da propria salva. Seguindo o casco, a
    // leitura vira "circule o boss no setor certo" em vez de "saia do circulo".
    atCaster: true,
    desc: 'Os canhoes do casco disparam em setores alternados, e a salva anda COM ele. Ache o RITMO, nao o lugar.',
    relic: { manaCost: 8, radius: 90, sectorCount: 4, cycleCount: 6, accel: 0.88, castMs: 2200,
             ticks: { count: 6, intervalMs: 800, pct: 0.35 } },
    npc:   { rangeMin: 0, rangeMax: 240, radius: 240, sectorCount: 4, cycleCount: 6, accel: 0.88, damageMult: 1.1, castTime: 2200, cooldown: 21000, weight: 3,
             ticks: { count: 6, intervalMs: 800 } },
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // 7. DRAKE MARINHO — mob ágil/elétrico (mapa 2). Primeiro conjunto elétrico.
  // ═══════════════════════════════════════════════════════════════════════════
  drake_chain_arc: {
    relicId: 'r36', name: 'Descarga em Cadeia', icon: '⚡', rarity: 'incomum',
    vfx: 'drake_chain_arc', source: 'cobra', shape: 'chain',
    // `jumpCastMs`: cada pulo é ANUNCIADO antes de bater. A cadeia deixou de ser
    // um estouro instantâneo e virou uma sequência que dá para ler — quem está
    // no próximo elo tem essa janela para sair do raio.
    desc: 'O raio pula entre até 4 alvos próximos, perdendo 25% de força a cada pulo. Cada pulo é marcado antes de cair.',
    // `seekRadius` é a tolerância de mira do PRIMEIRO elo (ver _chainTargets).
    // Antes esse papel era do `radius` (5 un!): era preciso clicar a 5 un do
    // centro do bicho para a cadeia sequer começar, e por isso a relíquia
    // "não fazia nada". `jumpRange` subiu de 35 para 60 pelo mesmo motivo — a
    // 35 un dois bichos quase nunca estão perto o bastante para o raio pular.
    relic: { manaCost: 4, count: 4, jumpRange: 60, seekRadius: 45, radius: 14,
             damagePct: 0.70, falloff: 0.75, castMs: 1000 },
    npc:   { rangeMin: 0, rangeMax: 140, count: 4, jumpRange: 90, radius: 15, damageMult: 2.0, falloff: 0.75, castTime: 1200, cooldown: 15000, weight: 5,
             jumpCastMs: 550 },
  },
  drake_hunter_orb: {
    relicId: 'r37', name: 'Orbe Caçadora', icon: '🔮', rarity: 'épico',
    vfx: 'drake_hunter_orb', source: 'cobra', shape: 'circle', special: 'orb',
    // A orbe é uma AMEAÇA MÓVEL de verdade: o servidor a move em direção ao alvo
    // vivo, ela corrói quem estiver dentro do raio a cada `orbTickMs`, e ao
    // alcançar (ou expirar) estoura com o dano cheio + atordoamento.
    // `orbTickPct` é a fração do dano por leva; o estouro usa o dano inteiro.
    desc: 'Uma orbe persegue você, corrói quem estiver dentro dela e estoura atordoando ao alcançar. Corra em curva.',
    // `orbSpeed` 45 (era 22): a 22 un/s a orbe andava METADE da velocidade do
    // barco — nunca alcançava nada que se mexesse e lia como bolha à deriva.
    // 45 é rápido o bastante para caçar e ainda dá para fugir em curva, que é a
    // leitura da skill. `catchRadius` sobe junto (9 → 14) porque o bicho é bem
    // maior que o ponto onde o servidor guarda o centro dele.
    relic: { manaCost: 5, radius: 18, orbSpeed: 45, lifeMs: 4000, catchRadius: 14, damagePct: 0.90, castMs: 1000,
             orbTickMs: 400, orbTickPct: 0.18, cc: { stunMs: 1000 } },
    npc:   { rangeMin: 0, rangeMax: 200, radius: 45, orbSpeed: 70, lifeMs: 4000, catchRadius: 18, damageMult: 1.6, castTime: 1000, cooldown: 14000, weight: 5,
             orbTickMs: 400, orbTickPct: 0.18, cc: { stunMs: 1000 } },
  },
  drake_static_field: {
    relicId: 'r38', name: 'Campo Estático', icon: '🌩️', rarity: 'raro',
    vfx: 'drake_static_field', source: 'cobra', shape: 'circle', special: 'static',
    desc: 'Campo de 4 s que só pune QUEM SE MEXER dentro dele. Não é lugar, é estado.',
    // Raio reduzido à METADE (era 75/150): o campo cobria meia tela e, sendo um
    // efeito de ESTADO (só pune quem se mexe), a área grande não acrescentava
    // decisão nenhuma — só poluía a leitura de tudo o mais que estivesse na
    // mesma região.
    relic: { manaCost: 6, radius: 38, castMs: 1200, moveThreshold: 6,
             ticks: { count: 8, intervalMs: 500, pct: 0.25 } },
    npc:   { rangeMin: 0, rangeMax: 200, radius: 75, damageMult: 0.8, castTime: 1200, cooldown: 16000, weight: 5,
             moveThreshold: 10, ticks: { count: 8, intervalMs: 500 } },
  },
  drake_lightning_web: {
    relicId: 'r39', name: 'Teia de Raios', icon: '🕸️', rarity: 'épico', star: true, // ⭐
    vfx: 'drake_lightning_web', source: 'cobra', shape: 'circle',
    desc: 'Seis nós ligados por feixes que trocam de par 3 vezes. Leia o grafo e ache a folga.',
    relic: { manaCost: 7, radius: 85, nodeCount: 6, phaseCount: 3, beamWidth: 10, collapseRadius: 22, castMs: 2200,
             ticks: { count: 3, intervalMs: 1400, pct: 0.55 } },
    npc:   { rangeMin: 0, rangeMax: 230, radius: 230, nodeCount: 6, phaseCount: 3, beamWidth: 20, collapseRadius: 55, damageMult: 1.6, castTime: 2200, cooldown: 22000, weight: 3,
             ticks: { count: 3, intervalMs: 1400 } },
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // 8. DRAKE BOSS — chefe de execução.
  // ═══════════════════════════════════════════════════════════════════════════
  drake_boss_creeping_barrage: {
    relicId: 'r40', name: 'Barragem Rolante', icon: '〰️', rarity: 'raro',
    vfx: 'drake_boss_creeping_barrage', source: 'cobra_boss', shape: 'line',
    // Cada passo ergue uma PAREDE real (mesmo wallManager do Muro de Pedra) que
    // fica de pé por um instante: a barragem não só machuca, ela EMPURRA e
    // fecha o caminho — atravessar para trás dela vira a jogada certa.
    special: 'obstacles', wallPerStep: true,
    desc: 'Parede de explosões que avança em 5 passos erguendo pedra a cada uma. Atravesse PARA TRÁS dela.',
    relic: { manaCost: 6, width: 80, band: 13, stepCount: 5, stepDistance: 20, firstDistance: 22, castMs: 1600,
             holdMs: 1400, obstacleRadius: 9,
             ticks: { count: 5, intervalMs: 550, pct: 0.45 } },
    npc:   { rangeMin: 0, rangeMax: 340, width: 220, band: 34, stepCount: 5, stepDistance: 55, firstDistance: 60, damageMult: 1.4, castTime: 1600, cooldown: 18000, weight: 5,
             holdMs: 1400, obstacleRadius: 18,
             ticks: { count: 5, intervalMs: 550 } },
  },
  drake_boss_sonar_rings: {
    relicId: 'r41', name: 'Sonar do Abismo', icon: '📡', rarity: 'épico',
    vfx: 'drake_boss_sonar_rings', source: 'cobra_boss', shape: 'ring',
    // `sonar`: as ondas sao SIMULADAS (cada uma corre de 0 ate `radius` em
    // `expandMs`), em vez de resolvidas em N levas grossas. Com 4 levas a
    // frente pulava 65 un por vez sobre uma faixa de 30 — 54% do raio NUNCA
    // era atingido e o dano nao tinha relacao com o anel que voce via passar.
    // `expandMs` tem de casar com o `expand_duration` do desenho.
    // `expandMs` 3200 (era 1600) e `gapStep` 0,8 (era 1,1) sao MEDIDOS, nao
    // chutados: o barco navega ~45 un/s e a onda cruzava 260 un em 1,6 s
    // (163 un/s). Do lado oposto ao vao eram 7,6 s de nado contra 0,8 s de
    // onda — matematicamente impossivel. Com a onda em 3,2 s e o vao girando
    // menos entre uma e outra, a manobra passa a caber na janela em TODAS as
    // distancias (ver a tabela no comentario do `gapStep`).
    special: 'sonar', expandMs: 3200,
    desc: 'Quatro anéis se expandem, cada um com um vão que GIRA. Dance até o vão.',
    // `ticks.intervalMs` aqui NAO e cadencia de dano: e o intervalo de
    // LANCAMENTO entre uma onda e a seguinte (o simulador cuida do dano). 1200
    // dá mais respiro entre paredes do que os 850 originais.
    relic: { manaCost: 7, radius: 95, band: 11, ringCount: 4, gapAngle: 60, gapStep: 0.8, castMs: 1500,
             ticks: { count: 4, intervalMs: 1200, pct: 0.40 } },
    npc:   { rangeMin: 0, rangeMax: 260, radius: 260, band: 30, ringCount: 4, gapAngle: 60, gapStep: 0.8, damageMult: 1.3, castTime: 1500, cooldown: 19000, weight: 4,
             ticks: { count: 4, intervalMs: 1200 } },
  },
  drake_boss_coral_communion: {
    relicId: 'r42', name: 'Comunhão do Coral', icon: '🪸', rarity: 'épico',
    vfx: 'drake_boss_coral_communion', source: 'cobra_boss', shape: 'circle', special: 'soak',
    desc: 'Pancada enorme com o dano DIVIDIDO entre todos os atingidos. Inverte tudo: amontoar salva.',
    // Cast pela METADE (era 3200 nos dois): 3,2 s de carga para um golpe que já
    // pede o grupo amontoado deixava tempo de sobra para reagir sem pensar.
    relic: { manaCost: 7, radius: 35, damagePct: 2.20, castMs: 1600 },
    npc:   { rangeMin: 0, rangeMax: 120, radius: 90, damageMult: 8.0, castTime: 1600, cooldown: 26000, weight: 3 },
  },
  drake_boss_core_overload: {
    relicId: 'r43', name: 'Sobrecarga do Núcleo', icon: '💠', rarity: 'lendário', star: true, // ⭐
    vfx: 'drake_boss_core_overload', source: 'cobra_boss', shape: 'circle', special: 'charge',
    desc: 'Carrega por 5 s e detona a tela inteira. INTERROMPÍVEL: dano no lançador cancela tudo.',
    relic: { manaCost: 9, radius: 115, coreRadius: 25, damagePct: 2.00, castMs: 800, chargeMs: 5000, interruptDamage: 1 },
    npc:   { rangeMin: 0, rangeMax: 320, radius: 320, coreRadius: 60, damageMult: 7.0, castTime: 800, cooldown: 30000, weight: 2,
             chargeMs: 5000, interruptDamage: 1 },
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // 9. CARNICEIRO DO OSSUÁRIO — BOSS FINAL. Três das quatro têm ALVO VIVO:
  //    a área é uma PESSOA, não um lugar.
  // ═══════════════════════════════════════════════════════════════════════════
  charnel_death_mark: {
    relicId: 'r44', name: 'Sentença do Crânio', icon: '💀', rarity: 'épico',
    vfx: 'charnel_death_mark', source: 'leviata_boss', shape: 'multi', special: 'mark',
    desc: 'Carimba 3 alvos; a marca ANDA COM ELES e estoura em 4 s onde estiverem.',
    relic: { manaCost: 7, count: 3, spread: 60, radius: 22, damagePct: 1.00, castMs: 1000, fuseMs: 4000 },
    npc:   { rangeMin: 0, rangeMax: 200, count: 3, spread: 150, radius: 60, damageMult: 3.0, castTime: 1000, cooldown: 20000, weight: 4, fuseMs: 4000 },
  },
  charnel_brood_hatch: {
    relicId: 'r45', name: 'Ninhada Pútrida', icon: '🥚', rarity: 'raro',
    vfx: 'charnel_brood_hatch', source: 'leviata_boss', shape: 'multi', special: 'brood',
    desc: 'Cinco ovos com 6 s de chocagem. Cada ovo destruído a tempo é uma explosão a menos.',
    relic: { manaCost: 6, count: 5, spread: 65, radius: 9, damagePct: 0.50, castMs: 1100, hatchMs: 6000 },
    npc:   { rangeMin: 0, rangeMax: 200, count: 5, spread: 180, radius: 22, damageMult: 1.6, castTime: 1100, cooldown: 19000, weight: 4, hatchMs: 6000 },
  },
  charnel_chain_bond: {
    relicId: 'r46', name: 'Grilhões do Ossuário', icon: '⛓️', rarity: 'épico',
    vfx: 'charnel_chain_bond', source: 'leviata_boss', shape: 'circle', special: 'bond',
    desc: 'Acorrenta inimigos em pares por 6 s: quem esticar a corrente sangra junto com o par.',
    relic: { manaCost: 7, radius: 55, pairCount: 2, maxLength: 45, castMs: 1200, durationMs: 6000,
             ticks: { count: 12, intervalMs: 500, pct: 0.20 } },
    npc:   { rangeMin: 0, rangeMax: 140, radius: 140, pairCount: 2, maxLength: 120, damageMult: 0.7, castTime: 1200, cooldown: 22000, weight: 4,
             durationMs: 6000, ticks: { count: 12, intervalMs: 500 } },
  },
  charnel_funeral_march: {
    relicId: 'r47', name: 'Marcha Fúnebre', icon: '⚰️', rarity: 'lendário', star: true, // ⭐
    vfx: 'charnel_funeral_march', source: 'leviata_boss', shape: 'ring',
    desc: 'A arena aperta em 4 passos… e no fim ABRE numa explosão central. Aperta junto, sai no fim.',
    relic: { manaCost: 10, radius: 120, finalRadius: 30, collapseRadius: 45, phaseCount: 4, damagePct: 1.60, castMs: 2600,
             ticks: { count: 8, intervalMs: 500, pct: 0.18 } },
    npc:   { rangeMin: 0, rangeMax: 320, radius: 320, finalRadius: 80, collapseRadius: 120, phaseCount: 4, damageMult: 5.0, castTime: 2600, cooldown: 28000, weight: 2,
             ticks: { count: 8, intervalMs: 500 } },
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // 10. ABERRAÇÃO DO VAZIO — mob do mapa 10 (o corpo detalhado do "mímico").
  //
  // Late game: o conjunto inteiro pesa mais que o dos mapas iniciais, mas o que
  // faz uma skill de mapa 10 doer NÃO é o número — é a JANELA. Aqui os castes
  // são curtos e as áreas grandes, então o erro cobra caro mesmo com dano
  // parecido. Todas as quatro são compostas só de forma + ticks + cc, que os
  // DOIS motores (attack-manager do bicho e monster-skill-manager da relíquia)
  // resolvem por igual — nada de `special` que só existe de um lado.
  // ═══════════════════════════════════════════════════════════════════════════
  alien_maw_engulf: {
    relicId: 'r48', name: 'Bocarra Torácica', icon: '👄', rarity: 'épico',
    vfx: 'alien_maw_engulf', source: 'alien', shape: 'circle', special: 'swallow',
    desc: 'O peito se abre e ENGOLE quem estiver colado: preso e ferido por 2 s, depois cuspido atrás dele.',
    // ── `swallow`: deslocamento + prisão, e não mais um stun ────────────────
    // A cavidade torácica da criatura é o desenho todo — ela ABRE como uma flor
    // de carne. Uma skill que só empurrasse seria desperdiçar isso.
    //
    // Mecanicamente é a primeira do jogo que TIRA a vítima do lugar e a segura
    // grudada no lançador: durante `holdMs` ela não navega (usa o mesmo
    // stunExpires que o resto do jogo já respeita) E a posição dela é reescrita
    // a cada leva para acompanhar quem engoliu. No fim é CUSPIDA `spitDist`
    // para trás — sair da bocarra não te devolve onde você entrou, e é isso que
    // separa a leitura de um atordoamento comum.
    //
    // Só UMA vítima por uso, e nunca um boss (mesma convenção do resto: chefe
    // só leva slow). O raio é curto de propósito: quem engole tem de se colar.
    relic: { manaCost: 6, radius: 32, holdMs: 2000, spitDist: 55, castMs: 900,
             ticks: { count: 5, intervalMs: 400, pct: 0.42 } },
    npc:   { rangeMin: 0, rangeMax: 75, radius: 75, holdMs: 2000, spitDist: 95, damageMult: 1.5, castTime: 900, cooldown: 18000, weight: 7,
             ticks: { count: 5, intervalMs: 400 } },
  },
  alien_tail_sweep: {
    relicId: 'r49', name: 'Varredura da Cauda', icon: '🌀', rarity: 'raro',
    vfx: 'alien_tail_sweep', source: 'alien', shape: 'ring',
    desc: 'A cauda enrolada chicoteia para FORA. O miolo é seguro — cole no bicho em vez de fugir.',
    // Dodge invertido: a leitura instintiva (correr) é a errada. `safeRadius`
    // generoso porque colar num bicho de mapa 10 já é risco suficiente.
    relic: { manaCost: 6, radius: 85, safeRadius: 26, damagePct: 1.35, castMs: 1100,
             cc: { slowPct: 0.35, slowMs: 2000 } },
    npc:   { rangeMin: 0, rangeMax: 200, radius: 200, safeRadius: 70, damageMult: 3.2, castTime: 1100, cooldown: 15000, weight: 7,
             cc: { slowPct: 0.35, slowMs: 2000 } },
  },
  alien_eyeless_siphon: {
    relicId: 'r50', name: 'Sorvo sem Olhos', icon: '🫧', rarity: 'épico',
    vfx: 'alien_eyeless_siphon', source: 'alien', shape: 'circle', special: 'manaburn',
    desc: 'A cabeça cega inspira: puxa para o centro e QUEIMA A MANA de quem estiver dentro.',
    // ── `manaburn`: o primeiro golpe do jogo que ataca MANA ─────────────────
    // A criatura não tem olhos — ela sente. O que ela procura não é o casco, é
    // o que faz o casco brilhar.
    //
    // Num jogo em que TODA relíquia custa mana e a regeneração é de 0,5/s, tirar
    // mana é uma pressão que nenhuma outra skill exerce: não te mata, te
    // DESARMA. E é honesto — dá para sair da zona, e o que se perde volta com o
    // tempo em vez de virar morte.
    //
    // `noManaDamagePct`: contra quem não tem mana (todo NPC) não haveria efeito
    // nenhum, e a relíquia viraria lixo em PvE. Aí o sorvo queima carne no lugar
    // — mesma fome, alvo diferente.
    relic: { manaCost: 7, radius: 78, manaBurn: 4, noManaDamagePct: 0.32, castMs: 1300,
             cc: { pullTo: 30, slowPct: 0.25, slowMs: 1400 },
             ticks: { count: 6, intervalMs: 500, pct: 0.16 } },
    npc:   { rangeMin: 0, rangeMax: 200, radius: 200, manaBurn: 6, noManaDamagePct: 0.32, damageMult: 0.8, castTime: 1300, cooldown: 19000, weight: 6,
             cc: { pullTo: 80, slowPct: 0.25, slowMs: 1400 },
             ticks: { count: 6, intervalMs: 500 } },
  },
  alien_void_lance: {
    relicId: 'r51', name: 'Lança do Vazio', icon: '🕳️', rarity: 'lendário', star: true, // ⭐
    vfx: 'alien_void_lance', source: 'alien', shape: 'line',
    desc: 'Feixe canalizado que persegue a sua mira por 3 s. Entre na guarda dele ou saia do eixo.',
    // Canalizada com cap de giro, mesma família do Jato do Pescoço — mas o
    // pescoço do leviatã vira 0,60 rad/s e este vira 0,45: é mais longo e mais
    // grosso, então precisa ser MAIS lento para continuar tendo saída. O ponto
    // de empate com os ~45 un/s do barco cai em 100 un.
    follow: true,
    turnRate: 0.45,
    rangeFromCannons: true,
    relic: { manaCost: 8, length: 120, width: 30, castMs: 1400,
             ticks: { count: 15, intervalMs: 200, pct: 0.20 } },
    npc:   { rangeMin: 0, rangeMax: 240, length: 240, width: 34, damageMult: 0.75, castTime: 1400, cooldown: 24000, weight: 4,
             ticks: { count: 15, intervalMs: 200 } },
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // 11. SOBERANO DO VAZIO — BOSS do mapa 10 (o corpo detalhado do mímico-chefe).
  //
  // Cinco ataques: é o conjunto mais largo do jogo, e de propósito — um chefe de
  // penúltimo mapa tem de ter repertório suficiente para você não decorar a
  // ordem. Duas delas usam `atCaster` (área presa ao corpo dele), o que muda a
  // pergunta de "onde vai cair?" para "onde ELE está indo?".
  // ═══════════════════════════════════════════════════════════════════════════
  alien_boss_face_choir: {
    relicId: 'r52', name: 'Coro dos Rostos', icon: '😱', rarity: 'lendário',
    vfx: 'alien_boss_face_choir', source: 'alien_boss', shape: 'circle', special: 'silence',
    desc: 'Os rostos presos na carne gritam juntos: você fica SEM RELÍQUIAS por 2 s.',
    // ── `silence`: o eixo que faltava ──────────────────────────────────────
    // Os rostos humanos embutidos no corpo dele são o detalhe mais perturbador
    // do modelo, e são gente que ele comeu. A skill é essa gente gritando.
    //
    // Silêncio é duro de propósito, e por isso é CURTO (2 s) e vem com o
    // telegraph mais longo do conjunto (1,8 s): dá para sair. Você continua
    // navegando e atirando de canhão — perde o botão, não o barco. Um silêncio
    // longo num jogo construído sobre relíquias viraria tempo morto.
    //
    // `atCaster` porque o grito sai DELE: a zona segura é longe, não em volta.
    atCaster: true,
    relic: { manaCost: 8, radius: 70, silenceMs: 2000, damagePct: 0.90, castMs: 1800 },
    npc:   { rangeMin: 0, rangeMax: 190, radius: 190, silenceMs: 2000, damageMult: 2.2, castTime: 1800, cooldown: 24000, weight: 5 },
  },
  alien_boss_cortex_mirror: {
    relicId: 'r53', name: 'Espelho do Córtex', icon: '🪞', rarity: 'épico',
    vfx: 'alien_boss_cortex_mirror', source: 'alien_boss', shape: 'circle', special: 'mirror',
    desc: 'O cérebro exposto LÊ o último golpe que você usou — e devolve na sua cara.',
    // ── `mirror`: o boss usa o seu próprio repertório ───────────────────────
    // O cérebro azul exposto no meio do peito pede uma skill sobre PENSAR, não
    // sobre bater. Esta é a única do jogo cujo efeito depende do que o alvo
    // andou fazendo: ele repete a última relíquia de bestiário que você lançou.
    //
    // Vira uma pressão de decisão que nenhuma outra exerce — a sua melhor skill
    // é também a que ele vai copiar. E se você ainda não usou nada de
    // bestiário, ele cai no golpe de reserva (`fallbackSkill`) em vez de perder
    // o turno, senão a skill puniria justamente quem chegou desarmado.
    relic: { manaCost: 6, radius: 55, damagePct: 0.55, castMs: 1200,
             fallbackSkill: 'alien_boss_face_choir' },
    npc:   { rangeMin: 0, rangeMax: 210, radius: 210, damageMult: 1.2, castTime: 1200, cooldown: 22000, weight: 5,
             fallbackSkill: 'alien_boss_face_choir' },
  },
  alien_boss_gut_drain: {
    relicId: 'r54', name: 'Sorvedouro Visceral', icon: '🩸', rarity: 'épico',
    vfx: 'alien_boss_gut_drain', source: 'alien_boss', shape: 'circle', special: 'drain',
    desc: 'Puxa todo mundo para a bocarra e CURA o lançador com parte do que drenou.',
    // `pullTo` fecha a distância e o `drain` devolve vida — o par é o que faz o
    // chefe se recuperar quando o grupo dispersa. `drainHealPct` só é lido pelo
    // motor da relíquia; no bicho a sucção sozinha já cumpre a leitura.
    relic: { manaCost: 7, radius: 80, damagePct: 1.20, castMs: 1500, drainHealPct: 0.45,
             cc: { pullTo: 26 } },
    npc:   { rangeMin: 0, rangeMax: 220, radius: 220, damageMult: 3.0, castTime: 1500, cooldown: 21000, weight: 5,
             drainHealPct: 0.45, cc: { pullTo: 70 } },
  },
  alien_boss_spine_volley: {
    relicId: 'r55', name: 'Salva de Espinhos', icon: '🦴', rarity: 'raro',
    vfx: 'alien_boss_spine_volley', source: 'alien_boss', shape: 'rays',
    desc: 'Coroa de raios girando em volta dele. Ande no MESMO sentido do giro para ficar na brecha.',
    // `rays` gira em volta de quem lançou (spinSpeed em rad/s) — o acerto
    // acompanha o desenho pelo crownSpin(). Poucos raios, brechas largas: a
    // skill é sobre andar junto com o giro, não sobre fugir dele.
    relic: { manaCost: 6, length: 95, angle: 26, rayCount: 5, spinSpeed: 1.15, castMs: 1200,
             ticks: { count: 14, intervalMs: 220, pct: 0.24 } },
    npc:   { rangeMin: 0, rangeMax: 230, length: 230, angle: 26, rayCount: 5, spinSpeed: 1.15, damageMult: 0.85, castTime: 1200, cooldown: 20000, weight: 5,
             ticks: { count: 14, intervalMs: 220 } },
  },
  alien_boss_void_collapse: {
    relicId: 'r56', name: 'Colapso do Vazio', icon: '🌌', rarity: 'lendário', star: true, // ⭐
    vfx: 'alien_boss_void_collapse', source: 'alien_boss', shape: 'ring',
    desc: 'O núcleo colapsa em 5 anéis que fecham para dentro. O último lugar seguro é onde ele está.',
    // Espelho da Marcha Fúnebre invertido: lá a arena aperta e ABRE no fim; aqui
    // ela fecha até o corpo do chefe, então a corrida é PARA DENTRO — e o miolo
    // seguro encolhe a cada leva. `safeRadius` pequeno de propósito: no fim só
    // cabe quem já está colado nele.
    relic: { manaCost: 10, radius: 130, safeRadius: 18, phaseCount: 5, damagePct: 1.80, castMs: 2400,
             ticks: { count: 10, intervalMs: 420, pct: 0.26 } },
    npc:   { rangeMin: 0, rangeMax: 340, radius: 340, safeRadius: 55, phaseCount: 5, damageMult: 5.5, castTime: 2400, cooldown: 30000, weight: 3,
             ticks: { count: 10, intervalMs: 420 } },
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // 12. ARAUTO DO ABISMO — mini-chefe da ARENA (mapa 11, zona vermelha PvP).
  //
  // É o único bicho do bestiário que luta num palco FECHADO (islandRadius 220,
  // leashRange 220) e com outros JOGADORES em volta se matando. Isso muda o que
  // faz sentido no conjunto: fugir para longe não é resposta, porque a arena
  // acaba; e qualquer coisa que prenda ou junte gente vale o dobro, porque
  // entrega a vítima para os outros players, não só para ele.
  //
  // Daí as três do usuário serem todas sobre POSIÇÃO e não sobre dano cru — o
  // que te mata na arena é ficar parado no lugar errado com plateia.
  // ═══════════════════════════════════════════════════════════════════════════
  abyss_judgment_pillars: {
    relicId: 'r57', name: 'Pilares do Juízo', icon: '🌩️', rarity: 'épico',
    vfx: 'abyss_judgment_pillars', source: 'arauto', shape: 'circle',
    // ── `targetMode`: a marcação nasce em CIMA de cada um, não num ponto ─────
    // Todo o resto do bestiário mira UM lugar e pergunta "quem está ali?". Esta
    // inverte: trava a posição de cada inimigo no alcance no instante do cast e
    // deixa cair uma coluna sobre cada uma delas. Não existe posição segura no
    // momento em que ela sai — existe a distância que dá para andar durante o
    // telegraph. Por isso o `castTime` é longo e o raio de cada pilar é pequeno:
    // a skill é um teste de reação, não de leitura de mapa.
    //
    // `maxTargets` é o teto de colunas simultâneas (o usuário pediu 8). Sem o
    // teto, uma arena cheia viraria uma coluna por jogador e o servidor mandaria
    // 20 telegraphs no mesmo frame.
    targetMode: 'all_players_in_range',
    desc: 'Uma coluna de luz cai do céu sobre CADA inimigo no alcance, até 8 de uma vez. Não tem para onde correr — tem quando.',
    // `seekRadius` é o alcance de BUSCA da relíquia (o bicho usa `rangeMax`, que
    // só existe do lado dele). Sem este número a versão do jogador cairia num
    // default e procuraria alvo num raio que ninguém escolheu.
    relic: { manaCost: 7, radius: 24, maxTargets: 4, seekRadius: 150, damagePct: 0.80, castMs: 1500 },
    npc:   { rangeMin: 0, rangeMax: 320, radius: 42, maxTargets: 8, damageMult: 2.6, castTime: 1600, cooldown: 17000, weight: 8 },
  },
  abyss_hunter_lights: {
    relicId: 'r58', name: 'Faróis de Carne', icon: '🕯️', rarity: 'épico',
    vfx: 'abyss_hunter_lights', source: 'arauto', shape: 'circle', special: 'lights',
    // ── `lights`: três projéteis TELEGUIADOS que imlodem ────────────────────
    // Lança `lightCount` luzes, uma por alvo. Elas VIAJAM atrás de quem foi
    // marcado — posição viva, não o ponto do lançamento — e implodem numa
    // explosão de luz quando alcançam (`catchRadius`) ou quando o tempo acaba
    // (`lifeMs`), onde quer que estejam.
    //
    // É a família da Orbe Caçadora, com a diferença que define as duas: a orbe é
    // UMA, corrói a cada leva e existe para te empurrar; estas são TRÊS, não
    // machucam enquanto voam e existem para dividir a atenção da sala. Numa
    // arena de PvP isso é o mais valioso — três pessoas correndo em direções
    // diferentes ao mesmo tempo desfaz qualquer formação.
    //
    // Velocidade menor que a do barco de propósito: dá para ganhar dos 5 s se
    // você correr em linha reta desde o começo. O preço é atravessar a arena
    // sem atirar, e é essa troca que a skill vende.
    desc: 'Lança 3 luzes que perseguem alvos diferentes. Cada uma implode numa explosão de luz ao alcançar — ou depois de 5 s, onde estiver.',
    relic: { manaCost: 6, lightCount: 3, lifeMs: 5000, lightSpeed: 40, catchRadius: 14,
             seekRadius: 150, radius: 34, damagePct: 0.95, castMs: 1000,
             cc: { slowPct: 0.25, slowMs: 1500 } },
    npc:   { rangeMin: 0, rangeMax: 300, lightCount: 3, lifeMs: 5000, lightSpeed: 62, catchRadius: 18,
             radius: 70, damageMult: 2.2, castTime: 1000, cooldown: 21000, weight: 6,
             cc: { slowPct: 0.25, slowMs: 1500 } },
  },
  abyss_earth_prison: {
    relicId: 'r59', name: 'Prisão de Terra', icon: '🧱', rarity: 'raro',
    vfx: 'abyss_earth_prison', source: 'arauto', shape: 'circle', special: 'prison',
    // ── `prison`: quatro paredes, sem brecha ────────────────────────────────
    // Prima da Jaula de Patas (`obstacles`), com a diferença que muda tudo: a
    // jaula é um anel de N pernas COM uma brecha sorteada, e existe para
    // empurrar você para um lado. Esta são 4 muros retos formando uma caixa
    // FECHADA em volta de um alvo — não tem saída para procurar.
    //
    // Bloqueio físico de verdade (wallManager, o mesmo do Muro de Pedra), então
    // ela não atordoa: você navega dentro da cela, atira de dentro dela, e
    // continua sendo alvo de todo mundo lá fora. Dano zero de propósito — o
    // preço é o tempo e a plateia, e somar dano a isso seria punir duas vezes.
    //
    // Os 30 s são o pedido para o BICHO, e só sobrevivem porque a cela é grande
    // o bastante para manobrar e o cooldown é o mais longo do conjunto. A
    // relíquia leva 6 s: 30 s de prisão num jogador em PvP não é uma skill, é um
    // castigo — e ninguém equiparia a segunda vez que levasse.
    // ── Cast CURTO de propósito ─────────────────────────────────────────────
    // 1,4 s davam tempo de sair da marcação navegando, e uma cela que se evita
    // com o leme não é uma cela — era só um susto com cooldown de 45 s. Em
    // 0,5 s ela PEGA, e é isso que a skill promete: a saída não é a proa, é
    // gastar um recurso (Teleporte r9 atravessa; o que quebra bloqueio, idem).
    //
    // O que segura o poder disso não é a esquiva, é o cooldown mais longo do
    // conjunto inteiro somado ao dano ZERO: você perde tempo, nunca o barco.
    desc: 'Quatro paredes de rocha sobem em volta de um alvo e o trancam quase sem aviso. Bloqueio físico real — dano nenhum, só tempo.',
    relic: { manaCost: 6, radius: 30, wallLength: 34, wallThickness: 5, holdMs: 6000, damagePct: 0, castMs: 500 },
    npc:   { rangeMin: 0, rangeMax: 260, radius: 46, wallLength: 52, wallThickness: 8, damageMult: 0, castTime: 500, cooldown: 45000, weight: 4,
             holdMs: 30000 },
  },
  abyss_lens_beam: {
    relicId: 'r61', name: 'Lente do Abismo', icon: '🔆', rarity: 'épico',
    vfx: 'abyss_lens_beam', source: 'arauto', shape: 'line',
    // ── Três fases, e a primeira é a única em que dá para reagir ────────────
    //   1. a LENTE se abre à frente do lançador e gira, carregando
    //   2. o raio dispara pelo corredor — rápido, reto, sem re-mira
    //   3. o fim do corredor irrompe (`eruptRadius`), e é lá que mais dói
    //
    // Não é canalizada (nada de `follow`): ela mira UMA vez, no fim do cast, e
    // solta. É o oposto do Jato do Pescoço e da Lança do Vazio, que perseguem
    // — aqui você não sai do eixo depois que saiu, você sai ANTES. Um chefe de
    // arena precisa de pelo menos um golpe que se leia pela geometria e não
    // pelo reflexo, senão o conjunto inteiro vira corrida.
    //
    // `eruptRadius` no fim faz o corredor ter um lugar PIOR que os outros: quem
    // está na linha leva, quem está no ponto final leva e ainda apanha da
    // irrupção. Dá ao jogador uma leitura de "para que lado eu saio" em vez de
    // só "saio".
    desc: 'A lente se abre, gira carregando e dispara um raio reto. O fim do corredor irrompe em lascas de luz.',
    relic: { manaCost: 6, length: 130, width: 26, eruptRadius: 32, damagePct: 1.10, castMs: 1300, travelMs: 180 },
    npc:   { rangeMin: 0, rangeMax: 280, length: 280, width: 46, eruptRadius: 60, damageMult: 2.9, castTime: 1400, cooldown: 15000, weight: 7,
             travelMs: 200 },
  },
  abyss_herald_embrace: {
    relicId: 'r60', name: 'Abraço do Arauto', icon: '🫂', rarity: 'lendário', star: true, // ⭐
    vfx: 'abyss_herald_embrace', source: 'arauto', shape: 'circle',
    // Os quatro braços são o que o modelo tem de mais próprio, e a leitura sai
    // deles: a área nasce NELE (`atCaster`), os braços disparam para fora e o
    // que era distância vira aglomeração. Puxa para o peito e PRENDE ali.
    //
    // Na arena isso não é só dano: quem foi arrastado aterrissa colado no chefe,
    // parado, com os outros jogadores por perto — a skill entrega a vítima para
    // a sala inteira. É o ⭐ do conjunto por isso, e não pelo número.
    atCaster: true,
    desc: 'Os quatro braços disparam, fisgam quem estiver por perto e ARRASTAM todo mundo para o peito dele — juntos, presos e no meio do estouro.',
    relic: { manaCost: 8, radius: 75, damagePct: 1.30, castMs: 1600,
             cc: { pullTo: 24, rootMs: 1400, slowPct: 0.30, slowMs: 2500 } },
    npc:   { rangeMin: 0, rangeMax: 210, radius: 210, damageMult: 3.4, castTime: 1700, cooldown: 26000, weight: 4,
             cc: { rootMs: 2200, slowPct: 0.30, slowMs: 3000 },
             effects: [{ type: 'pull', pullDistance: 46 }] },
  },
};

// ── Derivados ────────────────────────────────────────────────────────────────
// Uma passada só sobre a tabela gera as duas visões. Não escreva estas
// estruturas à mão: adicionar um ataque em MONSTER_SKILLS já propaga pros dois.

/** relicId → skillKey (ex.: 'r14' → 'crab_claw_slam'). */
const RELIC_TO_SKILL = {};
/** npc source → [relicId, ...] — o pool de drop DAQUELE bicho. */
const SKILLS_BY_SOURCE = {};
/** Entradas prontas para o RELIC_DEFS do jogo (effect genérico 'monster_skill'). */
const MONSTER_RELIC_DEFS = {};
/** Entradas prontas para o ATTACK_DEFS (versão usada pelo próprio bicho). */
const MONSTER_ATTACK_DEFS = {};
/** relicIds das ⭐ — o que o bicho guarda para a noite e só dropa à noite. */
const STAR_RELIC_IDS = new Set();

for (const [key, s] of Object.entries(MONSTER_SKILLS)) {
  RELIC_TO_SKILL[s.relicId] = key;
  (SKILLS_BY_SOURCE[s.source] ||= []).push(s.relicId);
  if (s.star) STAR_RELIC_IDS.add(s.relicId);

  MONSTER_RELIC_DEFS[s.relicId] = {
    name: s.name, icon: s.icon, rarity: s.rarity,
    effect: 'monster_skill',
    skill: key, vfx: s.vfx, shape: s.shape, special: s.special || null,
    follow: s.follow || false, dash: s.dash || false,
    wallPerStep: s.wallPerStep || false,
    rangeFromCannons: s.rangeFromCannons || false,
    toggle: false, targetMouse: true,
    // Informativo para a UI (moldura/tooltip da ⭐). O USO não é travado: quem
    // conquistou a relíquia usa de dia ou de noite.
    star: !!s.star,
    // Forma do espalhamento das sub-áreas (`multi`) — ver scatter().
    pattern: s.pattern || null, gapAngle: s.gapAngle || null,
    // Tempo de expansão de cada onda do Sonar. Mora no topo da skill (é forma,
    // não balanceamento por face) e por isso PRECISA ser copiado aqui — campo
    // no topo que ninguém copia some em silêncio e o simulador cai no default.
    expandMs: s.expandMs || null,
    atCaster: !!s.atCaster,
    travelMs: s.travelMs || null,
    dropIntervalMs: s.dropIntervalMs || null,
    dropWarnMs: s.dropWarnMs || null,
    turnRate: s.turnRate || null,
    // Multi-alvo (Pilares do Juízo): a skill resolve uma vez POR alvo travado no
    // cast, em vez de uma vez no ponto mirado. `maxTargets` vem de dentro do
    // `relic`/`npc` porque o teto é diferente nos dois lados.
    targetMode: s.targetMode || null,
    castTime: s.relic.castMs,
    ...s.relic,
  };

  MONSTER_ATTACK_DEFS[key] = {
    id: key, name: s.name,
    shape: s.shape, vfx: s.vfx, skill: key, special: s.special || null,
    follow: s.follow || false, dash: s.dash || false,
    wallPerStep: s.wallPerStep || false,
    rangeFromCannons: s.rangeFromCannons || false,
    // soak = dano dividido entre os atingidos — o attack-manager JÁ tem esse
    // rateio pronto (splitDamage, da Maré Partida); só apontamos pra ele.
    splitDamage: s.special === 'soak',
    // Só entra no sorteio de ataque do bicho durante a noite — ver
    // _getAvailable() em managers/attack-manager.js.
    star: !!s.star,
    // Forma do espalhamento das sub-áreas (`multi`) — ver scatter().
    pattern: s.pattern || null, gapAngle: s.gapAngle || null,
    expandMs: s.expandMs || null,          // ver a nota no MONSTER_RELIC_DEFS
    atCaster: !!s.atCaster,
    travelMs: s.travelMs || null,
    dropIntervalMs: s.dropIntervalMs || null,
    dropWarnMs: s.dropWarnMs || null,
    turnRate: s.turnRate || null,
    targetMode: s.targetMode || null,      // ver a nota no MONSTER_RELIC_DEFS
    telegraph: { color: 0xff4400 },
    ...s.npc,
  };
}

module.exports = {
  MONSTER_SKILLS, MONSTER_RELIC_DEFS, MONSTER_ATTACK_DEFS,
  RELIC_TO_SKILL, SKILLS_BY_SOURCE, STAR_RELIC_IDS,
};
