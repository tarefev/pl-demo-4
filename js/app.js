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
  blocks: null,        // рабочая копия блоков документа
  pleas: null,         // пункты просительной части
  boundLines: null,    // Set id линий, уже привязанных к блокам
  activeBlockId: null,
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
  state.boundLines = new Set();
  state.activeBlockId = null;
  state.docType = null;
  state.scenario = null;
  state.busy = false;

  feedEl.innerHTML = '';
  promptEl.value = '';
  autosize();
  setBusy(false);

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

function renderBlocks() {
  docBlocksEl.innerHTML = '';
  if (!state.blocks.length) {
    docBlocksEl.innerHTML = '<div class="doc-empty">В документе пока нет блоков — текст появится по мере работы сценариев</div>';
    return;
  }
  state.blocks.forEach(block => {
    const el = document.createElement('div');
    el.className = 'doc-block' + (block.id === state.activeBlockId ? ' is-active' : '');
    el.dataset.blockId = block.id;
    el.contentEditable = 'true';
    el.innerHTML = `
      <span class="doc-block__label" contenteditable="false">${block.label}</span>
      <button class="doc-block__status ${block.status === 'done' ? 'is-done' : ''}"
              contenteditable="false" title="Статус блока" tabindex="-1"></button>
      <button class="doc-block__star" contenteditable="false" title="Действия по блоку" tabindex="-1">
        <svg viewBox="0 0 24 24"><path d="M12 3l1.9 5.3L19 10l-5.1 1.7L12 17l-1.9-5.3L5 10l5.1-1.7z" fill="currentColor"/><path d="M19 15l.9 2.4L22 18l-2.1.7L19 21l-.9-2.3L16 18l2.1-.6z" fill="currentColor"/></svg>
      </button>
      ${block.html}`;
    el.addEventListener('focusin', () => setActiveBlock(block.id));
    el.addEventListener('click', () => setActiveBlock(block.id));
    // правки пользователя в редакторе сохраняются в стейт и переживают перерисовку
    el.addEventListener('input', () => {
      const copy = el.cloneNode(true);
      copy.querySelector('.doc-block__label')?.remove();
      copy.querySelector('.doc-block__status')?.remove();
      copy.querySelector('.doc-block__star')?.remove();
      block.html = copy.innerHTML;
    });
    el.querySelector('.doc-block__star').addEventListener('click', e => {
      e.stopPropagation();
      setActiveBlock(block.id);
      openBlockMenu(block, e.currentTarget);
    });
    docBlocksEl.appendChild(el);
  });
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
    docPleasEl.innerHTML = '';
    return;
  }
  docPleasEl.innerHTML = `
    <div class="doc-pleas" contenteditable="true">
      <div class="doc-pleas__intro">${pleaIntro()}</div>
      <ol>${state.pleas.map(p => `<li>${p}</li>`).join('')}</ol>
    </div>`;
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

/** Текст блока по линии: генерация + практика, если она есть в карточке дела. */
function composeBlockText(line) {
  let text = line.generatedText || REGEN_FALLBACK_TEXT;
  const practice = state.card.practice;
  if (practice && practice.length) {
    const refs = practice.slice(0, 2).map(p => `${p.num} (${p.court})`).join(', ');
    text += ` Аналогичная позиция подтверждается судебной практикой: ${refs}.`;
  }
  return text;
}

function setActiveBlock(id) {
  if (state.activeBlockId === id) return;
  state.activeBlockId = id;
  document.querySelectorAll('.doc-block').forEach(el =>
    el.classList.toggle('is-active', el.dataset.blockId === id));
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
function insertBlock(text, { afterId, lineId, atStart, kind } = {}) {
  const n = state.blocks.length + 1;
  const block = {
    id: `block-new-${n}`,
    label: `Блок ${n}`,
    status: 'done',
    lineId: lineId || null,
    kind: kind || null,
    html: text
  };
  if (atStart) {
    state.blocks.unshift(block);
  } else {
    const idx = afterId ? state.blocks.findIndex(b => b.id === afterId) : -1;
    if (idx >= 0) state.blocks.splice(idx + 1, 0, block);
    else state.blocks.push(block);
  }
  state.blocks.forEach((b, i) => { b.label = `Блок ${i + 1}`; });
  renderBlocks();
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
  const advLine = advName ? `от адвоката ${advName}` : 'от адвоката &lt;вставить ФИО адвоката&gt;';
  const cliLine = cliName
    ? `в интересах ${c.clientStatus ? c.clientStatus + ' ' : ''}${cliName}`
    : 'в интересах &lt;вставить ФИО доверителя&gt;';

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
    return [`В &lt;вставить название суда ${type.court}&gt;`, advLine, cliLine];
  }
  return [advLine, cliLine];
}

