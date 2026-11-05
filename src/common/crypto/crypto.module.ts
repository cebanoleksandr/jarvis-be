import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../../config/env.validation.js';
import { TokenCipher } from './token-cipher.js';

@Global()
@Module({
  providers: [
    {
      provide: TokenCipher,
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>) =>
        new TokenCipher(
          Buffer.from(config.get('TOKEN_ENC_KEY', { infer: true }), 'base64'),
        ),
    },
  ],
  exports: [TokenCipher],
})
export class CryptoModule {}
