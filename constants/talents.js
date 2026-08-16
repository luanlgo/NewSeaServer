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
const TREE_DEFS = {
  ataque:  { name: 'Ataque',  icon: '⚔', color: '#E05858', angle: -90 },
  defesa:  { name: 'Defesa',  icon: '🛡', color: '#5FB3D9', angle: 30  },
  recurso: { name: 'Recurso', icon: '💰', color: '#D4AF37', angle: 150 },
};

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
  { id: 'atk_municao',     icon: '📦', stat: 'ammo_damage_pct',       perLevel: 3,   unit: 'pct', wired: true,
    name: 'Munição Aprimorada',     desc: '+3% de dano da munição especial por nível.' },
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
  { id: 'atk_investida',    icon: '🐏', stat: 'ram_damage_pct',       perLevel: 4,   unit: 'pct',
    name: 'Investida',              desc: '+4% de dano de colisão por nível.' },

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
  { id: 'atk_miralonga',     icon: '🔭', stat: 'cannon_range_pct',    perLevel: 2,   unit: 'pct', wired: true,
    name: 'Miras Longas',           desc: '+2% de alcance dos canhões por nível.' },
  { id: 'atk_abordagem',     icon: '⚓', stat: 'damage_close_pct',    perLevel: 3,   unit: 'pct', wired: true,
    name: 'Abordagem',              desc: '+3% de dano a menos de 100 unidades do alvo, por nível.' },
  { id: 'atk_bombardeio',    icon: '☄', stat: 'damage_vs_cc_pct',    perLevel: 2.5, unit: 'pct', wired: true,
    name: 'Bombardeio',             desc: '+2,5% de dano contra alvos lentos ou atordoados, por nível.' },
  { id: 'atk_rastro',        icon: '〰', stat: 'slow_pursuers_pct',   perLevel: 1.5, unit: 'pct',
    name: 'Rastro Turbulento',      desc: 'Aplica 1,5% de lentidão por nível em quem navega no seu rastro.' },
  { id: 'atk_deriva',        icon: '🌪', stat: 'turn_while_fast_pct', perLevel: 3,   unit: 'pct', wired: true,
    name: 'Deriva',                 desc: '+3% de manobra em velocidade máxima, por nível.' },

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
  { id: 'atk_bordolivre',    icon: '🕊', stat: 'dash_cooldown_pct',   perLevel: 3,   unit: 'redpct',
    name: 'Bordo Livre',            desc: '−3% no tempo de recarga do impulso, por nível.' },
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
  { id: 'def_armadura',   icon: '🛡', stat: 'damage_reduction_pct',   perLevel: 1.5, unit: 'pct',    wired: true,
    name: 'Armadura Grossa',        desc: '+1,5% de redução de dano por nível.' },
  { id: 'def_calafate',   icon: '🪵', stat: 'hp_regen_flat',          perLevel: 0.4, unit: 'flat', wired: true,
    name: 'Calafate',               desc: '+0,4 de vida regenerada por segundo, por nível.' },
  { id: 'def_leme',       icon: '🎡', stat: 'turn_speed_pct',         perLevel: 2,   unit: 'pct', wired: true,
    name: 'Leme Leve',              desc: '+2% de velocidade de manobra por nível.' },

  // ── anel 1 ──
  { id: 'def_reforcado',    icon: '🏗', stat: 'max_hp_pct',           perLevel: 2,   unit: 'pct', wired: true,
    name: 'Casco Reforçado',        desc: '+2% da vida base do navio por nível.' },
  { id: 'def_esquiva',      icon: '🤸', stat: 'dodge_chance',         perLevel: 1,   unit: 'chance', wired: true,
    name: 'Manobra Evasiva',        desc: '+1% de chance de desviar de um tiro, por nível.' },
  { id: 'def_escudoguerra', icon: '🐲', stat: 'reduction_vs_npc_pct', perLevel: 1.5, unit: 'pct', wired: true,
    name: 'Escudo de Guerra',       desc: '+1,5% de redução de dano de criaturas por nível.' },
  { id: 'def_couraca',      icon: '⚔', stat: 'reduction_vs_player_pct', perLevel: 1.5, unit: 'pct', wired: true,
    name: 'Couraça Corsária',       desc: '+1,5% de redução de dano de jogadores por nível.' },
  { id: 'def_cascoliso',    icon: '🧽', stat: 'drag_reduction_pct',   perLevel: 2,   unit: 'pct', wired: true,
    name: 'Casco Liso',             desc: '−2% de arrasto na água por nível (mantém a velocidade nas curvas).' },

  // ── anel 2 ──
  { id: 'def_anteparo',     icon: '🧱', stat: 'reduction_aoe_pct',    perLevel: 2,   unit: 'pct',
    name: 'Anteparo',               desc: '+2% de redução de dano em área por nível.' },
  { id: 'def_wardsalgada',  icon: '🔯', stat: 'reduction_relic_pct',  perLevel: 2,   unit: 'pct',
    name: 'Ward Salgada',           desc: '+2% de redução de dano de relíquias por nível.' },
  { id: 'def_vontade',      icon: '🪢', stat: 'cc_resist_pct',        perLevel: 2.5, unit: 'redpct', wired: true,
    name: 'Vontade de Ferro',       desc: '−2,5% na duração de atordoamentos e lentidões, por nível.' },
  { id: 'def_reparo',       icon: '🔧', stat: 'repair_out_combat_pct', perLevel: 1,  unit: 'pct', wired: true,
    name: 'Reparos de Emergência',  desc: '+1% da vida máxima recuperada por segundo fora de combate, por nível.' },
  { id: 'def_bombeamento',  icon: '🪣', stat: 'hp_regen_low_pct',     perLevel: 0.3, unit: 'pct', wired: true,
    name: 'Bombas de Porão',        desc: '+0,3% da vida máxima por segundo enquanto abaixo de 40%, por nível.' },
  { id: 'def_escorregadio', icon: '🧊', stat: 'slow_resist_pct',      perLevel: 3,   unit: 'redpct', wired: true,
    name: 'Casco Escorregadio',     desc: '−3% na intensidade das lentidões sofridas, por nível.' },

  // ── anel 3 ──
  { id: 'def_espinhos',      icon: '🦔', stat: 'thorns_pct',          perLevel: 1,   unit: 'pct', wired: true,
    name: 'Casco de Espinhos',      desc: 'Devolve 1% do dano recebido ao atacante, por nível.' },
  { id: 'def_segundofolego', icon: '🫁', stat: 'second_wind_pct',     perLevel: 2,   unit: 'pct', wired: true,
    name: 'Segundo Fôlego',         desc: 'Cura 2% da vida máxima por nível ao cair abaixo de 25% (1 vez por minuto).' },
  { id: 'def_ancoraviva',    icon: '⚓', stat: 'reduction_still_pct', perLevel: 2,   unit: 'pct', wired: true,
    name: 'Âncora Viva',            desc: '+2% de redução de dano enquanto parado, por nível.' },
  { id: 'def_tregua',        icon: '🏳', stat: 'respawn_immunity_ms', perLevel: 200, unit: 'flat',
    name: 'Trégua',                 desc: '+200ms de invulnerabilidade após renascer, por nível.' },
  { id: 'def_vigia',         icon: '👀', stat: 'crit_taken_reduction', perLevel: 3,  unit: 'pct', wired: true,
    name: 'Vigia',                  desc: '+3% de redução do dano crítico recebido, por nível.' },
  { id: 'def_fuga',          icon: '🏃', stat: 'speed_low_hp_pct',    perLevel: 0.5, unit: 'pct', wired: true,
    name: 'Fuga Estratégica',       desc: '+0,5% de velocidade com a vida abaixo de 30%, por nível.' },
  { id: 'def_ancoragem',     icon: '🪝', stat: 'stop_time_pct',       perLevel: 3,   unit: 'redpct', wired: true,
    name: 'Ancoragem Rápida',       desc: '−3% no tempo para parar o navio, por nível.' },

  // ── anel 4 ──
  { id: 'def_madeiranobre', icon: '🌳', stat: 'max_hp_flat_2',        perLevel: 2000, unit: 'flat', wired: true,
    name: 'Madeira Nobre',          desc: '+2000 de vida máxima por nível.' },
  { id: 'def_barreira',     icon: '🔵', stat: 'shield_on_relic_pct',  perLevel: 1,   unit: 'pct', wired: true,
    name: 'Barreira Arcana',        desc: 'Usar uma relíquia concede um escudo de 1% da vida máxima por nível.' },
  { id: 'def_moral',        icon: '🎖', stat: 'reduction_per_ally_pct', perLevel: 0.5, unit: 'pct', wired: true,
    name: 'Moral de Ferro',         desc: '+0,5% de redução de dano por aliado do grupo por perto, por nível.' },
  { id: 'def_lobodomar',    icon: '🌑', stat: 'reduction_solo_pct',   perLevel: 2,   unit: 'pct', wired: true,
    name: 'Lobo do Mar',            desc: '+2% de redução de dano quando navega sem grupo, por nível.' },
  { id: 'def_recuperacao',  icon: '💚', stat: 'healing_received_pct', perLevel: 3,   unit: 'pct', wired: true,
    name: 'Recuperação',            desc: '+3% de cura recebida por nível.' },
  { id: 'def_teimosia',     icon: '🗿', stat: 'death_save_chance',    perLevel: 1,   unit: 'chance', wired: true,
    name: 'Teimosia',               desc: '1% de chance por nível de sobreviver com 1 de vida a um golpe fatal.' },
  { id: 'def_alvodificil',  icon: '🎯', stat: 'dodge_moving_chance',  perLevel: 1,   unit: 'chance', wired: true,
    name: 'Alvo Difícil',           desc: '+1% de chance de desvio enquanto está em movimento, por nível.' },
  { id: 'def_marchare',     icon: '↩', stat: 'reverse_speed_pct',    perLevel: 0.5, unit: 'pct', wired: true,
    name: 'Marcha à Ré',            desc: '+0,5% de velocidade de ré por nível.' },

  // ── anel 5 ──
  { id: 'def_fortaleza',      icon: '🏰', stat: 'damage_reduction_pct_2', perLevel: 1, unit: 'pct', wired: true,
    name: 'Fortaleza Flutuante',    desc: '+1% de redução de dano por nível.' },
  { id: 'def_absorcao',       icon: '🕳', stat: 'damage_to_mana_pct', perLevel: 1,   unit: 'pct', wired: true,
    name: 'Absorção',               desc: '1% do dano recebido vira mana, por nível.' },
  { id: 'def_sanguessuga',    icon: '🩸', stat: 'lifesteal_pct',      perLevel: 0.5, unit: 'pct', wired: true,
    name: 'Sanguessuga',            desc: 'Recupera 0,5% do dano causado como vida, por nível.' },
  { id: 'def_carapaca',       icon: '🐚', stat: 'flat_reduction',     perLevel: 2,   unit: 'flat', wired: true,
    name: 'Carapaça de Kraken',     desc: '−2 de dano por acerto recebido, por nível.' },
  { id: 'def_maresia',        icon: '🌫', stat: 'dot_reduction_pct',  perLevel: 3,   unit: 'pct',
    name: 'Maresia Purificadora',   desc: '+3% de redução de dano contínuo (veneno, fogo) por nível.' },
  { id: 'def_sentinela',      icon: '🔔', stat: 'reduction_after_hit_pct', perLevel: 1, unit: 'pct', wired: true,
    name: 'Sentinela',              desc: 'Cada golpe recebido dá +1% de redução por nível durante 5s (acumula 5x).' },
  { id: 'def_sombra',         icon: '🌚', stat: 'stealth_range_pct',  perLevel: 2,   unit: 'redpct', wired: true,
    name: 'Sombra do Mar',          desc: '−2% no alcance em que as criaturas te percebem, por nível.' },
  { id: 'def_retorno',        icon: '🔄', stat: 'respawn_time_pct',   perLevel: 3,   unit: 'redpct',
    name: 'Retorno Veloz',          desc: '−3% no tempo de renascimento por nível.' },
  { id: 'def_espiritovento',  icon: '🌟', stat: 'wind_spirit_pct',    perLevel: 2,   unit: 'pct', wired: true,
    name: 'Espírito do Vento',      desc: '+2% de velocidade e +1% de esquiva por nível.' },
  { id: 'def_coracaoabissal', icon: '💙', stat: 'abyssal_heart_pct',  perLevel: 3,   unit: 'pct', wired: true,
    name: 'Coração do Abismo',      desc: '+3% de vida máxima e +1% de redução de dano por nível.' },
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
  { id: 'res_saqueador',    icon: '🪦', stat: 'wreck_loot_pct',       perLevel: 5,   unit: 'pct',
    name: 'Saqueador de Naufrágios', desc: '+5% do espólio saqueado de destroços, por nível.' },
  { id: 'res_negociante',   icon: '🤝', stat: 'shop_discount_pct',    perLevel: 1,   unit: 'redpct',
    name: 'Negociante',             desc: '−1% no preço das lojas por nível.' },
  { id: 'res_impulso',      icon: '🌬', stat: 'accel_pct',            perLevel: 3,   unit: 'pct', wired: true,
    name: 'Impulso',                desc: '+3% de aceleração por nível.' },

  // ── anel 2 ──
  { id: 'res_pescador',   icon: '🎣', stat: 'fishing_yield_pct',      perLevel: 5,   unit: 'pct',
    name: 'Pescador Experiente',    desc: '+5% no resultado da pesca por nível.' },
  { id: 'res_polvora',    icon: '🧨', stat: 'gunpowder_drop_pct',     perLevel: 5,   unit: 'pct',
    name: 'Fabricante de Pólvora',  desc: '+5% de pólvora obtida por nível.' },
  { id: 'res_ferreiro',   icon: '⚒', stat: 'iron_drop_pct',          perLevel: 5,   unit: 'pct',
    name: 'Ferreiro',               desc: '+5% de placas de ferro obtidas por nível.' },
  { id: 'res_cartografo', icon: '🗺', stat: 'map_fragment_pct',       perLevel: 4,   unit: 'pct',
    name: 'Cartógrafo',             desc: '+4% de fragmentos de mapa obtidos por nível.' },
  { id: 'res_alquimista', icon: '⚗', stat: 'ammo_drop_pct',          perLevel: 4,   unit: 'pct',
    name: 'Alquimista',             desc: '+4% de munição obtida como espólio, por nível.' },
  { id: 'res_correnteza', icon: '🌊', stat: 'speed_out_combat_pct',   perLevel: 0.5, unit: 'pct', wired: true,
    name: 'Correnteza Favorável',   desc: '+0,5% de velocidade fora de combate, por nível.' },

  // ── anel 3 ──
  { id: 'res_economia',     icon: '💧', stat: 'relic_mana_cost_pct',  perLevel: 1.5, unit: 'redpct', wired: true,
    name: 'Economia Arcana',        desc: '−1,5% no custo de mana das relíquias por nível.' },
  { id: 'res_colecionador', icon: '🏺', stat: 'relic_drop_pct',       perLevel: 2,   unit: 'pct',
    name: 'Colecionador',           desc: '+2% de chance de drop de relíquia por nível.' },
  { id: 'res_contratado',   icon: '📜', stat: 'mission_reward_pct',   perLevel: 4,   unit: 'pct',
    name: 'Contratado',             desc: '+4% de recompensa de missão por nível.' },
  { id: 'res_recompensa',   icon: '🎯', stat: 'bounty_pct',           perLevel: 5,   unit: 'pct',
    name: 'Caçador de Recompensas', desc: '+5% de recompensa por alvos procurados e frotas, por nível.' },
  { id: 'res_tratador',     icon: '🐾', stat: 'pet_food_pct',         perLevel: 5,   unit: 'pct',
    name: 'Tratador',               desc: '+5% de eficiência da comida de mascote por nível.' },
  { id: 'res_ventoproprio', icon: '🍃', stat: 'weather_speed_pct',    perLevel: 8,   unit: 'pct',
    name: 'Vento Próprio',          desc: 'Ignora 8% da penalidade de velocidade do clima, por nível.' },
  { id: 'res_passagem',     icon: '🌀', stat: 'arch_cooldown_pct',    perLevel: 4,   unit: 'redpct',
    name: 'Passagem Rápida',        desc: '−4% no tempo de recarga das passagens antigas, por nível.' },

  // ── anel 4 ──
  { id: 'res_juros',        icon: '🏦', stat: 'bank_interest_pct',    perLevel: 0.5, unit: 'pct',
    name: 'Juros do Banco',         desc: '+0,5% de juros diários no banco, por nível.' },
  { id: 'res_espolio',      icon: '👥', stat: 'party_loot_pct',       perLevel: 2,   unit: 'pct',
    name: 'Espólio Partilhado',     desc: '+2% no espólio recebido quando em grupo, por nível.' },
  { id: 'res_sorte',        icon: '🍀', stat: 'rare_drop_pct',        perLevel: 2,   unit: 'pct',
    name: 'Sorte de Marujo',        desc: '+2% de chance de drop raro por nível.' },
  { id: 'res_concentracao', icon: '🧘', stat: 'mana_out_combat_pct',  perLevel: 10,  unit: 'pct', wired: true,
    name: 'Concentração',           desc: '+10% de recuperação de mana fora de combate, por nível.' },
  { id: 'res_rota',         icon: '📬', stat: 'trade_profit_pct',     perLevel: 2,   unit: 'pct',
    name: 'Rota Comercial',         desc: '+2% de lucro ao vender itens, por nível.' },
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
  { id: 'res_colheita',       icon: '👻', stat: 'mana_on_kill',       perLevel: 0.3, unit: 'flat', wired: true,
    name: 'Colheita de Almas',      desc: '+0,3 de mana por abate, por nível.' },
  { id: 'res_seguro',         icon: '📋', stat: 'death_penalty_pct',  perLevel: 4,   unit: 'redpct',
    name: 'Seguro Marítimo',        desc: '−4% na penalidade de morte por nível.' },
  { id: 'res_ritual',         icon: '⏳', stat: 'relic_cooldown_pct', perLevel: 1.5, unit: 'redpct',
    name: 'Ritual Acelerado',       desc: '−1,5% no tempo de recarga das relíquias por nível.' },
  { id: 'res_porao',          icon: '📦', stat: 'inventory_slots',    perLevel: 2,   unit: 'flat',
    name: 'Porão Ampliado',         desc: '+2 espaços de porão por nível.' },
  { id: 'res_navegacao',      icon: '🧭', stat: 'map_travel_pct',     perLevel: 3,   unit: 'pct',
    name: 'Navegação Precisa',      desc: '+3% de velocidade ao cruzar bordas de mapa, por nível.' },
  { id: 'res_cavalgar',       icon: '🏄', stat: 'wave_speed_pct',     perLevel: 0.5, unit: 'pct',
    name: 'Cavalgar as Ondas',      desc: '+0,5% de velocidade navegando a favor da corrente, por nível.' },
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
  TREE_DEFS, TREE_ORDER, TALENT_TREES, TALENT_DEFS,
  RING_COUNTS, RING_GATE, TALENT_MAX, TREE_SIZE,
  LEGACY_TALENT_MAP,
  TALENT_COST_TIERS, TALENT_XP_BASE, TALENT_XP_GROWTH, TALENT_XP_CAP,
};
