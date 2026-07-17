/**
 * Демо-движок чата по каркасу:
 *  - состояния: сценарий не запущен (C) / сценарий предложил чоисы (B.1) /
 *    сценарий ждёт текст (B.2) / идёт генерация (D, ввод заблокирован) /
 *    стартовый сценарий выбора типа документа (A — не прерывается командами);
 *  - перебивка: новый сценарий (командой из чата или файлом) поверх активного —
 *    вопрос «прервать?»; старый завершается, стейт обнуляется, действия не откатываются;
 *  - сценарии: стартовый (№1), привязка линии (№2), создание линии (№6),
 *    проверка документа (№15), генерация по линиям (№17), справка (№14),
 *    разбор DOCX (№3 — по скрепке).
 */

const $ = (sel, root = document) => root.querySelector(sel);

const switcherTabsEl = $('#demo-switcher-tabs');
const docBlocksEl = $('#doc-blocks');
const docPleasEl = $('#doc-pleas');
const feedEl = $('#assistant-feed');
const assistantScrollEl = $('#assistant-scroll');
const contextEl = $('#input-context');
const promptEl = $('#prompt-input');
const sendBtn = $('#btn-send');
const attachBtn = $('#btn-attach');
const assistantInputEl = $('#assistant-input');
const scenarioBannerTitleEl = $('#scenario-banner-title');
const scenarioBannerStepEl = $('#scenario-banner-step');
const scenarioBannerMenuBtn = $('#scenario-banner-menu');
const scenarioBannerDropdown = $('#scenario-banner-dropdown');
const scenarioAbortBtn = $('#scenario-abort');
const topbarTitleEl = $('#topbar-title');
const docTitleEl = $('#doc-title');
const docHeaderBodyEl = $('#doc-header-body');

/* ================= Состояние ================= */

const state = {
  tabIndex: 0,
  card: null,          // рабочая копия карточки дела (в чате не показывается)
  blocks: null,        // рабочая копия блоков документа (у блока: section 'facts'|'admission'|'law'|'defense')
  pleas: null,         // пункты просительной части
  structure: null,     // активные плейсхолдеры структуры (DOC_STRUCTURE[type]) или null
  factsSource: null,   // как заполнены обстоятельства: 'card' | 'verdict' | 'own'
  boundLines: null,    // Set id линий, уже привязанных к блокам
  warnExplained: false, // объяснение про «!» у блоков уже показано в чате
  activeBlockId: null,
  activeSubpart: null, // { blockId, key, title } — подблок конструктора в контексте чата
  docType: null,       // { key, label } после стартового сценария
  scenario: null,      // { id, title, stage: 'choices'|'text', chipsSpec, chipsEl, onText, reaskText, uninterruptible }
  busy: false
};

const clone = obj => JSON.parse(JSON.stringify(obj));
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ================= Переключатель раскладов ================= */

function renderSwitcher() {
  switcherTabsEl.innerHTML = '';
  DEMO_TABS.forEach((tab, i) => {
    const btn = document.createElement('button');
    btn.className = 'demo-tab' + (i === state.tabIndex ? ' is-active' : '');
    btn.textContent = tab.tab;
    btn.title = tab.hint;
    btn.addEventListener('click', () => resetDemo(i));
    switcherTabsEl.appendChild(btn);
  });
}

/** Полный сброс контекста под выбранный таб. */
function resetDemo(tabIndex) {
  const tab = DEMO_TABS[tabIndex];
  state.tabIndex = tabIndex;
  state.card = clone(tab.card);
  state.blocks = clone(DOC_BLOCKS);
  state.pleas = [];
  state.structure = null;
  state.factsSource = null;
  state.boundLines = new Set();
  state.warnExplained = false;
  state.activeSubpart = null;
  state.activeBlockId = null;
  state.docType = null;
  state.scenario = null;
  state.busy = false;

  feedEl.innerHTML = '';
  promptEl.value = '';
  autosize();
  setBusy(false);

  const cb = $('#text-only-cb');
  if (cb) {
    cb.checked = false;
    document.body.classList.remove('text-only');
  }

  topbarTitleEl.textContent = 'Новый документ';
  docTitleEl.textContent = 'Новый документ';
  docHeaderBodyEl.innerHTML = '<p class="placeholder">Шапка документа сформируется после выбора типа</p>';

  renderSwitcher();
  renderBlocks();
  renderPleas();
  renderContextChip();

  if (tab.demoNote) addMessage('demo', tab.demoNote);
  startDocTypeScenario();
}

/* ================= Документ ================= */

const SECTION_ORDER = ['verdict', 'facts', 'admission', 'law', 'defense'];

/** Короткое имя линии для панели блока. */
const shortLineTitle = t => (t || '').replace(/^Линия \d+:\s*/, '').split(' — ')[0];

/** Чего не хватает блоку по его сводке (галочка не зелёная, пока список не пуст). */
function blockIssues(block) {
  const isDefense = (block.section || 'defense') === 'defense' || !!(block.parts && block.parts.length);
  if (!isDefense) {
    return hasTextPlaceholder(block.html) ? ['не заполнены поля'] : [];
  }
  const issues = [];
  if (!block.lineId) issues.push('нет линии защиты', 'нет аргументов');
  if (!(block.evidence && block.evidence.length)) issues.push('нет доказательств');
  if (block.argsStale) issues.push('аргументы не обновлены');
  return issues;
}

/**
 * Панель состава и действий внутри блока (итерация 2):
 * флаги + кнопки (без «Короче/Подробнее/Вопрос»), справа «Перегенерировать»
 * (активна при ручных изменениях конструктора) и «Завершить/Открыть конструктор».
 */
function buildBlockMeta(block) {
  const meta = document.createElement('div');
  meta.className = 'doc-block__meta';
  meta.contentEditable = 'false';

  const isCtor = !!(block.parts && block.parts.length);
  const isDefense = (block.section || 'defense') === 'defense' || isCtor;
  let barBtns;

  if (isDefense) {
    const line = state.card.lines.find(l => l.id === block.lineId) || null;
    const evCount = (block.evidence || []).length;
    const argsPart = block.parts ? block.parts.find(p => p.key === 'arguments') : null;
    const argsOk = !!(argsPart && stripTags(argsPart.html).trim());
    // все флаги-кнопки и действия — в одну линию
    barBtns = [
      ['line-modal', line ? 'Линия: ' + shortLineTitle(line.title) : 'Линия защиты не привязана', !line, 'meta-btn--line'],
      ['evidence-modal', evCount ? 'Доказательства: ' + evCount : 'Нет привязанных доказательств', !evCount, ''],
      ['args-modal', argsOk ? 'Аргументы: есть' : 'Нет аргументов', !argsOk, ''],
      ['practice-modal', 'Практика', false, ''],
      ['rewrite', 'Редактировать с ИИ', false, '']
    ];
  } else {
    barBtns = [['rewrite', 'Редактировать с ИИ', false, '']];
  }

  const rightHtml = (isCtor ? `
    <button class="meta-regen" data-special="regen" ${block.dirty ? '' : 'disabled'}>Перегенерировать</button>
    <button data-special="ctor-toggle">${block.constructorDone ? 'Открыть конструктор' : 'Закрыть конструктор для блока'}</button>` : '')
    + '<button class="meta-del" data-special="delete" title="Удалить блок">Удалить</button>';

  meta.innerHTML = `
    <div class="doc-block__tools">
      <div class="doc-block__tools-left">${barBtns.map(([id, label, warn, cls]) =>
        `<button data-tool="${id}" class="${warn ? 'meta-btn--warn' : ''} ${cls}" title="${label}">${label}</button>`).join('')}</div>
      <div class="doc-block__tools-right">${rightHtml}</div>
    </div>`;

  meta.querySelectorAll('button[data-tool]').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      const id = btn.dataset.tool;
      setActiveBlock(block.id);
      if (state.busy) return;
      switch (id) {
        case 'line-modal': openLineModal(block); return;
        case 'args-modal': openArgsModal(block); return;
        case 'practice-modal': openPracticeModal(block); return;
        case 'evidence-modal':
          onStarAction({ id: 'bind-evidence', label: BLOCK_ACTION_LABELS['bind-evidence'], needsBlock: true });
          return;
        default:
          onStarAction({ id, label: BLOCK_ACTION_LABELS[id] || btn.textContent, needsBlock: id !== 'practice' });
      }
    });
  });
  meta.querySelector('[data-special="regen"]')?.addEventListener('click', e => {
    e.stopPropagation();
    onRegenerateClick(block);
  });
  meta.querySelector('[data-special="ctor-toggle"]')?.addEventListener('click', e => {
    e.stopPropagation();
    toggleConstructor(block);
  });
  meta.querySelector('[data-special="delete"]')?.addEventListener('click', e => {
    e.stopPropagation();
    confirmDeleteBlock(block);
  });
  return meta;
}

/** Удаление блока с подтверждением. */
function confirmDeleteBlock(block) {
  openModal({
    title: 'Удаление блока',
    bodyHtml: `Удалить ${block.label} из документа?`,
    buttons: [
      { label: 'Отмена' },
      {
        label: 'Удалить',
        primary: true,
        onClick: () => {
          closeModal();
          const label = block.label;
          const idx = state.blocks.indexOf(block);
          if (idx >= 0) state.blocks.splice(idx, 1);
          if (state.activeBlockId === block.id) {
            state.activeBlockId = null;
            state.activeSubpart = null;
          }
          renderBlocks();
          renderContextChip();
          addMessage('assistant', `${label} удалён из документа.`);
        }
      }
    ]
  });
}

/** Конструктор: подблоки-сущности с отдельными заголовками, редактируются по одному. */
function buildConstructor(block) {
  const ctor = document.createElement('div');
  ctor.className = 'doc-constructor';
  ctor.contentEditable = 'false';
  block.parts.forEach(part => {
    const sub = document.createElement('div');
    sub.className = 'doc-sub';

    if (part.key === 'arguments') {
      sub.innerHTML = `<div class="doc-sub__title" contenteditable="false">${part.title}</div>`;
      sub.appendChild(buildArgsEditor(block));
      sub.addEventListener('click', e => {
        e.stopPropagation();
        setActiveBlock(block.id);
        setActiveSubpart({ blockId: block.id, key: 'arguments', title: 'Аргументы' });
      });
      ctor.appendChild(sub);
      return;
    }

    const bodyHtml = part.key === 'norms' ? linkifyNorms(part.html) : part.html;
    sub.innerHTML = `
      <div class="doc-sub__title" contenteditable="false">${part.title}</div>
      <div class="doc-sub__body" contenteditable="true"${part.key === 'other' ? ' data-ph="Добавьте свободные факты и доводы…"' : ''}>${bodyHtml}</div>`;
    const body = sub.querySelector('.doc-sub__body');
    body.addEventListener('input', () => {
      part.html = body.innerHTML;
      markDirty(block, part.title, part.key);
    });
    // клик по подблоку кладёт его в контекст чата — можно отредактировать с ИИ
    body.addEventListener('click', e => {
      e.stopPropagation();
      setActiveBlock(block.id);
      setActiveSubpart({ blockId: block.id, key: part.key, title: part.title });
    });
    ctor.appendChild(sub);
  });
  return ctor;
}

/** Редактор аргументов: подподблоки с источниками, удалением и добавлением. */
function buildArgsEditor(block) {
  const wrap = document.createElement('div');
  wrap.className = 'doc-args';

  if (block.argsStale) {
    const banner = document.createElement('div');
    banner.className = 'doc-args__stale';
    banner.innerHTML = '<span>Данные обновлены</span><button type="button">Обновить аргументы</button>';
    banner.querySelector('button').addEventListener('click', e => {
      e.stopPropagation();
      refreshArguments(block);
    });
    wrap.appendChild(banner);
  }

  (block.argsList || []).forEach((arg, i) => {
    const item = document.createElement('div');
    item.className = 'doc-arg';
    item.innerHTML = `
      <div class="doc-arg__text" contenteditable="true">${arg.text}</div>
      <span class="doc-arg__src${arg.auto ? '' : ' doc-arg__src--manual'}">${arg.auto ? 'авто · ' + (SRC_LABELS[arg.source] || 'факт') : 'вручную'}</span>
      <button class="doc-arg__del" title="Удалить аргумент" type="button">×</button>`;
    const text = item.querySelector('.doc-arg__text');
    text.addEventListener('input', () => {
      arg.text = text.innerText;
      syncArgsPart(block);
      markDirty(block, 'Аргументы', 'arguments');
    });
    item.querySelector('.doc-arg__del').addEventListener('click', e => {
      e.stopPropagation();
      block.argsList.splice(i, 1);
      syncArgsPart(block);
      block.dirty = true;
      block.dirtyNotified = true;
      renderBlocks();
      addMessage('assistant', `Аргумент удалён из ${labelGen(block.label)}. Кнопка «Перегенерировать» активна.`);
    });
    wrap.appendChild(item);
  });

  const add = document.createElement('button');
  add.className = 'doc-arg__add';
  add.type = 'button';
  add.textContent = '+ Добавить аргумент';
  add.addEventListener('click', e => {
    e.stopPropagation();
    block.argsList = block.argsList || [];
    block.argsList.push({ text: '', source: null, auto: false, poolIdx: null });
    renderBlocks();
    const items = document.querySelectorAll(`.doc-block[data-block-id="${block.id}"] .doc-arg__text`);
    const last = items[items.length - 1];
    if (last) last.focus();
  });
  wrap.appendChild(add);

  return wrap;
}

