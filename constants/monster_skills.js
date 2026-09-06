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
// ── relicDisabled: a face JOGAVEL sai de cena, a do bicho fica ───────────────
// Uma skill pode funcionar bem na mao do monstro e nao funcionar na sua: a
// camera e outra, quem le o telegraph e outro, e algumas `special` nunca
// chegaram a ser implementadas do lado da reliquia. `relicDisabled: true`
// desliga SO a reliquia — o bicho continua usando o ataque normalmente.
//
// O que a flag faz, em ordem:
//   • o relicId sai do SKILLS_BY_SOURCE, entao o bicho para de dropa-la;
//   • `disabled: true` entra no RELIC_DEFS, e handleUseRelic() recusa o uso
//     ANTES de cobrar mana ou recarga (quem ja tem a reliquia nao a perde nem
//     gasta nada tentando);
//   • a UI mostra a moldura apagada e o motivo no tooltip.
// Ela NAO some do inventario de ninguem: desativar e reversivel, apagar nao.
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
    // `turnRate` dentro do `relic`: o cap de giro do JOGADOR e mais solto que o
    // do bicho (o cone e curto e largo, entao virar depressa nao vira acerto
    // garantido). Sem cap nenhum o cone SALTAVA para o cursor a cada leva —
    // e o que fazia o desenho e o dano discordarem para quem estava do outro
    // lado. 3,0 rad/s ainda deixa o alvo escapar contornando de perto.
    relic: { manaCost: 4, length: 70, angle: 55, castMs: 1000, turnRate: 3.0,
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
    // Cast pela METADE (era 2200): 2,2 s de carga para tres ondas que saem em
    // 0,36 s deixava o alvo sair andando antes da primeira — o telegraph era
    // mais longo que o golpe inteiro.
    relic: { manaCost: 6, radius: 60, castMs: 1100,
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
    // Mesmo remedio do Sopro: sem cap o cone re-mirava instantaneamente a cada
    // uma das 20 levas. Um pouco mais lento que o Sopro porque o cone e mais
    // estreito (45 graus) — a mesma velocidade de giro num cone fino vira
    // metralhadora teleguiada.
    relic: { manaCost: 6, length: 60, angle: 45, castMs: 1400, sweepTurns: 1.0, turnRate: 2.6,
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
    // ── CHUVA, não salva (a mesma lição do Cemitério de Naufrágios) ──────
    // Os seis obuses de uma vez fechavam um cerco: dava para ler o anel e
    // correr para a brecha UMA vez, e depois disso a salva tinha acabado. Cada
    // obus agora cai sozinho, `dropIntervalMs` depois do anterior, MIRADO em
    // onde o alvo está naquele instante — quem parou, come as seis. O `spread`
    // e o `pattern` continuam valendo para a face do BICHO, que mantém o anel.
    //
    // O raio caiu de 25 para 20 e o dano de 0,40 para 0,28: seis quedas miradas
    // acertam muito mais que um anel sorteado, então o pacote inteiro (1,68 de
    // poder de fogo se TUDO pegar) fica na mesma faixa do que era antes.
    // `dropWarnMs` 550 é medido: o barco anda ~45 un/s, ou seja ~25 un na janela
    // — mais que o raio de 20, então quem reage sai, e quem só olha, não. E ela
    // cabe dentro do `dropIntervalMs` de propósito: com aviso maior que o
    // intervalo, duas marcações ficam acesas ao mesmo tempo e a leitura de
    // "uma por vez" — que é o motivo inteiro da mudança — se perde.
    relic: { manaCost: 6, count: 6, spread: 30, radius: 20, damagePct: 0.28, castMs: 700,
             dropIntervalMs: 600, dropWarnMs: 550 },
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
    // Mesma vira da Salva de Morteiro: os cinco braços sobem UM DE CADA VEZ,
    // cada um em cima de onde o alvo está. O anel simultâneo continua do lado
    // do bicho (`spread`/`pattern` no `npc`).
    //
    // O root caiu de 2500 para 900 ms, e não é nerf gratuito: com queda mirada
    // em sequência, um root de 2,5 s prenderia o alvo debaixo dos três braços
    // seguintes — agarrou uma vez, agarrou até o fim, sem jogada nenhuma pelo
    // meio. Com 900 ms de agarrão num intervalo de 900 ms entre braços, quem
    // foi pego sai solto exatamente quando o próximo está sendo anunciado: dá
    // para escapar, mas só remando na hora certa.
    relic: { manaCost: 7, count: 5, spread: 24, radius: 22, damagePct: 0.24, castMs: 700,
             dropIntervalMs: 900, dropWarnMs: 700,
             cc: { rootMs: 900 } },
    npc:   { rangeMin: 0, rangeMax: 170, count: 5, spread: 45, radius: 32, damageMult: 1.0, castTime: 1500, cooldown: 18000, weight: 4,
             cc: { rootMs: 2500 } },
  },
  crab_boss_roar: {
    relicId: 'r21', name: 'Rugido Dilacerante', icon: '📢', rarity: 'épico', star: true, // ⭐
    vfx: 'crab_boss_roar', source: 'carangueijo_boss', shape: 'ring',
    desc: 'Anel que se expande com o MIOLO SEGURO. Dodge invertido: cole no centro.',
    relic: { manaCost: 8, radius: 90, safeRadius: 20, damagePct: 1.20, castMs: 1600 },
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
    // ── O veneno passou a EMPERRAR e a GRUDAR ──────────────────────────────
    // A poça só tirava vida enquanto o alvo estava em cima dela, e sair era de
    // graça: atravessar a coroa custava um tique e nada mais, então a parede
    // que a skill promete nunca chegou a ser parede.
    //   cc.slowPct  35% enquanto o casco estiver na bile — renovado a cada
    //               leva (ver `soRenovaSlow` no _applyCC), senão o slow morria
    //               na metade da duração das poças;
    //   dot         encostou, ficou ENVENENADO: 3 s de dano contínuo que
    //               continuam correndo fora da poça. É o que faz atravessar
    //               ser uma decisão em vez de um pedágio.
    relic: { manaCost: 5, count: 12, spread: 55, radius: 17, castMs: 1200, growth: 1.8,
             ticks: { count: 6, intervalMs: 800, pct: 0.12 },
             cc: { slowPct: 0.35, slowMs: 1200 },
             dot: { pct: 0.05, tickMs: 1000, durMs: 3000, effect: 'poison' } },
    npc:   { rangeMin: 0, rangeMax: 200, count: 12, spread: 110, radius: 34, damageMult: 0.6, castTime: 1200, cooldown: 30000, weight: 5,
             growth: 1.8, ticks: { count: 6, intervalMs: 800 } },
  },
  wyrm_abyss_coil: {
    relicId: 'r25', name: 'Espiral do Abismo', icon: '🌀', rarity: 'raro', star: true, // ⭐
    vfx: 'wyrm_abyss_coil', source: 'wrim', shape: 'ring',
    // ── `collapse`: as bolas são TANGÍVEIS e varrem para dentro ─────────────
    // O desenho sempre foi uma espiral de esferas fechando o cerco, e a
    // mecânica era um anel de dano que se desviava saindo dele. As duas coisas
    // não conversavam: o jogador via uma parede que se aproximava e a resposta
    // certa era atravessá-la, o que não faz sentido nenhum olhando a tela.
    //
    // Agora a parede empurra: a cada leva, quem estiver além do anel daquele
    // instante é EMPURRADO para dentro dele (ver _castCollapsingRing). Não dá
    // para sair pela borda — a saída é sobreviver ao aperto e estar longe do
    // miolo quando o centro entrar em erupção, que é onde o dano cheio cai.
    special: 'collapse', burstAtCenter: true,
    desc: 'As esferas fecham o cerco e EMPURRAM para dentro. No fim o miolo explode — aperte-se, mas não no centro.',
    relic: { manaCost: 7, radius: 95, safeRadius: 22, eruptRadius: 38, damagePct: 1.10, castMs: 2200,
             collapseTo: 34, phaseCount: 10,
             ticks: { count: 10, intervalMs: 220, pct: 0.10 } },
    // `damageMult` 3,2 → 0,30 e `burstMult` novo (2026-09-05). NÃO é um corte de
    // dificuldade: é o preço de o `collapse` passar a EXISTIR deste lado. Como
    // aro parado, o anel de raio 230 quase nunca encostava em ninguém e os
    // 3,2 × 10 levas eram teóricos; com a parede varrendo de verdade seriam 32×
    // o canhão do bicho num golpe só. A proporção segue a face da relíquia
    // (ticks 0,10 contra damagePct 1,10): o aperto é o preço, o miúlo é o golpe.
    // `atCaster`: o cerco fecha em volta do BICHO. Sem isto o aro nasce em cima
    // do jogador — ou seja, centrado em quem deveria estar fugindo dele: o
    // aperto nao aperta ninguém (você já está no meio) e o miúlo cai na sua
    // cabeça sem saída. Do lado da relíquia quem escolhe o centro é o cursor.
    npc:   { rangeMin: 0, rangeMax: 230, radius: 230, safeRadius: 60, eruptRadius: 95,
             atCaster: true, damageMult: 0.30, burstMult: 2.4, phaseCount: 10,
             castTime: 2200, cooldown: 20000, weight: 3,
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
    // Raio 60 (era 45) e 11 patas (eram 8): a 45 un a jaula cabia dentro de um
    // giro do barco e sair dela era andar reto por meio segundo. O numero de
    // patas sobe JUNTO com o raio — patas fixas num anel maior abrem vaos entre
    // elas, e a jaula deixaria de ser jaula por outro caminho. A brecha
    // anunciada (`gapAngle`) continua sendo a unica saida legitima.
    relic: { manaCost: 6, radius: 60, legCount: 11, gapAngle: 55, castMs: 1200, holdMs: 3500,
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
    // 1,6 rad/s do lado do jogador contra 0,60 do bicho: quem mira com o mouse
    // precisa de um feixe que responda, mas nao de um que GRUDE. Sem cap o
    // feixe saltava para o cursor a cada 120 ms e quem estava sendo varrido via
    // um raio parado no lugar onde o cast comecou.
    relic: { manaCost: 5, length: 75, width: 24, sweepArc: 80, turnSpeed: 0.9, castMs: 1200, turnRate: 1.6,
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
    relicId: 'r35', name: 'Cardume de Torpedos', icon: '🐟', rarity: 'épico',
    // ══ CONVERGIDA (2026-09-05) ═════════════════════════
    // Esta skill já foi duas: o bicho fazia a Salva de Bombordo (canhões do
    // casco em setores alternados) e a relíquia, os torpedos. A salva em
    // setores está no git — decisão do Luang de que o bestiario inteiro mostre
    // a MESMA skill que a relíquia dele entrega.
    //
    // A identidade agora mora toda no TOPO (nome, ícone, vfx, forma, special) e
    // os blocos `relic`/`npc` guardam só números. É assim que uma skill fica
    // igual nas duas mãos: divergir passa a exigir um override explícito.
    vfx: 'turtle_torpedo_swarm', source: 'tartaruga_boss', shape: 'circle',
    special: 'torpedo',
    // Sem `atCaster`: a âncora do desenho fica PLANTADA onde o cast começou.
    // Cada torpedo carrega a própria origem (o casco no instante do disparo), e
    // um quad que andasse junto arrastaria os torpedos em voo com ele.
    desc: 'Seis torpedos saem do casco em sequência e CURVAM até quem estiver à frente. Saia do cone, ou ganhe a corrida.',
    // ── Por que quase nunca acertavam (playtest 2026-09-04) ─────────────
    // O alvo era travado no DISPARO e o torpedo voava até aquele ponto FIXO. A
    // 45 un/s o alvo andava ~22 un no voo contra um estouro de raio 15: quem
    // navegava saia da explosão por construção, e só quem estava parado levava.
    // O conserto foi voo mais curto, raio maior e `homing` — na CHEGADA o
    // torpedo re-mira se o alvo continua dentro de `homingRadius` do ponto
    // anunciado. O cliente curva o desenho pelo MESMO critério, então o que se
    // vê e o que bate continuam sendo a mesma coisa.
    relic: {
      manaCost: 7, count: 6, radius: 22, length: 95, angle: 60,
      damagePct: 0.24, castMs: 400,
      salvoMs: 150, travelMs: 320, fanAngle: 40,
      homing: true, homingRadius: 55,
    },
    // Escala de bicho: cone e alcance maiores (ele mira de longe), voo um pouco
    // mais lento e raio de estouro proporcional. 6 × 1,05 = 6,3 se TUDO pegar —
    // a mesma exposição dos 6 × 1,1 da salva em setores que saiu daqui, com a
    // diferença de que esta dá para esquivar e aquela não dava.
    npc:   { rangeMin: 0, rangeMax: 240, count: 6, radius: 30, length: 200,
             angle: 70, fanAngle: 45, damageMult: 1.05,
             castTime: 1400, cooldown: 21000, weight: 3,
             salvoMs: 180, travelMs: 400, homing: true, homingRadius: 70 },
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // 7. DRAKE MARINHO — mob ágil/elétrico (mapa 2). Primeiro conjunto elétrico.
  // ═══════════════════════════════════════════════════════════════════════════
  drake_chain_arc: {
    relicId: 'r36', name: 'Rastilho de Raios', icon: '⚡', rarity: 'incomum',
    // ══ CONVERGIDA (2026-09-05) ═════════════════════════
    // O bicho fazia a Descarga em Cadeia (o raio pulando entre alvos próximos).
    // Cadeia é boa leitura de bicho e péssima de jogador — não há mira, o
    // servidor escolhe tudo — e por isso a relíquia virou rastilho. Agora o
    // bicho também arma a linha, e quem apanha responde do mesmo jeito que
    // responderia à própria relíquia: SAIA DE LADO, não para trás.
    vfx: 'drake_bolt_trail', source: 'cobra', shape: 'line',
    desc: 'Uma linha reta com seis raios caindo um após o outro, cada um um passo mais longe. Saia DE LADO.',
    // ── A forma: `line` com `stepCount` ───────────────────────────
    // O mesmo motor da Barragem Rolante: a cada leva o acerto é SÓ a faixa
    // daquele passo (`band` de espessura, `width` de largura lateral), a
    // `firstDistance + k×stepDistance` do casco. `ticks.count` TEM de bater com
    // `stepCount`, senão sobram passos sem raio — ou raios repetindo o último.
    //
    // O dano por raio parece alto, mas cada alvo costuma comer UM: as faixas
    // não se sobrepõem, então só quem correr AO LONGO da linha leva duas. É o
    // oposto de uma área que soma tudo.
    relic: {
      manaCost: 5, width: 26, band: 22, radius: 13,
      stepCount: 6, stepDistance: 17, firstDistance: 20, castMs: 500,
      cc: { slowPct: 0.25, slowMs: 1500 },
      ticks: { count: 6, intervalMs: 140, pct: 0.42 },
    },
    // Escala de bicho: 30 + 5×34 = 200 un de alcance, que é o próprio
    // `rangeMax`. 6 × 0,75 = 4,5 só para quem comer a linha inteira.
    npc:   { rangeMin: 0, rangeMax: 200, width: 40, band: 30, radius: 20,
             stepCount: 6, stepDistance: 34, firstDistance: 30,
             damageMult: 0.75, castTime: 1000, cooldown: 15000, weight: 5,
             cc: { slowPct: 0.30, slowMs: 1500 },
             ticks: { count: 6, intervalMs: 200 } },
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
    relicId: 'r38', name: 'Campo Voltaico', icon: '🌩️', rarity: 'raro',
    // ══ CONVERGIDA (2026-09-05) ═════════════════════════
    // O `special: 'static'` ("só pune quem se mexer") nunca chegou a existir em
    // motor nenhum: dos dois lados o campo resolvia como círculo comum, e a
    // promessa era só texto. Ele saiu do dado — um `special` que ninguém
    // implementa é pior que campo ausente, porque passa por implementado numa
    // auditoria e some em silêncio na execução.
    //
    // As duas faces são o CAMPO VOLTÁICO: um círculo que se arma em volta do
    // próprio casco e, no fim da carga, dispara uma descarga do casco para cada
    // um que ficou dentro. Defensiva por natureza (quem chega perto, paga) e a
    // leitura para o outro lado é só uma: saia do círculo a tempo.
    vfx: 'drake_voltaic_field', source: 'cobra', shape: 'circle',
    // `atCaster`: o laço de levas re-lê a posição de quem lançou, então o
    // círculo ACOMPANHA quem navega durante a carga em vez de ficar plantado.
    atCaster: true,
    desc: 'Um campo se arma em volta do casco e, no fim da carga, descarrega em todos que ficaram dentro. Saia a tempo.',
    // O desenho é o que há de novo: os arcos saem do casco até cada alvo
    // atingido, e quem os posiciona é a lista de `hits` do próprio golpe —
    // nada de adivinhação do lado do cliente.
    relic: {
      manaCost: 6, radius: 92, castMs: 1100, damagePct: 0.85,
      cc: { slowPct: 0.35, slowMs: 2000 },
    },
    // UMA leva, como a relíquia — e é essa a convergência que importa aqui: as
    // 8 levas antigas faziam do campo uma poça de permanência, que é o oposto
    // da carga única que a relíquia entrega. 2,6 num golpe contra os 0,8 × 8 de
    // antes: menos no total, e todo ele numa hora que dá para prever.
    npc:   { rangeMin: 0, rangeMax: 200, radius: 110, damageMult: 2.6,
             castTime: 1200, cooldown: 16000, weight: 5,
             cc: { slowPct: 0.35, slowMs: 2000 } },
  },
  drake_lightning_web: {
    relicId: 'r39', name: 'Tarrafa de Raios', icon: '🕸️', rarity: 'épico', star: true, // ⭐
    // ══ CONVERGIDA (2026-09-05) ═════════════════════════
    // O bicho fazia a Teia de Raios: seis nós ligados por feixes que trocavam
    // de par. Bonito de fora e impossível de cumprir — o `shape: 'circle'`
    // batia o disco inteiro, então "leia o grafo e ache a folga" nunca foi
    // verdade em motor nenhum, nem do lado do bicho.
    //
    // As duas faces são a TARRAFA: a rede cai do céu como um raio e PRENDE. Uma
    // skill de controle limpa, sem grafo para o motor ter de entender.
    vfx: 'drake_thunder_net', source: 'cobra', shape: 'circle',
    desc: 'A rede cai do céu como um raio e PRENDE quem ela cobrir. O dano é o de menos.',
    // A força não está no dano e sim nos segundos em que o alvo não navega. Por
    // isso o dano é baixo e o cast, longo o bastante para dar saída: um stun
    // sem janela de fuga seria a coisa mais forte do bestiario.
    relic: {
      manaCost: 6, radius: 54, damagePct: 0.85, castMs: 900,
      cc: { stunMs: 2000, slowPct: 0.30, slowMs: 2500 },
    },
    // Stun mais curto do lado do bicho (1,6 s contra 2 s) de propósito: perder
    // o barco é pior do que perder um alvo, e a cobra usa isto a cada 22 s.
    npc:   { rangeMin: 0, rangeMax: 230, radius: 70, damageMult: 2.2,
             castTime: 1400, cooldown: 22000, weight: 3,
             cc: { stunMs: 1600, slowPct: 0.30, slowMs: 2500 } },
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
    // `castMs` 1600 → 200: a barragem sai NO CLIQUE. Os cinco passos ja levam
    // 2,2 s para percorrer o corredor, e 1,6 s de carga por cima disso fazia a
    // skill demorar quatro segundos entre apertar e o ultimo passo cair. O
    // tempo de leitura continua existindo: e o proprio avanco, passo a passo.
    //
    // Por que 200 e nao 0: o cliente tem piso de 0,2 s de telegraph
    // (`maxf(cast_s, 0.2)` em _apply_monster_params). Com 0 aqui, a primeira
    // faixa BATERIA 200 ms antes de ser desenhada — dano vindo de lugar
    // nenhum. O numero casa com o piso do desenho de proposito.
    relic: { manaCost: 6, width: 80, band: 13, stepCount: 5, stepDistance: 20, firstDistance: 22, castMs: 200,
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
    relicId: 'r44', name: 'Crânio Faminto', icon: '💀', rarity: 'épico',
    // ══ CONVERGIDA (2026-09-05) ═════════════════════════
    // O chefe fazia a Sentença do Crânio: três carimbos que ANDAVAM com a
    // vítima e estouravam em 4 s onde ela estivesse. Era boa leitura de chefe
    // (quem apanha olha para o próprio barco e corre) e não pedia nada na mão do
    // jogador — marcar três e esperar quatro segundos não é jogada, é espera.
    //
    // As duas faces são o CRÂNIO FAMINTO: três crânios sobem do mar e CAÇAM.
    // O `special: 'mark'` saiu do jogo junto (está no git).
    vfx: 'charnel_skull_hunter', source: 'leviata_boss', shape: 'circle',
    special: 'summons', summonMode: 'hunt',
    // Nascem em volta do CASCO de quem lançou, não no ponto mirado. Numa skill
    // cuja graça é a perseguição, nascer longe troca a ameaça por um teste de
    // pontaria que a skill nem quer cobrar — saindo de baixo do casco, a mira
    // volta a ser só a DIREÇÃO da caçada.
    spawnAtCaster: true,
    desc: 'Três crânios sobem do mar e perseguem quem estiver mais perto por 5 s. Correr funciona — e quem foge não atira.',
    // `moveSpeed` fica ABAIXO dos ~45 un/s do barco em nenhum dos lados: eles
    // alcançam, mas devagar o bastante para dar três ou quatro segundos de
    // fuga. É aí que a skill cobra — no tempo em que você não está atirando.
    relic: {
      manaCost: 7, count: 3, radius: 24, damagePct: 0.55, castMs: 700,
      lifeMs: 5000, moveSpeed: 62, catchRadius: 16, spread: 26,
      summonTickMs: 160,
    },
    // 3 × 1,6 = 4,8 se as três alcançarem, contra os 3,0 de um carimbo só que
    // era inescapável. Mais teto, e agora existe resposta.
    npc:   { rangeMin: 0, rangeMax: 200, count: 3, radius: 34, damageMult: 1.6,
             castTime: 1000, cooldown: 20000, weight: 4,
             lifeMs: 5000, moveSpeed: 58, catchRadius: 18, spread: 34,
             summonTickMs: 160 },
  },
  charnel_brood_hatch: {
    relicId: 'r45', name: 'Ninhada à Espreita', icon: '🥚', rarity: 'raro',
    // ══ CONVERGIDA (2026-09-05) ═════════════════════════
    // O chefe punha cinco ovos com 6 s de chocagem, e o relógio decidia tudo. A
    // emboscada troca o relógio pela DECISÃO de quem passa: as crias nascem no
    // mar e dormem; quem chegar perto é que acorda a ninhada. Mesma fantasia,
    // pergunta outra. O `special: 'brood'` saiu do jogo junto (está no git).
    vfx: 'charnel_brood_ambush', source: 'leviata_boss', shape: 'circle',
    special: 'summons', summonMode: 'ambush',
    desc: 'Cinco crias nascem espalhadas e DORMEM. Quem passar perto acorda a ninhada — e aí elas são mais rápidas que o barco.',
    // `moveSpeed` acima do barco de propósito: acordou, alcançou. O que dá
    // saída é VER o ninho e contornar, não correr depois.
    relic: {
      manaCost: 6, count: 5, spread: 55, radius: 20, damagePct: 0.50, castMs: 800,
      lifeMs: 5000, moveSpeed: 78, catchRadius: 14, triggerRadius: 48,
      summonTickMs: 160,
    },
    // Espalhamento maior do lado do chefe (a arena é maior) e 5 × 1,1 = 5,5 de
    // teto — que na prática ninguém paga inteiro: acordar as cinco exigiria
    // passar por dentro do ninho todo.
    npc:   { rangeMin: 0, rangeMax: 200, count: 5, spread: 90, radius: 26,
             damageMult: 1.1, castTime: 1100, cooldown: 19000, weight: 4,
             lifeMs: 5000, moveSpeed: 74, catchRadius: 16, triggerRadius: 55,
             summonTickMs: 160 },
  },
  charnel_chain_bond: {
    relicId: 'r46', name: 'Escolta de Ossos', icon: '🦴', rarity: 'épico',
    // ══ CONVERGIDA (2026-09-05) ═════════════════════════
    // O `special: 'bond'` (acorrentar em pares, sangrar quem esticasse) nunca
    // teve implementação em motor nenhum, e a relíquia ficou desativada por isso
    // em 2026-08-22. Ela virou ESCOLTA; agora o chefe usa a mesma.
    //
    // É a única do bestiario sem alvo próprio: ela não abre uma jogada, ela
    // AMPLIFICA o que quem lançou já estava fazendo. Na mão do chefe isso vira
    // uma ameaça pendente — enquanto as caveiras estiverem em órbita, todo
    // golpe dele vale mais, e dá para ver isso antes de sentir.
    vfx: 'charnel_bone_escort', source: 'leviata_boss', shape: 'circle',
    special: 'summons', summonMode: 'escort',
    desc: 'Três caveiras ficam em órbita do casco e SALTAM juntas sempre que quem as invocou acerta alguma coisa.',
    // A janela (`durationMs`) só começa a contar no PRIMEIRO salto — guardar a
    // escolta para a briga certa é jogada, não desperdício.
    //
    // As três saltam JUNTAS, e o dano é o da SALVA inteira, não de cada caveira.
    // Antes cada acerto gastava uma, o que lia como "a skill está falhando":
    // você via três na órbita e só uma reagia. A recarga entre salvas existe
    // para uma bordada de quatro balas não gastar a skill inteira num piscar.
    relic: {
      manaCost: 7, count: 3, radius: 22, damagePct: 0.60, castMs: 400,
      durationMs: 10000, leapCooldownMs: 1500, orbitRadius: 26,
    },
    // Recarga maior do lado do chefe: os golpes dele acertam área, e a 1,5 s a
    // escolta sairia junto com cada leva de canalizada. ~5 salvas em 10 s.
    npc:   { rangeMin: 0, rangeMax: 140, count: 3, radius: 30, damageMult: 0.9,
             castTime: 900, cooldown: 22000, weight: 4,
             durationMs: 10000, leapCooldownMs: 1800, orbitRadius: 34 },
  },
  charnel_funeral_march: {
    relicId: 'r47', name: 'Marcha Fúnebre', icon: '⚰️', rarity: 'lendário', star: true, // ⭐
    vfx: 'charnel_funeral_march', source: 'leviata_boss', shape: 'ring',
    // Mesma família da Espiral (ver lá o porquê de `collapse`): os espinhos que
    // apertam a arena passaram a ser TANGÍVEIS — quem está fora do anel daquele
    // passo é empurrado para dentro. E a explosão central, que a descrição
    // sempre prometeu, existe: o `collapse` resolve o miolo com o dano cheio no
    // fim do último passo. Antes o `ring` só resolvia a coroa, e o centro — o
    // clímax do desenho — não batia em nada.
    special: 'collapse', burstAtCenter: true,
    desc: 'A arena aperta em 4 passos de espinho e no fim o MIOLO explode. Deixe-se apertar, e saia do centro no fim.',
    // `tangible`: os espinhos entram no wallManager e viram PAREDE de verdade,
    // replantados a cada passo. O empurrão por posição sozinho reposicionava uma
    // vez por leva e dava para remar de volta para fora no intervalo — a coroa
    // que a tela mostra fechando não segurava ninguém. Os dois se completam: o
    // empurrão é o aperto, a parede é o que impede de escapar dele.
    relic: { manaCost: 10, radius: 120, finalRadius: 30, collapseRadius: 45, phaseCount: 4, damagePct: 1.60, castMs: 2600,
             collapseTo: 30, tangible: true, spikeCount: 14,
             ticks: { count: 8, intervalMs: 500, pct: 0.18 } },
    // Mesma história da Espiral, e aqui foi onde o playtest bateu: o Carniceiro
    // apertava a arena no desenho e no dado, e não apertava nada no motor.
    // 5,0 × 8 levas era um número que só podia existir porque nenhuma pegava;
    // agora são 0,55 por leva e 4,0 no miúlo (≈ 8,4× no pior caso, na faixa da
    // Sobrecarga do Núcleo, que é a outra lendária de chefe).
    //
    // `tangible` aqui e NÃO na Espiral de propósito: a Marcha é a ⭐ do chefe
    // final e a arena fechando É a skill. Um mob de mapa aberto levantando 18
    // caixas de colisão a cada 20 s seria opressivo pelo motivo errado.
    npc:   { rangeMin: 0, rangeMax: 320, radius: 320, finalRadius: 80, collapseRadius: 120,
             atCaster: true, phaseCount: 4, damageMult: 0.55, burstMult: 4.0,
             tangible: true, spikeCount: 18,
             castTime: 2600, cooldown: 28000, weight: 2,
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
    // `radius` 32 → 58: era a razão de a relíquia "não fazer nada". O jogo
    // acontece na distância do canhão (80–120 un) e o barco tem raio ~14; para
    // a bocarra pegar alguém a 32 un era preciso estar praticamente encostado
    // no casco do bicho, o que quase nunca acontece — e quando não pegava
    // ninguém a skill terminava em SILÊNCIO, sem dano, sem aviso, sem nada.
    // 58 continua sendo o alcance mais curto do conjunto (é uma mordida), mas
    // agora é um alcance que existe.
    // ── `atCaster`: a bocarra E O PEITO de quem lança ────────────────────
    // Os DOIS motores sempre mediram a área a partir do LANÇADOR (o
    // `dist2D(npc, p)` do _runSwallow, o `player.x/player.z` do _castSwallow) —
    // e o dado não dizia isso a ninguém. Sem a marca, o cliente ancora círculo
    // no PONTO MIRADO: o desenho nascia em cima do alvo (onde ele estava no
    // instante do cast) enquanto o dano era medido do bicho. Dois círculos de
    // raio 75 a até 75 un um do outro — quase disjuntos. Era o "às vezes estou
    // dentro e não tomo dano, às vezes estou fora e tomo".
    //
    // Ancorada no lançador a área ainda ANDA com ele durante o cast, que é o
    // que a mordida precisa: o bicho fecha a distância enquanto escancara.
    atCaster: true,
    relic: { manaCost: 6, radius: 58, holdMs: 2000, spitDist: 55, castMs: 900,
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
    // 1,2 rad/s do lado do jogador (0,45 do lado do bicho): a lanca e o feixe
    // mais longo e grosso do jogo, entao gira mais devagar que o Jato — mas
    // ainda responde ao mouse. Sem cap ela colava no cursor a cada 200 ms e,
    // para quem estava do outro lado, ficava congelada no angulo do cast.
    relic: { manaCost: 8, length: 120, width: 30, castMs: 1400, turnRate: 1.2,
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
    relicId: 'r52', name: 'Coro dos Afogados', icon: '😱', rarity: 'lendário',
    // ══ CONVERGIDA (2026-09-05) ═════════════════════════
    // Os rostos humanos embutidos no corpo dele são o detalhe mais perturbador
    // do modelo, e são gente que ele comeu. A skill é essa gente gritando — e
    // agora ela SAI do casco em vez de só gritar de dentro dele.
    //
    // O `special: 'silence'` era a forma de resolução da face do chefe; virou
    // apenas o campo `silenceMs`, que é o que ele sempre foi: um debuff no
    // acerto, não um jeito de resolver área. O eixo continua no jogo — e agora
    // é cada rosto que encosta em você que o aplica.
    vfx: 'alien_face_volley', source: 'alien_boss', shape: 'circle',
    special: 'summons', summonMode: 'volley',
    desc: 'Cinco rostos se desprendem do casco e voam no alvo mais perto. Cada um pode atordoar — e, na boca do chefe, calar.',
    // O stun é SORTEIO por rosto e não garantia: cinco chances de 10% são ~41%
    // de pelo menos um, o que dá à skill um teto alto sem transformá-la em
    // controle confiável.
    relic: {
      manaCost: 8, count: 5, radius: 20, damagePct: 0.45, castMs: 700,
      lifeMs: 4000, moveSpeed: 88, catchRadius: 15, spread: 18,
      summonTickMs: 150, stunChance: 0.10, stunMs: 900,
    },
    // `silenceMs` só do lado do chefe, e curto: tirar o botão de quem apanha
    // muda a luta, mas NPC não usa relíquia — na mão do jogador o silêncio
    // seria uma linha de texto sem efeito. Você continua navegando e atirando de
    // canhão: perde o botão, não o barco.
    npc:   { rangeMin: 0, rangeMax: 190, count: 5, radius: 26, damageMult: 0.9,
             castTime: 1200, cooldown: 24000, weight: 5,
             lifeMs: 4000, moveSpeed: 84, catchRadius: 17, spread: 22,
             summonTickMs: 150, stunChance: 0.10, stunMs: 900,
             silenceMs: 1100 },
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
    // `length` 95 → 58: a coroa girava com raio de BICHO na mão do jogador e
    // cobria meia tela — não havia "andar junto com o giro", havia estar
    // dentro. 58 é quatro cascos de raio: as brechas passam a caber na tela e
    // a skill volta a ser sobre acompanhar o sentido do giro.
    relic: { manaCost: 6, length: 58, angle: 26, rayCount: 5, spinSpeed: 1.15, castMs: 1200,
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
    // `castMs` 1500 → 800 e `radius` 24 → 32. As posições são TRAVADAS no cast,
    // então o tempo de carga é exatamente a distância que o alvo tem para sair:
    // a 45 un/s, 1,5 s davam 67 un de fuga contra uma coluna de raio 24 —
    // nenhum NPC em movimento era atingido, nunca. Com 800 ms são 36 un, e a
    // coluna mais larga fecha o resto: quem reage escapa, quem está navegando
    // reto leva. Continua sendo teste de reação, só que com uma reação
    // possível de perder.
    relic: { manaCost: 7, radius: 32, maxTargets: 4, seekRadius: 150, damagePct: 0.80, castMs: 800 },
    // ── Cast 1600 → 950 (2026-09-06) ─────────────────────────────
    // As colunas TRAVAM a posição no cast (`targetMode`), então o cast É a
    // distância de fuga. A 45 un/s, 1,6 s davam 72 un contra um raio de 42:
    // 30 un de sobra — quem já estava navegando saia sem nem perceber. Em 950 ms
    // a conta fecha em ~43 un, colada no raio: sair passa a exigir estar indo
    // para o lado certo. Mesmo número que a face da relíquia levou no playtest.
    npc:   { rangeMin: 0, rangeMax: 320, radius: 42, maxTargets: 8, damageMult: 2.6, castTime: 950, cooldown: 17000, weight: 8 },
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
    // `radius` 60 (era 34): o número é o raio da IMPLOSÃO, e o desenho é medido
    // por ele — a versão do jogador saía com metade do estouro do bicho (70) e
    // lia como um faísca, não como uma luz de carne implodindo. Subir o raio
    // também abre a área de dano, que é o preço de fazer o efeito valer o que
    // o desenho promete; não foi para 70 porque a relíquia lança TRÊS e o bicho
    // acerta uma sala inteira de uma vez.
    relic: { manaCost: 6, lightCount: 3, lifeMs: 5000, lightSpeed: 40, catchRadius: 14,
             seekRadius: 150, radius: 60, damagePct: 0.95, castMs: 1000,
             cc: { slowPct: 0.25, slowMs: 1500 } },
    npc:   { rangeMin: 0, rangeMax: 300, lightCount: 3, lifeMs: 5000, lightSpeed: 62, catchRadius: 18,
             // Cast 1000 → 800 (2026-09-06): aqui o cast nunca foi a esquiva —
             // as luzes PERSEGUEM depois dele. Encurtar é só ritmo, para o
             // arauto parar de passar mais tempo carregando que atacando.
             radius: 70, damageMult: 2.2, castTime: 800, cooldown: 21000, weight: 6,
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
    // ── Duas faces, dois ritmos ─────────────────────────────────────────────
    // NA MÃO DO BICHO ela NÃO é canalizada (o `follow` mora dentro de `relic`,
    // não aqui em cima): mira uma vez no fim do cast e solta. Um chefe de arena
    // precisa de pelo menos um golpe que se leia pela geometria e não pelo
    // reflexo, senão o conjunto inteiro vira corrida.
    //
    // NA MÃO DO JOGADOR ela é o oposto: a lente ACOMPANHA o cursor e o corredor
    // machuca leva a leva enquanto dura. É a família do Jato do Pescoço — quem
    // segura o alvo dentro do feixe leva o dano cheio, quem só o cruza leva uma
    // leva ou duas. A troca é honesta nos dois lados: o bicho cobra leitura de
    // mapa, o jogador cobra mira contínua.
    //
    // `eruptRadius` no fim faz o corredor ter um lugar PIOR que os outros: quem
    // está na linha leva, quem está no ponto final leva e ainda apanha da
    // irrupção. Dá ao jogador uma leitura de "para que lado eu saio" em vez de
    // só "saio".
    desc: 'A lente se abre, gira carregando e dispara um raio reto. O fim do corredor irrompe em lascas de luz.',
    // `follow`/`ticks` só aqui dentro: o spread de `relic` vem DEPOIS do
    // `follow: s.follow || false` no montador dos defs (ver o fim do arquivo),
    // então este campo sobrescreve o de cima sem tocar na versão do bicho.
    //
    // 10 levas × 0,15 = 1,50 do poder de fogo se o alvo ficar no corredor as
    // 1,35 s inteiras (era 1,10 num golpe só). O teto subiu porque agora tem
    // como errar: antes bastava acertar o instante do disparo.
    //
    // `width` 26 → 34: num corredor que você dirige com o mouse, 13 un de folga
    // para cada lado é menos que o erro de mão em movimento — era a mesma
    // queixa que engrossou o Jato do Pescoço.
    // `burstPct`: a PANCADA de abertura, no instante em que o raio encosta. Sem
    // ela o `damagePct` do dado era letra morta — numa canalizada o `ticks.pct`
    // substitui o dano cheio em todas as levas, inclusive a primeira, e a Lente
    // lia como dez cutucões. Agora são duas camadas: 0,55 ao acertar + 10 × 0,15
    // enquanto o alvo ficar no corredor (teto de 2,05 se ele não sair nunca).
    relic: { manaCost: 6, length: 130, width: 34, eruptRadius: 32, damagePct: 1.10,
             burstPct: 0.55,
             castMs: 1300, travelMs: 180, follow: true,
             ticks: { count: 10, intervalMs: 150, pct: 0.15 } },
    // ── Cast 1400 → 900 (2026-09-06) ─────────────────────────────
    // Era a mais fácil de todas, e o comprimento enganava: de um corredor
    // ninguém escapa correndo 280 un para a frente — escapa andando 23 (meia
    // largura) DE LADO. 23 un custam 511 ms; o cast dava 1400. Quase 900 ms de
    // sobra pura. Em 900 sobram ~390, que é tempo de ver e virar, não de passear.
    npc:   { rangeMin: 0, rangeMax: 280, length: 280, width: 46, eruptRadius: 60, damageMult: 2.9, castTime: 900, cooldown: 15000, weight: 7,
             travelMs: 200 },
  },
  abyss_herald_embrace: {
    relicId: 'r60', name: 'Tromba do Arauto', icon: '🌪️', rarity: 'lendário', star: true, // ⭐
    // ══ CONVERGIDA (2026-09-05) ═════════════════════════
    // O Abraço era uma leitura de ARENA: os quatro braços fisgavam todo mundo
    // por perto e arrastavam para o peito dele, entregando a vítima para a sala
    // inteira. Isso só vale quando existe sala — no mundo aberto, na mão do
    // jogador, era um puxa-e-bate como vários outros. As duas faces agora são a
    // TROMBA. O abraço está no git.
    //
    // Reaproveita o motor da Orbe Caçadora com uma diferença que muda tudo:
    // `sticky`. A orbe estoura ao alcançar; a tromba GRUDA e continua moendo até
    // a vida dela acabar, e só aí estoura. Sem isso, "segue o alvo dando dano
    // por tique" seria uma promessa de um tique só.
    vfx: 'abyss_herald_twister', source: 'arauto', shape: 'circle',
    special: 'orb', sticky: true,
    // Sem `atCaster`: ela VIAJA. Presa ao casco, o desenho seria arrastado
    // junto com quem lançou em vez de perseguir.
    desc: 'Uma tromba d\'água persegue o alvo, gruda nele e mói até se desfazer. Dá para sair — e sair é a jogada.',
    relic: {
      manaCost: 9, radius: 46, catchRadius: 12, orbSpeed: 36,
      lifeMs: 6000, orbTickMs: 400, orbTickPct: 0.14, damagePct: 1.10,
      castMs: 1200,
      cc: { slowPct: 0.40, slowMs: 1400 },
    },
    // `orbSpeed` abaixo dos ~45 un/s do barco nos dois lados: ela alcança quem
    // parar ou for lento, e perde de quem decidir remar. O slow é o que torna
    // essa decisão difícil — e é por ele que ela é a ⭐ do conjunto, não pelo
    // número. 15 levas × (2,4 × 0,14) + estouro ≈ 7,4 para quem ficar os 6 s.
    npc:   { rangeMin: 0, rangeMax: 210, radius: 60, catchRadius: 14,
             orbSpeed: 34, lifeMs: 6000, orbTickMs: 400, orbTickPct: 0.14,
             // Cast 1400 → 1150 (2026-09-06). Mesma história das luzes: a
             // tromba GRUDA e persegue, então quem decide se você escapa é a
             // corrida (34 un/s dela contra 45 do barco), não o aviso.
             damageMult: 2.4, castTime: 1150, cooldown: 26000, weight: 4,
             cc: { slowPct: 0.40, slowMs: 1400 } },
  },
};

// ── Derivados ────────────────────────────────────────────────────────────────
// Uma passada só sobre a tabela gera as duas visões. Não escreva estas
// estruturas à mão: adicionar um ataque em MONSTER_SKILLS já propaga pros dois.

/** npc source → [relicId, ...] — o pool de drop DAQUELE bicho. */
const SKILLS_BY_SOURCE = {};
/** Entradas prontas para o RELIC_DEFS do jogo (effect genérico 'monster_skill'). */
const MONSTER_RELIC_DEFS = {};
/** Entradas prontas para o ATTACK_DEFS (versão usada pelo próprio bicho). */
const MONSTER_ATTACK_DEFS = {};
/**
 * As relíquias do bestiario que o PET pode usar.
 *
 * O critério não é gosto: o servidor NÃO SABE ONDE O PET ESTÁ (a posição dele é
 * do cliente — ver a nota do `_petDist` no pet-manager). Então só entra o que
 * resolve numa ÁREA APONTADA e não depende de onde o lançador está. Ficam de
 * fora, por construção:
 *
 *   cone / line / rays  — nascem no casco: sairiam do NAVIO, não do bicho
 *   `follow`            — re-mira no cursor, e o pet não tem mouse
 *   `atCaster`          — idem: a área é em volta de quem lança
 *   `dash`              — desloca o lançador
 *   `targetMode`        — mira todos no alcance; a mira é do pet, não do dono
 *   escolta / bulwark / mirror / drain / manaburn — dependem do DONO
 *   sem dano            — prisão e jaula: o pet não teria o que decidir
 *
 * O que VOA do casco até o alvo (faróis, crânios, ninhada) fica: é o mesmo
 * compromisso que o Foguete Naval já faz hoje na mão do pet — sai do navio e
 * acerta onde o pet mandou.
 *
 * `petRange` é 'medio' em todas de propósito. 'longo' está reservado ao trio de
 * artilharia que já o tinha (foguete e meteoro): dar alcance longo a vinte
 * relíquias faria o pet abrir briga sozinho, que é o oposto de suporte.
 */
//
// A r48 (Bocarra Torácica) SAIU em 2026-09-06: ela sempre resolveu em volta do
// LANÇADOR, e como o servidor não sabe onde o pet está, quem mandava o bicho
// abrir o peito via a bocarra abrir no PRÓPRIO casco. Ela passava no guarda
// abaixo só porque o dado não declarava o `atCaster` que o motor já praticava.
const PET_RELIC_IDS = new Set([
  'r17', 'r19', 'r20', 'r21', 'r24', 'r25', 'r27', 'r29', 'r33', 'r39',
  'r41', 'r42', 'r43', 'r44', 'r45', 'r47', 'r49', 'r56', 'r58',
]);

/** relicIds das ⭐ — o que o bicho guarda para a noite e só dropa à noite. */
const STAR_RELIC_IDS = new Set();

for (const [key, s] of Object.entries(MONSTER_SKILLS)) {
  // Reliquia desativada nao entra no pool de drop do bicho — continuar
  // sorteando uma recompensa que nao pode ser usada seria pior que nao dropar
  // nada, porque ela ainda ocuparia a vaga de um drop bom.
  if (!s.relicDisabled) (SKILLS_BY_SOURCE[s.source] ||= []).push(s.relicId);
  if (s.star) STAR_RELIC_IDS.add(s.relicId);

  MONSTER_RELIC_DEFS[s.relicId] = {
    name: s.name, icon: s.icon, rarity: s.rarity,
    effect: 'monster_skill',
    // Ver `relicDisabled` no cabecalho: so a face jogavel e desligada.
    disabled: !!s.relicDisabled,
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
    // O anel que EMPURRA (Espiral, Marcha) — ver _castCollapsingRing.
    burstAtCenter: !!s.burstAtCenter,
    travelMs: s.travelMs || null,
    dropIntervalMs: s.dropIntervalMs || null,
    dropWarnMs: s.dropWarnMs || null,
    turnRate: s.turnRate || null,
    // Multi-alvo (Pilares do Juízo): a skill resolve uma vez POR alvo travado no
    // cast, em vez de uma vez no ponto mirado. `maxTargets` vem de dentro do
    // `relic`/`npc` porque o teto é diferente nos dois lados.
    targetMode: s.targetMode || null,
    // ── Invocações e perseguição ───────────────────────────────────
    // `summonMode` escolhe qual das quatro leituras (hunt/ambush/volley/escort),
    // `spawnAtCaster` diz se as criaturas nascem no casco, `sticky` faz a orbe
    // GRUDAR no alvo em vez de estourar ao alcançar. Os três moram no topo da
    // skill (são forma, não balanço) e por isso PRECISAM ser copiados nos dois
    // builders — campo do topo que só um lado copia some em silêncio, e o outro
    // cai no default: as quatro invocações viravam 'hunt' e a tromba parava de
    // grudar, sem erro nenhum. Ver o guarda em npc-special-parity.test.js.
    summonMode: s.summonMode || null,
    spawnAtCaster: !!s.spawnAtCaster,
    sticky: !!s.sticky,
    castTime: s.relic.castMs,
    // Pet: ver PET_RELIC_IDS acima. Fica ANTES do spread para uma skill poder
    // sobrescrever — e depois do resto porque nada mais mexe nesses campos.
    petUsable: PET_RELIC_IDS.has(s.relicId),
    petTarget: PET_RELIC_IDS.has(s.relicId) ? 'inimigo' : undefined,
    petRange:  PET_RELIC_IDS.has(s.relicId) ? 'medio' : undefined,
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
    // O miúlo do anel que aperta. Estava SO no MONSTER_RELIC_DEFS: a face do
    // bicho declarava `collapse` e `collapseRadius` e não levava a flag que
    // manda o centro explodir, então mesmo depois de o motor ganhar o branch a
    // Marcha Fúnebre pararia no último passo do aperto. Campo do TOPO da skill
    // (é forma, não balanço) e por isso precisa ser copiado nos DOIS lados.
    // ── Invocações e perseguição ───────────────────────────────────
    // `summonMode` escolhe qual das quatro leituras (hunt/ambush/volley/escort),
    // `spawnAtCaster` diz se as criaturas nascem no casco, `sticky` faz a orbe
    // GRUDAR no alvo em vez de estourar ao alcançar. Os três moram no topo da
    // skill (são forma, não balanço) e por isso PRECISAM ser copiados nos dois
    // builders — campo do topo que só um lado copia some em silêncio, e o outro
    // cai no default: as quatro invocações viravam 'hunt' e a tromba parava de
    // grudar, sem erro nenhum. Ver o guarda em npc-special-parity.test.js.
    summonMode: s.summonMode || null,
    spawnAtCaster: !!s.spawnAtCaster,
    sticky: !!s.sticky,
    burstAtCenter: !!s.burstAtCenter,
    telegraph: { color: 0xff4400 },
    ...s.npc,
  };
}

module.exports = {
  MONSTER_SKILLS, MONSTER_RELIC_DEFS, MONSTER_ATTACK_DEFS,
  SKILLS_BY_SOURCE, STAR_RELIC_IDS, PET_RELIC_IDS,
};
