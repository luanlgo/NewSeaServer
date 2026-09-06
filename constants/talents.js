// constants/talents.js — Árvores de Talentos (Ataque / Defesa / Recurso)
//
// ── Formato ───────────────────────────────────────────────────────────────────
// 3 árvores × 40 talentos × 10 níveis. Cada árvore ocupa um setor de 120° na UI
// radial do cliente; os 40 nós se espalham em 6 anéis concêntricos:
//
//     anel  0    1    2    3    4    5
//     nós   4    5    6    7    8    10    (= 40)
//     gate  0    10   25   45   70   100   (pontos gastos NAQUELA árvore)
//
// A posição vem da ORDEM DO ARRAY: os 4 primeiros talentos da lista ocupam o
// anel 0, os 5 seguintes o anel 1, e assim por diante. Reordenar a lista move os
// nós na tela — é assim que se rebalanceia a árvore, sem ring/slot à mão.
//
// O cliente liga cada nó ao vizinho angularmente mais próximo do anel anterior.
// Não há lista de arestas: a regra é determinística e vale nos dois lados.
//
// ── Campos de um talento ──────────────────────────────────────────────────────
//   id        chave única (prefixo atk_/def_/res_) — é o que vai no DB
//   icon      emoji de fallback
//   stat      chave que o servidor agrega em player.tal[stat]
//   perLevel  valor somado por nível, JÁ na unidade exibida
//             (unit 'pct' → pontos percentuais; 'flat' → valor bruto)
//   unit      'pct' | 'redpct' (mostrado com −) | 'flat' | 'chance'
//   wired     true = o efeito já está aplicado no servidor hoje. A tradução de
//             stat → multiplicador vive em utils/talent-effects.js; os pontos
//             de aplicação estão em projectile-manager (dano), player-manager
//             (movimento e regen), npc-manager (percepção) e server.js
//             (relíquias, mana, espólio).
//             Os que continuam false dependem de sistemas que o jogo ainda não
//             tem — recarga de relíquia, dash do jogador, dano de colisão,
//             esteira, correnteza, juros do banco — ou de handlers de economia
//             que ainda não passam pelos talentos. O painel marca esses com
//             "⚙ Efeito ainda não aplicado".
//   name/desc texto em PT — o cliente usa I18n (tal.<id>.name / .desc), isto
//             aqui serve para mensagens do servidor e para leitura do arquivo.

'use strict';

// ── Árvores ───────────────────────────────────────────────────────────────────
// angle = ângulo CENTRAL do setor em graus (0° = direita, cresce no sentido
// horário na tela porque Y cresce para baixo). Ataque no topo, as outras duas
// abrindo para baixo.
const TREE_ORDER  = ['ataque', 'defesa', 'recurso'];
const RING_COUNTS = [4, 5, 6, 7, 8, 10];
const RING_GATE   = [0, 10, 25, 45, 70, 100];
const TALENT_MAX  = 10;
const TREE_SIZE   = RING_COUNTS.reduce((a, b) => a + b, 0);   // 40