/** Обновление аргументов после изменения связанных данных (источников). */
async function refreshArguments(block) {
  if (state.busy) return;
  await think(`Обновляю аргументы ${labelGen(block.label)}`, 1500);

  const hasPractice = !!(block.parts && block.parts.find(p => p.key === 'practice'));
  const hasCirc = !!(block.parts && block.parts.find(p => p.key === 'circumstances'));
  block.argsList = (block.argsList || []).filter(a => {
    if (!a.auto) return true;
    if (a.source === 'practice' && !hasPractice) return false;
    if (a.source === 'circumstances' && !hasCirc) return false;
    return true;
  });
  if ((block.evidence || []).length && !block.argsList.some(a => a.source === 'evidence')) {
    block.argsList.push({ text: 'Позиция защиты подтверждается приобщёнными доказательствами, исследованными в судебном заседании.', source: 'evidence', auto: true, poolIdx: null });
  }
  block.argsStale = false;
  syncArgsPart(block);
  block.dirty = true;
  block.dirtyNotified = true;
  renderBlocks();
  flashBlock(block.id);
  addMessage('assistant', `Аргументы ${labelGen(block.label)} обновлены с учётом изменённых данных. Проверьте состав и нажмите «Перегенерировать».`);
}

/** Пометить аргументы устаревшими (изменился связанный подблок) без перерисовки. */
function markArgsStale(block) {
  if (!block.parts || block.argsStale) return;
  block.argsStale = true;
  const el = document.querySelector(`.doc-block[data-block-id="${block.id}"] .doc-args`);
  if (el && !el.querySelector('.doc-args__stale')) {
    const banner = document.createElement('div');
    banner.className = 'doc-args__stale';
    banner.innerHTML = '<span>Данные обновлены</span><button type="button">Обновить аргументы</button>';
    banner.querySelector('button').addEventListener('click', e => {
      e.stopPropagation();
      refreshArguments(block);
    });
    el.prepend(banner);
  }
  updateChecklist();
}

/** Кликабельные нормы права в «Нормативной опоре». */
function linkifyNorms(html) {
  if (!html || html.includes('norm-link')) return html;
  let out = html;
  Object.keys(NORMS_DB).sort((a, b) => b.length - a.length).forEach(k => {
    out = out.split(k).join(`<span class="norm-link" data-norm="${k}">${k}</span>`);
  });
  return out;
}

function openNormModal(key) {
  const db = NORMS_DB[key];
  if (!db) return;
  openModal({
    title: `Нормативная база · ${db.act}`,
    bodyHtml: `<div class="norm-view"><div class="norm-view__title">${db.title}</div><p>${db.text}</p></div>`,
    buttons: [{ label: 'Закрыть' }]
  });
}

// capture-фаза: клики подблоков гасят всплытие, а норма должна открыться в любом случае
docBlocksEl.addEventListener('click', e => {
  const link = e.target.closest('.norm-link');
  if (link) {
    e.stopPropagation();
    e.preventDefault();
    openNormModal(link.dataset.norm);
  }
}, true);

/** Подблок сгенерированного текста (снизу); пустой — с ручным вводом. */
function buildGenerated(block) {
  const gen = document.createElement('div');
  gen.className = 'doc-generated';
  gen.contentEditable = 'false';
  gen.innerHTML = `
    <div class="doc-sub__title" contenteditable="false">Текст блока</div>
    <div class="doc-generated__body" contenteditable="true" data-ph="Введите текст блока…">${block.generated || ''}</div>`;
  const body = gen.querySelector('.doc-generated__body');
  body.addEventListener('input', () => {
    block.generated = body.innerHTML;
  });
  return gen;
}

/** «Блок 3» → «Блока 3» для отбивок в чат. */
const labelGen = label => (label || '').replace(/^Блок /, 'Блока ');

/** Ручное изменение конструктора: активируем «Перегенерировать», одно уведомление в чат. */
function markDirty(block, what, partKey) {
  block.dirty = true;
  const btn = document.querySelector(`.doc-block[data-block-id="${block.id}"] .meta-regen`);
  if (btn) btn.disabled = false;
  // связанные с аргументами подблоки изменились — аргументы требуют обновления
  if (partKey && partKey !== 'arguments' && ['norms', 'practice', 'circumstances', 'other', 'evidence'].includes(partKey)) {
    markArgsStale(block);
  }
  if (!block.dirtyNotified) {
    block.dirtyNotified = true;
    addMessage('assistant', `Изменён конструктор ${labelGen(block.label)}: ${what.toLowerCase()}. Кнопка «Перегенерировать» стала активна.`);
  }
  updateChecklist();
}

async function onRegenerateClick(block) {
  if (state.busy || !block.dirty) return;
  await think(`Перегенерирую текст ${labelGen(block.label)}`, 1800);
  block.generated = generateFromParts(block.parts);
  block.dirty = false;
  block.dirtyNotified = false;
  renderBlocks();
  flashBlock(block.id);
  addMessage('assistant', `Текст ${labelGen(block.label)} перегенерирован по данным конструктора.`);
}

function toggleConstructor(block) {
  block.constructorDone = !block.constructorDone;
  renderBlocks();
}

function renderBlocks() {
  docBlocksEl.innerHTML = '';
  let counter = 0;

  const renderBlockEl = block => {
    counter += 1;
    block.label = `Блок ${counter}`;
    const issuesOk = !blockIssues(block).length;
    const el = document.createElement('div');
    el.className = 'doc-block' + (block.id === state.activeBlockId ? ' is-active' : '');
    el.dataset.blockId = block.id;

    // метка и статус в sticky-обёртке: прилипают при скролле длинного блока
    const headHtml = `
      <div class="doc-block__pin" contenteditable="false">
        <span class="doc-block__label">${block.label}</span>
        <button class="doc-block__status ${issuesOk ? 'is-done' : ''}"
                title="${issuesOk ? 'Готово' : 'По сводке блока чего-то не хватает'}" tabindex="-1"></button>
      </div>`;

    if (block.parts && block.parts.length) {
      // конструкторный блок: сводка/кнопки -> конструктор -> сгенерированный текст
      // (кнопки сверху, чтобы «Закрыть/Открыть конструктор» не меняла положение)
      el.contentEditable = 'false';
      el.innerHTML = headHtml;
      const meta = buildBlockMeta(block);
      meta.classList.add('doc-block__meta--top');
      el.appendChild(meta);
      if (!block.constructorDone) el.appendChild(buildConstructor(block));
      el.appendChild(buildGenerated(block));
    } else {
      el.contentEditable = 'true';
      el.innerHTML = `${headHtml}${block.html}`;
      el.appendChild(buildBlockMeta(block));
      // правки пользователя в редакторе сохраняются в стейт и переживают перерисовку
      el.addEventListener('input', () => {
        const copy = el.cloneNode(true);
        copy.querySelector('.doc-block__pin')?.remove();
        copy.querySelector('.doc-block__meta')?.remove();
        block.html = copy.innerHTML;
        updateChecklist();
      });
    }

    el.addEventListener('focusin', () => setActiveBlock(block.id));
    el.addEventListener('click', () => {
      setActiveBlock(block.id);
      if (state.activeSubpart && state.activeSubpart.blockId === block.id) setActiveSubpart(null);
    });
    docBlocksEl.appendChild(el);
  };

  // точка вставки нового блока между блоками (появляется при наведении, «+» слева)
  const addInsertZone = afterBlock => {
    const z = document.createElement('div');
    z.className = 'doc-insert';
    z.contentEditable = 'false';
    z.innerHTML = '<div class="doc-insert__line"></div><button class="doc-insert__btn" title="Создать блок здесь">+</button>';
    z.querySelector('button').addEventListener('click', e => {
      e.stopPropagation();
      insertEmptyBlock(afterBlock.id, afterBlock.section || 'defense');
    });
    docBlocksEl.appendChild(z);
  };

  // постоянная точка вставки в конце, перед просительной частью
  const appendAddBlockButton = () => {
    const btn = document.createElement('button');
    btn.className = 'doc-add-block';
    btn.textContent = '+ Новый блок';
    btn.title = 'Добавить блок в конец документа, перед просительной частью';
    btn.addEventListener('click', () => insertEmptyBlock(null, 'defense'));
    docBlocksEl.appendChild(btn);
  };

  if (!state.structure) {
    if (!state.blocks.length) {
      docBlocksEl.innerHTML = '<div class="doc-empty">В документе пока нет блоков — текст появится по мере работы сценариев</div>';
    } else {
      state.blocks.forEach(b => { renderBlockEl(b); addInsertZone(b); });
    }
    appendAddBlockButton();
    updateChecklist();
    return;
  }

  // документ со структурой: секции по порядку, пустая секция = рамка-плейсхолдер
  // (секции-шаблоны, template: true, рамок не имеют — заполняются текстом сразу)
  SECTION_ORDER.forEach(sec => {
    const secBlocks = state.blocks.filter(b => (b.section || 'defense') === sec);
    const ph = state.structure.find(p => p.kind === sec);
    if (secBlocks.length) secBlocks.forEach(b => { renderBlockEl(b); addInsertZone(b); });
    else if (ph && !ph.template) docBlocksEl.appendChild(buildPlaceholder(ph));
  });
  appendAddBlockButton();
  updateChecklist();
}

/** Пустой блок в указанном месте: сразу активен, можно печатать или привязать линию. */
function insertEmptyBlock(afterId, section) {
  const opts = afterId ? { afterId, section, kind: 'manual' } : { section, kind: 'manual' };
  const id = insertBlock('', opts);
  setActiveBlock(id);
  const el = document.querySelector(`.doc-block[data-block-id="${id}"]`);
  if (el) el.focus();
  addMessage('assistant', `Добавлен пустой ${getBlock(id).label} — введите текст прямо в документе или привяжите линию защиты.`);
}

/* ================= Просительная часть ================= */

function pleaIntro() {
  const k = state.docType ? state.docType.key : null;
  if (k === 'appeal') return 'На основании изложенного, руководствуясь ст. 389.15, 389.20 УПК РФ, ПРОШУ:';
  if (k === 'cassation') return 'На основании изложенного, руководствуясь ст. 401.14, 401.15 УПК РФ, ПРОШУ:';
  if (k === 'motion') return 'На основании изложенного, руководствуясь ст. 119–122 УПК РФ, ПРОШУ:';
  return 'На основании изложенного ПРОШУ:';
}

function renderPleas() {
  if (!state.pleas.length) {
    // рамка-плейсхолдер просительной части (не интерактивная — по спеке)
    if (state.structure && state.structure.some(p => p.kind === 'pleas')) {
      const after = state.docType && state.docType.key === 'motion' ? 'обоснования' : 'защитной части';
      docPleasEl.innerHTML = `
        <div class="doc-ph doc-ph--static">
          <div class="doc-ph__title">Просительная часть</div>
          <div class="doc-ph__note">Будет сгенерирована автоматически после заполнения ${after}</div>
        </div>`;
    } else {
      docPleasEl.innerHTML = '';
    }
    updateChecklist();
    return;
  }
  docPleasEl.innerHTML = `
    <div class="doc-pleas" contenteditable="true">
      <div class="doc-pleas__intro">${pleaIntro()}</div>
      <ol>${state.pleas.map(p => `<li>${p}</li>`).join('')}</ol>
    </div>`;
  updateChecklist();
}

/** Добавляет пункт в просительную часть (без дублей) и подсвечивает её. */
function addPlea(text) {
  if (!text || state.pleas.includes(text)) return;
  state.pleas.push(text);
  renderPleas();
  const el = docPleasEl.querySelector('.doc-pleas');
  if (el) {
    el.classList.add('flash');
    setTimeout(() => el.classList.remove('flash'), 1600);
  }
}

/* ================= Структура документа: плейсхолдеры и чеклист (ревизия 16.07.26) ================= */

const factsFilled = () => state.blocks.some(b => (b.section || 'defense') === 'facts');

const PH_ACTION_TITLES = {
  'verdict-card': 'Заполнить описание приговора',
  'verdict-own': 'Описание приговора своими словами',
  'facts-card': 'Заполнить обстоятельства из карточки дела',
  'facts-verdict': 'Разбор файла',
  'facts-own': 'Заполнить обстоятельства своими словами',
  'admission-fill': 'Заполнить признание по эпизодам',
  'defense-add': 'Создание линии защиты',
  'law-auto': 'Подобрать правовое обоснование',
  'law-own': 'Правовое обоснование своими словами'
};

/** Рамка-плейсхолдер секции. По наведению показывает кнопки (CSS). */
function buildPlaceholder(ph) {
  const el = document.createElement('div');
  el.className = 'doc-ph';
  el.dataset.kind = ph.kind;

  let actionsHtml = '';
  if (ph.kind === 'verdict') {
    actionsHtml =
      (state.card.verdict ? '<button data-act="verdict-card">Заполнить из карточки дела</button>' : '') +
      '<button data-act="verdict-own">Заполнить своими словами</button>';
  } else if (ph.kind === 'facts') {
    actionsHtml =
      (state.card.episodes.length ? '<button data-act="facts-card">Заполнить из карточки дела</button>' : '') +
      '<button data-act="facts-verdict">Заполнить из приговора</button>' +
      '<button data-act="facts-own">Заполнить своими словами</button>';
  } else if (ph.kind === 'admission') {
    actionsHtml = factsFilled()
      ? '<button data-act="admission-fill">Заполнить по эпизодам</button>'
      : '<span class="doc-ph__note">Сначала заполните обстоятельства дела</span>';
  } else if (ph.kind === 'defense') {
    actionsHtml = '<button data-act="defense-add">Добавить линию защиты</button>';
  } else if (ph.kind === 'law') {
    actionsHtml =
      '<button data-act="law-auto">Подобрать нормы автоматически</button>' +
      '<button data-act="law-own">Написать своими словами</button>';
  }

  el.innerHTML = `
    <div class="doc-ph__title">${ph.title}</div>
    <div class="doc-ph__actions">${actionsHtml}</div>`;

  el.querySelectorAll('button[data-act]').forEach(btn =>
    btn.addEventListener('click', () => onPlaceholderAction(btn.dataset.act)));
  return el;
}

