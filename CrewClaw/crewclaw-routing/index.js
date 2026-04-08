// crewclaw-routing entry point — loads TypeScript source via jiti
import { createJiti } from 'jiti';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const require = createRequire(import.meta.url);

const jiti = createJiti(__filename, {
  interopDefault: true,
  fsCache: false,
  requireCache: false,
});

export default jiti('./index.ts');