// ── ATAQUE ────────────────────────────────────────────────────────────────────
// Dano, crítico, cadência — e o que serve para ALCANÇAR o alvo, que veio da
// antiga árvore de Mobilidade (perseguição, arrancada, investida, impulso).
const TREE_ATAQUE = [
  // ── anel 0 ── fundamentos
  { id: 'atk_artilharia',  icon: '🎯', stat: 'damage_pct',            perLevel: 2,   unit: 'pct',    wired: true,
    name: 'Artilharia Pesada',      desc: '+2% de dano de canhão por nível.' },
  { id: 'atk_focoarcano',  icon: '✨', stat: 'relic_damage_pct',      perLevel: 2,   unit: 'pct',    wired: true,
    name: 'Foco Arcano',            desc: '+2% de dano de relíquia por nível.' },
  { id: 'atk_olhoaguia',   icon: '👁', stat: 'crit_chance',           perLevel: 1,   unit: 'chance', wired: true,
    name: 'Olho de Águia',          desc: '+1% de chance de acerto crítico por nível.' },
  { id: 'atk_perseguicao', icon: '🐆', stat: 'speed_in_combat_pct',   perLevel: 0.5, unit: 'pct', wired: true,
    name: 'Perseguição',            desc: '+0,5% de velocidade em combate, por nível.' },

  // ── anel 1 ──
  // ── Dano crítico: 0,5%/nível nos DOIS nós ─────────────────────────────────
  // Este e o Sangue Frio somavam +80% em cima de um golpe que já valia o dobro
  // — o crítico virava a única coisa que importava na construção. Agora os dois
  // juntos entregam +10% no talento cheio, que é tempero e não o prato.
  { id: 'atk_golpecerteiro', icon: '💥', stat: 'crit_damage_pct',     perLevel: 0.5, unit: 'pct', wired: true,
    name: 'Golpe Certeiro',         desc: '+0,5% de dano crítico por nível.' },
  { id: 'atk_bateria',       icon: '💣', stat: 'cannon_slots',        perLevel: 1,   unit: 'flat',   wired: true,
    name: 'Bateria Extra',          desc: '+1 slot de canhão por nível.' },
  { id: 'atk_perfurante',    icon: '🔩', stat: 'armor_pen_pct',       perLevel: 1.5, unit: 'pct', wired: true,
    name: 'Bala Perfurante',        desc: 'Ignora 1,5% da defesa do alvo por nível.' },
  { id: 'atk_cacafera',      icon: '🐙', stat: 'damage_vs_npc_pct',   perLevel: 2,   unit: 'pct', wired: true,
    name: 'Caçador de Feras',       desc: '+2% de dano contra criaturas por nível.' },
  { id: 'atk_arrancada',     icon: '💨', stat: 'burst_speed_pct',     perLevel: 0.5, unit: 'pct', wired: true,
    name: 'Arrancada',              desc: '+0,5% de velocidade nos 3s após sair da imobilidade, por nível.' },

  // ── anel 2 ──
  { id: 'atk_corsario',    icon: '🏴', stat: 'damage_vs_player_pct',  perLevel: 2,   unit: 'pct', wired: true,
    name: 'Corsário',               desc: '+2% de dano contra jogadores por nível.' },
  { id: 'atk_colosso',     icon: '💀', stat: 'damage_vs_boss_pct',    perLevel: 2.5, unit: 'pct', wired: true,
    name: 'Matador de Colossos',    desc: '+2,5% de dano contra chefes por nível.' },
  { id: 'atk_polvoraseca', icon: '🔥', stat: 'reload_pct',            perLevel: 1.5, unit: 'redpct', wired: true,
    name: 'Pólvora Seca',           desc: '−1,5% no tempo de recarga dos canhões por nível.' },
  { id: 'atk_municao',     icon: '📦', stat: 'ammo_damage_pct',       perLevel: 2,   unit: 'pct', wired: true,
    name: 'Munição Aprimorada',     desc: '+2% de dano da munição especial por nível.' },
  { id: 'atk_salva',       icon: '🚢', stat: 'salvo_damage_pct',      perLevel: 2,   unit: 'pct', wired: true,
    name: 'Salva Cerrada',          desc: '+2% de dano quando dispara a salva completa, por nível.' },
  { id: 'atk_bracolongo',  icon: '🫳', stat: 'relic_range_pct',       perLevel: 2,   unit: 'pct', wired: true,
    name: 'Braço Longo',            desc: '+2% de alcance das relíquias por nível.' },

  // ── anel 3 ──
  { id: 'atk_incendiario',  icon: '🛢', stat: 'burn_pct',             perLevel: 0.5, unit: 'pct', wired: true,
    name: 'Óleo Incendiário',       desc: 'Acertos queimam o alvo por 3s, causando 0,5% do dano por nível.' },
  { id: 'atk_misericordia', icon: '⚰', stat: 'execute_pct',          perLevel: 3,   unit: 'pct', wired: true,
    name: 'Golpe de Misericórdia',  desc: '+3% de dano contra alvos abaixo de 30% de vida, por nível.' },
  { id: 'atk_emboscada',    icon: '🎭', stat: 'opener_pct',           perLevel: 4,   unit: 'pct', wired: true,
    name: 'Emboscada',              desc: '+4% de dano no primeiro acerto em um alvo, por nível.' },
  { id: 'atk_estilhaco',    icon: '💫', stat: 'aoe_damage_pct',       perLevel: 3,   unit: 'pct',
    name: 'Estilhaço',              desc: '+3% de dano em área das relíquias por nível.' },
  { id: 'atk_vidente',      icon: '🔮', stat: 'relic_crit_chance',    perLevel: 2,   unit: 'chance', wired: true,
    name: 'Vidente',                desc: '+2% de chance de crítico de relíquia por nível.' },
  { id: 'atk_conjuracao',   icon: '⚡', stat: 'relic_cast_pct',       perLevel: 2,   unit: 'redpct', wired: true,
    name: 'Conjuração Ágil',        desc: '−2% no tempo de conjuração das relíquias, por nível.' },
  // Era "Investida" (+4% de dano de COLISÃO) e nunca teve efeito: o jogo não
  // simula dano de aríete. Virou o segundo nó de perfuração a pedido do
  // playtest — "a defesa está muito forte" —, e é por isso que ele tem stat
  // PRÓPRIO (`armor_pen_pct_2`) em vez de somar no do Bala Perfurante: o painel
  // mostra um número por stat, e dois nós no mesmo stat viram um só na leitura.
  // O `id` fica: é o que está gravado no DB de quem já comprou o nó.
  { id: 'atk_investida',    icon: '🗡', stat: 'armor_pen_pct_2',      perLevel: 2,   unit: 'pct', wired: true,
    name: 'Ponta de Aço',           desc: 'Ignora mais 2% da defesa do alvo por nível.' },

  // ── anel 4 ──
  // Frenesi e Carnificina são os dois talentos de acúmulo. Nenhum dos dois tem
  // relógio: as pilhas duram ENQUANTO o combate durar e caem juntas quando ele
  // acaba. Um enche rápido acertando, o outro paga alto por abate.
  { id: 'atk_frenesi',       icon: '😤', stat: 'frenzy_pct',          perLevel: 1,   unit: 'pct', wired: true,
    name: 'Frenesi de Batalha',     desc: 'Cada acerto dá +1% de dano por nível, acumulando até 5 vezes. Zera ao sair de combate.' },
  // Ver a nota no Golpe Certeiro: os dois nós de dano crítico somam +10%.
  { id: 'atk_sanguefrio',    icon: '🧊', stat: 'crit_damage_high_hp', perLevel: 0.5, unit: 'pct', wired: true,
    name: 'Sangue Frio',            desc: '+0,5% de dano crítico com a vida acima de 80%, por nível.' },
  { id: 'atk_ultimorecurso', icon: '🩸', stat: 'damage_low_hp_pct',   perLevel: 4,   unit: 'pct', wired: true,
    name: 'Último Recurso',         desc: '+4% de dano com a vida abaixo de 30%, por nível.' },
  // ── Rasga-Velame: o nó que era alcance ─────────────────────────────────
  // Nasceu como "+2% de alcance de canhão por nível" e o alcance é exatamente o
  // eixo que este jogo NÃO quer esticar: mais alcance não muda a briga, só
  // afasta os dois barcos até o combate virar troca de tiros de longe.
  //
  // O `id` ficou: ele é o que está gravado no DB de quem já comprou o nó, e
  // trocar a chave apagaria os níveis pagos. O que mudou foi o STAT.
  { id: 'atk_miralonga',     icon: '⛓', stat: 'slow_on_hit_pct',     perLevel: 1,   unit: 'pct', wired: true,
    name: 'Rasga-Velame',           desc: 'Cada acerto de canhão deixa o alvo 1% mais lento por nível, durante 2s.' },
  { id: 'atk_abordagem',     icon: '⚓', stat: 'damage_close_pct',    perLevel: 3,   unit: 'pct', wired: true,
    name: 'Abordagem',              desc: '+3% de dano a menos de 100 unidades do alvo, por nível.' },
  { id: 'atk_bombardeio',    icon: '☄', stat: 'damage_vs_cc_pct',    perLevel: 2.5, unit: 'pct', wired: true,
    name: 'Bombardeio',             desc: '+2,5% de dano contra alvos lentos ou atordoados, por nível.' },
  // Era "Rastro Turbulento" (lentidão em quem navegava atrás) e nunca teve
  // efeito — não há esteira no jogo. Virou o nó de SEQUÊNCIA: acertos seguidos
  // acumulam pilhas de dano e errar zera tudo, o que amarra este talento no
  // Pulso Firme (precisão) do mesmo anel.
  //
  // ⚠️ `perLevel` aqui é o TETO DE PILHAS, não o bônus: são +2 pilhas por nível
  // (20 no talento cheio) e cada pilha vale STREAK_PCT_PER_STACK (2%) em
  // talent-effects. Guardar o teto no stat é o que deixa a UI mostrar um número
  // que quer dizer alguma coisa — "+2 por nível" são duas pilhas, não 2%.
  { id: 'atk_rastro',        icon: '🥁', stat: 'streak_damage_stacks', perLevel: 2,   unit: 'flat', wired: true,
    name: 'Cadência Mortal',        desc: 'Cada acerto seguido dá +2% de dano; +2 pilhas de teto por nível. Errar zera a sequência.' },
  // Era "Deriva" (+3% de manobra em velocidade máxima). Virou PRECISÃO: desde
  // que a mira do canhão passou a rolar por tiro (constants/cannons.js), ela é
  // o eixo que mais se sente e não tinha nenhum talento. O teto do canhão +
  // pesquisa continua sendo o CANNON_ACCURACY_MAX (70%) — o talento soma DEPOIS
  // dele, com teto próprio de 95%, senão o nó cheio não faria nada em quem já
  // pesquisou a Mira Calibrada.
  { id: 'atk_deriva',        icon: '🔭', stat: 'cannon_accuracy_pct',  perLevel: 1,   unit: 'pct', wired: true,
    name: 'Pulso Firme',            desc: '+1% de precisão dos canhões por nível.' },

  // ── anel 5 ── o último da lista é o capstone da árvore
  { id: 'atk_tiroduplo',     icon: '🎰', stat: 'double_shot_chance',  perLevel: 1,   unit: 'chance', wired: true,
    name: 'Tiro Duplo',             desc: '1% de chance por nível de disparar uma segunda salva sem custo.' },
  { id: 'atk_cascata',       icon: '🌊', stat: 'crit_chain_pct',      perLevel: 2,   unit: 'chance', wired: true,
    name: 'Cascata',                desc: 'Um crítico aumenta em 2% por nível a chance do crítico seguinte.' },
  { id: 'atk_balacorrente',  icon: '⛓', stat: 'pierce_chance',       perLevel: 3,   unit: 'chance', wired: true,
    name: 'Bala de Corrente',       desc: '3% de chance por nível do projétil atravessar e atingir um segundo alvo.' },
  { id: 'atk_poderdefogo',   icon: '🔱', stat: 'damage_final_pct',    perLevel: 1.5, unit: 'pct', wired: true,
    name: 'Poder de Fogo',          desc: '+1,5% de todo o dano causado, por nível.' },
  { id: 'atk_sobrecarga',    icon: '🌩', stat: 'relic_overload_pct',  perLevel: 3,   unit: 'pct', wired: true,
    name: 'Sobrecarga Arcana',      desc: '+3% de dano de relíquia por nível, ao custo de +1% de mana por nível.' },
  { id: 'atk_carnificina',   icon: '☠', stat: 'killstreak_pct',      perLevel: 2,   unit: 'pct', wired: true,
    name: 'Carnificina',            desc: 'Cada abate dá +2% de dano por nível, acumulando até 3 vezes. Zera ao sair de combate.' },
  { id: 'atk_ventania',      icon: '💠', stat: 'speed_on_kill_pct',   perLevel: 0.5, unit: 'pct', wired: true,
    name: 'Ventania',               desc: '+0,5% de velocidade por 5s após um abate, por nível.' },
  { id: 'atk_impulsoarcano', icon: '✳', stat: 'speed_on_relic_pct',  perLevel: 0.5, unit: 'pct', wired: true,
    name: 'Impulso Arcano',         desc: '+0,5% de velocidade por 4s após usar uma relíquia, por nível.' },
  // Era "Bordo Livre" (recarga do impulso) e nunca teve efeito — o jogador não
  // tem impulso. É a Cadência Mortal do outro lado da moeda: a mesma sequência
  // de acertos, convertida em perfuração. Mesmo formato de dado (o `perLevel` é
  // o teto de pilhas), mesma pilha compartilhada em `_streakStacks`.
  { id: 'atk_bordolivre',    icon: '🪛', stat: 'streak_pen_stacks',    perLevel: 2,   unit: 'flat', wired: true,
    name: 'Broca Corsária',         desc: 'Cada acerto seguido ignora +2% da defesa do alvo; +2 pilhas de teto por nível. Errar zera a sequência.' },
  // Era +5%/nível e virou +3%: a +50% ele dava 2,5× o Artilharia Pesada, o maior
  // talento de dano incondicional da árvore. A penalidade acompanha pela razão
  // fixa de 0,4 em talent-effects (3 × 0,4 = 1,2 ponto de redução por nível).
  { id: 'atk_furiakraken',   icon: '🐉', stat: 'kraken_fury_pct',     perLevel: 3,   unit: 'pct', wired: true,
    name: 'Fúria do Kraken',        desc: '+3% de dano por nível, mas −1,2% de redução de dano por nível.' },
];