/** Клик по кнопке плейсхолдера — фронтовое действие; поверх сценария спрашиваем «прервать?». */
function onPlaceholderAction(act) {
  if (state.busy) return;
  const run = () => runPlaceholderAction(act);
  if (state.scenario) {
    askInterrupt(PH_ACTION_TITLES[act] || 'Действие со структурой документа', run);
    return;
  }
  run();
}

async function runPlaceholderAction(act) {
  switch (act) {
    case 'verdict-card':
      await think('Формирую описание приговора', 1500);
      insertBlock(composeVerdictText(), { atStart: true, section: 'verdict', kind: 'verdict' });
      addMessage('assistant', 'Описание приговора заполнено из карточки дела.');
      break;

    case 'verdict-own':
      insertBlock('<span class="ph-mark">Опишите приговор первой инстанции</span>', { atStart: true, section: 'verdict', kind: 'verdict-own' });
      addMessage('assistant', 'Заполните описание приговора самостоятельно в документе.');
      break;

    case 'facts-card':
      state.factsSource = 'card';
      await think('Формирую описание обстоятельств из карточки дела', 1600);
      insertBlock(composeFactsText(), { atStart: true, section: 'facts', kind: 'facts' });
      addMessage('assistant', 'Обстоятельства дела заполнены из карточки дела.');
      await maybeAutoAdmission();
      break;

    case 'facts-verdict':
      state.factsSource = 'verdict';
      runDocxScenario(); // сценарий 3, по завершении сам запустит 17
      break;

    case 'facts-own':
      state.factsSource = 'own';
      insertBlock('<span class="ph-mark">Опишите обстоятельства дела</span>', { atStart: true, section: 'facts', kind: 'facts-own' });
      addMessage('assistant', 'Заполните обстоятельства дела самостоятельно в документе или сформулируйте кратко в чате.');
      break;

    case 'admission-fill':
      await think('Формирую позицию по вине по эпизодам', 1400);
      insertBlock(composeAdmissionText(), { section: 'admission', kind: 'admission' });
      addMessage('assistant', 'Позиция по вине заполнена.');
      break;

    case 'defense-add':
      startCreateLine(); // сценарий 6
      break;

    case 'law-auto':
      await think('Подбираю правовое обоснование', 1500);
      insertBlock(MOTION_LAW_TEXT, { section: 'law', kind: 'law' });
      addMessage('assistant', 'Правовое обоснование добавлено в документ.');
      break;

    case 'law-own':
      insertBlock('<span class="ph-mark">Изложите правовое обоснование ходатайства</span>', { section: 'law', kind: 'law-own' });
      addMessage('assistant', 'Заполните правовое обоснование самостоятельно в документе.');
      break;
  }
}

/** Разово поясняем в чате значок «!» у блоков, требующих завершения. */
function maybeExplainWarnings() {
  if (state.warnExplained) return;
  if (!state.blocks.some(b => blockIssues(b).length)) return;
  state.warnExplained = true;
  const el = addMessage('assistant', '');
  el.innerHTML = 'Значком <span class="msg-warn-icon">!</span> отмечены блоки текста, которые требуют завершения — например, в них не хватает доказательств. Чего именно не хватает, видно в сводке блока.';
  scrollFeed();
}

/** Если признание известно по всем эпизодам — генерируем секцию автоматически. */
async function maybeAutoAdmission({ silent } = {}) {
  if (!state.structure || !state.structure.some(p => p.kind === 'admission')) return false;
  if (state.blocks.some(b => (b.section || 'defense') === 'admission')) return false;
  if (!factsFilled()) return false;
  const eps = state.card.episodes;
  if (!eps.length || !eps.every(ep => ep.admission)) return false;

  await think('Формирую позицию по вине по эпизодам', 1200);
  insertBlock(composeAdmissionText(), { section: 'admission', kind: 'admission' });
  if (!silent) addMessage('assistant', 'Признание заполнено автоматически по данным карточки дела.');
  return true;
}

/** Блок «Признание»: по эпизодам, неизвестные значения — тёмно-жёлтым маркером. */
function composeAdmissionText() {
  if (state.factsSource === 'own') {
    return '<span class="ph-mark">Заполните позицию по вине</span>';
  }
  const fromVerdict = state.factsSource === 'verdict';
  return state.card.episodes.map((ep, i) => {
    const qual = ep.qualification || '<span class="ph-mark">указать квалификацию</span>';
    const adm = ep.admission || (fromVerdict ? 'вину не признал' : '<span class="ph-mark">указать статус признания</span>');
    return `По эпизоду ${i + 1}, ${qual} — ${adm}.`;
  }).join('<br>');
}

/* ---------- Чеклист наполнения (строка состояния) ---------- */

const docChecklistEl = $('#doc-checklist');

const CHECK_ICONS = {
  empty: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8" fill="none" stroke="currentColor" stroke-width="2"/></svg>',
  warn: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9" fill="currentColor" opacity=".18"/><path d="M12 7v6" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/><circle cx="12" cy="16.6" r="1.3" fill="currentColor"/></svg>',
  done: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9" fill="currentColor" opacity=".18"/><path d="m7.5 12.5 3 3 6-6.5" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>'
};

const hasTextPlaceholder = html => /ph-mark|&lt;вставить|<вставить/i.test(html || '');

function updateChecklist() {
  if (!docChecklistEl) return;
  if (!state.docType || !state.structure) {
    docChecklistEl.hidden = true;
    return;
  }

  const items = [];

  // шапка — обязательно; незавершённое заполнение (плейсхолдеры) подсвечиваем жёлтым
  const headerHtml = docHeaderBodyEl.innerHTML;
  const headerHasPh = /ph-mark|вставить/i.test(headerHtml);
  const headerEmpty = /placeholder/i.test(headerHtml);
  items.push({ label: 'Шапка', st: headerEmpty ? 'empty' : headerHasPh ? 'warn' : 'done' });

  state.structure.forEach(ph => {
    if (ph.kind === 'pleas') {
      items.push({ label: ph.title, st: state.pleas.length ? 'done' : 'empty' });
      return;
    }
    const secBlocks = state.blocks.filter(b => (b.section || 'defense') === ph.kind);
    if (!secBlocks.length) {
      items.push({ label: ph.title, st: 'empty' });
      return;
    }
    // текстовые плейсхолдеры внутри — заполнение не завершено, жёлтым
    const blockHasPh = b => hasTextPlaceholder(b.html) ||
      (b.parts && b.parts.some(p => hasTextPlaceholder(p.html))) ||
      hasTextPlaceholder(b.generated);
    if (secBlocks.some(blockHasPh)) {
      items.push({ label: ph.title, st: 'warn' });
      return;
    }
    if (ph.kind === 'defense') {
      const issuesFree = secBlocks.every(b => !blockIssues(b).length);
      items.push({ label: ph.title, st: issuesFree ? 'done' : 'warn' });
      return;
    }
    items.push({ label: ph.title, st: 'done' });
  });

  docChecklistEl.hidden = false;
  docChecklistEl.innerHTML = items.map(i =>
    `<span class="check-item check-item--${i.st}" title="${i.st === 'done' ? 'Готово' : i.st === 'warn' ? 'Имеются недостатки' : 'Не заполнено'}">${CHECK_ICONS[i.st]}${i.label}</span>`
  ).join('');
}

/** Метки источников аргументов. */
const SRC_LABELS = {
  practice: 'практика',
  circumstances: 'обстоятельства',
  norms: 'нормативка',
  evidence: 'доказательства',
  fact: 'факт'
};

/** Стартовый список аргументов по линии: первые два из пула, авто. */
function defaultArgsList(line) {
  const pool = line.argumentsPool || [];
  if (!pool.length) {
    const text = (line.argument || line.thesis || REGEN_FALLBACK_TEXT).replace(/\s+/g, ' ').trim();
    return [{ text, source: 'fact', auto: true, poolIdx: null }];
  }
  return pool.slice(0, 2).map((a, i) => ({ text: a.text, source: a.source, auto: true, poolIdx: i }));
}

/** Синхронизация подблока «Аргументы» с списком аргументов блока. */
function syncArgsPart(block) {
  if (!block.parts) return;
  const html = (block.argsList || []).map(a => a.text).filter(Boolean).join(' ');
  const part = block.parts.find(p => p.key === 'arguments');
  if (part) part.html = html;
  else block.parts.splice(1, 0, { key: 'arguments', title: 'Аргументы', html });
}

/** Подблоки конструктора по линии защиты; sel — аргументы/дела практики. */
function buildLineParts(line, sel = {}) {
  const parts = [];
  parts.push({ key: 'line', title: 'Линия защиты', html: `${shortLineTitle(line.title)}${line.thesis ? '. Тезис: ' + line.thesis : ''}` });

  const argsList = sel.argsList || defaultArgsList(line);
  parts.push({ key: 'arguments', title: 'Аргументы', html: argsList.map(a => a.text).join(' ') });

  if (line.norms) parts.push({ key: 'norms', title: 'Нормативная опора', html: line.norms });

  const practice = state.card.practice;
  if (practice && practice.length) {
    const pSel = (sel.selectedPractice || [0, 1]).filter(i => practice[i]);
    if (pSel.length) {
      parts.push({ key: 'practice', title: 'Практика', html: pSel.map(i => `${practice[i].num} (${practice[i].court}) — ${practice[i].result.toLowerCase()}`).join('; ') + '.' });
    }
  }
  if (state.card.circumstances && state.card.circumstances.length) {
    parts.push({ key: 'circumstances', title: 'Обстоятельства', html: state.card.circumstances.join('; ') + '.' });
  }
  parts.push({ key: 'other', title: 'Другие факты и доводы', html: '' });
  return parts;
}

/** Генерация текста блока по фактуре конструктора. */
function generateFromParts(parts) {
  const get = k => stripTags((parts.find(p => p.key === k) || {}).html || '').replace(/\.$/, '');
  const dot = s => s ? s + '.' : '';
  const args = get('arguments');
  const circ = get('circumstances');
  const ev = get('evidence');
  const norms = get('norms');
  const practice = get('practice');

  let text = dot(args);
  if (circ) text += ` При оценке содеянного подлежат учёту обстоятельства: ${circ.charAt(0).toLowerCase()}${circ.slice(1)}.`;
  if (ev) text += ` Изложенное подтверждается доказательствами: ${ev.charAt(0).toLowerCase()}${ev.slice(1)}.`;
  if (norms) text += ` Правовое обоснование: ${norms}.`;
  if (practice) text += ` Аналогичная позиция отражена в судебной практике: ${practice}.`;
  return text.trim();
}

/** Вставка конструкторного блока по линии: конструктор + сразу сгенерированный текст. */
function insertLineBlock(line, opts = {}) {
  const argsList = defaultArgsList(line);
  const selectedPractice = state.card.practice && state.card.practice.length
    ? [0, 1].filter(i => state.card.practice[i]) : null;
  const parts = buildLineParts(line, { argsList, selectedPractice });
  const id = insertBlock('', { ...opts, lineId: line.id, parts, generated: generateFromParts(parts) });
  const b = getBlock(id);
  b.argsList = argsList;
  b.selectedPractice = selectedPractice;
  b.argsStale = false;
  return id;
}

/** Привязка линии к блоку: полная перезаливка конструктора и текста. */
function applyLineToBlock(block, line, { silent } = {}) {
  block.lineId = line.id;
  block.argsList = defaultArgsList(line);
  block.argsStale = false;
  block.selectedPractice = state.card.practice && state.card.practice.length
    ? [0, 1].filter(i => state.card.practice[i]) : null;
  block.parts = buildLineParts(line, { argsList: block.argsList, selectedPractice: block.selectedPractice });
  block.generated = generateFromParts(block.parts);
  block.evidence = block.evidence || [];
  block.dirty = false;
  block.dirtyNotified = false;
  block.constructorDone = false;
  state.boundLines.add(line.id);
  addPlea(line.plea || PLEA_FALLBACK);
  renderBlocks();
  flashBlock(block.id);
  if (!silent) addMessage('assistant', `К ${labelGen(block.label).replace('Блока', 'Блоку')} привязана линия «${shortLineTitle(line.title)}» — конструктор и текст заполнены заново.`);
}

/** «Вся информация блока будет удалена» — блок становится пустым. */
function clearBlockInfo(block) {
  block.lineId = null;
  block.parts = null;
  block.generated = '';
  block.html = '';
  block.evidence = [];
  block.argsList = null;
  block.argsStale = false;
  block.selectedPractice = null;
  block.dirty = false;
  block.dirtyNotified = false;
  block.constructorDone = false;
  renderBlocks();
  updateChecklist();
}

