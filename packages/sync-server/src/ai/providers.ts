export type RuntimeId = 'claude_code' | 'openai_compat';

export type ApiProvider = {
  id: string;
  label: string;
  /** OpenAI-compatible base URL (…/v1). Empty for `custom`. */
  baseUrl: string;
  needsBaseUrl?: boolean;
  /** The key is optional (local servers). */
  keyOptional?: boolean;
  keyUrl?: string;
  /** Suggested model ids. The first is the default. */
  models: string[];
};

export const API_PROVIDERS: ApiProvider[] = [
  {
    id: 'openrouter',
    label: 'OpenRouter (hundreds of models, one key)',
    baseUrl: 'https://openrouter.ai/api/v1',
    keyUrl: 'https://openrouter.ai/settings/keys',
    models: [
      'anthropic/claude-sonnet-4.5',
      'google/gemini-2.5-flash',
      'deepseek/deepseek-chat',
      'openai/gpt-5',
    ],
  },
  {
    id: 'deepseek',
    label: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/v1',
    keyUrl: 'https://platform.deepseek.com/api_keys',
    models: ['deepseek-chat', 'deepseek-reasoner'],
  },
  {
    id: 'openai',
    label: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    keyUrl: 'https://platform.openai.com/api-keys',
    models: ['gpt-5', 'gpt-5-mini'],
  },
  {
    id: 'gemini',
    label: 'Google AI Studio (Gemini)',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    keyUrl: 'https://aistudio.google.com/app/apikey',
    models: ['gemini-2.5-pro', 'gemini-2.5-flash'],
  },
  {
    id: 'xai',
    label: 'xAI (Grok)',
    baseUrl: 'https://api.x.ai/v1',
    keyUrl: 'https://console.x.ai/',
    models: ['grok-4', 'grok-4-fast'],
  },
  {
    id: 'ollama-cloud',
    label: 'Ollama Cloud',
    baseUrl: 'https://ollama.com/v1',
    keyUrl: 'https://ollama.com/settings/keys',
    models: ['gpt-oss:120b', 'gpt-oss:20b'],
  },
  {
    id: 'custom',
    label: 'Other OpenAI-compatible server (vLLM, LM Studio, LiteLLM, Ollama…)',
    baseUrl: '',
    needsBaseUrl: true,
    keyOptional: true,
    models: [],
  },
];

export const CLAUDE_MODELS = ['sonnet', 'opus', 'haiku'];

export function getProvider(id: string | null | undefined) {
  return API_PROVIDERS.find(provider => provider.id === id) ?? null;
}

export function defaultModel(runtime: RuntimeId, providerId?: string | null) {
  if (runtime === 'claude_code') return CLAUDE_MODELS[0];
  return getProvider(providerId)?.models[0] ?? '';
}