function renderDocHeader(lines) {
  docHeaderBodyEl.innerHTML = lines.map(l => `<p>${l}</p>`).join('');
  const wrap = docHeaderBodyEl.closest('.doc-header');
  wrap.classList.add('flash');
  wrap.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  setTimeout(() => wrap.classList.remove('flash'), 1600);
}

/* ================= Чип контекста во вводе ================= */

function renderContextChip() {
  updateScenarioBanner();
  contextEl.innerHTML = '';
  if (!state.activeBlockId) return;
  const block = getBlock(state.activeBlockId);
  if (!block) return;

  const chip = document.createElement('span');
  chip.className = 'context-chip';
  // пока идёт сценарий — пилз блока без крестика
  chip.innerHTML = state.scenario ? block.label : `${block.label}
    <button title="Отвязать блок">
      <svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/></svg>`;
  const closeBtn = chip.querySelector('button');
  if (closeBtn) closeBtn.addEventListener('click', () => {
    state.activeBlockId = null;
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
  addMessage('assistant', `Тип документа выбран: «${title}». Шапка документа сформирована.`);

  // 2.1 апелляция/кассация/позиция → сценарий 17
  if (type.key === 'appeal' || type.key === 'cassation' || type.key === 'position') {
    state.scenario = null;
    startScenario('gen-by-lines', 'Генерация текста по линиям защиты');
    runGenByLines();
    return;
  }

  // 2.2 ходатайство → сценарий 18
  if (type.key === 'motion') {
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

/** Сценарий 18: генерация текста ходатайства по введённым деталям. */
async function onMotionDetails(text) {
  await think('Генерирую текст ходатайства', 2000);
  insertBlock(`${text.charAt(0).toUpperCase()}${text.slice(1)}. Изложенные обстоятельства имеют существенное значение для дела и подтверждаются его материалами (статьи 119, 120 УПК РФ).`);
  addPlea(PLEA_MOTION);
  endScenario('Текст ходатайства добавлен в документ, просительная часть сформирована.');
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
    generatedText: REGEN_FALLBACK_TEXT
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
  const blockLabel = boundBlock?.label || 'блоку';

  offerChoices([
    {
      label: 'Перегенерировать блок',
      onPick: async () => {
        addMessage('user', 'Перегенерировать блок');
        await think('Генерирую новый текст блока', 2000);
        regenerateBlock(state.activeBlockId, composeBlockText(line));
        addPlea(line.plea || PLEA_FALLBACK);
        endScenario('Текст блока обновлён, просительная часть пересобрана с учётом линии защиты.');
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
    generatedText: REGEN_FALLBACK_TEXT
  };
  state.card.lines.push(line);

  const options = [];
  if (state.activeBlockId) {
    options.push({
      label: 'Добавить после активного блока',
      onPick: async () => {
        addMessage('user', 'Добавить после активного блока');
        await think('Генерирую текст по линии защиты', 1800);
        insertBlock(composeBlockText(line), { afterId: state.activeBlockId, lineId: line.id });
        state.boundLines.add(line.id);
        addPlea(line.plea || PLEA_FALLBACK);
        endScenario('Текст по линии добавлен после активного блока, просительная часть обновлена.');
      }
    });
  }
  options.push(
    {
      label: 'Добавить в конец документа',
      onPick: async () => {
        addMessage('user', 'Добавить в конец документа');
        await think('Генерирую текст по линии защиты', 1800);
        insertBlock(composeBlockText(line), { lineId: line.id });
        state.boundLines.add(line.id);
        addPlea(line.plea || PLEA_FALLBACK);
        endScenario('Текст по линии добавлен в конец документа, просительная часть обновлена.');
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
          insertBlock(composeBlockText(line), { lineId: line.id });
          state.boundLines.add(line.id);
          addPlea(line.plea || PLEA_FALLBACK);
        });
        addMessage('assistant', `Текст по ${unbound.length} лини${unbound.length === 1 ? 'и' : 'ям'} добавлен в документ, просительная часть обновлена.`);
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
  const warnBlocks = state.blocks.filter(b => b.status !== 'done').length;
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
    insertBlock(composeBlockText(line), { lineId: line.id });
    state.boundLines.add(line.id);
    addPlea(line.plea || PLEA_FALLBACK);
  });

  // 17.3 Сутевая часть дела (фабула) — первым блоком после заголовка
  let factsAdded = false;
  if (state.card.episodes.length && !state.blocks.some(b => b.kind === 'facts')) {
    setStep('17.3');
    await think('Генерирую сутевую часть дела по фабуле', 1800);
    insertBlock(composeFactsText(), { atStart: true, kind: 'facts' });
    factsAdded = true;
  }

  setStep('17.4');
  endScenario(
    (factsAdded ? 'Сутевая часть по фабуле дела вставлена первым блоком. ' : '') +
    `Текст по ${unbound.length} ранее непривязанн${unbound.length === 1 ? 'ой линии' : 'ым линиям'} защиты вставлен в конец документа. Просительная часть обновлена.`);
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
  const el = addMessage('assistant', HELP_TEXT);
  el.classList.add('msg--pre');
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

/** Общий пайплайн разбора приговора (шаги 3.1–3.4). */
async function runDocxPipeline() {
  addFileMessage(DOCX_FILE_NAME);

  setStep('3.1');
  await think('Проверяю, приговор ли это первой инстанции', 1500);
  addMessage('assistant', 'Это приговор первой инстанции — продолжаю разбор.');

  setStep('3.2');
  await think('Разбираю документ: доверитель, фабула, доказательства, стадии, участники, обстоятельства, линии защиты', 3000);

  setStep('3.3');
  state.card = clone(DOCX_PARSED_CARD);
  addMessage('assistant', 'Карточка дела обновлена по материалам приговора.');

  setStep('3.4');
  const c = state.card;
  addMessage('assistant',
    `Отчёт по разбору:\n` +
    `• Доверитель: ${c.client}\n` +
    `• Эпизодов фабулы: ${c.episodes.length}\n` +
    `• Линий защиты: ${c.lines.length}\n` +
    `• Доказательств: ${c.evidence.length}\n` +
    `• Обстоятельств: ${c.circumstances.length}`).classList.add('msg--pre');
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
      openPracticeModal();
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
      startScenario('rewrite-block', 'Скорректировать блок');
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
  }
}

/* ---------- Меню действий у блока (ховер-звёздочка) ---------- */

const blockMenuEl = $('#block-menu');

const BLOCK_ACTION_LABELS = {
  'bind-line': 'Привязать линию защиты',
  'practice': 'Практика по линии защиты',
  'bind-evidence': 'Привязать доказательство',
  'rewrite': 'Скорректировать блок',
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

/** 16.5 / 16.7 — короче/подробнее без вопросов и подтверждений. */
async function rewriteBlockAuto(block, mode) {
  await think(mode === 'shorter' ? 'Переписываю блок короче' : 'Переписываю блок подробнее', 1800);
  const text = stripTags(block.html);
  if (mode === 'shorter') {
    const sentences = text.split('. ');
    block.html = sentences.slice(0, 2).join('. ') + (sentences.length > 2 ? '.' : '');
  } else {
    block.html = text + ' ' + DETAIL_SENTENCE.replace(/\s+/g, ' ').trim();
  }
  block.htmlBase = null;
  renderBlocks();
  flashBlock(block.id);
  addMessage('assistant', mode === 'shorter' ? 'Блок переписан короче.' : 'Блок переписан подробнее.');
}

/** 16.6 — переписать блок по свободному запросу. */
async function onRewriteBlock(block, request) {
  await think('Переписываю блок согласно запросу', 1800);
  block.html = REGEN_FALLBACK_TEXT;
  block.htmlBase = null;
  renderBlocks();
  flashBlock(block.id);
  endScenario('Блок скорректирован согласно вашему запросу.');
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
  addMessage('assistant', 'Провожу перегенерацию текста документа с учётом новых доказательств.');
  await think('Перегенерирую текст блока', 2000);

  if (!block.htmlBase) block.htmlBase = block.html;
  const list = selected.map(i => state.card.evidence[i]);
  block.html = block.htmlBase + (list.length
    ? ` Изложенное подтверждается: ${list.map(e => e.charAt(0).toLowerCase() + e.slice(1)).join('; ')}.`
    : '');
  renderBlocks();
  flashBlock(block.id);
  addMessage('assistant', 'Текст блока перегенерирован.');
}

/** 16.3 — попап практики по линии защиты. */
function openPracticeModal() {
  const items = PRACTICE_CASES.map(c => `
    <div class="practice-case">
      <div class="practice-case__num">${c.num}</div>
      <div class="practice-case__court">${c.court}</div>
      <div>${c.summary}</div>
      <span class="practice-case__result">${c.result}</span>
    </div>`).join('');
  openModal({
    title: 'Практика по линии защиты',
    bodyHtml: items,
    buttons: [{ label: 'Закрыть' }]
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

/* ================= Шапка ================= */

$('#btn-download').addEventListener('click', () => window.print());
$('#btn-print').addEventListener('click', () => window.print());
$('#btn-logs').addEventListener('click', e => e.preventDefault());

/* ================= Старт ================= */

resetDemo(0);