/**
 * Текст блока по линии — сущности отдельными абзацами (ревизия v3):
 * линия защиты, аргументы, нормативка, практика, обстоятельства.
 * Доказательства добавляются своим абзацем при привязке (16.1).
 */
function composeBlockText(line) {
  const paras = [];
  paras.push(`<p><b>Линия защиты:</b> ${shortLineTitle(line.title)}${line.thesis ? '. Тезис: ' + line.thesis : ''}</p>`);
  paras.push(`<p><b>Аргументы:</b> ${line.argument || line.thesis || REGEN_FALLBACK_TEXT}</p>`);
  if (line.norms) paras.push(`<p><b>Нормативное обоснование:</b> ${line.norms}</p>`);
  const practice = state.card.practice;
  if (practice && practice.length) {
    paras.push(`<p><b>Практика:</b> ${practice.slice(0, 2).map(p => `${p.num} (${p.court}) — ${p.result.toLowerCase()}`).join('; ')}.</p>`);
  }
  if (state.card.circumstances && state.card.circumstances.length) {
    paras.push(`<p><b>Обстоятельства:</b> ${state.card.circumstances.join('; ')}.</p>`);
  }
  return paras.join('');
}

/** Описание приговора первой инстанции (для кассации — плюс апелляционное определение). */
function composeVerdictText() {
  const c = state.card;
  const v = c.verdict || {};
  const mark = t => `<span class="ph-mark">${t}</span>`;
  const client = c.client || mark('указать ФИО осуждённого');
  const parts = [
    `Приговором ${v.courtName || mark('указать суд')} от ${v.date || mark('указать дату')} ` +
    `${client}${v.born ? ', ' + v.born + ',' : ''} признан виновным в совершении преступления, ` +
    `предусмотренного ${v.qualification || mark('указать квалификацию')}, и ему назначено наказание ` +
    `в виде ${v.sentence || mark('указать наказание')}.`
  ];
  if (state.docType && state.docType.key === 'cassation') {
    parts.push(c.appellateRuling || mark('Опишите апелляционное определение'));
  }
  return parts.map(p => `<p>${p}</p>`).join('');
}

function setActiveBlock(id) {
  if (state.activeBlockId === id) return;
  state.activeBlockId = id;
  state.activeSubpart = null;
  document.querySelectorAll('.doc-block').forEach(el =>
    el.classList.toggle('is-active', el.dataset.blockId === id));
  renderContextChip();
}

function setActiveSubpart(sp) {
  state.activeSubpart = sp;
  renderContextChip();
}

function getBlock(id) {
  return state.blocks.find(b => b.id === id);
}

/** Заменяет текст блока, ставит ✓ и подсвечивает. */
function regenerateBlock(id, newText) {
  const block = getBlock(id);
  if (!block) return;
  block.html = newText;
  block.status = 'done';
  renderBlocks();
  flashBlock(id);
}

/** Вставляет новый блок (в начало, после activeBlock или в конец), возвращает его id. */
function insertBlock(text, { afterId, lineId, atStart, kind, section, parts, generated } = {}) {
  const n = state.blocks.length + 1;
  const block = {
    id: `block-new-${n}`,
    label: `Блок ${n}`,
    status: 'done',
    lineId: lineId || null,
    kind: kind || null,
    section: section || 'defense',
    parts: parts || null,        // подблоки конструктора [{key, title, html}]
    generated: generated || '',  // сгенерированный текст под конструктором
    constructorDone: false,
    dirty: false,
    html: text
  };
  if (atStart) {
    state.blocks.unshift(block);
  } else {
    const idx = afterId ? state.blocks.findIndex(b => b.id === afterId) : -1;
    if (idx >= 0) state.blocks.splice(idx + 1, 0, block);
    else state.blocks.push(block);
  }
  renderBlocks(); // нумерация «Блок N» проставляется при рендере по порядку секций
  flashBlock(block.id);
  return block.id;
}

function flashBlock(id) {
  const el = document.querySelector(`.doc-block[data-block-id="${id}"]`);
  if (!el) return;
  el.classList.add('flash');
  el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  setTimeout(() => el.classList.remove('flash'), 1600);
}

/* ================= Шапка и заголовок документа ================= */

function applyDocTitle(title) {
  topbarTitleEl.textContent = title;
  docTitleEl.textContent = title;
}

/** Генерация шапки по типу документа и данным карточки (плейсхолдеры, где данных нет). */
function generateHeaderLines(type) {
  const c = state.card;
  const advName = c.advocateGen || c.advocate;
  const cliName = c.clientGen || c.client;
  const ph = t => `<span class="ph-mark">&lt;${t}&gt;</span>`;
  const advLine = advName ? `от адвоката ${advName}` : `от адвоката ${ph('вставить ФИО адвоката')}`;
  const cliLine = cliName
    ? `в интересах ${c.clientStatus ? c.clientStatus + ' ' : ''}${cliName}`
    : `в интересах ${ph('вставить ФИО доверителя')}`;

  if (type.court) {
    const court = c.court ? (type.key === 'appeal' ? c.court.appeal : c.court.cassation) : null;
    if (court) {
      // полные данные для шапки есть в карточке дела
      const lines = [`В ${court.name}`, court.address, ''];
      lines.push(advLine);
      if (c.advocateDetails) lines.push(c.advocateDetails);
      lines.push('');
      lines.push(cliLine);
      if (c.court.caseNum) lines.push(`по уголовному делу № ${c.court.caseNum}`);
      if (c.court.firstInstanceRef) lines.push(`(${c.court.firstInstanceRef})`);
      return lines;
    }
    return [`В ${ph('вставить название суда ' + type.court)}`, advLine, cliLine];
  }
  return [advLine, cliLine];
}

function renderDocHeader(lines) {
  docHeaderBodyEl.innerHTML = lines.map(l => `<p>${l}</p>`).join('');
  const wrap = docHeaderBodyEl.closest('.doc-header');
  wrap.classList.add('flash');
  wrap.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  setTimeout(() => wrap.classList.remove('flash'), 1600);
  updateChecklist();
}

// правка шапки руками тоже обновляет чеклист (убрал <вставить...> — шапка готова)
docHeaderBodyEl.addEventListener('input', () => updateChecklist());

/* ================= Чип контекста во вводе ================= */

function renderContextChip() {
  updateScenarioBanner();
  contextEl.innerHTML = '';
  if (!state.activeBlockId) return;
  const block = getBlock(state.activeBlockId);
  if (!block) return;

  const chip = document.createElement('span');
  chip.className = 'context-chip';
  const sp = state.activeSubpart;
  const chipLabel = block.label + (sp && sp.blockId === block.id ? ' · ' + sp.title : '');
  // пока идёт сценарий — пилз блока без крестика
  chip.innerHTML = state.scenario ? chipLabel : `${chipLabel}
    <button title="Отвязать блок">
      <svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/></svg>`;
  const closeBtn = chip.querySelector('button');
  if (closeBtn) closeBtn.addEventListener('click', () => {
    state.activeBlockId = null;
    state.activeSubpart = null;
    document.querySelectorAll('.doc-block').forEach(el => el.classList.remove('is-active'));
    renderContextChip();
  });
  contextEl.appendChild(chip);
}

/* ================= Баннер «Выполняется сценарий» ================= */

function updateScenarioBanner() {
  const sc = state.scenario;
  assistantInputEl.classList.toggle('has-scenario', !!sc);
  scenarioBannerTitleEl.textContent = sc ? sc.title : '';
  scenarioBannerStepEl.hidden = !(sc && sc.step);
  scenarioBannerStepEl.textContent = sc && sc.step ? 'шаг ' + sc.step : '';
  scenarioBannerDropdown.classList.remove('is-open');
}

/** Текущий шаг сценария по нумерации из дока «Ревизия сценариев». */
function setStep(step) {
  if (!state.scenario) return;
  state.scenario.step = step;
  updateScenarioBanner();
}

scenarioBannerMenuBtn.addEventListener('click', e => {
  e.stopPropagation();
  scenarioBannerDropdown.classList.toggle('is-open');
});
document.addEventListener('click', e => {
  if (!scenarioBannerDropdown.contains(e.target)) scenarioBannerDropdown.classList.remove('is-open');
});
scenarioAbortBtn.addEventListener('click', () => {
  const sc = state.scenario;
  if (!sc) return;
  if (sc.chipsEl) sc.chipsEl.classList.add('is-answered');
  state.scenario = null;
  renderContextChip();
  addMessage('assistant', `Сценарий «${sc.title}» прерван. Уже выполненные действия не откатываются.`);
});

/* ================= Лента ассистента ================= */

function scrollFeed() {
  assistantScrollEl.scrollTop = assistantScrollEl.scrollHeight;
  // и ещё раз после отрисовки — на случай, если контент дорастёт после layout
  requestAnimationFrame(() => {
    assistantScrollEl.scrollTop = assistantScrollEl.scrollHeight;
  });
}

// любое изменение ленты (сообщение, чипы, «думает», правка текста) прокручивает чат к низу
new MutationObserver(scrollFeed).observe(feedEl, { childList: true, subtree: true, characterData: true });

function addMessage(kind, text) {
  const el = document.createElement('div');
  el.className = `msg msg--${kind}`;
  el.textContent = text;
  feedEl.appendChild(el);
  scrollFeed();
  return el;
}

/** Сообщение-файл от пользователя. */
function addFileMessage(fileName) {
  const el = document.createElement('div');
  el.className = 'msg msg--user msg--file';
  el.innerHTML = `<svg viewBox="0 0 24 24"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><path d="M14 3v5h5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg>${fileName}`;
  feedEl.appendChild(el);
  scrollFeed();
}

/** «Генерация» (состояние D): блокирует ввод и чипы. */
async function think(text, ms = 1400) {
  setBusy(true);
  const el = document.createElement('div');
  el.className = 'msg msg--thinking';
  el.innerHTML = `${text}<span class="dots"></span>`;
  feedEl.appendChild(el);
  scrollFeed();
  await sleep(ms);
  el.remove();
  setBusy(false);
}

function setBusy(busy) {
  state.busy = busy;
  promptEl.disabled = busy;
  sendBtn.disabled = busy;
  const star = document.querySelector('#btn-star');
  if (star) star.disabled = busy;
  feedEl.classList.toggle('is-busy', busy);
}

/* ================= Движок сценариев ================= */

function startScenario(id, title, { uninterruptible } = {}) {
  state.scenario = {
    id, title,
    stage: null, step: null, chipsSpec: null, chipsEl: null,
    onText: null, reaskText: null,
    uninterruptible: !!uninterruptible
  };
  renderContextChip();
}

function endScenario(finalText) {
  if (finalText) addMessage('assistant', finalText);
  state.scenario = null;
  renderContextChip();
}

/**
 * Группа чипов. options: [{label, sub, wide, ghost, episode, onPick}]
 * После выбора группа замораживается, выбранный чип подсвечивается.
 */
function addChips(options) {
  const wrap = document.createElement('div');
  wrap.className = 'chips';

  options.forEach(opt => {
    const btn = document.createElement('button');
    btn.className = 'chip'
      + (opt.wide ? ' chip--wide' : '')
      + (opt.ghost ? ' chip--ghost' : '')
      + (opt.episode ? ' chip--episode' : '');
    btn.innerHTML = `<span>${opt.label}${opt.sub ? `<small class="chip__sub">${opt.sub}</small>` : ''}</span>`;
    btn.addEventListener('click', () => {
      if (state.busy || wrap.classList.contains('is-answered')) return;
      wrap.classList.add('is-answered');
      btn.classList.add('is-chosen');
      opt.onPick();
    });
    wrap.appendChild(btn);
  });

  feedEl.appendChild(wrap);
  scrollFeed();
  return wrap;
}

/** Чоисы в рамках сценария (B.1): запоминаем для перебивки и повторного показа. */
function offerChoices(options, intro) {
  if (intro) addMessage('assistant', intro);
  if (state.scenario) {
    state.scenario.stage = 'choices';
    state.scenario.chipsSpec = options;
    state.scenario.onText = null;
    state.scenario.chipsEl = addChips(options);
    return state.scenario.chipsEl;
  }
  return addChips(options);
}

/** Ожидание текстового ввода в рамках сценария (B.2). */
function awaitText(promptText, handler) {
  if (promptText) addMessage('assistant', promptText);
  state.scenario.stage = 'text';
  state.scenario.chipsSpec = null;
  state.scenario.chipsEl = null;
  state.scenario.onText = handler;
  state.scenario.reaskText = promptText;
}

/* ---------- Роутинг свободного ввода ---------- */

const normalize = s => s.toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' ').trim();

function matchTrigger(text) {
  return SCENARIO_TRIGGERS.find(t => t.re.test(text)) || null;
}

/** «Если есть пилз с таким текстом — выбираем пилз». */
function matchChipButton(text) {
  const sc = state.scenario;
  if (!sc || !sc.chipsEl || sc.chipsEl.classList.contains('is-answered')) return null;
  const q = normalize(text);
  if (q.length < 3) return null;
  return [...sc.chipsEl.querySelectorAll('.chip')].find(btn => {
    const label = normalize(btn.textContent);
    return label.includes(q) || q.includes(label);
  }) || null;
}

function launchScenario(trigger) {
  switch (trigger.id) {
    case 'bind-line': startBindLine(); break;
    case 'create-line': startCreateLine(); break;
    case 'check-doc': startCheckDoc(); break;
    case 'gen-by-lines': startGenByLines(); break;
    case 'help': startHelp(); break;
  }
}