// ── DEFESA ────────────────────────────────────────────────────────────────────
// Vida, redução, regeneração — e o que serve para NÃO SER ATINGIDO ou sair
// inteiro da briga, herdado da antiga árvore de Mobilidade.
const TREE_DEFESA = [
  // ── anel 0 ──
  { id: 'def_cascoferro', icon: '❤', stat: 'max_hp_flat',            perLevel: 250, unit: 'flat',   wired: true,
    name: 'Casco de Ferro',         desc: '+250 de vida máxima por nível.' },
  { id: 'def_armadura',   icon: '🛡', stat: 'damage_reduction_pct',   perLevel: 0.5, unit: 'pct',    wired: true,
    name: 'Armadura Grossa',        desc: '+0,5% de redução de dano por nível.' },
  // Calafate era +0,4 de vida por segundo. Virou multiplicador de CURA a pedido
  // do playtest: a regeneração plana envelheceu junto com o jogo (0,4/s num
  // casco de 70k não se percebe) e a árvore não tinha nada que valorizasse
  // curandeiro, bala de cura e relíquia de cura. Stat próprio (`_2`) pelo mesmo
  // motivo do Ponta de Aço: um número por nó no painel.
  { id: 'def_calafate',   icon: '🪵', stat: 'healing_received_pct_2',  perLevel: 1,   unit: 'pct', wired: true,
    name: 'Calafate',               desc: '+1% de toda cura recebida por nível.' },
  { id: 'def_leme',       icon: '🎡', stat: 'turn_speed_pct',         perLevel: 1,   unit: 'pct', wired: true,
    name: 'Leme Leve',              desc: '+1% de velocidade de manobra por nível.' },

  // ── anel 1 ──
  { id: 'def_reforcado',    icon: '🏗', stat: 'max_hp_pct',           perLevel: 2,   unit: 'pct', wired: true,
    name: 'Casco Reforçado',        desc: '+2% da vida base do navio por nível.' },
  { id: 'def_esquiva',      icon: '🤸', stat: 'dodge_chance',         perLevel: 1,   unit: 'chance', wired: true,
    name: 'Manobra Evasiva',        desc: '+1% de chance de desviar de um tiro, por nível.' },
  { id: 'def_escudoguerra', icon: '🐲', stat: 'reduction_vs_npc_pct', perLevel: 0.5, unit: 'pct', wired: true,
    name: 'Escudo de Guerra',       desc: '+0,5% de redução de dano de criaturas por nível.' },
  { id: 'def_couraca',      icon: '⚔', stat: 'reduction_vs_player_pct', perLevel: 0.5, unit: 'pct', wired: true,
    name: 'Couraça Corsária',       desc: '+0,5% de redução de dano de jogadores por nível.' },
  // Era "Casco Liso" (−2% de arrasto nas curvas): efeito real, mas invisível —
  // ninguém sente 20% de arrasto a menos. Virou a rede de segurança do anel 1:
  // ao CRUZAR 20% de vida, ergue um escudo que absorve dano de verdade.
  // Rearma sozinho quando a vida volta acima de 20% (mais um piso de tempo em
  // LOW_HP_SHIELD_CD_MS), então oscilar na faixa não vira escudo infinito.
  { id: 'def_cascoliso',    icon: '🛟', stat: 'low_hp_shield_pct',    perLevel: 1,   unit: 'pct', wired: true,
    name: 'Casco Duplo',            desc: 'Ao cair abaixo de 20% de vida, ganha um escudo de 1% da vida máxima por nível (dura 10s).' },

  // ── anel 2 ──
  // Era +0,5% de redução de dano em ÁREA e nunca teve efeito (nenhum caminho de
  // dano em área passava o contexto). Virou o que o nome sempre prometeu: a
  // antepara aguenta o golpe inteiro, de vez em quando. Bloqueio é ANULAÇÃO,
  // como a esquiva — 5% no talento cheio, com aviso próprio na tela.
  { id: 'def_anteparo',     icon: '🧱', stat: 'block_chance',         perLevel: 0.5, unit: 'chance', wired: true,
    name: 'Anteparo',               desc: '+0,5% de chance por nível de bloquear um golpe por inteiro.' },
  { id: 'def_wardsalgada',  icon: '🔯', stat: 'reduction_relic_pct',  perLevel: 0.5,   unit: 'pct',
    name: 'Ward Salgada',           desc: '+0,5% de redução de dano de relíquias por nível.' },
  { id: 'def_vontade',      icon: '🪢', stat: 'cc_resist_pct',        perLevel: 2.5, unit: 'redpct', wired: true,
    name: 'Vontade de Ferro',       desc: '−2,5% na duração de atordoamentos e lentidões, por nível.' },
  // Era regeneração passiva fora de combate (0,1% da vida máxima por segundo
  // por nível). Virou multiplicador de CURA fora de combate — a mesma família
  // do Calafate e da Recuperação, com a condição que o nome pede. Decisão do
  // Luang, com o preço declarado: o jogo perde a regeneração passiva acima de
  // 40% de vida (abaixo disso as Bombas de Porão continuam).
  { id: 'def_reparo',       icon: '🔧', stat: 'healing_out_combat_pct', perLevel: 2, unit: 'pct', wired: true,
    name: 'Reparos de Emergência',  desc: '+2% de toda cura recebida fora de combate, por nível.' },
  // ⚠️ NÃO é uma cura de uma vez: é regeneração CONTÍNUA e sem recarga, que
  // corre enquanto a vida estiver abaixo de 40%. Quem tem recarga é o Segundo
  // Fôlego (1× por minuto) — os dois já foram confundidos um com o outro.
  { id: 'def_bombeamento',  icon: '🪣', stat: 'hp_regen_low_pct',     perLevel: 0.3, unit: 'pct', wired: true,
    name: 'Bombas de Porão',        desc: 'Abaixo de 40% de vida, recupera 0,3% da vida máxima POR SEGUNDO, por nível — contínuo, sem recarga.' },
  { id: 'def_escorregadio', icon: '🧊', stat: 'slow_resist_pct',      perLevel: 3,   unit: 'redpct', wired: true,
    name: 'Casco Escorregadio',     desc: '−3% na intensidade das lentidões sofridas, por nível.' },

  // ── anel 3 ──
  { id: 'def_espinhos',      icon: '🦔', stat: 'thorns_pct',          perLevel: 1,   unit: 'pct', wired: true,
    name: 'Casco de Espinhos',      desc: 'Devolve 1% do dano recebido ao atacante, por nível.' },
  { id: 'def_segundofolego', icon: '🫁', stat: 'second_wind_pct',     perLevel: 2,   unit: 'pct', wired: true,
    name: 'Segundo Fôlego',         desc: 'Cura de uma vez 2% da vida máxima por nível ao cair abaixo de 25% — recarga de 1 minuto.' },
  { id: 'def_ancoraviva',    icon: '⚓', stat: 'reduction_still_pct', perLevel: 0.5,   unit: 'pct', wired: true,
    name: 'Âncora Viva',            desc: '+0,5% de redução de dano enquanto parado, por nível.' },
  // O jogo já dava 30 s de período seguro ao renascer e o talento nunca somava
  // nada nele — agora soma. 1 s por nível (era 200 ms): a 200 ms o nó cheio
  // valia 2 s em cima de 30, ou seja, ruído.
  { id: 'def_tregua',        icon: '🏳', stat: 'respawn_immunity_ms', perLevel: 1000, unit: 'flat', wired: true,
    name: 'Trégua',                 desc: '+1s de período seguro ao renascer, por nível (soma nos 30s de sempre).' },
  { id: 'def_vigia',         icon: '👀', stat: 'crit_taken_reduction', perLevel: 0.5,  unit: 'pct', wired: true,
    name: 'Vigia',                  desc: '+0,5% de redução do dano crítico recebido, por nível.' },
  { id: 'def_fuga',          icon: '🏃', stat: 'speed_low_hp_pct',    perLevel: 0.5, unit: 'pct', wired: true,
    name: 'Fuga Estratégica',       desc: '+0,5% de velocidade com a vida abaixo de 30%, por nível.' },
  // Era "Ancoragem Rápida" (−3% no tempo de parar o navio): efeito real e
  // imperceptível. Virou o talento de quem ataca ilha — as torres são a única
  // fonte de dano do jogo contra a qual não havia defesa nenhuma na árvore.
  { id: 'def_ancoragem',     icon: '🗼', stat: 'reduction_vs_tower_pct', perLevel: 2, unit: 'pct', wired: true,
    name: 'Escudo de Assédio',      desc: '−2% do dano recebido das torres de ilha, por nível.' },

  // ── anel 4 ──
  { id: 'def_madeiranobre', icon: '🌳', stat: 'max_hp_flat_2',        perLevel: 2000, unit: 'flat', wired: true,
    name: 'Madeira Nobre',          desc: '+2000 de vida máxima por nível.' },
  // ⚠️ Isto NÃO era um escudo: o server.js somava o valor direto no `hp`
  // (`player.hp += barreira`), então era cura instantânea, não aparecia nada na
  // tela e não fazia nada com a vida cheia. O playtest resumiu em quatro
  // palavras: "nem percebi esse escudo". Agora é absorção de verdade, com
  // prazo, barra própria na HUD e bolha em volta do casco.
  { id: 'def_barreira',     icon: '🔵', stat: 'shield_on_relic_pct',  perLevel: 1,   unit: 'pct', wired: true,
    name: 'Barreira Arcana',        desc: 'Usar uma relíquia ergue um escudo que absorve 1% da vida máxima por nível, durante 8s.' },
  { id: 'def_moral',        icon: '🎖', stat: 'reduction_per_ally_pct', perLevel: 0.5, unit: 'pct', wired: true,
    name: 'Moral de Ferro',         desc: '+0,5% de redução de dano por aliado do grupo por perto, por nível.' },
  { id: 'def_lobodomar',    icon: '🌑', stat: 'reduction_solo_pct',   perLevel: 0.5,   unit: 'pct', wired: true,
    name: 'Lobo do Mar',            desc: '+0,5% de redução de dano quando navega sem grupo, por nível.' },
  { id: 'def_recuperacao',  icon: '💚', stat: 'healing_received_pct', perLevel: 2,   unit: 'pct', wired: true,
    name: 'Recuperação',            desc: '+2% de toda cura recebida por nível.' },
  { id: 'def_teimosia',     icon: '🗿', stat: 'death_save_chance',    perLevel: 1,   unit: 'chance', wired: true,
    name: 'Teimosia',               desc: '1% de chance por nível de sobreviver com 1 de vida a um golpe fatal.' },
  { id: 'def_alvodificil',  icon: '🎯', stat: 'dodge_moving_chance',  perLevel: 1,   unit: 'chance', wired: true,
    name: 'Alvo Difícil',           desc: '+1% de chance de desvio enquanto está em movimento, por nível.' },
  // Era "+0,5% de velocidade de ré". A ré existe (tecla S), mas ninguém navega
  // de ré tempo suficiente para sentir meio por cento dela. Virou a defesa
  // contra os NPCs que atiram de canhão — frota de caçadores, guardas de ilha,
  // navios das masmorras bônus (todos marcados com `usesCannons`) —, que é
  // coisa diferente do Escudo de Guerra (esse vale contra as CRIATURAS).
  { id: 'def_marchare',     icon: '🚢', stat: 'reduction_vs_npc_ship_pct', perLevel: 1, unit: 'pct', wired: true,
    name: 'Guarda de Bordada',      desc: '−1% do dano recebido de navios inimigos, por nível.' },

  // ── anel 5 ──
  { id: 'def_fortaleza',      icon: '🏰', stat: 'damage_reduction_pct_2', perLevel: 0.5, unit: 'pct', wired: true,
    name: 'Fortaleza Flutuante',    desc: '+0,5% de redução de dano por nível.' },
  // ── Absorção: mana PLANA por golpe, não fração do dano ────────────────────
  // "1% do dano recebido vira mana" foi escrito quando dano e mana moravam na
  // mesma ordem de grandeza. Hoje um golpe tira dezenas de milhares e a barra
  // inteira tem ~20 pontos: 1% de um golpe de 50k são 500 de mana num copo de
  // 20, ou seja, QUALQUER acerto enchia a barra e o número do talento nunca
  // significou nada. Agora a promessa é na moeda certa — meio ponto de mana por
  // nível, a cada golpe levado, 5 no talento cheio.
  { id: 'def_absorcao',       icon: '🕳', stat: 'mana_on_hit_flat',   perLevel: 0.5, unit: 'flat', wired: true,
    name: 'Absorção',               desc: '+0,5 de mana a cada golpe recebido, por nível.' },
  { id: 'def_sanguessuga',    icon: '🩸', stat: 'lifesteal_pct',      perLevel: 0.5, unit: 'pct', wired: true,
    name: 'Sanguessuga',            desc: 'Recupera 0,5% do dano causado como vida, por nível.' },
  // ── Carapaça de Kraken: o corte plano agora É do casco ─────────────────────
  // −2 de dano por nível envelheceu junto com o jogo: num mapa onde um acerto
  // tira 50k, os −20 do talento cheio somem no arredondamento. O número fixo
  // também nunca serviu às duas pontas ao mesmo tempo — −20 é muito num barco
  // de 200 de vida e é nada num de 70k.
  //
  // Amarrando o corte à vida MÁXIMA de quem apanha, ele acompanha o mapa
  // sozinho e continua sendo o que o talento sempre foi: a defesa contra
  // chuvisco. Contra um golpe de 50k, 1% de um casco de 70k é só um arranhão;
  // contra uma salva de dez bolas pequenas, corta dez vezes.
  { id: 'def_carapaca',       icon: '🐚', stat: 'flat_reduction_pct', perLevel: 0.1, unit: 'redpct', wired: true,
    name: 'Carapaça de Kraken',     desc: 'Todo golpe que você leva chega 0,1% da sua vida máxima mais fraco, por nível. É um desconto FIXO por acerto: apara rajada de tiro pequeno, quase não se nota num golpe enorme.' },
  // O caminho de dano contínuo (processDots no server.js) nunca dizia que era
  // DoT ao pedir a redução, então este talento existia e não fazia nada.
  { id: 'def_maresia',        icon: '🌫', stat: 'dot_reduction_pct',  perLevel: 0.5, unit: 'pct', wired: true,
    name: 'Maresia Purificadora',   desc: '+0,5% de redução de dano contínuo (veneno, fogo, sangramento) por nível.' },
  { id: 'def_sentinela',      icon: '🔔', stat: 'reduction_after_hit_pct', perLevel: 0.5, unit: 'pct', wired: true,
    name: 'Sentinela',              desc: 'Cada golpe recebido dá +0,5% de redução por nível durante 5s (acumula 5x).' },
  { id: 'def_sombra',         icon: '🌚', stat: 'stealth_range_pct',  perLevel: 2,   unit: 'redpct', wired: true,
    name: 'Sombra do Mar',          desc: '−2% no alcance em que as criaturas te percebem, por nível.' },
  // ⚠️ O talento prometia "−3% no tempo de renascimento" e NÃO HÁ tempo de
  // renascimento: o painel de morte tem um botão e o `request_respawn` devolve
  // o jogador na hora. Encurtar zero é zero, e inventar uma espera só para o
  // talento ter o que cortar seria punir todo mundo para premiar um nó.
  // A promessa vizinha — voltar pronto para brigar — o jogo já tem onde
  // cumprir: renasce-se com 10% da vida, e agora este nó levanta esse número.
  { id: 'def_retorno',        icon: '🔄', stat: 'respawn_hp_pct',     perLevel: 3,   unit: 'pct', wired: true,
    name: 'Volta por Cima',         desc: '+3% da vida máxima ao renascer, por nível (o padrão é 10%).' },
  { id: 'def_espiritovento',  icon: '🌟', stat: 'wind_spirit_pct',    perLevel: 2,   unit: 'pct', wired: true,
    name: 'Espírito do Vento',      desc: '+2% de velocidade e +1% de esquiva por nível.' },
  { id: 'def_coracaoabissal', icon: '💙', stat: 'abyssal_heart_pct',  perLevel: 3,   unit: 'pct', wired: true,
    name: 'Coração do Abismo',      desc: '+3% de vida máxima e +0,5% de redução de dano por nível.' },
];

