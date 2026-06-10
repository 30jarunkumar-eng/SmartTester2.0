'use strict';

/**
 * Shared OpenAI-compatible client factory.
 *
 * Supports:
 *  - OpenAI directly        (OPENAI_BASE_URL not set)
 *  - OpenRouter             (OPENAI_BASE_URL=https://openrouter.ai/api/v1)
 *  - NVIDIA NIM             (OPENAI_BASE_URL=https://integrate.api.nvidia.com/v1)
 *  - Any other OpenAI-compatible provider
 *
 * All providers use the same `openai` npm package — just different base URLs.
 */

const OpenAI = require('openai');

const PROVIDER_CONFIGS = {
  openrouter: {
    baseURL:        'https://openrouter.ai/api/v1',
    defaultHeaders: {
      'HTTP-Referer': 'https://github.com/SmartTester2.0',
      'X-Title':      'SmartTester QA Framework'
    }
  },
  nvidia: {
    baseURL: 'https://integrate.api.nvidia.com/v1'
  }
};

// Model name aliases — maps friendly names to provider-specific model IDs
const MODEL_ALIASES = {
  // generic aliases → resolved per provider
  'gpt-4o':       { openrouter: 'openai/gpt-4o',                        nvidia: 'meta/llama-3.1-70b-instruct' },
  'claude':        { openrouter: 'anthropic/claude-3.5-sonnet',          nvidia: 'meta/llama-3.1-70b-instruct' },
  'gemini':        { openrouter: 'google/gemini-flash-1.5',              nvidia: 'meta/llama-3.1-70b-instruct' },
  'llama':         { openrouter: 'meta-llama/llama-3.1-70b-instruct:free', nvidia: 'meta/llama-3.1-70b-instruct' },
  'mistral':       { openrouter: 'mistralai/mistral-large',              nvidia: 'mistralai/mistral-large-latest' },
  'nemotron':      { openrouter: 'nvidia/nemotron-4-340b-instruct',      nvidia: 'nvidia/nemotron-4-340b-instruct' }
};

/**
 * Build and return a configured OpenAI client instance.
 * Reads OPENAI_API_KEY, OPENAI_BASE_URL, OPENAI_PROVIDER from process.env.
 */
function createClient() {
  const apiKey   = process.env.OPENAI_API_KEY;
  const baseURL  = process.env.OPENAI_BASE_URL;
  const provider = (process.env.OPENAI_PROVIDER || '').toLowerCase();

  if (!apiKey) throw new Error('OPENAI_API_KEY is not set. Copy .env.example to .env and add your key.');

  const config = { apiKey };

  // Apply provider-preset config
  if (provider && PROVIDER_CONFIGS[provider]) {
    const preset = PROVIDER_CONFIGS[provider];
    config.baseURL        = baseURL || preset.baseURL;
    config.defaultHeaders = preset.defaultHeaders || {};
  } else if (baseURL) {
    // Custom base URL without named provider
    config.baseURL = baseURL;
  }

  return new OpenAI(config);
}

/**
 * Resolve the model name for the current provider.
 * If OPENAI_MODEL is already provider-specific (contains '/'), use it directly.
 * Otherwise try to map it via MODEL_ALIASES.
 */
function resolveModel() {
  const raw      = process.env.OPENAI_MODEL || 'gpt-4o';
  const provider = (process.env.OPENAI_PROVIDER || '').toLowerCase();

  // Already provider-namespaced (e.g. "openai/gpt-4o", "meta/llama-...")
  if (raw.includes('/')) return raw;

  // Try alias mapping
  if (provider && MODEL_ALIASES[raw] && MODEL_ALIASES[raw][provider]) {
    return MODEL_ALIASES[raw][provider];
  }

  return raw;
}

/**
 * Print which provider / model is active (for startup logging).
 */
function describeProvider() {
  const provider = process.env.OPENAI_PROVIDER || 'openai';
  const baseURL  = process.env.OPENAI_BASE_URL  || 'https://api.openai.com/v1';
  const model    = resolveModel();
  return `${provider} · ${model} · ${baseURL}`;
}

module.exports = { createClient, resolveModel, describeProvider };