/** Вопрос «прервать сценарий?» (правила B.1.1 / B.1.4 каркаса). */
function askInterrupt(actionTitle, onConfirm) {
  const sc = state.scenario;
  const savedSpec = sc.chipsSpec;
  const savedEl = sc.chipsEl;
  const savedStage = sc.stage;
  const savedOnText = sc.onText;
  const savedReask = sc.reaskText;

  const resume = () => {
    if (savedStage === 'choices' && savedSpec) {
      offerChoices(savedSpec, 'Продолжаем. Выберите один из вариантов:');
    } else if (savedStage === 'text') {
      sc.stage = 'text';
      sc.onText = savedOnText;
      if (savedReask) addMessage('assistant', savedReask);
    }
  };

  offerChoices([
    {
      label: 'Прервать сценарий',
      onPick: () => {
        addMessage('user', 'Прервать сценарий');
        if (savedEl) savedEl.classList.add('is-answered');
        const old = state.scenario;
        state.scenario = null;
        renderContextChip();
        addMessage('assistant', `Сценарий «${old.title}» прерван. Уже выполненные действия не откатываются.`);
        onConfirm();
      }
    },
    {
      label: 'Продолжить текущий',
      ghost: true,
      onPick: () => {
        addMessage('user', 'Продолжить текущий');
        resume();
      }
    }
  ], `Сейчас идёт сценарий «${sc.title}». Прервать его и выполнить «${actionTitle}»?`);
}

/** Текст не подходит под контекст ожидания (B.2.3.2): ответ / переформулировать / новый вопрос. */
function askTextMismatch(text, trigger) {
  const sc = state.scenario;
  const savedOnText = sc.onText;
  const savedReask = sc.reaskText;

  offerChoices([
    {
      label: 'Это был ответ',
      onPick: () => {
        addMessage('user', 'Это был ответ');
        sc.stage = 'text';
        savedOnText(text);
      }
    },
    {
      label: 'Переформулирую',
      ghost: true,
      onPick: () => {
        addMessage('user', 'Переформулирую');
        awaitText(savedReask || 'Слушаю.', savedOnText);
      }
    },
    {
      label: 'Это новый вопрос',
      ghost: true,
      onPick: () => {
        addMessage('user', 'Это новый вопрос');
        const old = state.scenario;
        state.scenario = null;
        renderContextChip();
        addMessage('assistant', `Сценарий «${old.title}» завершён.`);
        launchScenario(trigger);
      }
    }
  ], 'Похоже, это не ответ на мой вопрос. Это был ответ, переформулируете или это новый вопрос?');
}

/** Текст похож на название типа документа (определитель A.1.3.2). */
const DOC_TYPE_NAME_RE = /жалоб|ходатайств|заявлен|позици|возражен|апелляц|кассац|отзыв|обращени|документ/i;

async function routeText(text) {
  const trigger = matchTrigger(text);
  const sc = state.scenario;

  // Сценарий не запущен (состояние C)
  if (!sc) {
    if (trigger) return launchScenario(trigger);
    if (state.activeSubpart) return editSubpartWithAI(text);
    return onFreeInput(text);
  }

  // Состояние A: стартовый сценарий — команды его не прерывают
  if (sc.id === 'start-doc' && sc.stage === 'choices') {
    const chipBtn = matchChipButton(text);
    if (chipBtn) return chipBtn.click();
    if (text.length <= 60 && DOC_TYPE_NAME_RE.test(text)) {
      const label = text.charAt(0).toUpperCase() + text.slice(1);
      return finalizeDocType({ key: 'other' }, label);
    }
    addMessage('assistant', 'Сначала выберем тип документа. Выберите вариант ниже или напишите название документа своими словами.');
    return offerChoices(sc.chipsSpec);
  }

  // B.1: предложены чоисы
  if (sc.stage === 'choices') {
    const chipBtn = matchChipButton(text);
    if (chipBtn) return chipBtn.click();
    if (trigger) return askInterrupt(trigger.title, () => launchScenario(trigger));
    addMessage('assistant', 'Выберите, пожалуйста, один из предложенных вариантов. Если хотите другое действие — введите команду, и я предложу прервать сценарий.');
    if (sc.chipsSpec) offerChoices(sc.chipsSpec);
    return;
  }

  // B.2: ждём текстовый ввод
  if (sc.stage === 'text') {
    if (trigger) return askTextMismatch(text, trigger);
    const handler = sc.onText;
    sc.onText = null;
    return handler(text);
  }
}

/** Редактирование активного подблока конструктора с ИИ по запросу из чата. */
async function editSubpartWithAI(text) {
  const sp = state.activeSubpart;
  const block = getBlock(sp.blockId);
  const part = block && block.parts ? block.parts.find(p => p.key === sp.key) : null;
  if (!block || !part) {
    setActiveSubpart(null);
    return onFreeInput(text);
  }

  await think(`Редактирую подблок «${part.title}» ${labelGen(block.label)}`, 1600);

  if (sp.key === 'arguments') {
    // запрос из чата добавляет ручной аргумент
    block.argsList = block.argsList || [];
    block.argsList.push({ text: `${text.charAt(0).toUpperCase()}${text.slice(1).replace(/\.?$/, '.')}`, source: null, auto: false, poolIdx: null });
    syncArgsPart(block);
  } else {
    const base = stripTags(part.html).replace(/\s+/g, ' ').trim();
    const lead = base.split('. ').slice(0, 2).join('. ').replace(/\.?$/, '.');
    part.html = `${lead} Дополнительно учтено: ${text.charAt(0).toLowerCase()}${text.slice(1).replace(/\.?$/, '.')}`;
    if (['norms', 'practice', 'circumstances', 'other'].includes(sp.key)) block.argsStale = true;
  }
  block.dirty = true;
  block.dirtyNotified = true;
  renderBlocks();
  flashBlock(block.id);
  addMessage('assistant', `Подблок «${part.title}» ${labelGen(block.label)} отредактирован с учётом запроса. Кнопка «Перегенерировать» стала активна.`);
}

async function onFreeInput(text) {
  await think('Обрабатываю запрос', 1400);
  addMessage('assistant', '(Демо) Свободный ввод вне сценариев отвечает заглушкой. Наберите «справка» — покажу доступные команды.');
}

/* ================= Сценарий №1: стартовый (выбор типа документа) ================= */

function startDocTypeScenario() {
  startScenario('start-doc', 'Выбор типа документа', { uninterruptible: true });
  setStep('1.1');
  addMessage('assistant', WELCOME_TEXT).classList.add('msg--pre');
  offerDocTypeChoices();
}

function offerDocTypeChoices(intro) {
  offerChoices(DOC_TYPES.map(t => ({
    label: t.label,
    onPick: () => {
      addMessage('user', t.label);
      onDocTypePicked(t);
    }
  })), intro);
}

function onDocTypePicked(type) {
  // 1.1.1 Ходатайство: второй набор чойсов
  if (type.key === 'motion') {
    setStep('1.1.1');
    offerChoices(MOTION_TYPES.map(m => ({
      label: m,
      onPick: () => {
        addMessage('user', m);
        finalizeDocType(type, `Ходатайство ${m.charAt(0).toLowerCase()}${m.slice(1)}`);
      }
    })), 'Какое ходатайство готовим? Выберите тип или напишите свой:');
    return;
  }
  finalizeDocType(type, type.label);
}

/** Шаг 2 стартового: тип выбран — шапка и переход к следующему сценарию. */
async function finalizeDocType(type, title) {
  state.docType = { key: type.key, label: title };
  applyDocTitle(title);

  setStep(type.key === 'motion' ? '2.2' : type.key === 'other' ? '2.3' : '2.1.1');
  await think('Формирую шапку документа', 1600);
  renderDocHeader(generateHeaderLines(type));

  // короткое сообщение: тип + шапка + (для жалоб) следующий шаг
  const uploadHint = type.key === 'appeal'
    ? ' Следующим шагом загрузите приговор первой инстанции.'
    : type.key === 'cassation'
      ? ' Следующим шагом загрузите приговор первой инстанции и апелляционное определение.'
      : '';
  addMessage('assistant', `Тип документа выбран: «${title}». Шапка документа сформирована.${uploadHint}`);

  // 2.1.1.2 / 2.2 — плейсхолдеры структуры вставляются молча
  state.structure = DOC_STRUCTURE[type.key] || null;
  if (state.structure) {
    setStep(type.key === 'motion' ? '2.2' : '2.1.1.2');
    renderBlocks();
    renderPleas();
  }

  // 2.1 апелляция/кассация: следующим шагом предлагаем загрузить документы (или пропустить)
  if (type.key === 'appeal' || type.key === 'cassation') {
    const sc = state.scenario;
    sc.id = 'upload-docs';
    sc.title = type.key === 'appeal' ? 'Загрузка приговора' : 'Загрузка приговора и апелляционного определения';
    sc.uninterruptible = false;
    updateScenarioBanner();

    const goGen = () => {
      state.scenario = null;
      renderContextChip();
      startScenario('gen-by-lines', 'Генерация текста по линиям защиты');
      runGenByLines();
    };

    offerChoices([
      {
        label: type.key === 'appeal' ? 'Загрузить приговор' : 'Загрузить документы',
        onPick: () => {
          addMessage('user', type.key === 'appeal' ? 'Загрузить приговор' : 'Загрузить документы');
          state.scenario = null;
          renderContextChip();
          runDocxScenario();
        }
      },
      {
        label: 'Пропустить',
        ghost: true,
        onPick: () => {
          addMessage('user', 'Пропустить');
          goGen();
        }
      }
    ]);
    return;
  }

  // позиция защиты → сразу сценарий 17
  if (type.key === 'position') {
    state.scenario = null;
    startScenario('gen-by-lines', 'Генерация текста по линиям защиты');
    runGenByLines();
    return;
  }

  // 2.2 ходатайство → текстовый шаблон с плейсхолдерами + сценарий 18
  if (type.key === 'motion') {
    insertMotionTemplate();
    addMessage('assistant', 'В документ вставлен шаблон ходатайства — незаполненные места отмечены жёлтым.');
    const sc = state.scenario;
    sc.id = 'motion';
    sc.title = 'Подготовка ходатайства';
    sc.uninterruptible = false;
    setStep('18');
    awaitText('Уточните: какие обстоятельства обосновывают ходатайство и о чём просим суд?', onMotionDetails);
    return;
  }

  // 2.3 другой тип → сценарий 19 → справка (сценарий 14)
  endScenario('Документ создан. Дальше можно работать командами из чата.');
  startHelp();
}

/** Шаблон ходатайства: текст с плейсхолдерами по данным карточки (чего нет — жёлтым). */
function insertMotionTemplate() {
  const c = state.card;
  const mark = t => `<span class="ph-mark">${t}</span>`;
  const caseNum = c.court && c.court.caseNum ? `№ ${c.court.caseNum}` : mark('указать номер дела');
  const courtName = c.court && c.court.appeal ? 'Киевского районного суда г. Симферополя' : mark('указать суд или орган');
  const client = c.clientGen || mark('указать ФИО доверителя');
  const qual = c.episodes[0] && c.episodes[0].qualification ? c.episodes[0].qualification : mark('указать квалификацию');

  insertBlock(
    `<p>В производстве ${courtName} находится уголовное дело ${caseNum} в отношении ${client}, обвиняемого в совершении преступления, предусмотренного ${qual}.</p>` +
    `<p>${mark('Изложите обстоятельства, обосновывающие ходатайство')}</p>`,
    { section: 'facts', kind: 'motion-tpl' });

  insertBlock(MOTION_LAW_TEXT, { section: 'law', kind: 'law' });
}

/** Сценарий 18: детали от пользователя заполняют плейсхолдер обоснования в шаблоне. */
async function onMotionDetails(text) {
  await think('Генерирую текст ходатайства', 2000);
  const filled = `${text.charAt(0).toUpperCase()}${text.slice(1)}. Изложенные обстоятельства имеют существенное значение для дела и подтверждаются его материалами (статьи 119, 120 УПК РФ).`;

  const tpl = state.blocks.find(b => b.kind === 'motion-tpl');
  if (tpl) {
    tpl.html = tpl.html.replace(/<span class="ph-mark">Изложите обстоятельства[^<]*<\/span>/, filled);
    renderBlocks();
    flashBlock(tpl.id);
  } else {
    insertBlock(filled, { section: 'facts', kind: 'motion-facts' });
  }
  addPlea(PLEA_MOTION);
  endScenario('Обоснование ходатайства заполнено, просительная часть сформирована.');
  startHelp();
}

/* ================= Сценарий №2: привязка линии защиты к блоку ================= */

function startBindLine() {
  startScenario('bind-line', 'Привязка линии защиты к блоку');
  setStep('2.1');

  // 2.1 Блок известен?
  if (!state.activeBlockId) {
    endScenario('Блок не выбран. Кликните на нужный блок в документе и вызовите привязку линии ещё раз.');
    return;
  }

  // 2.2 Эпизоды
  if (!state.card.episodes.length) {
    setStep('2.2.1');
    awaitText(
      'Карточка дела не заполнена: эпизодов фабулы нет. Введите краткую фабулу своими словами прямо в чат либо приложите DOCX с приговором или постановлением о возбуждении дела (скрепка внизу).',
      onFabulaEntered
    );
    return;
  }

  if (state.card.episodes.length === 1) {
    onEpisodeChosen(state.card.episodes[0], { silent: true });
  } else {
    setStep('2.2.2');
    offerChoices(
      state.card.episodes.map(ep => ({
        label: ep.title,
        sub: ep.text,
        wide: true,
        episode: true,
        onPick: () => {
          addMessage('user', ep.title);
          onEpisodeChosen(ep);
        }
      })),
      'К какому эпизоду относится этот блок? Выберите эпизод.'
    );
  }
}

