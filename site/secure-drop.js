'use strict';

/*
 * Continuity Bureau Source Desk — Stage 0 safety surface.
 *
 * This page intentionally has no recipient configuration, cryptographic
 * implementation, persistence, or network submission code. Do not add a JWK
 * here or reactivate the former WebCrypto RSA/AES prototype. The repository
 * threat model requires a pinned, reviewed HPKE + streaming-AEAD implementation,
 * signed recipient manifests, interoperability vectors, and an independent
 * audit before sources may enter plaintext.
 */

const elements = {
  fields: document.querySelector('#intake-fields'),
  locked: document.querySelector('#locked-state'),
  status: document.querySelector('#desk-status'),
  recipientKeyId: document.querySelector('#recipient-key-id'),
  recipientFingerprint: document.querySelector('#recipient-fingerprint'),
  message: document.querySelector('#form-message'),
};

function replaceStatus(label) {
  const indicator = document.createElement('span');
  indicator.setAttribute('aria-hidden', 'true');
  elements.status.replaceChildren(indicator, document.createTextNode(` ${label}`));
}

function lockDesk() {
  elements.fields.disabled = true;
  elements.locked.hidden = false;
  elements.status.className = 'desk-status locked';
  replaceStatus('RESEARCH ONLY / INTAKE DISABLED');
  elements.recipientKeyId.textContent = 'NO OPERATIONAL MANIFEST';
  elements.recipientFingerprint.textContent = 'NOT PUBLISHED';
  elements.message.textContent =
    'No source material is accepted here. Do not enter or attach confidential information.';
  elements.message.classList.add('error');
}

lockDesk();
