import { Module } from '@nestjs/common';
import { AnthropicProvider } from './anthropic.provider.js';
import { LlmProvider } from './llm.types.js';

@Module({
  providers: [{ provide: LlmProvider, useClass: AnthropicProvider }],
  exports: [LlmProvider],
})
export class LlmModule {}
