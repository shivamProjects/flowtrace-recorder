/**
 * shadow-dom-widgets.test.js — Tests for Shadow DOM boundary traversal,
 * custom component label resolution, interactive retargeting, and auto-login helpers.
 */
import { describe, expect, it, beforeEach } from 'vitest';
import {
  closestCrossShadow,
  parentElementOrShadowHost,
  resolveLabel,
  inferRole,
  retargetToInteractive,
} from '@flowtrace/recorder-core';
import {
  findLoginField,
  findSignInButton,
  setNativeValue,
} from '@flowtrace/recorder-core';

describe('DOM & Shadow DOM Enhancement Utilities', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('parentElementOrShadowHost steps out of shadow root to host element', () => {
    const host = document.createElement('custom-input');
    document.body.appendChild(host);
    const shadow = host.attachShadow({ mode: 'open' });
    const inner = document.createElement('input');
    shadow.appendChild(inner);

    expect(parentElementOrShadowHost(inner)).toBe(host);
  });

  it('closestCrossShadow traverses shadow boundaries up to matching ancestor', () => {
    const card = document.createElement('div');
    card.className = 'interactive-card';
    document.body.appendChild(card);

    const host = document.createElement('custom-button');
    card.appendChild(host);

    const shadow = host.attachShadow({ mode: 'open' });
    const innerSpan = document.createElement('span');
    shadow.appendChild(innerSpan);

    const match = closestCrossShadow(innerSpan, '.interactive-card');
    expect(match).toBe(card);
  });

  it('resolveLabel resolves labels across shadow boundaries and host attributes', () => {
    // 1. Host with label-hint
    const jetInput = document.createElement('oj-input-text');
    jetInput.setAttribute('label-hint', 'Customer Account');
    document.body.appendChild(jetInput);

    const shadow = jetInput.attachShadow({ mode: 'open' });
    const inner = document.createElement('input');
    shadow.appendChild(inner);

    expect(resolveLabel(inner)).toBe('Customer Account');

    // 2. Element inside shadow with aria-label
    const btnHost = document.createElement('custom-btn');
    document.body.appendChild(btnHost);
    const btnShadow = btnHost.attachShadow({ mode: 'open' });
    const innerBtn = document.createElement('button');
    innerBtn.setAttribute('aria-label', 'Submit Invoice');
    btnShadow.appendChild(innerBtn);

    expect(resolveLabel(innerBtn)).toBe('Submit Invoice');
  });

  it('inferRole correctly identifies custom web components', () => {
    const ojBtn = document.createElement('oj-button');
    const ojSelect = document.createElement('oj-select-single');
    const ojText = document.createElement('oj-input-text');

    expect(inferRole(ojBtn)).toBe('button');
    expect(inferRole(ojSelect)).toBe('combobox');
    expect(inferRole(ojText)).toBe('textbox');
  });

  it('retargetToInteractive retargets clicked decorative children to interactive container', () => {
    const btn = document.createElement('button');
    btn.className = 'primary-btn';
    btn.innerHTML = '<span class="icon"><svg><path id="target-icon"></path></svg></span><span class="label">Save</span>';
    document.body.appendChild(btn);

    const path = btn.querySelector('#target-icon');
    const retargeted = retargetToInteractive(path);
    expect(retargeted).toBe(btn);
  });
});

describe('Auto-Login & Framework Piercing Utilities', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('finds username and password fields on enterprise login pages', () => {
    document.body.innerHTML = `
      <form id="login-form">
        <input id="idcs-signin-basic-authn-username" name="os_username" placeholder="Username or Email">
        <input id="idcs-signin-basic-authn-password" name="os_password" type="password" placeholder="Password">
        <button type="submit" id="signin-btn">Sign In</button>
      </form>
    `;

    const user = findLoginField('username');
    const pass = findLoginField('password');
    const btn = findSignInButton();

    expect(user).not.toBeNull();
    expect(user.name).toBe('os_username');
    expect(pass).not.toBeNull();
    expect(pass.type).toBe('password');
    expect(btn).not.toBeNull();
    expect(btn.id).toBe('signin-btn');
  });

  it('setNativeValue dispatches input event and updates input value', () => {
    const input = document.createElement('input');
    document.body.appendChild(input);

    let inputFired = false;
    input.addEventListener('input', () => { inputFired = true; });

    setNativeValue(input, 'test_user');
    expect(input.value).toBe('test_user');
    expect(inputFired).toBe(true);
  });
});
