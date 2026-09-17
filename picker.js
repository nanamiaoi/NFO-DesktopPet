const grid = document.getElementById('grid');
const btnStart = document.getElementById('btn-start');
const btnQuit = document.getElementById('btn-quit');
const remember = document.getElementById('remember');

/** @type {Set<string>} */
const selected = new Set();

function syncStart() {
  btnStart.disabled = selected.size === 0;
  btnStart.textContent = selected.size > 1 ? `开始（${selected.size}）` : '开始';
}

function toggle(id) {
  if (selected.has(id)) selected.delete(id);
  else selected.add(id);
  for (const el of grid.querySelectorAll('.card')) {
    el.classList.toggle('selected', selected.has(el.dataset.id));
  }
  syncStart();
}

async function init() {
  const data = await window.pickerAPI.getBootstrap();
  remember.checked = !!data.skipPicker;

  for (const id of data.characters) {
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'card';
    card.dataset.id = id;
    card.innerHTML = `<img src="assets/${id}_idle_01.png" alt="${id}" draggable="false" /><div class="name">${id}</div>`;
    card.addEventListener('click', () => toggle(id));
    grid.appendChild(card);
  }

  const initial = Array.isArray(data.selectedCharacters) && data.selectedCharacters.length
    ? data.selectedCharacters
    : data.lastCharacter
      ? [data.lastCharacter]
      : data.characters[0]
        ? [data.characters[0]]
        : [];

  for (const id of initial) {
    if (data.characters.includes(id)) selected.add(id);
  }
  for (const el of grid.querySelectorAll('.card')) {
    el.classList.toggle('selected', selected.has(el.dataset.id));
  }
  syncStart();
}

function start() {
  if (!selected.size) return;
  window.pickerAPI.start([...selected], remember.checked);
}

btnStart.addEventListener('click', start);
btnQuit.addEventListener('click', () => window.pickerAPI.quit());

document.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') start();
  if (e.key === 'Escape') window.pickerAPI.quit();
});

init();
