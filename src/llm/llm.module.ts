import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../config/env.validation.js';
import { AnthropicProvider } from './anthropic.provider.js';
import { LlmProvider } from './llm.types.js';
import { OpenRouterProvider } from './openrouter.provider.js';

@Module({
  providers: [
    {
      provide: LlmProvider,
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>): LlmProvider =>
        config.get('LLM_PROVIDER', { infer: true }) === 'openrouter'
          ? new OpenRouterProvider(config)
          : new AnthropicProvider(config),
    },
  ],
  exports: [LlmProvider],
})
export class LlmModule {}