// ── RECURSO ───────────────────────────────────────────────────────────────────
// Espólio, mana, ofícios — e a NAVEGAÇÃO de longo curso (velocidade de cruzeiro,
// clima, visão, portais), que veio da antiga árvore de Mobilidade.
const TREE_RECURSO = [
  // ── anel 0 ──
  { id: 'res_pilhador',   icon: '💰', stat: 'gold_drop_pct',          perLevel: 3,   unit: 'pct',    wired: true,
    name: 'Pilhador',               desc: '+3% de ouro obtido por nível.' },
  { id: 'res_estudioso',  icon: '📚', stat: 'xp_drop_pct',            perLevel: 4,   unit: 'pct',    wired: true,
    name: 'Estudioso',              desc: '+4% de XP obtido por nível.' },
  { id: 'res_ganancioso', icon: '🟡', stat: 'dobrao_drop_pct',        perLevel: 3,   unit: 'pct',    wired: true,
    name: 'Corsário Ganancioso',    desc: '+3% de dobrões obtidos por nível.' },
  { id: 'res_velas',      icon: '⛵', stat: 'speed_pct',              perLevel: 0.5, unit: 'pct', wired: true,
    name: 'Velas Rápidas',          desc: '+0,5% de velocidade do navio por nível.' },

  // ── anel 1 ──
  { id: 'res_manaflow',     icon: '🔷', stat: 'mana_regen_pct',       perLevel: 8,   unit: 'pct',    wired: true,
    name: 'Fluxo de Mana',          desc: '+8% na velocidade de recuperação de mana por nível.' },
  { id: 'res_reservatorio', icon: '🫙', stat: 'max_mana_flat',        perLevel: 1,   unit: 'flat', wired: true,
    name: 'Reservatório Arcano',    desc: '+1 de mana máxima por nível.' },
  // Existia desde sempre com o efeito "por aplicar" — agora tem para onde
  // apontar: é o talento de quem vive de saquear espólio de abordagem.
  { id: 'res_saqueador',    icon: '🪦', stat: 'wreck_loot_pct',       perLevel: 5,   unit: 'pct', wired: true,
    name: 'Saqueador de Naufrágios', desc: '+5% do espólio saqueado de destroços, por nível.' },
  // `fx.shopPriceMult` existia desde a primeira leva e NENHUMA loja a chamava —
  // o talento era um número bonito na árvore. Agora passa pelo helper central
  // `precoComDesconto` (server.js), que é por onde todo preço de loja sai.
  { id: 'res_negociante',   icon: '🤝', stat: 'shop_discount_pct',    perLevel: 1,   unit: 'redpct', wired: true,
    name: 'Negociante',             desc: '−1% no preço das lojas por nível.' },
  // Era "+3% de aceleração": a rampa de aceleração é rápida por padrão de
  // propósito (para não mudar o tato do barco), então o talento mexia num
  // décimo de segundo que ninguém percebe. Virou XP de mascote — o segundo nó
  // de pet da árvore, ao lado do Vínculo Selvagem.
  { id: 'res_impulso',      icon: '🎓', stat: 'pet_xp_pct',           perLevel: 1,   unit: 'pct', wired: true,
    name: 'Adestrador',             desc: '+1% de XP para o mascote por nível.' },

  // ── anel 2 ── a tripulação de abordagem
  // Saíram daqui quatro talentos de ofício (pólvora, ferro, fragmentos de mapa,
  // munição): prometiam percentual sobre drops que o jogo nunca teve, e não
  // havia sistema no horizonte para ligá-los. No lugar entra a tripulação de
  // piratas, que é onde a árvore de Recurso passa a decidir uma briga.
  // Aqui morava a "Lamparina Reforçada" (+10 de alcance de luz e de clareira na
  // névoa por nível). O bônus era bom demais para ser opcional — enxergar à
  // noite não devia custar 10 níveis de talento —, então ele VIROU PADRÃO do
  // jogo: o cliente soma o equivalente ao nó cheio para todo mundo (ver
  // VISION_BONUS_DEFAULT em scripts/main.gd). No lugar entra o primeiro talento
  // de MASCOTE de verdade da árvore: o pet ganhou relíquias em 09/2026 e nada
  // na árvore olhava para ele.
  { id: 'res_lamparina',  icon: '🐉', stat: 'pet_relic_cooldown_ms',  perLevel: 500, unit: 'flat', wired: true,
    name: 'Vínculo Selvagem',       desc: '−0,5s na recarga das relíquias do mascote, por nível.' },
  { id: 'res_alistamento', icon: '👥', stat: 'pirate_capacity_flat',  perLevel: 5,   unit: 'flat', wired: true,
    name: 'Alistamento',            desc: '+5 de capacidade de porão para piratas, por nível.' },
  { id: 'res_abordagem',   icon: '⚔', stat: 'pirate_power_pct',      perLevel: 2,   unit: 'pct', wired: true,
    name: 'Mestre de Abordagem',    desc: '+2% de força dos seus piratas ao abordar um espólio, por nível.' },
  { id: 'res_disciplina',  icon: '🎖', stat: 'pirate_casualty_pct',   perLevel: 1.5, unit: 'redpct', wired: true,
    name: 'Disciplina de Convés',   desc: '−1,5% de baixas entre os seus piratas na abordagem, por nível.' },
  { id: 'res_destilaria',  icon: '🍾', stat: 'run_upkeep_pct',        perLevel: 2,   unit: 'redpct', wired: true,
    name: 'Destilaria de Bordo',    desc: '−2% no consumo de RUN da tripulação, por nível.' },
  { id: 'res_correnteza', icon: '🌊', stat: 'speed_out_combat_pct',   perLevel: 0.5, unit: 'pct', wired: true,
    name: 'Correnteza Favorável',   desc: '+0,5% de velocidade fora de combate, por nível.' },

  // ── anel 3 ──
  { id: 'res_economia',     icon: '💧', stat: 'relic_mana_cost_pct',  perLevel: 1.5, unit: 'redpct', wired: true,
    name: 'Economia Arcana',        desc: '−1,5% no custo de mana das relíquias por nível.' },
  // Estes quatro já tinham a função pronta em talent-effects (`lootMult` com o
  // `kind` certo) e nenhum handler a chamava — o clássico "talento que existe
  // e não faz nada". O que entrou foi só o call-site.
  { id: 'res_colecionador', icon: '🏺', stat: 'relic_drop_pct',       perLevel: 2,   unit: 'pct',   wired: true,
    name: 'Colecionador',           desc: '+2% de chance de drop de relíquia por nível.' },
  { id: 'res_contratado',   icon: '📜', stat: 'mission_reward_pct',   perLevel: 4,   unit: 'pct',   wired: true,
    name: 'Contratado',             desc: '+4% de recompensa das missões diárias, por nível.' },
  { id: 'res_recompensa',   icon: '🎯', stat: 'bounty_pct',           perLevel: 5,   unit: 'pct',   wired: true,
    name: 'Caçador de Recompensas', desc: '+5% de recompensa por alvos procurados e frotas, por nível.' },
  { id: 'res_tratador',     icon: '🐾', stat: 'pet_food_pct',         perLevel: 5,   unit: 'pct',   wired: true,
    name: 'Tratador',               desc: '+5% de eficiência da comida de mascote por nível.' },
  // Era "Vento Próprio" (ignora a penalidade de velocidade do clima) e o clima
  // NÃO tem penalidade de velocidade — nunca teve. Virou o primeiro dos dois
  // nós da Mesa de Exploração, que era o sistema mais órfão da árvore.
  { id: 'res_ventoproprio', icon: '🧭', stat: 'fragment_extra_chance',perLevel: 3,   unit: 'chance', wired: true,
    name: 'Faro de Tesouro',        desc: '3% de chance por nível de um fragmento de mapa extra a cada abate.' },
  { id: 'res_passagem',     icon: '🌀', stat: 'arch_cooldown_pct',    perLevel: 4,   unit: 'redpct', wired: true,
    name: 'Passagem Rápida',        desc: '−4% no tempo de recarga das passagens antigas, por nível.' },

  // ── anel 4 ──
  // Saíram os Juros do Banco (o banco nunca pagou juros) e a Rota Comercial
  // (não há venda de itens a quem cobrar lucro). Entram os dois lados da moeda
  // do espólio: defender o próprio naufrágio e contratar mais barato.
  { id: 'res_muralha',      icon: '🏰', stat: 'pirate_defense_pct',   perLevel: 2.5, unit: 'pct', wired: true,
    name: 'Muralha de Convés',      desc: '+2,5% de defesa dos seus piratas quando o seu espólio é abordado, por nível.' },
  { id: 'res_espolio',      icon: '👥', stat: 'party_loot_pct',       perLevel: 2,   unit: 'pct',   wired: true,
    name: 'Espólio Partilhado',     desc: '+2% no ouro e nos dobrões recebidos em grupo, por nível.' },
  { id: 'res_sorte',        icon: '🍀', stat: 'rare_drop_pct',        perLevel: 2,   unit: 'pct',   wired: true,
    name: 'Sorte de Marujo',        desc: '+2% de chance de drop de navio raro por nível.' },
  { id: 'res_concentracao', icon: '🧘', stat: 'mana_out_combat_pct',  perLevel: 10,  unit: 'pct', wired: true,
    name: 'Concentração',           desc: '+10% de recuperação de mana fora de combate, por nível.' },
  { id: 'res_recrutador',   icon: '📝', stat: 'pirate_price_pct',     perLevel: 1.5, unit: 'redpct', wired: true,
    name: 'Recrutador',             desc: '−1,5% no preço de contratar piratas, por nível.' },
  { id: 'res_sabedoria',    icon: '🗿', stat: 'xp_boss_pct',          perLevel: 5,   unit: 'pct', wired: true,
    name: 'Sabedoria Antiga',       desc: '+5% de XP obtido de chefes, por nível.' },
  { id: 'res_nevoa',        icon: '🌁', stat: 'fog_vision_pct',       perLevel: 5,   unit: 'pct',
    name: 'Navegante da Névoa',     desc: '+5% de alcance de visão na névoa, por nível.' },
  { id: 'res_noturno',      icon: '🌙', stat: 'night_vision_pct',     perLevel: 5,   unit: 'pct',
    name: 'Olhos Noturnos',         desc: '+5% de alcance de visão à noite, por nível.' },

  // ── anel 5 ──
  { id: 'res_cofreduplo',     icon: '💎', stat: 'dobrao_double_chance', perLevel: 1, unit: 'chance', wired: true,
    name: 'Cofre Duplo',            desc: '1% de chance por nível de dobrar os dobrões de um espólio.' },
  { id: 'res_veiadeouro',     icon: '🪙', stat: 'gold_double_chance', perLevel: 1,   unit: 'chance', wired: true,
    name: 'Veia de Ouro',           desc: '1% de chance por nível de dobrar o ouro de um espólio.' },
  // Era "+0,3 de mana por abate" e virou o espólio da Mesa de Exploração, a
  // pedido do playtest: a mesa é onde o fragmento vira munição e peça de mapa,
  // e não havia um talento sequer olhando para ela.
  { id: 'res_colheita',     icon: '🗺', stat: 'exploration_loot_pct', perLevel: 1,   unit: 'pct',   wired: true,
    name: 'Garimpeiro',             desc: '+1% na quantidade de tudo que a Mesa de Exploração devolve, por nível.' },
  { id: 'res_seguro',       icon: '📋', stat: 'death_penalty_pct',    perLevel: 4,   unit: 'redpct', wired: true,
    name: 'Seguro Marítimo',        desc: '−4% no ouro perdido ao afundar, por nível.' },
  { id: 'res_ritual',       icon: '⏳', stat: 'relic_cooldown_pct',   perLevel: 1.5, unit: 'redpct', wired: true,
    name: 'Ritual Acelerado',       desc: '−1,5% no tempo de recarga das relíquias por nível.' },
  // Era "+2 espaços de porão" e o porão NÃO tem limite de espaços — nunca
  // teve. Virou o segundo nó da Mesa de Exploração: a rolagem extra.
  { id: 'res_porao',        icon: '⛏', stat: 'exploration_double_chance',perLevel: 1,   unit: 'chance', wired: true,
    name: 'Escavação Profunda',     desc: '1% de chance por nível de a Mesa de Exploração render uma rolagem extra.' },
  // Saíram a Navegação Precisa e o Cavalgar as Ondas: a travessia de borda é
  // instantânea e não existe corrente a favor — os dois prometiam velocidade em
  // situações que o jogo não simula. No lugar, os dois nós que fecham a linha
  // de piratas: porão grande e o comando que soma força e saque de uma vez.
  { id: 'res_capitania',      icon: '🧿', stat: 'pirate_capacity_pct', perLevel: 3,  unit: 'pct', wired: true,
    name: 'Capitania',              desc: '+3% de capacidade de porão para piratas, por nível.' },
  { id: 'res_almirante',      icon: '🎩', stat: 'pirate_command_pct',  perLevel: 2,  unit: 'pct', wired: true,
    name: 'Almirante',              desc: '+2% de força de abordagem e +2% de saque de espólio, por nível.' },
  { id: 'res_esquadra',       icon: '⛴', stat: 'party_speed_pct',    perLevel: 0.5, unit: 'pct', wired: true,
    name: 'Vento de Esquadra',      desc: '+0,5% de velocidade para todo o grupo por perto, por nível.' },
  { id: 'res_tesouroabissal', icon: '🏆', stat: 'abyssal_treasure_pct', perLevel: 2, unit: 'pct', wired: true,
    name: 'Tesouro do Abismo',      desc: '+2% em TODO ganho (ouro, dobrões e XP) por nível.' },
];