/** 2.2.1.1.1 — фабула введена текстом: распознаём и сохраняем эпизод. */
async function onFabulaEntered(text) {
  setStep('2.2.1.1');
  await think('Распознаю фабулу', 2000);

  const episode = {
    id: 'ep-user-1',
    title: 'Эпизод 1 — из введённой фабулы',
    text: text
  };
  state.card.episodes.push(episode);

  addMessage('assistant', 'Фабула распознана и сохранена в карточку дела.');
  onEpisodeChosen(episode, { silent: true });
}

/** 2.3 — эпизод известен, смотрим линии. */
function onEpisodeChosen(episode, { silent } = {}) {
  const lines = state.card.lines.filter(l => !l.episodeId || l.episodeId === episode.id);

  if (!lines.length) {
    setStep('2.3.2');
    addMessage('assistant',
      (silent ? `Эпизод определён: ${episode.title}. ` : '') +
      'Для данного эпизода ещё нет линий защиты. Создайте новую линию.');
    offerCreateLine(episode, { stepBase: '2.3.2' });
    return;
  }

  setStep('2.3.1');
  offerChoices([
    ...lines.map(line => ({
      label: line.title,
      wide: true,
      onPick: () => {
        addMessage('user', line.title);
        onLineChosen(line, episode);
      }
    })),
    { label: 'Создать новую линию', ghost: true, onPick: () => { addMessage('user', 'Создать новую линию'); offerCreateLine(episode, { skipIntro: true, stepBase: '2.3.1.2' }); } },
    { label: 'Оставить свободным', ghost: true, onPick: () => { addMessage('user', 'Оставить свободным'); endScenario('Блок оставлен свободным — вернуться к выбору линии можно в любой момент.'); } }
  ], 'Выберите линию защиты для этого блока, создайте новую или оставьте блок свободным.');
}

/** 2.3.х — способ создания линии. */
function offerCreateLine(episode, { skipIntro, stepBase = '2.3.2' } = {}) {
  setStep(stepBase);
  offerChoices([
    { label: 'Подобрать по практике', onPick: () => { addMessage('user', 'Подобрать по практике'); offerPracticeLines(episode, 0, `${stepBase}.1`); } },
    { label: 'Написать тезис своими словами', onPick: () => { addMessage('user', 'Своими словами'); askThesis(episode, `${stepBase}.2`); } }
  ], skipIntro ? null : 'Как создать линию защиты?');
}

/** Пилзы линий из практики с пагинацией «Показать еще». */
function offerPracticeLines(episode, offset, step) {
  if (step && offset === 0) setStep(step);
  const page = PRACTICE_LINES.slice(offset, offset + PRACTICE_PAGE_SIZE);
  const hasMore = offset + PRACTICE_PAGE_SIZE < PRACTICE_LINES.length;

  offerChoices([
    ...page.map(p => ({
      label: p.title,
      sub: `${p.cases} дел в практике`,
      wide: true,
      onPick: () => {
        addMessage('user', p.title);
        createLine(episode, p.title, null);
      }
    })),
    ...(hasMore ? [{ label: 'Показать еще', ghost: true, onPick: () => offerPracticeLines(episode, offset + PRACTICE_PAGE_SIZE, step) }] : [])
  ], offset === 0 ? 'Линии защиты с наиболее объёмной практикой:' : null);
}

/** Ждём тезис свободным вводом (B.2). */
function askThesis(episode, stepBase = '2.3.2.2') {
  setStep(`${stepBase}.1`);
  awaitText('Введите тезис защиты своими словами.', text => {
    setStep(`${stepBase}.2`);
    onThesisEntered(episode, text);
  });
}

/** «Нейронка» угадывает 3 линии по тезису. */
async function onThesisEntered(episode, thesis) {
  await think('Подбираю подходящие линии защиты', 1600);
  offerChoices([
    ...GUESSED_LINES.map(title => ({
      label: title,
      wide: true,
      onPick: () => {
        addMessage('user', title);
        createLine(episode, title, thesis);
      }
    })),
    {
      label: 'Не устроил ни один из вариантов',
      ghost: true,
      onPick: () => {
        addMessage('user', 'Не устроил ни один из вариантов');
        createLine(episode, null, thesis);
      }
    }
  ], 'Похоже на одну из этих линий — выберите подходящую:');
}

/** Создание линии + привязка. */
async function createLine(episode, title, thesis) {
  await think('Создаю линию защиты', 1500);

  const line = {
    id: `line-new-${state.card.lines.length + 1}`,
    episodeId: episode ? episode.id : null,
    title: title || 'Новая линия защиты (без названия)',
    thesis: thesis || 'Тезис сформирован автоматически по материалам практики.',
    argument: REGEN_FALLBACK_TEXT
  };
  state.card.lines.push(line);
  addMessage('assistant', `Линия защиты сохранена в карточку дела: «${line.title}».`);

  onLineChosen(line, episode, { created: true });
}

/** 2.4 — линия привязана, предлагаем перегенерацию блока. */
async function onLineChosen(line, episode, { created } = {}) {
  setStep('2.4');
  if (!created) await think('Привязываю линию к блоку', 1200);

  state.boundLines.add(line.id);
  const boundBlock = getBlock(state.activeBlockId);
  if (boundBlock) boundBlock.lineId = line.id;
  updateChecklist();
  const blockLabel = boundBlock?.label || 'блоку';

  offerChoices([
    {
      label: 'Перегенерировать блок',
      onPick: async () => {
        addMessage('user', 'Перегенерировать блок');
        await think('Генерирую новый текст блока', 2000);
        const target = getBlock(state.activeBlockId);
        if (target) applyLineToBlock(target, line, { silent: true });
        endScenario('Текст блока обновлён по конструктору линии, просительная часть пересобрана.');
      }
    },
    {
      label: 'Не перегенерировать',
      ghost: true,
      onPick: () => {
        addMessage('user', 'Не перегенерировать');
        endScenario('Готово: линия привязана к блоку. Текст блока оставлен без изменений.');
      }
    }
  ], `${created ? '' : 'Линия привязана к ' + blockLabel + ', эпизод — к линии. '}Перегенерировать текст блока с учётом привязанной информации?`);
}

/* ================= Сценарий №6: создание линии защиты ================= */

function startCreateLine() {
  startScenario('create-line', 'Создание линии защиты');
  setStep('6');
  const episode = state.card.episodes[0] || null;

  offerChoices([
    { label: 'Подобрать по практике', onPick: () => { addMessage('user', 'Подобрать по практике'); offerPracticeLines6(episode, 0); } },
    { label: 'Написать тезис своими словами', onPick: () => { addMessage('user', 'Своими словами'); setStep('6.2.1'); awaitText('Введите тезис защиты своими словами.', text => { setStep('6.2.2'); onThesis6(episode, text); }); } }
  ], 'Как создать линию защиты?');
}

function offerPracticeLines6(episode, offset) {
  if (offset === 0) setStep('6.1');
  const page = PRACTICE_LINES.slice(offset, offset + PRACTICE_PAGE_SIZE);
  const hasMore = offset + PRACTICE_PAGE_SIZE < PRACTICE_LINES.length;

  offerChoices([
    ...page.map(p => ({
      label: p.title,
      sub: `${p.cases} дел в практике`,
      wide: true,
      onPick: () => {
        addMessage('user', p.title);
        createLine6(episode, p.title, null);
      }
    })),
    ...(hasMore ? [{ label: 'Показать еще', ghost: true, onPick: () => offerPracticeLines6(episode, offset + PRACTICE_PAGE_SIZE) }] : [])
  ], offset === 0 ? 'Линии защиты с наиболее объёмной практикой:' : null);
}

async function onThesis6(episode, thesis) {
  await think('Подбираю подходящие линии защиты', 1600);
  offerChoices([
    ...GUESSED_LINES.map(title => ({
      label: title,
      wide: true,
      onPick: () => {
        addMessage('user', title);
        createLine6(episode, title, thesis);
      }
    })),
    { label: 'Не устроил ни один из вариантов', ghost: true, onPick: () => { addMessage('user', 'Не устроил ни один из вариантов'); createLine6(episode, null, thesis); } }
  ], 'Похоже на одну из этих линий — выберите подходящую:');
}

/** 6.3 — куда добавить текст по созданной линии. */
async function createLine6(episode, title, thesis) {
  setStep('6.3');
  await think('Создаю линию защиты', 1500);

  const line = {
    id: `line-new-${state.card.lines.length + 1}`,
    episodeId: episode ? episode.id : null,
    title: title || 'Новая линия защиты (без названия)',
    thesis: thesis || 'Тезис сформирован автоматически по материалам практики.',
    argument: REGEN_FALLBACK_TEXT
  };
  state.card.lines.push(line);

  const options = [];
  if (state.activeBlockId) {
    options.push({
      label: 'Добавить после активного блока',
      onPick: async () => {
        addMessage('user', 'Добавить после активного блока');
        await think('Генерирую текст по линии защиты', 1800);
        insertLineBlock(line, { afterId: state.activeBlockId });
        state.boundLines.add(line.id);
        addPlea(line.plea || PLEA_FALLBACK);
        endScenario('Текст по линии добавлен после активного блока, просительная часть обновлена.');
        maybeExplainWarnings();
      }
    });
  }
  options.push(
    {
      label: 'Добавить в конец документа',
      onPick: async () => {
        addMessage('user', 'Добавить в конец документа');
        await think('Генерирую текст по линии защиты', 1800);
        insertLineBlock(line);
        state.boundLines.add(line.id);
        addPlea(line.plea || PLEA_FALLBACK);
        endScenario('Текст по линии добавлен в конец документа, просительная часть обновлена.');
        maybeExplainWarnings();
      }
    },
    {
      label: 'Не добавлять',
      ghost: true,
      onPick: () => {
        addMessage('user', 'Не добавлять');
        endScenario('Линия создана и сохранена в карточку дела. Текст в документ не добавлялся.');
      }
    }
  );

  offerChoices(options, `Линия создана: «${line.title}». Добавить текст по ней в документ?`);
}

/* ================= Сценарий №15: проверка документа ================= */

function unboundLines() {
  return state.card.lines.filter(l => !state.boundLines.has(l.id));
}

function startCheckDoc() {
  startScenario('check-doc', 'Проверка документа');
  step15_1();
}

async function step15_1() {
  setStep('15.1');
  await think('Проверяю линии защиты, не добавленные в документ', 1300);
  const unbound = unboundLines();

  if (!unbound.length) {
    addMessage('assistant', state.card.lines.length
      ? 'Все линии защиты добавлены в документ.'
      : 'В карточке дела пока нет линий защиты.');
    return step15_rest();
  }

  offerChoices([
    {
      label: 'Добавить все линии',
      onPick: async () => {
        addMessage('user', 'Добавить все линии');
        setStep('15.1.2');
        await think('Генерирую текст документа по выбранным линиям защиты', 2200);
        unbound.forEach(line => {
          insertLineBlock(line);
          state.boundLines.add(line.id);
          addPlea(line.plea || PLEA_FALLBACK);
        });
        addMessage('assistant', `Текст по ${unbound.length} лини${unbound.length === 1 ? 'и' : 'ям'} добавлен в документ, просительная часть обновлена.`);
        maybeExplainWarnings();
        step15_rest();
      }
    },
    {
      label: 'Пропустить',
      ghost: true,
      onPick: () => {
        addMessage('user', 'Пропустить');
        step15_rest();
      }
    }
  ], `Обнаружены линии защиты, не добавленные в текст документа: ${unbound.length}. Добавить?`);
}

/** Шаги 15.2–15.7 — последовательный чек-лист. */
async function step15_rest() {
  setStep('15.2');
  await think('Проверяю привязку блоков к линиям защиты', 1100);
  const warnBlocks = state.blocks.filter(b => blockIssues(b).length).length;
  addMessage('assistant', !state.blocks.length
    ? 'В документе пока нет блоков.'
    : warnBlocks
      ? `Есть блоки без привязанной линии защиты: ${warnBlocks} (отмечены «!»). Привязать линию можно командой «привяжи линию» по активному блоку.`
      : 'Все блоки привязаны к линиям защиты.');

  setStep('15.3');
  await think('Проверяю доказательства по линиям защиты', 1100);
  addMessage('assistant', state.card.evidence.length
    ? 'У всех линий защиты есть доказательства.'
    : 'В карточке дела нет доказательств — привязка доказательств к линиям будет доступна из меню ии-звёздочки.');

  setStep('15.5');
  await think('Проверяю просительную часть', 1100);
  if (state.pleas.length) {
    addMessage('assistant', 'Просительная часть заполнена и покрывает текущий состав блоков.');
  } else if (state.blocks.length) {
    await think('Собираю просительную часть', 1200);
    state.card.lines.filter(l => state.boundLines.has(l.id)).forEach(l => addPlea(l.plea || PLEA_FALLBACK));
    addMessage('assistant', state.pleas.length
      ? 'Просительная часть собрана.'
      : 'Просительная часть будет собрана после привязки линий защиты к блокам.');
  } else {
    addMessage('assistant', 'Документ пуст — просительная часть будет собрана после добавления блоков.');
  }

  setStep('15.6');
  await think('Проверяю полноту документа', 1300);
  addMessage('assistant', 'Документ можно дополнить: указание на смягчающие обстоятельства (ст. 61 УК РФ) и ходатайство об исследовании видеозаписи в судебном заседании.');

  setStep('15.7');
  await think('Проверяю противоречия между блоками', 1300);
  endScenario('Противоречий между блоками не найдено. Проверка документа завершена.');
}

