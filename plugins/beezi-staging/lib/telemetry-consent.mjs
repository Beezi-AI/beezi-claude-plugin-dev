import { readJson, writeJsonSecure } from './fs-store.mjs';
import { telemetryConsentFile } from './paths.mjs';

const CONSENT_VERSION = 1;

export function readConsent() {
  const raw = readJson(telemetryConsentFile());
  if (!raw || raw.version !== CONSENT_VERSION) return null;
  return raw;
}

// Absent record, unreadable record, or anything other than an explicit grant reads as "no".
export function isTelemetryGranted() {
  const state = readConsent();
  return state != null && state.consent === 'granted';
}

export function hasBeenAsked() {
  const state = readConsent();
  return state != null && state.askedAt != null;
}

function write(patch) {
  const state = readConsent();
  writeJsonSecure(telemetryConsentFile(), { version: CONSENT_VERSION, ...(state == null ? {} : state), ...patch });
}

export function grantConsent() {
  write({ consent: 'granted', askedAt: new Date().toISOString(), decidedAt: new Date().toISOString() });
}

export function denyConsent() {
  write({ consent: 'denied', askedAt: new Date().toISOString(), decidedAt: new Date().toISOString() });
}

// Stamped when the one-time prompt is shown, so it is shown exactly once whatever the answer.
export function markAsked() {
  write({ askedAt: new Date().toISOString() });
}