// ── Montagem: a ORDEM do array vira (anel, slot) ─────────────────────────────
function buildTree(tree, list) {
  if (list.length !== TREE_SIZE) {
    throw new Error(`talents.js: ${tree} tem ${list.length} talentos, esperava ${TREE_SIZE}`);
  }
  const out = [];
  let ring = 0;
  let slot = 0;
  for (const def of list) {
    if (slot >= RING_COUNTS[ring]) { ring += 1; slot = 0; }
    out.push({ ...def, tree, ring, slot, max: TALENT_MAX, wired: def.wired === true });
    slot += 1;
  }
  return out;
}

const TALENT_TREES = {
  ataque:  buildTree('ataque',  TREE_ATAQUE),
  defesa:  buildTree('defesa',  TREE_DEFESA),
  recurso: buildTree('recurso', TREE_RECURSO),
};

// ── TALENT_DEFS — mapa achatado id → def ─────────────────────────────────────
// É o que `handleBuyTalent` e `handleResetTalents` consultam.
const TALENT_DEFS = {};
for (const tree of TREE_ORDER) {
  for (const def of TALENT_TREES[tree]) {
    if (TALENT_DEFS[def.id]) throw new Error(`talents.js: id duplicado "${def.id}"`);
    TALENT_DEFS[def.id] = def;
  }
}

