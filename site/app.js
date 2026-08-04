'use strict';

/* global document */

const nodes = document.querySelectorAll('.node');
const readout = document.querySelector('#node-readout');

for (const node of nodes) {
  node.addEventListener('click', () => {
    for (const item of nodes) item.classList.remove('is-active');
    node.classList.add('is-active');
    if (readout) readout.textContent = node.dataset.node || 'RESEARCH NODE';
  });
}

const clock = document.querySelector('.initiation-clock');
const clockFields = {
  days: document.querySelector('#clock-days'),
  hours: document.querySelector('#clock-hours'),
  minutes: document.querySelector('#clock-minutes'),
  seconds: document.querySelector('#clock-seconds'),
};

function updateClock() {
  if (!clock) return;
  const deadline = Date.parse(clock.dataset.deadline || '');
  if (!Number.isFinite(deadline)) return;
  let remaining = Math.max(0, deadline - Date.now());
  const days = Math.floor(remaining / 86_400_000);
  remaining %= 86_400_000;
  const hours = Math.floor(remaining / 3_600_000);
  remaining %= 3_600_000;
  const minutes = Math.floor(remaining / 60_000);
  const seconds = Math.floor((remaining % 60_000) / 1_000);
  const values = { days, hours, minutes, seconds };
  for (const [name, value] of Object.entries(values)) {
    if (clockFields[name]) clockFields[name].textContent = String(value).padStart(2, '0');
  }
}

updateClock();
setInterval(updateClock, 1_000);
