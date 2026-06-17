import { registerBuiltInSymbolExtractor } from './registry';
import { goSymbolExtractor } from './go';
import { rustSymbolExtractor } from './rust';

registerBuiltInSymbolExtractor(goSymbolExtractor);
registerBuiltInSymbolExtractor(rustSymbolExtractor);