// Dois talentos no mesmo `stat` somariam em silêncio na agregação do servidor.
const _stats = new Set();
for (const def of Object.values(TALENT_DEFS)) {
  if (_stats.has(def.stat)) throw new Error(`talents.js: stat duplicado "${def.stat}" (${def.id})`);
  _stats.add(def.stat);
}

// ── Migração dos 10 talentos do sistema antigo ───────────────────────────────
// O sistema velho tinha 10 talentos de no máximo 5 níveis. Os valores por nível
// mudaram, então converter os níveis desbalancearia o build: no primeiro login
// os antigos são zerados e o total gasto volta como talentPoints livres.
// O mapa abaixo existe para o jogador saber onde recomprar o que tinha.
const LEGACY_TALENT_MAP = {
  hp:            'def_cascoferro',
  defesa:        'def_armadura',
  canhoes:       'atk_bateria',
  dano:          'atk_artilharia',
  dano_relic:    'atk_focoarcano',
  riqueza:       'res_pilhador',
  ganancioso:    'res_ganancioso',
  mestre:        'res_estudioso',
  crit_relic:    'atk_vidente',
  slot_reliquia: 'res_manaflow',
};

// ── TALENT_COST_TIERS — custo da próxima compra por total já adquirido ───────
// upTo é limite superior EXCLUSIVO. O teto do sistema é 1200 pontos
// (120 talentos × 10), então a tabela antiga — que travava em 3.000 dobrões
// após a 30ª compra — deixaria as ~1.170 compras seguintes com o mesmo preço.
// Os degraus abaixo mantêm o começo barato e fazem o fim doer.
// Todos os degraus foram multiplicados por 10 num ajuste de playtest: passados
// os 200 pontos o talento saía por 500 dobrões, barato demais para um jogador
// que já chegou lá. A forma da curva não mudou — só a escala.
const TALENT_COST_TIERS = [
  { upTo: 10,    cost: 500,      currency: 'gold'   },
  { upTo: 20,    cost: 1000,      currency: 'gold'   },
  { upTo: 40,   cost: 5000,     currency: 'gold'   },
  { upTo: 60,   cost: 20000,    currency: 'gold'   },
  { upTo: 100,  cost: 50000,    currency: 'gold'   },
  { upTo: 200,  cost: 100000,   currency: 'gold'   },
  { upTo: 350,  cost: 5000,      currency: 'dobrao' },
  { upTo: 550,  cost: 10000,     currency: 'dobrao' },
  { upTo: 800,  cost: 20000,     currency: 'dobrao' },
  { upTo: 9999, cost: 35000,     currency: 'dobrao' },
];