/* ================= Сценарий №17: генерация текста по линиям ================= */

function startGenByLines() {
  startScenario('gen-by-lines', 'Генерация текста по линиям защиты');
  runGenByLines();
}

async function runGenByLines() {
  setStep('17.1');
  const unbound = unboundLines();
  if (!unbound.length) {
    // 17.1.2 — линий нет: отбивка и справка (сценарий 14)
    if (!state.card.lines.length) {
      endScenario('В карточке дела нет линий защиты — блоки по линиям сгенерировать пока нечем.');
      startHelp();
    } else {
      endScenario('Все линии защиты уже привязаны к блокам документа.');
    }
    return;
  }

  setStep('17.2');
  await think('Генерирую текст по непривязанным линиям защиты', 2200);
  unbound.forEach(line => {
    insertLineBlock(line);
    state.boundLines.add(line.id);
    addPlea(line.plea || PLEA_FALLBACK);
  });

  // 17.3 Сутевая часть дела (фабула) — первым блоком после заголовка
  let factsAdded = false;
  if (state.card.episodes.length && !factsFilled()) {
    setStep('17.3');
    await think('Генерирую сутевую часть дела по фабуле', 1800);
    insertBlock(composeFactsText(), { atStart: true, section: 'facts', kind: 'facts' });
    if (!state.factsSource) state.factsSource = 'card';
    factsAdded = true;
  }

  // описание приговора (апелляция/кассация) — самой первой секцией
  if (state.structure && state.structure.some(p => p.kind === 'verdict') && state.card.verdict
      && !state.blocks.some(b => (b.section || 'defense') === 'verdict')) {
    await think('Формирую описание приговора', 1400);
    insertBlock(composeVerdictText(), { atStart: true, section: 'verdict', kind: 'verdict' });
  }

  // признание известно по карточке — заполняем автоматически (без отдельной отбивки)
  await maybeAutoAdmission({ silent: true });

  setStep('17.4');
  endScenario();

  // акцентное финальное сообщение: переводим адвоката в документ слева
  const doneSections = [];
  if (state.blocks.some(b => (b.section || 'defense') === 'verdict')) doneSections.push('описание приговора');
  if (factsFilled()) doneSections.push('обстоятельства дела');
  if (state.blocks.some(b => (b.section || 'defense') === 'admission')) doneSections.push('признание');
  doneSections.push(`защитная часть (${unbound.length} блок${unbound.length === 1 ? '' : 'а'})`, 'просительная часть');

  const accent = addMessage('assistant', '');
  accent.classList.add('msg--accent');
  accent.innerHTML = `
    <div class="msg-accent__title">Черновик собран — продолжайте в документе слева</div>
    <ul>
      <li>Заполнено: ${doneSections.join(', ')}.</li>
      <li>Жёлтые метки <span class="msg-warn-icon">!</span> и чеклист сверху показывают, что требует завершения.</li>
      <li>Раскройте конструктор блока, чтобы уточнить аргументы, доказательства и практику.</li>
    </ul>`;
  scrollFeed();
  state.warnExplained = true;
}

/** 17.3 — сутевая часть: фабула всех эпизодов дела. */
function composeFactsText() {
  const c = state.card;
  const caseRef = c.court && c.court.caseNum ? ` № ${c.court.caseNum}` : '';
  const client = c.clientDat || c.client;
  const intro = `По уголовному делу${caseRef} моему доверителю${client ? ' ' + client : ''} вменяются следующие деяния.`;
  const episodes = c.episodes.map((ep, i) => {
    const text = ep.text.replace(/\s+/g, ' ').trim();
    const sentences = text.split('. ');
    return `По эпизоду ${i + 1}: ${sentences.slice(0, 2).join('. ')}${sentences.length > 1 ? '.' : ''}`;
  }).join(' ');
  return `${intro} ${episodes}`;
}

/* ================= Сценарий №14: справка ================= */

function startHelp() {
  const el = addMessage('assistant', '');
  el.classList.add('msg--help');
  el.innerHTML = HELP_HTML;
  scrollFeed();
}

/* ================= Сценарий №3: разбор DOCX (по скрепке) ================= */

function onAttachClick() {
  if (state.busy) return;

  const sc = state.scenario;

  // приложили файл во время стартового сценария: разбираем и возвращаемся к выбору типа
  if (sc && sc.id === 'start-doc') {
    runDocxDuringStart();
    return;
  }
  if (sc) {
    askInterrupt('Разбор файла', () => runDocxScenario());
    return;
  }
  runDocxScenario();
}

/** Общий пайплайн разбора приговора (шаги 3.1–3.4). Для кассации — плюс апелляционное определение. */
async function runDocxPipeline() {
  const isCassation = state.docType && state.docType.key === 'cassation';
  addFileMessage(DOCX_FILE_NAME);
  if (isCassation) addFileMessage(DOCX_FILE_NAME_APPEAL_RULING);

  setStep('3.1');
  await think(isCassation ? 'Проверяю приложенные документы' : 'Проверяю, приговор ли это первой инстанции', 1500);
  addMessage('assistant', isCassation
    ? 'Это приговор первой инстанции и апелляционное определение — продолжаю разбор.'
    : 'Это приговор первой инстанции — продолжаю разбор.');

  setStep('3.2');
  await think('Разбираю документ: доверитель, фабула, доказательства, стадии, участники, обстоятельства, линии защиты', 3000);

  setStep('3.3');
  state.card = clone(DOCX_PARSED_CARD);

  setStep('3.4');
  const c = state.card;
  const report = addMessage('assistant', '');
  report.classList.add('msg--card');
  report.innerHTML = `
    <div class="msg-card__title">Разбор завершён — карточка дела заполнена</div>
    <ul>
      <li>Доверитель: ${c.client}</li>
      <li>Эпизоды фабулы: ${c.episodes.length}</li>
      <li>Линии защиты: ${c.lines.length}</li>
      <li>Доказательства: ${c.evidence.length} · Обстоятельства: ${c.circumstances.length}</li>
    </ul>`;
  scrollFeed();
}

/** Разбор из состояния C или после перебивки: далее сценарий 17. */
async function runDocxScenario() {
  startScenario('docx', 'Разбор документа');
  await runDocxPipeline();

  state.scenario = null;
  startScenario('gen-by-lines', 'Генерация текста по линиям защиты');
  runGenByLines();
}

/** Разбор во время стартового сценария: после отчёта возвращаемся к выбору типа. */
async function runDocxDuringStart() {
  const sc = state.scenario;
  const savedTitle = sc.title;
  sc.title = 'Разбор документа';
  updateScenarioBanner();

  await runDocxPipeline();

  sc.title = savedTitle;
  setStep('1.1');
  offerDocTypeChoices('Теперь выберите тип документа — данные из приговора будут использованы при подготовке:');
}

/* ================= Меню ии-звёздочки (сценарии 16.x) ================= */

const starBtn = $('#btn-star');
const starMenu = $('#star-menu');
const modalOverlay = $('#modal-overlay');
const modalEl = $('#modal');

function renderStarMenu() {
  starMenu.innerHTML = '';
  CHAT_STAR_ACTIONS.forEach(action => {
    const btn = document.createElement('button');
    btn.textContent = action.label;
    btn.addEventListener('click', () => {
      starMenu.classList.remove('is-open');
      onStarAction(action);
    });
    starMenu.appendChild(btn);
  });
}

starBtn.addEventListener('click', e => {
  e.stopPropagation();
  if (state.busy) return;
  renderStarMenu();
  starMenu.classList.toggle('is-open');
});
document.addEventListener('click', e => {
  if (!starMenu.contains(e.target) && !starBtn.contains(e.target)) starMenu.classList.remove('is-open');
});

/** Вход 1 каркаса: пилз из выпадайки-звёздочки. */
function onStarAction(action) {
  if (state.busy) return;
  const sc = state.scenario;

  // Состояние A: стартовый сценарий — игнорируем, предлагаем чоисы снова
  if (sc && sc.id === 'start-doc') {
    addMessage('assistant', 'Сначала выберем тип документа — после этого действия из ИИ-меню станут доступны.');
    if (sc.chipsSpec) offerChoices(sc.chipsSpec);
    return;
  }
  // Состояние B: спросить, прервать ли сценарий
  if (sc) {
    askInterrupt(action.label, () => runStarAction(action));
    return;
  }
  // Состояние C: выполнить согласно id
  runStarAction(action);
}

function runStarAction(action) {
  const block = getBlock(state.activeBlockId);
  if (action.needsBlock && !block) {
    addMessage('assistant', 'Блок не выбран. Кликните на нужный блок в документе и вызовите действие из ИИ-меню ещё раз.');
    return;
  }

  switch (action.id) {
    case 'bind-line':
      addMessage('user', action.label);
      startBindLine();
      break;
    case 'bind-evidence':
      openEvidenceModal(block);
      break;
    case 'practice':
      openPracticeModal(block);
      break;
    case 'shorter':
      addMessage('user', `${block.label}: Перепеши короче`);
      rewriteBlockAuto(block, 'shorter');
      break;
    case 'longer':
      addMessage('user', `${block.label}: Перепеши подробнее`);
      rewriteBlockAuto(block, 'longer');
      break;
    case 'rewrite':
      startScenario('rewrite-block', 'Редактировать с ИИ');
      setStep('16.6');
      awaitText('Как хотите изменить текст блока?', text => onRewriteBlock(block, text));
      break;
    case 'help':
      addMessage('user', 'Показать справку');
      startHelp();
      break;
    case 'check-doc':
      addMessage('user', 'Проверить документ');
      startCheckDoc();
      break;
    case 'create-line':
      addMessage('user', 'Новая линия защиты');
      startCreateLine();
      break;
  }
}

/* ---------- Меню действий у блока (ховер-звёздочка) ---------- */

const blockMenuEl = $('#block-menu');

const BLOCK_ACTION_LABELS = {
  'bind-line': 'Привязать линию защиты',
  'practice': 'Практика по линии защиты',
  'bind-evidence': 'Привязать доказательство',
  'rewrite': 'Редактировать с ИИ',
  'longer': 'Сделать подробнее',
  'shorter': 'Сделать короче'
};

function openBlockMenu(block, anchorBtn) {
  closeBlockMenu();
  const line = state.card.lines.find(l => l.id === block.lineId) || null;
  const evCount = (block.evidence || []).length;

  blockMenuEl.innerHTML = `
    <div class="block-menu__summary">${line ? 'Линия защиты: ' + line.title : 'Линия защиты не привязана'}</div>
    ${line
      ? '<button data-action="practice">Практика по линии защиты</button>'
      : '<button data-action="bind-line">Привязать линию защиты</button>'}
    <div class="block-menu__divider"></div>
    <div class="block-menu__row"><span>Доказательства</span><span>${evCount}</span></div>
    <button data-action="bind-evidence">Привязать доказательство</button>
    <div class="block-menu__divider"></div>
    <button data-action="rewrite">Скорректировать блок</button>
    <button data-action="longer">Сделать подробнее</button>
    <button data-action="shorter">Сделать короче</button>
    <button data-action="ask-question">Задать вопрос по блоку</button>`;

  blockMenuEl.hidden = false;
  const r = anchorBtn.getBoundingClientRect();
  const w = 300;
  blockMenuEl.style.left = Math.max(8, Math.min(r.right - w, window.innerWidth - w - 8)) + 'px';
  blockMenuEl.style.top = Math.min(r.bottom + 6, window.innerHeight - blockMenuEl.offsetHeight - 8) + 'px';

  blockMenuEl.querySelectorAll('button[data-action]').forEach(btn => {
    btn.addEventListener('click', () => {
      const actionId = btn.dataset.action;
      closeBlockMenu();
      setActiveBlock(block.id);
      if (actionId === 'ask-question') {
        // 16.4: вопрос по блоку = активный блок + ввод вопроса в чат
        promptEl.focus();
        return;
      }
      onStarAction({ id: actionId, label: BLOCK_ACTION_LABELS[actionId], needsBlock: actionId !== 'practice' });
    });
  });
}

function closeBlockMenu() {
  blockMenuEl.hidden = true;
  blockMenuEl.innerHTML = '';
}

document.addEventListener('click', e => {
  if (!blockMenuEl.contains(e.target) && !e.target.closest('.doc-block__star')) closeBlockMenu();
});
$('#doc-scroll').addEventListener('scroll', closeBlockMenu);

const stripTags = html => {
  const d = document.createElement('div');
  d.innerHTML = html;
  return d.textContent.replace(/\s+/g, ' ').trim();
};

