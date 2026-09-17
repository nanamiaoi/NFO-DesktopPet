const slider = document.getElementById('slider');
const label = document.getElementById('label');
const btnReset = document.getElementById('btn-reset');
const btnClose = document.getElementById('btn-close');

function render(percent) {
  slider.value = String(percent);
  label.textContent = `${percent}%`;
}

async function init() {
  const { percent } = await window.sizeAPI.get();
  render(percent);
}

slider.addEventListener('input', () => {
  const percent = Number(slider.value);
  render(percent);
  window.sizeAPI.set(percent);
});

btnReset.addEventListener('click', () => {
  render(100);
  window.sizeAPI.set(100);
});

btnClose.addEventListener('click', () => window.sizeAPI.close());

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') window.sizeAPI.close();
});

init();