// ── XP mínimo para a n-ésima compra (0-indexed) ──────────────────────────────
// min(floor(BASE × GROWTH^n), CAP) — cada compra pede 10% a mais que a anterior:
//
//     500 → 550 → 605 → 665 → 732 → 805 → 885 → 974 → …
//
// O teto de 2M saía cedo demais para 1200 pontos: era atingido na 88ª compra e
// deixava as outras 1112 com o MESMO gate. Sem ele a curva cresce livre.
//
// O CAP continua existindo, mas como TRAVA DE OVERFLOW, não como balanceamento:
// 500 × 1,1^1199 ≈ 2,3 × 10^52, que estoura o int64 do GDScript e faz a barra de
// XP do painel mostrar um número negativo. MAX_SAFE_INTEGER mantém a conta exata
// dos dois lados e só entra em cena lá pela 320ª compra — quando a exigência já
// é de quatrilhões de XP e o teto não muda nada na prática.
const TALENT_XP_BASE   = 500;
const TALENT_XP_GROWTH = 1.1;
const TALENT_XP_CAP    = Number.MAX_SAFE_INTEGER;   // 9.007.199.254.740.991

module.exports = {
  TREE_ORDER, TALENT_TREES, TALENT_DEFS,
  RING_COUNTS, RING_GATE, TALENT_MAX, TREE_SIZE,
  LEGACY_TALENT_MAP,
  TALENT_COST_TIERS, TALENT_XP_BASE, TALENT_XP_GROWTH, TALENT_XP_CAP,
};
