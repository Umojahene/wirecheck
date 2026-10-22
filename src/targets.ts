// Adding an endpoint is a spec entry here and nothing else. If adding one
// requires touching a probe, the probe is wrong.
//
// `requires` is checked before any call, so a missing key is reported as
// unreachable rather than thrown halfway through a run.

import type { Target } from './types.ts';

const env = (k: string) => process.env[k] ?? '';

export const TARGETS: Record<string, Target> = {
  // The reference. Divergences are measured against whatever this does.
  openai: {
    name: 'openai',
    url: () => 'https://api.openai.com/v1/chat/completions',
    headers: () => ({
      Authorization: `Bearer ${env('OPENAI_API_KEY')}`,
      'Content-Type': 'application/json',
    }),
    defaultModel: process.env.WIRECHECK_OPENAI_MODEL || 'gpt-4o-mini',
    requires: ['OPENAI_API_KEY'],
    note: 'reference implementation',
  },

  deepseek: {
    name: 'deepseek',
    url: () => 'https://api.deepseek.com/v1/chat/completions',
    headers: () => ({
      Authorization: `Bearer ${env('DEEPSEEK_API_KEY')}`,
      'Content-Type': 'application/json',
    }),
    defaultModel: 'deepseek-chat',
    requires: ['DEEPSEEK_API_KEY'],
  },

  openrouter: {
    name: 'openrouter',
    url: () => 'https://openrouter.ai/api/v1/chat/completions',
    // Referer/Title are OpenRouter's app-attribution headers, not auth.
    headers: () => ({
      Authorization: `Bearer ${env('OPENROUTER_API_KEY')}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://github.com/Umojahene/wirecheck',
      'X-Title': 'wirecheck',
    }),
    defaultModel: 'openai/gpt-4o-mini',
    requires: ['OPENROUTER_API_KEY'],
  },

  cloudflare: {
    name: 'cloudflare',
    url: () =>
      `https://api.cloudflare.com/client/v4/accounts/${env('CF_ACCOUNT_ID')}/ai/v1/chat/completions`,
    headers: () => ({
      Authorization: `Bearer ${env('CF_API_TOKEN')}`,
      'Content-Type': 'application/json',
    }),
    defaultModel: '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
    requires: ['CF_ACCOUNT_ID', 'CF_API_TOKEN'],
    note: 'Workers AI; free plan is allowance-limited and FAILS rather than bills when spent',
  },

  // Ollama speaks the OpenAI wire format at /v1. No auth, no billing, so it is
  // the one target safe to run repeatedly while developing a probe.
  ollama: {
    name: 'ollama',
    url: () => `${env('OLLAMA_HOST') || 'http://localhost:11434'}/v1/chat/completions`,
    headers: () => ({ 'Content-Type': 'application/json' }),
    defaultModel: process.env.WIRECHECK_OLLAMA_MODEL || 'qwen3:8b',
    requires: [],
    local: true,
    note: 'local; no auth, no cost',
  },

  xai: {
    name: 'xai',
    url: () => 'https://api.x.ai/v1/chat/completions',
    headers: () => ({
      Authorization: `Bearer ${env('XAI_API_KEY')}`,
      'Content-Type': 'application/json',
    }),
    defaultModel: 'grok-4-fast',
    requires: ['XAI_API_KEY'],
  },

  groq: {
    name: 'groq',
    url: () => 'https://api.groq.com/openai/v1/chat/completions',
    headers: () => ({
      Authorization: `Bearer ${env('GROQ_API_KEY')}`,
      'Content-Type': 'application/json',
    }),
    defaultModel: 'llama-3.3-70b-versatile',
    requires: ['GROQ_API_KEY'],
  },

  together: {
    name: 'together',
    url: () => 'https://api.together.xyz/v1/chat/completions',
    headers: () => ({
      Authorization: `Bearer ${env('TOGETHER_API_KEY')}`,
      'Content-Type': 'application/json',
    }),
    defaultModel: 'meta-llama/Llama-3.3-70B-Instruct-Turbo',
    requires: ['TOGETHER_API_KEY'],
  },

  mistral: {
    name: 'mistral',
    url: () => 'https://api.mistral.ai/v1/chat/completions',
    headers: () => ({
      Authorization: `Bearer ${env('MISTRAL_API_KEY')}`,
      'Content-Type': 'application/json',
    }),
    defaultModel: 'mistral-small-latest',
    requires: ['MISTRAL_API_KEY'],
  },
};

/** An endpoint not in the table, given on the command line. */
export function customTarget(url: string, model: string, keyEnv?: string): Target {
  return {
    name: 'custom',
    url: () => url,
    headers: () => ({
      'Content-Type': 'application/json',
      ...(keyEnv && env(keyEnv) ? { Authorization: `Bearer ${env(keyEnv)}` } : {}),
    }),
    defaultModel: model,
    requires: keyEnv ? [keyEnv] : [],
  };
}

export function missingEnv(t: Target): string[] {
  return t.requires.filter((k) => !env(k));
}
