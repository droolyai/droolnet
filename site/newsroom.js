(function () {
  'use strict';

  const STORAGE_KEY = 'continuity-bureau:signal-desk:saved-v1';
  const stories = {
    reservoir: {
      title: 'A reservoir went quiet. The maintenance logs did not.',
      desk: 'Civic systems',
      dek: 'A fictional dossier demonstrating how public records, protected-source context, and uncertainty can travel together.',
      claims: [
        ['A public dashboard changed before the interruption.', 'Supported by two synthetic timestamped captures; motive is not established.'],
        ['Operators received repeated pump warnings.', 'Supported by a fictional maintenance-log facsimile; independent corroboration staged.'],
        ['Residents lacked timely notice.', 'Illustrated by three invented interviews; not a representative sample.'],
      ],
      receipt: { ID: 'demo:9b21f73a…42cf', Method: 'Illustrative digest label', Evidence: '6 synthetic objects', Redactions: '2 / source-safety rationale', Network: 'Local prototype only' },
      corrections: ['v1.1 / Demo revision: clarified that the interview sample is not representative.', 'v1.0 / Initial fictional dossier assembled for interface testing.'],
    },
    model: {
      title: 'The algorithm graded families. Its documentation graded itself.',
      desk: 'Technology',
      dek: 'A fictional procurement investigation showing how a high-risk source review and contradictory evidence are disclosed.',
      claims: [
        ['A vendor score influenced benefit reviews.', 'Supported by a synthetic contract appendix; operational use remains disputed.'],
        ['The public model card omitted three inputs.', 'Supported by a generated schema comparison.'],
        ['Appeal staff could not inspect the score.', 'Protected fictional source account; independent confirmation pending.'],
      ],
      receipt: { ID: 'demo:61f0a944…18aa', Method: 'Synthetic schema comparison', Evidence: '9 synthetic objects', Redactions: '4 / retaliation risk', Network: 'Local prototype only' },
      corrections: ['v1.2 / Demo correction: “determined” changed to “influenced” to reflect the fictional evidence.', 'v1.0 / Initial fictional dossier assembled for interface testing.'],
    },
    frequency: {
      title: 'When a community station vanished, its archive found another route.',
      desk: 'Culture',
      dek: 'A fictional oral-history dossier exploring consent, cultural provenance, and portable archives.',
      claims: [
        ['Volunteers recovered 312 recordings.', 'Synthetic catalog manifest with 312 generated entries.'],
        ['Artists approved archive inclusion.', 'Fictional consent receipts cover 71%; the rest remain private.'],
        ['A neighborhood relay served the archive.', 'Scenario only; no real relay or peer network is claimed.'],
      ],
      receipt: { ID: 'demo:a201b17e…e903', Method: 'Consent-led manifest demonstration', Evidence: '5 synthetic objects', Redactions: '1 / private recording', Network: 'Simulation only' },
      corrections: ['v1.1 / Demo revision: surfaced the 71% consent coverage in the claim map.', 'v1.0 / Initial fictional dossier assembled for interface testing.'],
    },
    heat: {
      title: 'The cooling centers closed at eight. The hottest hours came later.',
      desk: 'Climate',
      dek: 'A fictional data dossier showing reproducible methods, data limitations, and source protection.',
      claims: [
        ['Modeled indoor heat peaked after closing.', 'Generated fixture and reproducible demo calculation; not observed field data.'],
        ['Transit gaps affected overnight access.', 'Synthetic timetable comparison; accessibility variables incomplete.'],
        ['Unofficial sites filled the gap.', 'Two fictional interviews; location details withheld in the scenario.'],
      ],
      receipt: { ID: 'demo:407c22d1…a680', Method: 'Reproducible fixture notebook', Evidence: '7 synthetic objects', Redactions: '3 / location safety', Network: 'Local prototype only' },
      corrections: ['v1.1 / Demo correction: labeled indoor values as modeled rather than measured.', 'v1.0 / Initial fictional dossier assembled for interface testing.'],
    },
  };

  function readSaved() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY) || '[]';
      if (raw.length > 1024) return [];
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      return [...new Set(parsed.filter((id) => typeof id === 'string' && stories[id]))].slice(0, Object.keys(stories).length);
    } catch (_) {
      return [];
    }
  }

  let saved = readSaved();
  const dossierDialog = document.querySelector('[data-dossier-dialog]');
  const savedDialog = document.querySelector('[data-saved-dialog]');
  let lastDialogOpener = null;

  function syncDialogState() {
    const anyOpen = [dossierDialog, savedDialog].some((dialog) => dialog && dialog.open);
    document.body.classList.toggle('dialog-open', anyOpen);
    if (!anyOpen && lastDialogOpener instanceof HTMLElement && lastDialogOpener.isConnected) {
      lastDialogOpener.focus();
      lastDialogOpener = null;
    }
  }

  function persistSaved() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(saved)); } catch (_) { /* Storage can be disabled. */ }
    renderSaved();
  }

  function renderSaved() {
    document.querySelectorAll('[data-saved-count]').forEach((node) => { node.textContent = String(saved.length); });
    document.querySelectorAll('[data-save-story]').forEach((button) => {
      const active = saved.includes(button.dataset.saveStory);
      button.setAttribute('aria-pressed', String(active));
      button.replaceChildren();
      const icon = document.createElement('span');
      icon.setAttribute('aria-hidden', 'true');
      icon.textContent = active ? '✓' : '＋';
      button.append(icon, ` ${active ? 'Saved here' : 'Save locally'}`);
    });
    const list = document.querySelector('[data-saved-list]');
    if (!list) return;
    if (!saved.length) {
      list.replaceChildren();
      const empty = document.createElement('p');
      empty.className = 'saved-empty';
      empty.textContent = 'No saved signals yet.';
      list.append(empty);
      return;
    }
    const fragment = document.createDocumentFragment();
    saved.forEach((id) => {
      const item = document.createElement('article');
      item.className = 'saved-item';
      const copy = document.createElement('div');
      const title = document.createElement('b');
      title.textContent = stories[id].title;
      const desk = document.createElement('small');
      desk.textContent = `${stories[id].desk} · fictional demo`;
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.dataset.removeSaved = id;
      remove.setAttribute('aria-label', `Remove “${stories[id].title}” from reading list`);
      remove.textContent = 'Remove';
      copy.append(title, desk);
      item.append(copy, remove);
      fragment.append(item);
    });
    list.replaceChildren(fragment);
  }

  function toggleSaved(id) {
    saved = saved.includes(id) ? saved.filter((item) => item !== id) : [...saved, id];
    persistSaved();
  }

  function openDossier(id, opener) {
    const story = stories[id];
    if (!story || !dossierDialog) return;
    dossierDialog.querySelector('[data-dossier-title]').textContent = story.title;
    dossierDialog.querySelector('[data-dossier-dek]').textContent = story.dek;
    const claimList = dossierDialog.querySelector('[data-claim-list]');
    const claims = story.claims.map(([claim, note]) => {
      const item = document.createElement('article');
      item.className = 'claim';
      const heading = document.createElement('b');
      heading.textContent = claim;
      const detail = document.createElement('small');
      detail.textContent = note;
      item.append(heading, detail);
      return item;
    });
    claimList.replaceChildren(...claims);

    const receiptList = dossierDialog.querySelector('[data-receipt-list]');
    const receipts = Object.entries(story.receipt).map(([key, value]) => {
      const row = document.createElement('div');
      const term = document.createElement('dt');
      term.textContent = key;
      const detail = document.createElement('dd');
      detail.textContent = value;
      row.append(term, detail);
      return row;
    });
    receiptList.replaceChildren(...receipts);

    const correctionList = dossierDialog.querySelector('[data-correction-list]');
    const corrections = story.corrections.map((text) => {
      const item = document.createElement('li');
      item.textContent = text;
      return item;
    });
    correctionList.replaceChildren(...corrections);
    if (!dossierDialog.open) {
      lastDialogOpener = opener instanceof HTMLElement ? opener : null;
      dossierDialog.showModal();
    }
    syncDialogState();
  }

  function closeDialog(dialog) {
    if (dialog && dialog.open) dialog.close();
    syncDialogState();
  }

  document.addEventListener('click', (event) => {
    if (!(event.target instanceof Element)) return;
    const filter = event.target.closest('[data-filter]');
    if (filter) {
      const desk = filter.dataset.filter;
      document.querySelectorAll('[data-filter]').forEach((button) => {
        const active = button === filter;
        button.classList.toggle('is-active', active);
        button.setAttribute('aria-pressed', String(active));
      });
      let visibleCount = 0;
      document.querySelectorAll('[data-story]').forEach((card) => {
        card.hidden = desk !== 'all' && !card.dataset.desk.split(' ').includes(desk);
        if (!card.hidden) visibleCount += 1;
      });
      const status = document.querySelector('[data-filter-status]');
      if (status) status.textContent = `Showing ${visibleCount} fictional demo ${visibleCount === 1 ? 'dossier' : 'dossiers'} for ${desk === 'all' ? 'all desks' : `${filter.textContent.trim()} desk`}.`;
      return;
    }

    const save = event.target.closest('[data-save-story]');
    if (save) { toggleSaved(save.dataset.saveStory); return; }
    const remove = event.target.closest('[data-remove-saved]');
    if (remove) { toggleSaved(remove.dataset.removeSaved); return; }
    const dossier = event.target.closest('[data-open-dossier]');
    if (dossier) { openDossier(dossier.dataset.openDossier, dossier); return; }
    if (event.target.closest('[data-close-dialog]')) { closeDialog(dossierDialog); return; }
    if (event.target.closest('[data-open-saved]')) {
      renderSaved();
      if (savedDialog && !savedDialog.open) {
        lastDialogOpener = event.target.closest('[data-open-saved]');
        savedDialog.showModal();
      }
      syncDialogState();
      return;
    }
    if (event.target.closest('[data-close-saved]')) { closeDialog(savedDialog); return; }
    if (event.target.closest('[data-clear-saved]')) { saved = []; persistSaved(); }
  });

  [dossierDialog, savedDialog].forEach((dialog) => {
    if (!dialog) return;
    dialog.addEventListener('click', (event) => {
      const rect = dialog.getBoundingClientRect();
      const outside = event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom;
      if (outside) closeDialog(dialog);
    });
    dialog.addEventListener('close', syncDialogState);
  });

  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    const openDialog = [dossierDialog, savedDialog].find((dialog) => dialog && dialog.open);
    if (!openDialog) return;
    event.preventDefault();
    closeDialog(openDialog);
  });

  renderSaved();
})();