/** 16.5 / 16.7 — короче/подробнее без вопросов и подтверждений (учитывает абзацы-сущности). */
async function rewriteBlockAuto(block, mode) {
  await think(mode === 'shorter' ? 'Переписываю блок короче' : 'Переписываю блок подробнее', 1800);

  const d = document.createElement('div');
  d.innerHTML = block.html;
  const paras = [...d.querySelectorAll('p')];

  if (paras.length) {
    if (mode === 'shorter') {
      // каждый абзац-сущность сокращаем до первого предложения, сохраняя подпись
      paras.forEach(p => {
        const label = p.querySelector('b');
        const labelHtml = label ? label.outerHTML + ' ' : '';
        const text = p.textContent.replace(label ? label.textContent : '', '').replace(/\s+/g, ' ').trim();
        const first = text.split('. ')[0];
        p.innerHTML = labelHtml + first + (first.endsWith('.') ? '' : '.');
      });
    } else {
      const extra = document.createElement('p');
      extra.innerHTML = '<b>Дополнительно:</b> ' + DETAIL_SENTENCE.replace(/\s+/g, ' ').trim();
      d.appendChild(extra);
    }
    block.html = d.innerHTML;
  } else {
    const text = stripTags(block.html);
    if (mode === 'shorter') {
      const sentences = text.split('. ');
      block.html = sentences.slice(0, 2).join('. ') + (sentences.length > 2 ? '.' : '');
    } else {
      block.html = text + ' ' + DETAIL_SENTENCE.replace(/\s+/g, ' ').trim();
    }
  }
  block.htmlBase = null;
  renderBlocks();
  flashBlock(block.id);
  addMessage('assistant', mode === 'shorter' ? 'Блок переписан короче.' : 'Блок переписан подробнее.');
}

/** 16.6 — редактирование блока с ИИ по свободному запросу. */
async function onRewriteBlock(block, request) {
  await think('Редактирую блок согласно запросу', 1800);
  if (block.parts && block.parts.length) {
    block.generated = `${REGEN_FALLBACK_TEXT.replace(/\s+/g, ' ').trim()}`;
  } else {
    block.html = REGEN_FALLBACK_TEXT;
    block.htmlBase = null;
  }
  renderBlocks();
  flashBlock(block.id);
  endScenario(`Текст ${labelGen(block.label)} отредактирован согласно вашему запросу.`);
}

/* ---------- Модалки ---------- */

function openModal({ title, bodyHtml, buttons }) {
  modalEl.innerHTML = `
    <div class="modal__title">${title}</div>
    <div class="modal__body">${bodyHtml}</div>
    <div class="modal__footer"></div>`;
  const footer = modalEl.querySelector('.modal__footer');
  buttons.forEach(b => {
    const btn = document.createElement('button');
    btn.className = 'modal__btn' + (b.primary ? ' modal__btn--primary' : '');
    btn.textContent = b.label;
    btn.addEventListener('click', () => b.onClick ? b.onClick() : closeModal());
    footer.appendChild(btn);
  });
  modalOverlay.hidden = false;
}

function closeModal() {
  modalOverlay.hidden = true;
  modalEl.innerHTML = '';
}

modalOverlay.addEventListener('click', e => {
  if (e.target === modalOverlay) closeModal();
});

/** 16.1 — попап привязки доказательств к блоку. */
function openEvidenceModal(block) {
  const evidence = state.card.evidence;
  if (!evidence.length) {
    openModal({
      title: 'Привязать доказательства',
      bodyHtml: 'В карточке дела нет доказательств. Они появятся после разбора приговора (скрепка внизу чата).',
      buttons: [{ label: 'Закрыть' }]
    });
    return;
  }

  block.evidence = block.evidence || [];
  const items = evidence.map((ev, i) => `
    <label class="evidence-item">
      <input type="checkbox" data-idx="${i}" ${block.evidence.includes(i) ? 'checked' : ''}>
      <span>${ev}</span>
    </label>`).join('');

  openModal({
    title: `Привязать доказательства · ${block.label}`,
    bodyHtml: items,
    buttons: [
      { label: 'Отмена' },
      { label: 'Привязать', primary: true, onClick: () => applyEvidence(block) }
    ]
  });
}

async function applyEvidence(block) {
  const selected = [...modalEl.querySelectorAll('input:checked')].map(i => +i.dataset.idx);
  closeModal();

  const prev = block.evidence || [];
  const changed = selected.length !== prev.length || selected.some(i => !prev.includes(i));
  if (!changed) {
    addMessage('assistant', 'Состав доказательств не изменился — перегенерация не требуется.');
    return;
  }

  block.evidence = selected;
  const list = selected.map(i => state.card.evidence[i]);

  // конструкторный блок: обновляем подблок «Доказательства», текст перегенерируется кнопкой
  if (block.parts && block.parts.length) {
    const html = list.length ? list.join('; ') + '.' : '';
    const evPart = block.parts.find(p => p.key === 'evidence');
    if (evPart) {
      if (html) evPart.html = html;
      else block.parts.splice(block.parts.indexOf(evPart), 1);
    } else if (html) {
      block.parts.push({ key: 'evidence', title: 'Доказательства', html });
    }
    block.dirty = true;
    block.dirtyNotified = true;
    block.argsStale = true;
    renderBlocks();
    flashBlock(block.id);
    addMessage('assistant', `Доказательства добавлены в ${block.label}: ${list.length} шт. Данные аргументов обновились — нажмите «Обновить аргументы», затем «Перегенерировать».`);
    return;
  }

  addMessage('assistant', 'Провожу перегенерацию текста документа с учётом новых доказательств.');
  await think('Перегенерирую текст блока', 2000);

  if (!block.htmlBase) block.htmlBase = block.html;
  block.html = block.htmlBase + (list.length
    ? `<p><b>Доказательства:</b> ${list.join('; ')}.</p>`
    : '');
  renderBlocks();
  flashBlock(block.id);
  addMessage('assistant', `Текст ${block.label} перегенерирован.`);
}

/** Модалка выбора линии защиты для блока (чекбоксы, текущая отмечена). */
function openLineModal(block) {
  const lines = state.card.lines;
  if (!lines.length) {
    openModal({
      title: 'Линия защиты',
      bodyHtml: 'В карточке дела пока нет линий защиты. Создайте линию командой «создай линию» или через меню ✦ в чате.',
      buttons: [{ label: 'Закрыть' }]
    });
    return;
  }

  const items = lines.map(l => `
    <label class="evidence-item">
      <input type="checkbox" data-line-id="${l.id}" ${block.lineId === l.id ? 'checked' : ''}>
      <span><b>${shortLineTitle(l.title)}</b>${l.thesis ? `<br><small class="modal-sub">${l.thesis}</small>` : ''}</span>
    </label>`).join('');

  openModal({
    title: `Линия защиты · ${block.label}`,
    bodyHtml: items,
    buttons: [{ label: 'Закрыть' }]
  });

  modalEl.querySelectorAll('input[data-line-id]').forEach(cb => {
    cb.addEventListener('change', () => {
      const lineId = cb.dataset.lineId;
      if (!cb.checked && block.lineId === lineId) {
        // сняли галку с используемой линии
        confirmLineChange(block, null);
      } else if (cb.checked && lineId !== block.lineId) {
        const newLine = lines.find(l => l.id === lineId);
        if (block.lineId) confirmLineChange(block, newLine);
        else { closeModal(); applyLineToBlock(block, newLine); }
      }
    });
  });
}

/** Подтверждение смены/снятия линии: информация блока будет удалена. */
function confirmLineChange(block, newLine) {
  openModal({
    title: 'Смена линии защиты',
    bodyHtml: 'Уверены, что хотите поменять линию? При смене линии вся информация блока будет удалена.',
    buttons: [
      { label: 'Отмена' },
      {
        label: 'Да, поменять',
        primary: true,
        onClick: () => {
          closeModal();
          const label = block.label;
          clearBlockInfo(block);
          if (newLine) applyLineToBlock(block, newLine);
          else addMessage('assistant', `Линия защиты отвязана от ${labelGen(label)}, информация блока удалена.`);
        }
      }
    ]
  });
}

/** Модалка аргументов: авто-предложения, сгруппированные по источникам. */
function openArgsModal(block) {
  const line = state.card.lines.find(l => l.id === block.lineId);
  if (!line) {
    openModal({ title: 'Аргументы', bodyHtml: 'Сначала привяжите к блоку линию защиты.', buttons: [{ label: 'Закрыть' }] });
    return;
  }
  const pool = line.argumentsPool || [];
  const usedIdx = new Set((block.argsList || []).filter(a => a.auto && a.poolIdx !== null).map(a => a.poolIdx));

  const GROUPS = [['practice', 'Практика'], ['circumstances', 'Обстоятельства'], ['norms', 'Нормативная опора'], ['fact', 'Факты']];
  const groupsHtml = GROUPS.map(([src, title]) => {
    const items = pool.map((a, i) => ({ a, i })).filter(x => (x.a.source || 'fact') === src);
    if (!items.length) return '';
    return `
      <div class="args-group">
        <div class="args-group__title">${title}</div>
        ${items.map(({ a, i }) => `
          <label class="evidence-item">
            <input type="checkbox" data-idx="${i}" ${usedIdx.has(i) ? 'checked' : ''}>
            <span>${a.text}</span>
          </label>`).join('')}
      </div>`;
  }).join('');

  openModal({
    title: `Аргументы линии · ${block.label}`,
    bodyHtml: groupsHtml || 'Для этой линии аргументы не подобраны.',
    buttons: [
      { label: 'Отмена' },
      {
        label: 'Применить',
        primary: true,
        onClick: () => {
          const sel = [...modalEl.querySelectorAll('input[data-idx]:checked')].map(i => +i.dataset.idx);
          closeModal();
          const manual = (block.argsList || []).filter(a => !a.auto);
          block.argsList = [
            ...sel.sort((x, y) => x - y).map(i => ({ text: pool[i].text, source: pool[i].source, auto: true, poolIdx: i })),
            ...manual
          ];
          block.argsStale = false;
          syncArgsPart(block);
          block.dirty = true;
          block.dirtyNotified = true;
          renderBlocks();
          flashBlock(block.id);
          addMessage('assistant', `Состав аргументов ${labelGen(block.label)} обновлён: выбрано ${sel.length} из ${pool.length} предложенных. Кнопка «Перегенерировать» активна.`);
        }
      }
    ]
  });
}

/** 16.3 — практика: чекбоксы по делам, отмечены упомянутые в тексте блока. */
function openPracticeModal(block) {
  const pool = (state.card.practice && state.card.practice.length) ? state.card.practice : PRACTICE_CASES;
  const canBind = !!(block && block.parts && block.parts.length);
  const selected = canBind ? (block.selectedPractice || []) : [];

  const items = pool.map((c, i) => `
    <label class="evidence-item">
      <input type="checkbox" data-idx="${i}" ${selected.includes(i) ? 'checked' : ''} ${canBind ? '' : 'disabled'}>
      <span><b>${c.num}</b> · ${c.court}<br><small class="modal-sub">${c.summary}</small><br><span class="practice-case__result">${c.result}</span></span>
    </label>`).join('');

  openModal({
    title: canBind ? `Практика по линии · ${block.label}` : 'Практика по линии защиты',
    bodyHtml: items,
    buttons: canBind ? [
      { label: 'Отмена' },
      {
        label: 'Применить',
        primary: true,
        onClick: () => {
          const sel = [...modalEl.querySelectorAll('input[data-idx]:checked')].map(i => +i.dataset.idx);
          closeModal();
          block.selectedPractice = sel;
          const html = sel.map(i => `${pool[i].num} (${pool[i].court}) — ${pool[i].result.toLowerCase()}`).join('; ') + (sel.length ? '.' : '');
          const existing = block.parts.find(p => p.key === 'practice');
          if (sel.length) {
            if (existing) existing.html = html;
            else {
              const idx = block.parts.findIndex(p => p.key === 'circumstances');
              const item = { key: 'practice', title: 'Практика', html };
              if (idx >= 0) block.parts.splice(idx, 0, item);
              else block.parts.push(item);
            }
          } else if (existing) {
            block.parts.splice(block.parts.indexOf(existing), 1);
          }
          block.dirty = true;
          block.dirtyNotified = true;
          block.argsStale = true;
          renderBlocks();
          flashBlock(block.id);
          addMessage('assistant', `Практика ${labelGen(block.label)} обновлена: выбрано дел — ${sel.length}. Кнопка «Перегенерировать» активна.`);
        }
      }
    ] : [{ label: 'Закрыть' }]
  });
}

/* ================= Ввод ================= */

function sendPrompt() {
  if (state.busy) return;
  const text = promptEl.value.trim();
  if (!text) return;
  promptEl.value = '';
  autosize();
  addMessage('user', text);
  routeText(text);
}

function autosize() {
  promptEl.style.height = 'auto';
  promptEl.style.height = Math.min(promptEl.scrollHeight, 120) + 'px';
}

promptEl.addEventListener('input', autosize);
promptEl.addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendPrompt();
  }
});
sendBtn.addEventListener('click', sendPrompt);
attachBtn.addEventListener('click', onAttachClick);

/* ================= Режим «только текст документа» ================= */

const textOnlyCb = $('#text-only-cb');
textOnlyCb.addEventListener('change', () => {
  document.body.classList.toggle('text-only', textOnlyCb.checked);
});

/* ================= Шапка ================= */

$('#btn-download').addEventListener('click', () => window.print());
$('#btn-print').addEventListener('click', () => window.print());
$('#btn-logs').addEventListener('click', e => e.preventDefault());

/* ================= Старт ================= */

resetDemo(0);
